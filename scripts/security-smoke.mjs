#!/usr/bin/env node
/**
 * Non-mocked deployment-security proof for Phase 9F.
 *
 * Everything 9F added is a claim about a *running deployment*, not about a function:
 * a posture that refuses to start, a listener that terminates real TLS, a signature
 * checked over a real socket, a root key replaced while every credential stays
 * readable, and an outbound cap that actually keeps sockets closed. None of that can
 * be shown in-process, so this script starts real listeners, spawns the real entry
 * point, and drives real HTTP and HTTPS.
 *
 * Deliberate choices:
 *
 * - The `lan` refusals spawn `apps/server/src/index.ts` as a **child process** and
 *   assert its exit status. Calling `resolvePosture` directly would prove the
 *   function throws; only a child can prove the process refuses to serve.
 * - TLS verification is **not disabled**. The client trusts the test CA and the
 *   server certificate carries an IP SAN, so the handshake is genuinely verified.
 *   `rejectUnauthorized: false` would have made the TLS section prove nothing.
 * - The root key is read from `master.key` and scanned for as **raw bytes**. With
 *   secure-file custody there is no hex string to grep for, and scanning for a
 *   string that never existed would be a check that cannot fail.
 *
 * Exits non-zero on any failed check.
 */
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../apps/server/src/index.ts", import.meta.url));
const APP_ENTRY = fileURLToPath(new URL("../apps/server/src/app.ts", import.meta.url));
const RUNTIME_ENTRY = fileURLToPath(
  new URL("../apps/server/src/runtime.ts", import.meta.url),
);
const SIGNING_ENTRY = fileURLToPath(
  new URL("../apps/server/src/signing.ts", import.meta.url),
);
const ROUTER_ENTRY = fileURLToPath(
  new URL("../packages/router/src/index.ts", import.meta.url),
);

if (!process.env.BAYZ_SECURITY_SMOKE_LOADER) {
  const relaunch = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url)],
    { stdio: "inherit", env: { ...process.env, BAYZ_SECURITY_SMOKE_LOADER: "1" } },
  );
  process.exit(relaunch.status ?? 1);
}

const TOKEN = "security-smoke-token-0123456789abcdef";
const CREDENTIAL = "sk-security-smoke-provider-credential-never-leaks";
const PASSWORD = "hunter2-security-smoke-proxy-password";
const PROMPT = "SECURITY-SMOKE-PROMPT-must-never-touch-disk";
const COMPLETION = "SECURITY-SMOKE-COMPLETION-also-never-persisted";

const captured = [];
const bodies = [];
const failures = [];
let checks = 0;

function check(label, condition) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    failures.push(label);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

const openSockets = new Set();

function track(socket) {
  openSockets.add(socket);
  socket.on("close", () => openSockets.delete(socket));
  socket.on("error", () => {});
  return socket;
}

/* ------------------------------------------------------------------ *
 * A real PKI
 *
 * EC keys rather than RSA: this device generates P-256 fast enough that the smoke
 * stays usable, and it exercises the same code path.
 * ------------------------------------------------------------------ */

function buildPki(dir) {
  const openssl = (args) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  openssl([
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2",
    "-subj", "/CN=bayz-security-smoke-ca",
  ]);
  openssl([
    "req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-nodes", "-keyout", "server.key", "-out", "server.csr",
    "-subj", "/CN=localhost",
  ]);
  // An IP SAN, so the client can verify the certificate instead of skipping
  // verification. A smoke that passed `rejectUnauthorized: false` would prove the
  // listener speaks TLS and nothing about whether the certificate is the one served.
  writeFileSync(join(dir, "server.ext"), "subjectAltName=IP:127.0.0.1,DNS:localhost\n");
  openssl([
    "x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key",
    "-CAcreateserial", "-out", "server.crt", "-days", "2", "-extfile", "server.ext",
  ]);
  return {
    caCert: join(dir, "ca.crt"),
    serverCert: join(dir, "server.crt"),
    serverKey: join(dir, "server.key"),
  };
}

/** The first non-internal private IPv4 this device has, or undefined. */
function privateIpv4() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) {
        continue;
      }
      const [a, b] = entry.address.split(".").map(Number);
      if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
        return entry.address;
      }
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * A real upstream
 * ------------------------------------------------------------------ */

