#!/usr/bin/env node
/**
 * Install, first boot, restart, and uninstall — Phase 9J Task 5.
 *
 * **Everything here runs against the packed artifact, never the workspace.** That distinction is the
 * whole task: the workspace has ten `@bayz/*` symlinks and a `node_modules` tree a user will never
 * have, so a test that imports `apps/server/src` proves nothing about what an operator installs. The
 * measured pre-9J artifact would have failed to install at all.
 *
 * Numbered checks, so the platform matrix can cite `smoke:install#N`. Exits non-zero on any failure.
 *
 * Run: `node scripts/install-smoke.mjs`
 *
 * Environment:
 *   BAYZ_INSTALL_SMOKE_CACHE   reuse an npm cache directory across runs (still never the
 *                              developer's `~/.npm`). Omit for a throwaway cache.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const remoteLoad = await import(join(dirname(fileURLToPath(import.meta.url)), "remote-load.mjs"));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/*
 * Relaunch under `tsx`, exactly as every other smoke in this repository does.
 *
 * The smoke needs one thing from the workspace: the real `TARGET_SCHEMA_VERSION`, so the schema head
 * the *artifact* creates is compared against the head the *source* declares rather than against a
 * number copied into this file that would go stale on the next migration. That constant lives in a
 * `.ts` module, so the loader is required — the first version of this script imported it without the
 * loader and died with `ERR_MODULE_NOT_FOUND` on `errors.js` after check 19.
 *
 * The loader is used for that one import only. Everything under test is the installed artifact's
 * own compiled bundle, launched as a separate process through the npm bin link.
 */
if (!process.env.BAYZ_INSTALL_SMOKE_LOADER) {
  const relaunch = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, BAYZ_INSTALL_SMOKE_LOADER: "1" } },
  );
  process.exit(relaunch.status ?? 1);
}

const failures = [];
let checkNumber = 0;

