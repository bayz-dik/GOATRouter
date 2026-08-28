import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { TLS_MAX_VERSION, TLS_MIN_VERSION, TlsError, loadTlsConfig } from "../src/tls.js";

/* ------------------------------------------------------------------ *
 * A real PKI, generated once
 *
 * Certificates are produced with `openssl` rather than hand-rolled, and the HTTPS
 * assertions drive a real listener over a real socket. A mocked TLS layer would prove
 * only that the mock was called.
 * ------------------------------------------------------------------ */

type Pki = {
  dir: string;
  caCert: string;
  serverCert: string;
  serverKey: string;
  clientCert: string;
  clientKey: string;
  /** A client pair signed by nobody the server trusts. */
  rogueCert: string;
  rogueKey: string;
};

function openssl(args: readonly string[], cwd: string): void {
  execFileSync("openssl", args, { cwd, stdio: "pipe" });
}

let pki: Pki | undefined;

/**
 * EC keys, not RSA: an ARM64 device generates six RSA-2048 keys slowly enough to
 * dominate the suite, and P-256 exercises the same code path.
 */
function ensurePki(): Pki {
  if (pki !== undefined) {
    return pki;
  }
  const dir = mkdtempSync(join(tmpdir(), "bayz-tls-"));
  const subject = (cn: string): string => `/CN=${cn}`;

  // A CA that signs both the server and the legitimate client.
  openssl(
    [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2",
      "-subj", subject("bayz-test-ca"),
    ],
    dir,
  );

  const leaf = (name: string, cn: string, san: string | undefined): void => {
    openssl(
      [
        "req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
        "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`,
        "-subj", subject(cn),
      ],
      dir,
    );
    const args = [
      "x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key",
      "-CAcreateserial", "-out", `${name}.crt`, "-days", "2",
    ];
    if (san !== undefined) {
      writeFileSync(join(dir, `${name}.ext`), `subjectAltName=${san}\n`);
      args.push("-extfile", `${name}.ext`);
    }
    openssl(args, dir);
  };

  leaf("server", "localhost", "IP:127.0.0.1,DNS:localhost");
  leaf("client", "bayz-client", undefined);

  // Self-signed, so the server's CA cannot vouch for it.
  openssl(
    [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-nodes", "-keyout", "rogue.key", "-out", "rogue.crt", "-days", "2",
      "-subj", subject("rogue"),
    ],
    dir,
  );

  pki = {
    dir,
    caCert: join(dir, "ca.crt"),
    serverCert: join(dir, "server.crt"),
    serverKey: join(dir, "server.key"),
    clientCert: join(dir, "client.crt"),
    clientKey: join(dir, "client.key"),
    rogueCert: join(dir, "rogue.crt"),
    rogueKey: join(dir, "rogue.key"),
  };
  return pki;
}

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

test("no TLS variables means no TLS, exactly as before", () => {
  assert.equal(loadTlsConfig({}), undefined);
});

test("TLS is loaded from the certificate and key paths", () => {
  const p = ensurePki();
  const config = loadTlsConfig({
    BAYZ_TLS_CERT: p.serverCert,
    BAYZ_TLS_KEY: p.serverKey,
  });
  assert.ok(config !== undefined);
  // The file *contents* are held, not the paths: a path kept on a live object is a
  // path that can end up in a log line or an error response.
  assert.ok(config.cert.includes("BEGIN CERTIFICATE"));
  assert.ok(config.key.includes("PRIVATE KEY"));
  assert.equal(config.requestCert, false);
  assert.equal(config.mutual, false);
});

test("a certificate without a key, or a key without a certificate, is refused", () => {
  const p = ensurePki();
  for (const env of [
    { BAYZ_TLS_CERT: p.serverCert },
    { BAYZ_TLS_KEY: p.serverKey },
  ]) {
    assert.throws(
      () => loadTlsConfig(env),
      (error: unknown) => error instanceof TlsError && error.requirement === "incomplete",
      "half a TLS configuration must never start",
    );
  }
});