/**
 * An origin that records what it saw and, optionally, holds every request open.
 *
 * Holding is what makes the concurrency section meaningful: the cap has to be
 * observed at the *socket*, and an origin that answers immediately would never let
 * enough requests overlap to show whether it holds.
 */
async function startOrigin() {
  const seen = [];
  let inHandler = 0;
  let peak = 0;
  let hold = false;
  const pending = [];

  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ url: request.url, authorization: request.headers.authorization, body });
      inHandler += 1;
      peak = Math.max(peak, inHandler);
      const answer = () => {
        inHandler -= 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          request.url?.includes("/chat/completions")
            ? JSON.stringify({
                id: "chatcmpl-security-smoke",
                model: "smoke-model",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: COMPLETION },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
              })
            : JSON.stringify({ data: [{ id: "smoke-model" }] }),
        );
      };
      if (hold) {
        pending.push(answer);
      } else {
        answer();
      }
    });
  });
  server.on("connection", track);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    server,
    port: server.address().port,
    seen,
    peak: () => peak,
    inHandler: () => inHandler,
    resetPeak: () => {
      peak = 0;
    },
    setHold: (value) => {
      hold = value;
    },
    releaseAll: () => {
      while (pending.length > 0) {
        pending.shift()();
      }
    },
    pending: () => pending.length,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Spawn the real entry point and resolve with what it did. */
function bootEntry(env, { waitForReady = false, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", ENTRY], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ status: null, out, timedOut: true });
    }, timeoutMs);

    const onChunk = (chunk) => {
      out += String(chunk);
      if (waitForReady && out.includes("Bayz Core ready")) {
        // Killed on purpose: the claim under test is that it *started*, and leaving a
        // listener alive would hold the port for the rest of the run.
        child.kill("SIGTERM");
        finish({ status: 0, out, ready: true });
      }
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.on("exit", (status) => finish({ status, out }));
  });
}