function check(label, condition, detail) {
  checkNumber += 1;
  if (condition) {
    console.log(`  ok   ${String(checkNumber).padStart(2)}. ${label}`);
  } else {
    console.error(`  FAIL ${String(checkNumber).padStart(2)}. ${label}${detail === undefined ? "" : ` — ${detail}`}`);
    failures.push(`#${checkNumber} ${label}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/* --------------------------------------------------------------- fixtures */

/**
 * A real loopback origin, so the chat check exercises the real provider path.
 *
 * A mocked upstream would leave the artifact's bundled `@bayz/router` untested against a socket,
 * which is exactly the layer bundling could have broken. It answers a `stream: true` request with
 * real SSE, so the streaming column is filled by the transport rather than by a refusal path.
 */
async function startOrigin() {
  const seen = [];
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ url: request.url, authorization: request.headers.authorization, body });

      let wantsStream = false;
      try {
        wantsStream = JSON.parse(body).stream === true;
      } catch {
        wantsStream = false;
      }

      if (request.url?.includes("/chat/completions") && wantsStream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({ model: "install-model", choices: [{ delta: { content: "INSTALL-STREAM-OK" } }] })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
          })}\n\n`,
        );
        response.write("data: [DONE]\n\n");
        response.end();
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      if (request.url?.includes("/chat/completions")) {
        response.end(
          JSON.stringify({
            id: "chatcmpl-install-smoke",
            model: "install-model",
            choices: [
              { index: 0, message: { role: "assistant", content: "INSTALL-SMOKE-OK" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          }),
        );
        return;
      }
      response.end(JSON.stringify({ data: [{ id: "install-model" }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, seen };
}

/**
 * A real HTTP `CONNECT` proxy requiring Basic auth, tunnelling to the origin.
 *
 * The proxy column of the platform matrix is about the most platform-sensitive network path BAYZ has,
 * so it is proven with a real tunnel that records what it saw — not by asserting a route row exists.
 * `connects` is what makes the assertion meaningful: the request must actually have gone through here.
 */
async function startConnectProxy({ password }) {
  const connects = [];
  const expected = Buffer.from(`bayz:${password}`, "utf8").toString("base64");
  const server = createNetServer((client) => {
    client.on("error", () => {});
    let head = Buffer.alloc(0);

    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      client.off("data", onData);

      const request = head.subarray(0, end).toString("utf8");
      const rest = head.subarray(end + 4);
      const target = /^CONNECT (\S+)/.exec(request)?.[1] ?? "";
      const auth = /proxy-authorization: Basic (\S+)/i.exec(request)?.[1];

      if (auth !== expected) {
        connects.push({ target, authorized: false });
        client.end("HTTP/1.1 407 Proxy Authentication Required\r\nproxy-authenticate: Basic\r\n\r\n");
        return;
      }

      const [host, port] = target.split(":");
      connects.push({ target, authorized: true, port: Number(port) });

      const upstream = netConnect({ host, port: Number(port) }, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length > 0) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on("error", () => client.destroy());
    };

    client.on("data", onData);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, connects };
}

/**
 * A registry that answers **404 for everything**, bound to `@bayz` only.
 *
 * This is how the "no access to any `@bayz/*` package" requirement is proven rather than asserted. If
 * a regression reintroduced a `@bayz/storage` dependency into the artifact, npm would ask this server
 * and the install would fail loudly here instead of in a user's terminal. The counters also let the
 * smoke assert npm never even *asked* — a stronger statement than "the install happened to succeed".
 */
async function startRefusingRegistry() {
  const requests = [];
  const server = createHttpServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, requests };
}

/* ----------------------------------------------------------------- daemon */

/**
 * Start the **installed binary** and wait for it to answer.
 *
 * The bin symlink is executed directly rather than through `node <path>`, so the shebang and the
 * executable bit npm created are both exercised. Readiness is a real HTTP probe, not a sleep.
 */
async function startInstalled({ bin, env, port, timeoutMs = 30_000 }) {
  const child = spawn(bin, [], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  let exited = false;
  let exitCode;
  child.on("exit", (code) => {
    exited = true;
    exitCode = code;
  });

  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline && !exited) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.status === 200) {
        ready = true;
        break;
      }
    } catch {
      // Not listening yet.
    }
    await sleep(250);
  }

  return {
    child,
    ready,
    get exited() {
      return exited;
    },
    get exitCode() {
      return exitCode;
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    async stop() {
      if (exited) return;
      child.kill("SIGTERM");
      const stopBy = Date.now() + 15_000;
      while (Date.now() < stopBy && !exited) await sleep(150);
      if (!exited) child.kill("SIGKILL");
      while (!exited) await sleep(50);
    },
  };
}

/** Run the installed binary to completion, for the refusal checks. */
function runInstalledToExit({ bin, env, timeoutMs = 30_000 }) {
  const result = spawnSync(bin, [], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function api(base, path, { token, method = "GET", body } = {}) {
  const headers = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json, headers: response.headers };
}

function mode(path) {
  return existsSync(path) ? statSync(path).mode & 0o777 : undefined;
}

/* -------------------------------------------------------------------- run */

async function main() {
  console.log("BAYZ install / first boot / restart / uninstall smoke — Phase 9J Task 5");

  const pack = await import(join(ROOT, "scripts/pack.mjs"));

  const workspace = mkdtempSync(join(tmpdir(), "bayz-install-smoke-"));
  const outDir = join(workspace, "artifact");
  const prefix = join(workspace, "prefix");
  const cache = process.env.BAYZ_INSTALL_SMOKE_CACHE ?? join(workspace, "cache");
  const dataDir = join(workspace, "data");
  mkdirSync(prefix, { recursive: true });
  mkdirSync(cache, { recursive: true });

  const origin = await startOrigin();
  const registry = await startRefusingRegistry();
  const proxyPassword = "install-smoke-proxy-password";
  const proxy = await startConnectProxy({ password: proxyPassword });

  const token = "install-smoke-token-0123456789abcd";
  let daemon;

  try {
    section("1. Build the artifact");
    const built = pack.buildArtifact({ root: ROOT, outDir });
    check("the packaging script produced a tarball", existsSync(built.tarballPath), built.tarballPath);
    const verified = pack.verifyArtifact(built.tarballPath);
    check("the artifact passes its own verification", verified.problems.length === 0, verified.problems.join("; "));

    section("2. Install into a clean prefix with no @bayz registry access");
    /*
     * `--@bayz:registry` points at the 404 server. `--prefix` and `--cache` keep the developer's
     * global environment and real npm cache untouched, which the plan requires: a smoke that wrote to
     * `~/.npm` or a global prefix would be a side effect nobody asked for.
     */
    const install = spawnSync(
      "npm",
      [
        "install",
        built.tarballPath,
        "--prefix",
        prefix,
        "--cache",
        cache,
        /*
         * **Written as one `--flag=value` argv entry deliberately.**
         *
         * Passed as two entries (`"--@bayz:registry", url`) npm does not recognise the pair and
         * treats the URL as a *second install target* — it then tries to fetch
         * `http://127.0.0.1:<port>/` as a package and hangs retrying against the 404 server until the
         * smoke times out. The first run of this script hung for nine minutes for exactly that
         * reason, with `ps` showing `npm install <tarball> http://127.0.0.1:40793/`.
         */
        `--@bayz:registry=http://127.0.0.1:${registry.port}/`,
        "--omit=dev",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: workspace, encoding: "utf8", timeout: 600_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    check("npm install of the artifact exits 0", install.status === 0, (install.stderr ?? "").slice(-400));

    const installedRoot = join(prefix, "node_modules", pack.ARTIFACT_NAME);
    check("the package is installed under the prefix", existsSync(installedRoot), installedRoot);

    const bin = join(prefix, "node_modules", ".bin", "bayz");
    check("the bin link exists and is executable", existsSync(bin) && (statSync(bin).mode & 0o111) !== 0, bin);

    /*
     * **The load-bearing assertion of this section.** The install resolved with no `@bayz/*` fetched,
     * proven by the refusing registry never being asked. A regression back to workspace-linked
     * dependencies fails here rather than in a user's terminal.
     */
    check(
      "npm never requested a @bayz/* package from any registry",
      registry.requests.length === 0,
      `asked for: ${registry.requests.join(", ")}`,
    );
    check(
      "no @bayz/* package is present in the installed tree",
      !existsSync(join(prefix, "node_modules", "@bayz")),
      "an @bayz scope directory was installed",
    );

    const installedManifest = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
    check(
      "the installed manifest declares only what the bundle imports",
      JSON.stringify(Object.keys(installedManifest.dependencies).sort()) === JSON.stringify(verified.imported),
      `${Object.keys(installedManifest.dependencies).join(",")} vs ${verified.imported.join(",")}`,
    );
    check(
      "no workspace source or test file was installed",
      !existsSync(join(installedRoot, "src")) && !existsSync(join(installedRoot, "test")),
      "the installed package carries source or tests",
    );

    const versionRun = spawnSync(bin, ["--version"], {
      encoding: "utf8",
      env: { ...process.env, BAYZ_DATA_DIR: join(workspace, "never-created") },
      timeout: 60_000,
    });
    check("the installed bin prints its version", versionRun.stdout.trim() === installedManifest.version, versionRun.stdout);
    check(
      "--version created no data directory",
      !existsSync(join(workspace, "never-created")),
      "printing a version created a data directory",
    );

    section("3. First boot creates the data directory and the database");
    const port = 21801;
    daemon = await startInstalled({
      bin,
      port,
      env: {
        BAYZ_DATA_DIR: dataDir,
        BAYZ_PORT: String(port),
        BAYZ_HOST: "127.0.0.1",
        BAYZ_API_TOKEN: token,
      },
    });
    check("the installed daemon became ready", daemon.ready, `${daemon.stderr.slice(-400)}`);
    const base = `http://127.0.0.1:${port}`;

    check("the data directory was created", existsSync(dataDir), dataDir);
    /*
     * Observed, not intended. On a filesystem that cannot represent POSIX modes this records what it
     * saw rather than failing — the same rule Task 3 established. This device does honour them.
     */
    const dirMode = mode(dataDir);
    const dbMode = mode(join(dataDir, "bayz.db"));
    const keyMode = mode(join(dataDir, "master.key"));
    check(`the data directory is 0700 (observed 0${dirMode?.toString(8)})`, dirMode === 0o700, `mode 0${dirMode?.toString(8)}`);
    check(`bayz.db is 0600 (observed 0${dbMode?.toString(8)})`, dbMode === 0o600, `mode 0${dbMode?.toString(8)}`);
    check(`master.key is 0600 (observed 0${keyMode?.toString(8)})`, keyMode === 0o600, `mode 0${keyMode?.toString(8)}`);

    const health = await api(base, "/api/health");
    check("/api/health answers 200 unauthenticated", health.status === 200 && health.json?.status === "ok", health.text);

    const unauthorized = await api(base, "/api/status");
    check("/api/status is 401 without a token", unauthorized.status === 401, String(unauthorized.status));

    const status = await api(base, "/api/status", { token });
    check("/api/status answers with the token", status.status === 200, status.text);
    /*
     * Schema head is read from the running daemon rather than hardcoded here, then compared against
     * the workspace's own migration head — so a schema bump does not require editing this smoke, and a
     * *mismatch* between what the artifact creates and what the source declares still fails.
     */
    const { TARGET_SCHEMA_VERSION } = await import(join(ROOT, "packages/storage/src/migrations.ts"));
    check(
      `the database was created at schema head v${TARGET_SCHEMA_VERSION}`,
      status.json?.schemaVersion === TARGET_SCHEMA_VERSION,
      `daemon reports v${status.json?.schemaVersion}`,
    );

    section("4. The packaged dashboard is served from packaged files");
    const shell = await api(base, "/");
    check("the dashboard shell is served", shell.status === 200 && shell.text.includes("<div id=\"root\">"), String(shell.status));
    const assetMatch = /src="(\/assets\/[^"]+\.js)"/.exec(shell.text);
    check("the shell references a packaged asset", assetMatch !== null, shell.text.slice(0, 200));
    if (assetMatch !== null) {
      const asset = await api(base, assetMatch[1]);
      check("the packaged bundle is served", asset.status === 200 && asset.text.length > 1000, String(asset.status));
      check(
        "the served bundle loads no remote origin",
        !remoteLoad.hasRemoteLoadReference(asset.text),
        "a remote resource load reference is present in the served bundle",
      );
    } else {
      check("the packaged bundle is served", false, "no asset reference to follow");
      check("the served bundle loads no remote origin", false, "no asset reference to follow");
    }
    check(
      "the shell itself references no remote origin",
      !/https?:\/\/(?!127\.0\.0\.1|localhost)/i.test(shell.text),
      "the shell references a remote origin",
    );

    section("5. A real chat succeeds through the installed artifact");
    const provider = await api(base, "/api/providers", {
      token,
      method: "POST",
      body: {
        id: "install",
        kind: "openai-compatible",
        displayName: "Install Smoke",
        baseUrl: `http://127.0.0.1:${origin.port}/v1`,
        config: { allowLoopback: true },
      },
    });
    check("a provider can be created over the API", provider.status === 201, provider.text);

    const credential = await api(base, "/api/providers/install/credential", {
      token,
      method: "PUT",
      body: { value: "install-smoke-credential-value" },
    });
    check("a credential can be stored", credential.status === 204, String(credential.status));

    /*
     * `freeOnly: false` for the same reason `api-smoke` needs it: this fixture origin publishes no
     * pricing metadata, so its model classifies as undiscovered, and undiscovered is not free
     * (spec §25 rule 5). Free-only routing keeps its own coverage; weakening it is not on the table.
     */
    const route = await api(base, "/api/routes", {
      token,
      method: "POST",
      body: { id: "install-route", model: "install-model", providerId: "install", freeOnly: false },
    });
    check("a route can be created", route.status === 201, route.text);

    const chat = await api(base, "/v1/chat/completions", {
      token,
      method: "POST",
      body: { model: "install-model", messages: [{ role: "user", content: "install smoke" }] },
    });
    check("a real chat returns 200", chat.status === 200, chat.text.slice(0, 200));
    check(
      "the completion came from the real loopback origin",
      chat.json?.choices?.[0]?.message?.content === "INSTALL-SMOKE-OK",
      JSON.stringify(chat.json?.choices?.[0]?.message ?? null),
    );
    check(
      "the origin saw the request with the stored credential",
      origin.seen.some((entry) => entry.url?.includes("/chat/completions") && entry.authorization === "Bearer install-smoke-credential-value"),
      "the upstream did not receive the stored credential",
    );

    const identity = await api(base, "/api/identities", {
      token,
      method: "POST",
      body: { id: "install-client", displayName: "Install Client", scopes: ["chat.completions"] },
    });
    check("a scoped identity can be created", identity.status === 201, identity.text);

    section("6. Streaming works through the installed artifact");
    /*
     * The stream column is a separate matrix cell from chat because streaming fails independently:
     * the SSE path has its own parser, its own cancellation semantics, and its own tool-call
     * reassembly (all four 9H defects were on this path). Driven with a raw `fetch` rather than the
     * JSON helper, because the point is the transport.
     */
    const streamResponse = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "install-model",
        messages: [{ role: "user", content: "stream please" }],
        stream: true,
      }),
    });
    check("a streaming chat returns 200", streamResponse.status === 200, String(streamResponse.status));
    check(
      "the response is an event stream",
      (streamResponse.headers.get("content-type") ?? "").includes("text/event-stream"),
      streamResponse.headers.get("content-type") ?? "(none)",
    );
    const streamBody = await streamResponse.text();
    check("the stream carried the upstream delta", streamBody.includes("INSTALL-STREAM-OK"), streamBody.slice(0, 200));
    check("the stream terminated with [DONE]", streamBody.includes("[DONE]"), streamBody.slice(-120));

    section("7. Egress through a real CONNECT proxy");
    /*
     * A proxy-bound route, proven by the tunnel recording the connection rather than by the row
     * existing. `node:http`/`node:https` is the router's own request path, which is what makes a
     * proxy-bound route actually traverse its proxy — global `fetch` is not proxied.
     */
    const proxyCreated = await api(base, "/api/proxies", {
      token,
      method: "POST",
      body: {
        id: "install-tunnel",
        kind: "http",
        host: "127.0.0.1",
        port: proxy.port,
        username: "bayz",
        config: { connectTimeoutMs: 5000, healthCheckHost: "127.0.0.1", healthCheckPort: origin.port },
      },
    });
    check("a proxy can be created", proxyCreated.status === 201, proxyCreated.text);

    const proxyPasswordWrite = await api(base, "/api/proxies/install-tunnel/password", {
      token,
      method: "PUT",
      body: { value: proxyPassword },
    });
    check("the proxy password can be stored", proxyPasswordWrite.status === 204, String(proxyPasswordWrite.status));

    const proxyRoute = await api(base, "/api/routes", {
      token,
      method: "POST",
      body: {
        id: "install-proxy-route",
        model: "proxied-model",
        providerId: "install",
        proxyId: "install-tunnel",
        freeOnly: false,
      },
    });
    check("a proxy-bound route can be created", proxyRoute.status === 201, proxyRoute.text);

    const connectsBefore = proxy.connects.length;
    const proxiedChat = await api(base, "/v1/chat/completions", {
      token,
      method: "POST",
      body: { model: "proxied-model", messages: [{ role: "user", content: "through the tunnel" }] },
    });
    check("a chat over the proxy-bound route returns 200", proxiedChat.status === 200, proxiedChat.text.slice(0, 200));
    check(
      "the CONNECT proxy actually carried the request",
      proxy.connects.length > connectsBefore && proxy.connects.some((entry) => entry.authorized && entry.port === origin.port),
      JSON.stringify(proxy.connects.slice(-2)),
    );
    check(
      "the routing header names the proxy that was used",
      proxiedChat.headers.get("x-bayz-proxy") === "install-tunnel",
      proxiedChat.headers.get("x-bayz-proxy") ?? "(none)",
    );

    section("8. Restart reopens the same database with data intact");
    await daemon.stop();
    check("the daemon stopped cleanly on SIGTERM", daemon.exitCode === 0, `exit ${daemon.exitCode}`);

    /*
     * WAL residue is the classic restart failure: a `-wal` left behind by an unclean stop can block
     * the next open. Checked as a *fact about the directory* before restarting, then the restart
     * itself is the proof that whatever is there does not block startup.
     */
    const residue = readdirSync(dataDir).filter((name) => name.endsWith("-shm"));
    check("no -shm residue survives a clean stop", residue.length === 0, residue.join(", "));

    const restarted = await startInstalled({
      bin,
      port,
      env: {
        BAYZ_DATA_DIR: dataDir,
        BAYZ_PORT: String(port),
        BAYZ_HOST: "127.0.0.1",
        BAYZ_API_TOKEN: token,
      },
    });
    daemon = restarted;
    check("the daemon restarts against the existing database", restarted.ready, restarted.stderr.slice(-400));

    const afterProviders = await api(base, "/api/providers", { token });
    check(
      "the provider survived the restart",
      afterProviders.json?.providers?.some((entry) => entry.id === "install"),
      afterProviders.text.slice(0, 200),
    );
    check(
      "the stored credential survived the restart",
      afterProviders.json?.providers?.find((entry) => entry.id === "install")?.credentialPresent === true,
      "credentialPresent is not true after restart",
    );
    const afterRoutes = await api(base, "/api/routes", { token });
    check(
      "the route survived the restart",
      afterRoutes.json?.routes?.some((entry) => entry.id === "install-route"),
      afterRoutes.text.slice(0, 200),
    );
    const afterIdentities = await api(base, "/api/identities", { token });
    check(
      "the identity survived the restart",
      afterIdentities.json?.identities?.some((entry) => entry.id === "install-client"),
      afterIdentities.text.slice(0, 200),
    );
    const afterChat = await api(base, "/v1/chat/completions", {
      token,
      method: "POST",
      body: { model: "install-model", messages: [{ role: "user", content: "after restart" }] },
    });
    check("a chat still succeeds after the restart", afterChat.status === 200, afterChat.text.slice(0, 200));

    section("9. A generated token is refused for a non-loopback bind (9F)");
    /*
     * The 9F posture ladder, exercised through the installed artifact rather than through a unit test,
     * because bundling is exactly the step that could have dropped the gate. A wildcard bind is
     * `remote`, which requires an explicit token — and a *generated* one does not count.
     */
    const generatedRemote = runInstalledToExit({
      bin,
      env: {
        BAYZ_DATA_DIR: join(workspace, "remote-data"),
        BAYZ_PORT: "21802",
        BAYZ_HOST: "0.0.0.0",
        BAYZ_ALLOW_REMOTE: "true",
        BAYZ_API_TOKEN: undefined,
      },
    });
    check("a remote bind with a generated token refuses to start", generatedRemote.status !== 0, `exit ${generatedRemote.status}`);
    check(
      "the refusal names the missing explicit token",
      /explicit_api_token|BAYZ_API_TOKEN/.test(`${generatedRemote.stdout}${generatedRemote.stderr}`),
      `${generatedRemote.stdout}${generatedRemote.stderr}`.slice(-300),
    );
    const remoteNoOptIn = runInstalledToExit({
      bin,
      env: {
        BAYZ_DATA_DIR: join(workspace, "remote-data-2"),
        BAYZ_PORT: "21803",
        BAYZ_HOST: "0.0.0.0",
        BAYZ_API_TOKEN: token,
      },
    });
    check("a non-loopback bind without the opt-in refuses to start", remoteNoOptIn.status !== 0, `exit ${remoteNoOptIn.status}`);

    section("10. Uninstall leaves operator data untouched");
    await daemon.stop();
    daemon = undefined;

    const dbBefore = readFileSync(join(dataDir, "bayz.db")).length;
    const uninstall = spawnSync(
      "npm",
      ["uninstall", pack.ARTIFACT_NAME, "--prefix", prefix, "--cache", cache, "--no-audit", "--no-fund"],
      { cwd: workspace, encoding: "utf8", timeout: 600_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    check("npm uninstall exits 0", uninstall.status === 0, (uninstall.stderr ?? "").slice(-400));
    check("the package is gone from the prefix", !existsSync(installedRoot), installedRoot);
    check("the bin link is gone", !existsSync(bin), bin);

    /*
     * **The assertion that matters here.** Data is the operator's. Uninstalling software must never
     * delete a database holding encrypted credentials — and deletion would be unrecoverable, because
     * the DEKs live in that same directory.
     */
    check("the data directory survived the uninstall", existsSync(dataDir), dataDir);
    check("the database survived the uninstall", existsSync(join(dataDir, "bayz.db")), "bayz.db was removed");
    check("the database is unchanged in size", readFileSync(join(dataDir, "bayz.db")).length === dbBefore, "the database changed during uninstall");
    check("the root key survived the uninstall", existsSync(join(dataDir, "master.key")), "master.key was removed");

    section("11. The install guide documents the data path and the deletion warning");
    const guide = readFileSync(join(ROOT, "docs/install.md"), "utf8");
    check("docs/install.md documents the resolution chain", /fallback chain|read in order/i.test(guide));
    check("docs/install.md names the path to delete to remove data", /## Removing BAYZ/i.test(guide) && /bayz\.db/.test(guide));
    check(
      "docs/install.md warns that deleting the data directory is irreversible",
      /irreversible/i.test(guide) && /DEK|encryption key/i.test(guide),
      "the deletion warning does not explain that the keys go with it",
    );
    check("docs/install.md documents installing the packed artifact", /npm install/.test(guide) && /tarball|\.tgz/.test(guide));
  } finally {
    if (daemon !== undefined) await daemon.stop();
    origin.server.close();
    registry.server.close();
    proxy.server.close();
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      // A leftover temp directory is not a smoke failure.
    }
  }

  console.log("");
  console.log(`${checkNumber - failures.length}/${checkNumber} checks passed`);
  if (failures.length > 0) {
    console.error("install smoke: FAIL");
    for (const failure of failures) console.error(`  - ${failure}`);
    return 1;
  }
  console.log("install smoke: PASS");
  return 0;
}

process.exitCode = await main();