test("an unreadable file is a startup failure whose message omits the path", () => {
  const p = ensurePki();
  const secret = join(p.dir, "this-path-is-secret-layout.pem");

  assert.throws(
    () => loadTlsConfig({ BAYZ_TLS_CERT: secret, BAYZ_TLS_KEY: p.serverKey }),
    (error: unknown) => {
      assert.ok(error instanceof TlsError);
      assert.equal(error.requirement, "unreadable");
      // The message reaches a startup log and possibly an operator's terminal
      // recording. Naming the path discloses where key material lives.
      assert.equal(
        error.message.includes(secret),
        false,
        "the error message must not disclose the path",
      );
      assert.equal(error.message.includes("this-path-is-secret-layout"), false);
      assert.match(error.message, /BAYZ_TLS_CERT/);
      return true;
    },
  );
});

test("an empty PEM file is refused rather than handed to the TLS stack", () => {
  const p = ensurePki();
  const empty = join(p.dir, "empty.pem");
  writeFileSync(empty, "   \n");
  // A zero-byte cert is a real failure mode: a half-finished copy, or a file an
  // operator created before pasting into it. Passing it through would produce an
  // obscure OpenSSL error at listen time instead of a named startup refusal.
  assert.throws(
    () => loadTlsConfig({ BAYZ_TLS_CERT: empty, BAYZ_TLS_KEY: p.serverKey }),
    (error: unknown) => error instanceof TlsError && error.requirement === "unreadable",
  );
});

test("TLS 1.2 is the floor and 1.3 the ceiling", () => {
  const p = ensurePki();
  const config = loadTlsConfig({
    BAYZ_TLS_CERT: p.serverCert,
    BAYZ_TLS_KEY: p.serverKey,
  })!;
  // Pinned as constants so a later edit that drops the floor to 1.0 fails here
  // rather than quietly re-enabling a deprecated protocol.
  assert.equal(TLS_MIN_VERSION, "TLSv1.2");
  assert.equal(TLS_MAX_VERSION, "TLSv1.3");
  assert.equal(config.minVersion, "TLSv1.2");
  assert.equal(config.maxVersion, "TLSv1.3");
});

test("a client CA turns on mutual TLS", () => {
  const p = ensurePki();
  const config = loadTlsConfig({
    BAYZ_TLS_CERT: p.serverCert,
    BAYZ_TLS_KEY: p.serverKey,
    BAYZ_TLS_CLIENT_CA: p.caCert,
  })!;
  assert.equal(config.requestCert, true);
  assert.equal(config.rejectUnauthorized, true);
  assert.equal(config.mutual, true);
  assert.ok(config.ca !== undefined);
});

test("a client CA without server TLS is refused rather than ignored", () => {
  const p = ensurePki();
  // Silently ignoring it would leave an operator believing mTLS was in force.
  assert.throws(
    () => loadTlsConfig({ BAYZ_TLS_CLIENT_CA: p.caCert }),
    (error: unknown) => error instanceof TlsError && error.requirement === "incomplete",
  );
});

/* ------------------------------------------------------------------ *
 * A real HTTPS listener
 * ------------------------------------------------------------------ */

const TOKEN = "tls-token-0123456789abcdef";

type Reply = { status: number; body: string };

/** Any version string, including one below the floor, so the refusal is testable. */
type TlsVersion = "TLSv1" | "TLSv1.1" | "TLSv1.2" | "TLSv1.3";

function get(
  port: number,
  path: string,
  options: {
    ca?: string;
    cert?: string;
    key?: string;
    minVersion?: TlsVersion;
    maxVersion?: TlsVersion;
  },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { authorization: `Bearer ${TOKEN}`, host: "127.0.0.1" },
        ...(options.ca === undefined ? {} : { ca: readFileSync(options.ca) }),
        ...(options.cert === undefined ? {} : { cert: readFileSync(options.cert) }),
        ...(options.key === undefined ? {} : { key: readFileSync(options.key) }),
        ...(options.minVersion === undefined
          ? {}
          : { minVersion: options.minVersion as "TLSv1.2" }),
        ...(options.maxVersion === undefined
          ? {}
          : { maxVersion: options.maxVersion as "TLSv1.2" }),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("a real HTTPS request over the generated pair succeeds end to end", async (t) => {
  const p = ensurePki();
  const https = loadTlsConfig({
    BAYZ_TLS_CERT: p.serverCert,
    BAYZ_TLS_KEY: p.serverKey,
  })!;

  const app = buildApp({
    logger: false,
    apiToken: TOKEN,
    registerTestRoutes: true,
    rateLimit: { max: 100000, authMax: 100000 },
    https,
  });
  t.after(async () => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;

  const response = await get(port, "/__test/guarded", { ca: p.caCert });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).ok, true);
});