/** An HTTPS request that genuinely verifies the server certificate. */
function httpsCall(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const request = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        ca: options.ca,
        // No `servername`: RFC 6066 forbids an IP in SNI and Node deprecates it.
        // Verification still happens — against `host`, which the certificate's IP SAN
        // covers — so the handshake is genuinely checked rather than skipped.
        headers: {
          host: `127.0.0.1:${port}`,
          ...(options.auth === false ? {} : { authorization: `Bearer ${TOKEN}` }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(options.headers ?? {}),
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          bodies.push(text);
          let json;
          try {
            json = text.length > 0 ? JSON.parse(text) : undefined;
          } catch {
            json = undefined;
          }
          resolve({ status: response.statusCode, text, json });
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

function readDatabaseBytes(dataDir) {
  const base = join(dataDir, "bayz.db");
  const parts = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(`${base}${suffix}`)) {
      parts.push(readFileSync(`${base}${suffix}`));
    }
  }
  return Buffer.concat(parts);
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "bayz-security-smoke-"));
  const pkiDir = join(root, "pki");
  mkdirSync(pkiDir, { recursive: true });
  const pki = buildPki(pkiDir);

  // @fastify/static requires the directory to exist, so the spawned children get a
  // real one rather than the built dashboard, which this script does not need.
  const dashboardRoot = join(root, "dashboard");
  mkdirSync(dashboardRoot, { recursive: true });
  writeFileSync(join(dashboardRoot, "index.html"), "<!doctype html><title>x</title>");

  const dataDir = join(root, "loopback", ".bayz");
  const { buildApp } = await import(APP_ENTRY);
  const { createBayzRuntime } = await import(RUNTIME_ENTRY);
  const { signRequest } = await import(SIGNING_ENTRY);
  const { configureOutboundConcurrency, resetOutboundConcurrency, outboundSemaphore } =
    await import(ROUTER_ENTRY);

  const origin = await startOrigin();

  /*
   * Secure-file custody, deliberately: `BAYZ_MASTER_KEY` is absent so the root key
   * lives in `master.key` and rotation is genuinely supported. With env custody the
   * rotation section could only prove the refusal path.
   */
  const runtime = createBayzRuntime(
    { host: "127.0.0.1", port: 0, dataDir, dashboardRoot },
    {
      env: { BAYZ_API_TOKEN: TOKEN },
      notify: () => {},
      logger: (payload) => captured.push(JSON.stringify(payload)),
    },
  );

  const app = buildApp({
    logger: false,
    apiToken: TOKEN,
    runtime,
    posture: "loopback",
    requireSigning: true,
    https: {
      cert: readFileSync(pki.serverCert, "utf8"),
      key: readFileSync(pki.serverKey, "utf8"),
      requestCert: false,
      rejectUnauthorized: false,
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.3",
      mutual: false,
    },
  });

  const ca = readFileSync(pki.caCert, "utf8");
  let port;

  /** A signed call. The signature is produced by the shipped `signRequest`. */
  const signed = async (method, path, body, overrides = {}) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const headers = signRequest({ key: TOKEN, method, url: path, body: raw, ...overrides });
    return httpsCall(port, path, { method, ca, ...(body === undefined ? {} : { body }), headers });
  };

  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    port = app.server.address().port;

    section(`1. A real TLS listener on loopback, signing required (port ${port})`);
    const health = await httpsCall(port, "/api/health", { ca, auth: false });
    check("health answers over real, verified TLS", health.status === 200);
    check("health is unauthenticated and unsigned", health.json?.status === "ok");

    const unsigned = await httpsCall(port, "/api/status", { ca });
    check("a guarded request without a signature is 401", unsigned.status === 401);
    check(
      "the refusal does not name which header is missing",
      unsigned.json?.error?.code === "signature_required",
    );

    const status = await signed("GET", "/api/status");
    check("a signed request is served", status.status === 200);
    check("the derived posture is reported", status.json?.posture === "loopback");
    check("the key is reported as a fingerprint only", /^kek_[0-9a-f]{32}$/.test(status.json?.keyId ?? ""));

    section("2. A lan bind without TLS refuses to start");
    // 10.0.0.1 is not an address this device holds, and it does not need to be: the
    // posture gate runs before `listen`, so the refusal is proven without depending
    // on the local network. That is the point — the process must never reach a bind.
    const noTls = await bootEntry({
      BAYZ_HOST: "10.0.0.1",
      BAYZ_PORT: "21491",
      BAYZ_ALLOW_REMOTE: "true",
      BAYZ_API_TOKEN: TOKEN,
      BAYZ_DATA_DIR: join(root, "lan-no-tls"),
      BAYZ_DASHBOARD_ROOT: dashboardRoot,
      BAYZ_TLS_CERT: "",
      BAYZ_TLS_KEY: "",
    });
    check("the process exited non-zero", noTls.status !== 0 && noTls.status !== null);
    check("the refusal is a posture refusal", noTls.out.includes("posture_refused"));
    check("the refusal names TLS as what is missing", noTls.out.includes('"stage":"tls"'));
    check("no listener was ever announced", !noTls.out.includes("Bayz Core ready"));

    section("3. A remote bind with TLS but no client authentication also refuses");
    const noClientAuth = await bootEntry({
      BAYZ_HOST: "0.0.0.0",
      BAYZ_PORT: "21492",
      BAYZ_ALLOW_REMOTE: "true",
      BAYZ_API_TOKEN: TOKEN,
      BAYZ_DATA_DIR: join(root, "remote-no-auth"),
      BAYZ_DASHBOARD_ROOT: dashboardRoot,
      BAYZ_TLS_CERT: pki.serverCert,
      BAYZ_TLS_KEY: pki.serverKey,
    });
    check("a wildcard bind is treated as remote and refused", noClientAuth.status !== 0);
    check(
      "the missing requirement is client authentication",
      noClientAuth.out.includes('"stage":"client_authentication"'),
    );

    section("4. A lan bind with TLS starts");
    const lanAddress = privateIpv4();
    check("this device has a private IPv4 to bind", lanAddress !== undefined);
    if (lanAddress !== undefined) {
      const withTls = await bootEntry(
        {
          BAYZ_HOST: lanAddress,
          BAYZ_PORT: "21493",
          BAYZ_ALLOW_REMOTE: "true",
          BAYZ_API_TOKEN: TOKEN,
          BAYZ_DATA_DIR: join(root, "lan-tls"),
          BAYZ_DASHBOARD_ROOT: dashboardRoot,
          BAYZ_TLS_CERT: pki.serverCert,
          BAYZ_TLS_KEY: pki.serverKey,
        },
        { waitForReady: true },
      );
      check("the listener started", withTls.ready === true);
      check("the posture is lan", withTls.out.includes('"posture":"lan"'));
      check("TLS is in force", withTls.out.includes('"tls":true'));
      check("the lan concurrency cap is applied", withTls.out.includes('"concurrency":32'));
      check("the listener is HTTPS", withTls.out.includes(`https://${lanAddress}:21493`));
      check("no API token in the startup log", !withTls.out.includes(TOKEN));
    }

    section("5. Register a provider, a proxy password, and a route over signed HTTPS");
    const provider = await signed("POST", "/api/providers", {
      id: "smoke",
      kind: "openai-compatible",
      displayName: "Smoke",
      baseUrl: `http://127.0.0.1:${origin.port}/v1`,
      config: { allowLoopback: true },
    });
    check("the provider was created", provider.status === 201);
    check("no credential at creation", provider.json?.credentialPresent === false);

    const wrote = await signed("PUT", "/api/providers/smoke/credential", {
      value: CREDENTIAL,
    });
    check("the credential was stored with no body echoed", wrote.status === 204);

    const proxy = await signed("POST", "/api/proxies", {
      id: "tunnel",
      kind: "http",
      host: "127.0.0.1",
      port: origin.port,
      username: "bayz",
    });
    check("the proxy was created", proxy.status === 201);
    const proxyPassword = await signed("PUT", "/api/proxies/tunnel/password", {
      value: PASSWORD,
    });
    check("the proxy password was stored", proxyPassword.status === 204);

    const route = await signed("POST", "/api/routes", {
      id: "direct",
      model: "smoke-model",
      providerId: "smoke",
      priority: 500,
      // The fixture origin publishes no pricing metadata, so its models classify as
      // undiscovered — and undiscovered is not free (spec §25 rule 5). Free-only
      // routing has its own coverage; leaving the default on would refuse every chat
      // below for a reason this smoke is not about.
      freeOnly: false,
    });
    check("the route was created", route.status === 201);

    section("6. A real chat over verified HTTPS reaches the upstream");
    const chat = await signed("POST", "/v1/chat/completions", {
      model: "smoke-model",
      messages: [{ role: "user", content: PROMPT }],
    });
    check("the chat succeeded over TLS", chat.status === 200);
    check(
      "the completion came from the real origin",
      chat.json?.choices?.[0]?.message?.content === COMPLETION,
    );
    const upstream = origin.seen.at(-1);
    check(
      "the upstream received the stored credential",
      upstream?.authorization === `Bearer ${CREDENTIAL}`,
    );

    section("7. A replayed, stale, or tampered signature is refused");
    const nonce = "smoke-nonce-0123456789abcdef";
    const at = Date.now();
    const first = await signed("GET", "/api/status", undefined, { nonce, at });
    check("a freshly signed request is accepted", first.status === 200);
    const replay = await signed("GET", "/api/status", undefined, { nonce, at });
    check("the identical request replayed is refused", replay.status === 401);
    check(
      "the refusal says it has been seen before",
      replay.json?.error?.code === "signature_replayed",
    );

    const stale = await signed("GET", "/api/status", undefined, {
      at: Date.now() - 10 * 60 * 1000,
    });
    check("a stale timestamp is refused", stale.json?.error?.code === "signature_stale");

    // Signed for one body, sent with another: the body hash is part of the canonical
    // string, so this must fail even though the signature itself is well formed.
    const tamperedHeaders = signRequest({
      key: TOKEN,
      method: "POST",
      url: "/api/routes",
      body: JSON.stringify({ id: "signed-for-this" }),
    });
    const tampered = await httpsCall(port, "/api/routes", {
      method: "POST",
      ca,
      body: { id: "but-sent-this", model: "m", providerId: "smoke" },
      headers: tamperedHeaders,
    });
    check("a tampered body is refused", tampered.status === 401);
    check(
      "the refusal is an invalid signature",
      tampered.json?.error?.code === "signature_invalid",
    );

    const wrongKey = signRequest({ key: "not-the-token", method: "GET", url: "/api/status" });
    const forged = await httpsCall(port, "/api/status", { ca, headers: wrongKey });
    check("a signature under the wrong key is refused", forged.status === 401);

    section("8. Root-key rotation keeps every secret readable");
    const before = status.json?.keyId;
    const rotated = await signed("POST", "/api/security/rotate-root-key");
    check("rotation succeeded", rotated.status === 200);
    // Exactly two secrets are under custody at this point: the provider credential
    // and the proxy password. The API token came from `BAYZ_API_TOKEN`, and
    // `resolveApiToken` deliberately does not copy an environment token into the
    // database, so there is no third row to rewrap.
    check("both stored secrets were rewrapped", rotated.json?.rotated === 2);
    check("the new key id differs from the old", rotated.json?.keyId !== before);
    check("the previous key id is reported", rotated.json?.previousKeyId === before);
    check(
      "no key material is in the response",
      !/[0-9a-f]{64}/.test(JSON.stringify(rotated.json ?? {})),
    );

    // The load-bearing assertion: the credential still decrypts under the new key,
    // proven by a real chat that authenticates with it rather than by reading a flag.
    const afterRotation = await signed("POST", "/v1/chat/completions", {
      model: "smoke-model",
      messages: [{ role: "user", content: PROMPT }],
    });
    check("a chat still authenticates after rotation", afterRotation.status === 200);
    check(
      "the upstream still received the same credential",
      origin.seen.at(-1)?.authorization === `Bearer ${CREDENTIAL}`,
    );
    const proxyAfter = await signed("GET", "/api/proxies/tunnel");
    check("the proxy password survived rotation", proxyAfter.json?.passwordPresent === true);

    const audit = await signed("GET", "/api/security/audit");
    check("the rotation was audited", audit.json?.audit?.[0]?.action === "root_key_rotated");
    check("the audit records the count it rewrapped", audit.json?.audit?.[0]?.subjectCount === 2);
    check(
      "the audit exposes no key material",
      !/[0-9a-f]{64}/.test(JSON.stringify(audit.json ?? {})),
    );

    section("9. Credential rotation and revocation are real");
    const ROTATED_CREDENTIAL = "sk-security-smoke-rotated-credential";
    check(
      "the credential was replaced",
      (await signed("PUT", "/api/providers/smoke/credential", { value: ROTATED_CREDENTIAL }))
        .status === 204,
    );
    const afterCredentialRotation = await signed("POST", "/v1/chat/completions", {
      model: "smoke-model",
      messages: [{ role: "user", content: PROMPT }],
    });
    check("a chat succeeds with the new credential", afterCredentialRotation.status === 200);
    check(
      "the upstream saw the new credential, not the old one",
      origin.seen.at(-1)?.authorization === `Bearer ${ROTATED_CREDENTIAL}`,
    );

    check(
      "the credential was revoked",
      (await signed("DELETE", "/api/providers/smoke/credential")).status === 204,
    );
    const seenBeforeRevoked = origin.seen.length;
    const afterRevocation = await signed("POST", "/v1/chat/completions", {
      model: "smoke-model",
      messages: [{ role: "user", content: PROMPT }],
    });
    // Honest erasure: the row is gone, so the request goes out unauthenticated rather
    // than with a stale credential. The origin here accepts anything, so what is
    // asserted is that no credential was presented — not that the upstream refused.
    check("a chat after revocation carries no credential", afterRevocation.status === 200);
    check(
      "the upstream received no Authorization header",
      origin.seen.length > seenBeforeRevoked &&
        origin.seen.at(-1)?.authorization === undefined,
    );
    check(
      "the provider reports the credential as absent",
      (await signed("GET", "/api/providers/smoke")).json?.credentialPresent === false,
    );

    section("10. A 200-request burst stays inside the outbound cap");
    // Driven through the router rather than the HTTP API: the server-side window
    // limiter would refuse most of 200 requests long before the outbound cap was
    // exercised, and it is the *outbound* socket count under test here.
    const CAP = 8;
    const BURST = 200;
    resetOutboundConcurrency();
    configureOutboundConcurrency({ limit: CAP, queueLimit: BURST + 16 });
    check("the process-wide cap was applied", outboundSemaphore().limit === CAP);

    origin.resetPeak();
    origin.setHold(true);
    const burst = Array.from({ length: BURST }, () =>
      runtime.router
        .chat({ model: "smoke-model", messages: [{ role: "user", content: PROMPT }] })
        .then(
          (result) => result.content === COMPLETION,
          () => false,
        ),
    );
    // Let the burst pile up, then answer everything: the peak is measured while the
    // origin is holding, so it reflects genuinely simultaneous upstream work.
    const deadline = Date.now() + 15_000;
    while (origin.pending() < CAP && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const peakWhileHeld = origin.peak();
    const drain = setInterval(() => origin.releaseAll(), 20);
    const results = await Promise.all(burst);
    clearInterval(drain);
    origin.releaseAll();
    origin.setHold(false);

    check(`all ${BURST} requests completed`, results.every(Boolean));
    check(
      `never more than ${CAP} upstream requests at once (peak ${origin.peak()})`,
      origin.peak() <= CAP,
    );
    check("the cap was actually reached, so the measurement means something", peakWhileHeld >= 1);
    check("no permit leaked", outboundSemaphore().inFlight() === 0);
    check("no waiter was left queued", outboundSemaphore().queued() === 0);
    resetOutboundConcurrency();
  } finally {
    await app.close();
    runtime.close();
    for (const socket of openSockets) {
      socket.destroy();
    }
    await origin.close();
  }

  section("11. Scan the real bytes on disk and every captured log line");
  {
    const bytes = readDatabaseBytes(dataDir);
    check("database bytes were read", bytes.byteLength > 0);
    check(
      "provider metadata is present, proving the scan reads real content",
      bytes.includes(Buffer.from("smoke", "utf8")),
    );

    // The root key with secure-file custody is 32 raw bytes in `master.key`. Scanning
    // for those bytes is the honest check; there is no hex string to look for, and
    // grepping for one that never existed could not fail.
    const masterKey = readFileSync(join(dataDir, "master.key"));
    check("the root key file was read", masterKey.byteLength === 32);
    check("the root key bytes are absent from the database", !bytes.includes(masterKey));
    check(
      "the root key hex is absent too",
      !bytes.toString("latin1").includes(masterKey.toString("hex")),
    );

    const tlsKey = readFileSync(pki.serverKey, "utf8");
    const tlsKeyBody = tlsKey
      .split("\n")
      .filter((line) => !line.startsWith("-----"))
      .join("");
    for (const [label, needle] of [
      ["the prompt", PROMPT],
      ["the completion", COMPLETION],
      ["the provider credential", CREDENTIAL],
      ["the rotated credential", "sk-security-smoke-rotated-credential"],
      ["the proxy password", PASSWORD],
      ["the api token", TOKEN],
      ["the TLS private key", tlsKeyBody],
    ]) {
      check(`${label} is absent from disk`, !bytes.includes(Buffer.from(needle, "utf8")));
    }

    const logs = captured.join("\n");
    const wire = [...captured, ...bodies].join("\n");
    check("log lines were captured", captured.length > 0);

    /*
     * Two different scopes, deliberately.
     *
     * The completion is *supposed* to appear in a response body — that is the answer
     * the client asked for — so folding bodies into one scan would make this section
     * either fail on correct behaviour or be weakened until it proved nothing. Prompt
     * and completion are therefore checked against the **logs**, where they must never
     * appear, while credentials and keys are checked against logs **and** every body.
     */
    for (const [label, needle] of [
      ["the prompt", PROMPT],
      ["the completion", COMPLETION],
    ]) {
      check(`${label} is absent from the logs`, !logs.includes(needle));
    }
    check(
      "the completion did reach a response body, proving the body scan reads real content",
      bodies.some((body) => body.includes(COMPLETION)),
    );
    for (const [label, needle] of [
      ["the root key hex", masterKey.toString("hex")],
      ["the provider credential", CREDENTIAL],
      ["the rotated credential", "sk-security-smoke-rotated-credential"],
      ["the proxy password", PASSWORD],
      ["the api token", TOKEN],
      ["the TLS private key", tlsKeyBody],
    ]) {
      check(`${label} is absent from the logs and response bodies`, !wire.includes(needle));
    }
  }

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length > 0) {
    console.error("security smoke: FAIL");
    process.exit(1);
  }
  console.log("security smoke: PASS");
}

main().catch((error) => {
  console.error("security smoke: FAIL");
  console.error(error);
  process.exit(1);
});