test("a TLS 1.2 client negotiates, and 1.1 is outside the window", async (t) => {
  const p = ensurePki();
  const https = loadTlsConfig({
    BAYZ_TLS_CERT: p.serverCert,
    BAYZ_TLS_KEY: p.serverKey,
  })!;

  const app = buildApp({
    logger: false,
    apiToken: TOKEN,
    registerTestRoutes: true,
    rateLimit: { max: 100000, authMax: 100000 },
    https,
  });
  t.after(async () => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;

  // 1.2 is the floor, so a client pinned to exactly 1.2 must work. Asserting this
  // stops the floor from being raised to 1.3 by accident, which would silently cut
  // off older clients.
  const twelve = await get(port, "/__test/guarded", {
    ca: p.caCert,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
  });
  assert.equal(twelve.status, 200);

  // A client pinned below the floor must never establish a session. Node's own
  // security level refuses to *offer* 1.1 by default, so the rejection may be raised
  // locally rather than by the peer — the outcome that matters is identical, and
  // asserting "no 1.1 session" rather than "a specific error" is what keeps this
  // honest about where the refusal comes from.
  await assert.rejects(
    () =>
      get(port, "/__test/guarded", {
        ca: p.caCert,
        minVersion: "TLSv1.1",
        maxVersion: "TLSv1.1",
      }),
    (error: unknown) => error instanceof Error,
    "a TLS 1.1-only client must not reach a route",
  );
});

test("mutual TLS accepts a client the CA signed and refuses one it did not", async (t) => {
  const p = ensurePki();
  const https = loadTlsConfig({
    BAYZ_TLS_CERT: p.serverCert,
    BAYZ_TLS_KEY: p.serverKey,
    BAYZ_TLS_CLIENT_CA: p.caCert,
  })!;

  const app = buildApp({
    logger: false,
    apiToken: TOKEN,
    registerTestRoutes: true,
    rateLimit: { max: 100000, authMax: 100000 },
    https,
  });
  t.after(async () => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;

  const allowed = await get(port, "/__test/guarded", {
    ca: p.caCert,
    cert: p.clientCert,
    key: p.clientKey,
  });
  assert.equal(allowed.status, 200);

  // A self-signed client certificate: a valid bearer token in the request would not
  // help, because the handshake never completes.
  await assert.rejects(
    () =>
      get(port, "/__test/guarded", {
        ca: p.caCert,
        cert: p.rogueCert,
        key: p.rogueKey,
      }),
    (error: unknown) => error instanceof Error,
    "an unsigned client certificate must not complete the handshake",
  );

  // No certificate at all is refused too, which is what makes mTLS a requirement
  // rather than an option the client chooses.
  await assert.rejects(
    () => get(port, "/__test/guarded", { ca: p.caCert }),
    (error: unknown) => error instanceof Error,
    "a missing client certificate must not complete the handshake",
  );
});

test("the health probe over HTTPS still carries the Phase 1 contract", async (t) => {
  const p = ensurePki();
  const https = loadTlsConfig({
    BAYZ_TLS_CERT: p.serverCert,
    BAYZ_TLS_KEY: p.serverKey,
  })!;

  const app = buildApp({ logger: false, apiToken: TOKEN, https });
  t.after(async () => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;

  const response = await get(port, "/api/health", { ca: p.caCert });
  assert.equal(response.status, 200);
  assert.deepEqual(
    Object.keys(JSON.parse(response.body)).sort(),
    ["status", "uptimeSeconds", "version"],
    "enabling TLS must not change the health contract",
  );
});

test("no private key material appears in a TLS error", () => {
  const p = ensurePki();
  const keyBytes = readFileSync(p.serverKey, "utf8");
  const body = keyBytes.split("\n").filter((line) => line.length > 40)[0]!;

  try {
    loadTlsConfig({ BAYZ_TLS_CERT: join(p.dir, "absent.pem"), BAYZ_TLS_KEY: p.serverKey });
    assert.fail("expected a TlsError");
  } catch (error) {
    assert.ok(error instanceof TlsError);
    assert.equal(
      (error.message + String(error.stack)).includes(body),
      false,
      "key material must never reach an error path",
    );
  }
});
