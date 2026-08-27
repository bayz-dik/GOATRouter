#!/usr/bin/env node
/**
 * Non-mocked multi-proxy UX proof for Phase 9E.
 *
 * Starts a real Bayz server, two real HTTP CONNECT proxies, one real SOCKS5 proxy, and
 * twelve real loopback provider origins. Every assignment goes through the HTTP API and
 * every claim about where traffic went is read off the proxies' own connect logs — an
 * in-process test can assert that a function returned "assigned", but only a real tunnel
 * can show that twelve providers actually egress through proxy A and then six of them
 * actually move to proxy B.
 *
 * Exits non-zero on any failed check.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ENTRY = fileURLToPath(new URL("../apps/server/src/app.ts", import.meta.url));
const RUNTIME_ENTRY = fileURLToPath(
  new URL("../apps/server/src/runtime.ts", import.meta.url),
);

if (!process.env.BAYZ_PROXY_UX_SMOKE_LOADER) {
  const relaunch = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url)],
    { stdio: "inherit", env: { ...process.env, BAYZ_PROXY_UX_SMOKE_LOADER: "1" } },
  );
  process.exit(relaunch.status ?? 1);
}

const TOKEN = "proxy-ux-smoke-token-0123456789ab";
const KEK_HEX = Buffer.alloc(32, 0x5c).toString("hex");
/**
 * ASCII only: this value is sent as an `Authorization` header, and Node rejects a
 * non-latin1 header value with `ERR_INVALID_CHAR` before it reaches the socket.
 */
const CREDENTIAL = "sk-proxy-ux-smoke-credential-never-on-disk-8842";
/** Distinct per proxy, so a leak can be attributed rather than merely detected. */
const PASSWORD_A = "hunter2-PROXY-A-ux-smoke-never-on-disk-4417";
const PASSWORD_B = "hunter2-PROXY-B-ux-smoke-never-on-disk-9930";
const PASSWORD_S = "hunter2-SOCKS-ux-smoke-never-on-disk-2255";
const PROXY_USER = "bayz";
const PROMPT = "PROXY-UX-SMOKE-PROMPT-must-never-touch-disk";
const COMPLETION = "PROXY-UX-SMOKE-COMPLETION-also-never-persisted";

/** Twelve providers is the plan's fleet size for the bulk path. */
const FLEET = 12;
/** How many of the twelve move to proxy B, leaving a provable split. */
const MOVED = 6;
/** How many are then set back to direct. */
const DIRECTED = 3;

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

/**
 * One real origin per provider.
 *
 * Each answers with its own index, so a response proves which origin served it and a
 * mixed-up assignment cannot pass by accident.
 */
async function startOrigin(index) {
  const seen = [];
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      seen.push({
        url: request.url,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url?.includes("/chat/completions")) {
        response.end(
          JSON.stringify({
            id: `chatcmpl-origin-${index}`,
            model: `model-${index}`,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: `${COMPLETION}:${index}` },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
          }),
        );
        return;
      }
      response.end(JSON.stringify({ data: [{ id: `model-${index}` }] }));
    });
  });
  server.on("connection", track);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, seen, index };
}

/**
 * A real HTTP CONNECT proxy requiring Basic auth.
 *
 * It records the authority of every CONNECT so the smoke can prove *which* provider
 * origin was reached through *which* proxy — the whole point of a multi-proxy test.
 */
async function startConnectProxy(password) {
  const connects = [];
  const raw = [];
  const expected = Buffer.from(`${PROXY_USER}:${password}`, "utf8").toString("base64");
  const server = createServer((client) => {
    track(client);
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, Buffer.from(chunk)]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        return;
      }
      client.off("data", onData);
      const request = head.subarray(0, end).toString("utf8");
      raw.push(request);
      const authority = /^CONNECT (\S+)/.exec(request)?.[1];
      if (!request.includes(expected)) {
        client.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
        client.end();
        return;
      }
      const port = Number(authority?.split(":")[1] ?? 0);
      connects.push({ authority, port });
      const rest = head.subarray(end + 4);
      const upstream = track(
        connect({ host: "127.0.0.1", port }, () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (rest.length > 0) {
            upstream.write(rest);
          }
          client.pipe(upstream);
          upstream.pipe(client);
        }),
      );
      upstream.on("error", () => client.destroy());
    };
    client.on("data", onData);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, connects, raw };
}

/** A real SOCKS5 proxy requiring RFC 1929 auth, recording the requested port. */
async function startSocks5Proxy(password) {
  const connects = [];
  const raw = [];
  const server = createServer((client) => {
    track(client);
    let stage = "greeting";
    let buffer = Buffer.alloc(0);

    client.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      raw.push(Buffer.from(chunk));

      if (stage === "greeting" && buffer.length >= 2) {
        const count = buffer[1];
        if (buffer.length < 2 + count) {
          return;
        }
        const methods = [...buffer.subarray(2, 2 + count)];
        buffer = buffer.subarray(2 + count);
        if (!methods.includes(0x02)) {
          client.write(Buffer.from([0x05, 0xff]));
          client.end();
          return;
        }
        client.write(Buffer.from([0x05, 0x02]));
        stage = "auth";
      }

      if (stage === "auth" && buffer.length >= 2) {
        const userLen = buffer[1];
        if (buffer.length < 2 + userLen + 1) {
          return;
        }
        const passLen = buffer[2 + userLen];
        if (buffer.length < 3 + userLen + passLen) {
          return;
        }
        const user = buffer.subarray(2, 2 + userLen).toString("utf8");
        const pass = buffer.subarray(3 + userLen, 3 + userLen + passLen).toString("utf8");
        buffer = buffer.subarray(3 + userLen + passLen);
        if (user !== PROXY_USER || pass !== password) {
          client.write(Buffer.from([0x01, 0x01]));
          client.end();
          return;
        }
        client.write(Buffer.from([0x01, 0x00]));
        stage = "connect";
      }

      if (stage === "connect" && buffer.length >= 5) {
        const atyp = buffer[3];
        let headerLength;
        if (atyp === 0x01) {
          headerLength = 4 + 4 + 2;
        } else if (atyp === 0x03) {
          headerLength = 4 + 1 + buffer[4] + 2;
        } else if (atyp === 0x04) {
          headerLength = 4 + 16 + 2;
        } else {
          client.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          client.end();
          return;
        }
        if (buffer.length < headerLength) {
          return;
        }
        const port = buffer.readUInt16BE(headerLength - 2);
        connects.push({ port });
        const rest = buffer.subarray(headerLength);
        buffer = Buffer.alloc(0);
        stage = "piping";

        const upstream = track(
          connect({ host: "127.0.0.1", port }, () => {
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x50]));
            if (rest.length > 0) {
              upstream.write(rest);
            }
            client.pipe(upstream);
            upstream.pipe(client);
          }),
        );
        upstream.on("error", () => client.destroy());
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, connects, raw };
}

function readDatabaseBytes(dataDir) {
  const base = join(dataDir, "bayz.db");
  const parts = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${base}${suffix}`;
    if (existsSync(file)) {
      parts.push(readFileSync(file));
    }
  }
  return Buffer.concat(parts);
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "bayz-proxy-ux-smoke-"));
  const dataDir = join(root, ".bayz");
  const { buildApp } = await import(APP_ENTRY);
  const { createBayzRuntime } = await import(RUNTIME_ENTRY);

  const origins = [];
  for (let index = 1; index <= FLEET; index += 1) {
    origins.push(await startOrigin(index));
  }
  const proxyA = await startConnectProxy(PASSWORD_A);
  const proxyB = await startConnectProxy(PASSWORD_B);
  const proxyS = await startSocks5Proxy(PASSWORD_S);

  const runtime = createBayzRuntime(
    { host: "127.0.0.1", port: 0, dataDir, dashboardRoot: join(root, "no-dashboard") },
    {
      env: { BAYZ_MASTER_KEY: KEK_HEX, BAYZ_API_TOKEN: TOKEN },
      notify: () => {},
      logger: (payload) => captured.push(JSON.stringify(payload)),
    },
  );
  const app = buildApp({ logger: false, apiToken: TOKEN, runtime });

  let base;

  async function call(method, path, options = {}) {
    const headers = { authorization: `Bearer ${TOKEN}` };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    bodies.push(text);
    let json;
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, headers: response.headers, text, json };
  }

  /** Chat through one provider's route and report which proxy header came back. */
  async function chat(index) {
    const response = await call("POST", "/v1/chat/completions", {
      body: {
        model: `model-${index}`,
        messages: [{ role: "user", content: `${PROMPT}:${index}` }],
      },
    });
    return {
      status: response.status,
      proxy: response.headers.get("x-bayz-proxy"),
      content: response.json?.choices?.[0]?.message?.content,
      text: response.text,
    };
  }

  const providerId = (index) => `fleet-${index}`;
  const routeId = (index) => `route-${index}`;
  const portOf = (index) => origins[index - 1].port;

  /** CONNECTs recorded by a proxy for a given provider index. */
  const connectsFor = (proxy, index) =>
    proxy.connects.filter((entry) => entry.port === portOf(index)).length;

  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${app.server.address().port}`;

    section(`1. Real listener on ${base} with ${FLEET} real provider origins`);
    check("the listener bound loopback", app.server.address().address === "127.0.0.1");
    check(`${FLEET} origins are listening`, origins.every((entry) => entry.port > 0));
    check(
      "every origin has a distinct port",
      new Set(origins.map((entry) => entry.port)).size === FLEET,
    );

    section("2. Create three real proxies through the API");
    const createdA = await call("POST", "/api/proxies", {
      body: {
        id: "proxy-a",
        kind: "http",
        host: "127.0.0.1",
        port: proxyA.port,
        username: PROXY_USER,
        config: { connectTimeoutMs: 5000 },
      },
    });
    const createdB = await call("POST", "/api/proxies", {
      body: {
        id: "proxy-b",
        kind: "http",
        host: "127.0.0.1",
        port: proxyB.port,
        username: PROXY_USER,
        config: { connectTimeoutMs: 5000 },
      },
    });
    const createdS = await call("POST", "/api/proxies", {
      body: {
        id: "proxy-socks",
        kind: "socks5",
        host: "127.0.0.1",
        port: proxyS.port,
        username: PROXY_USER,
        config: { connectTimeoutMs: 5000 },
      },
    });
    check("proxy A was created", createdA.status === 201);
    check("proxy B was created", createdB.status === 201);
    check("the socks5 proxy was created", createdS.status === 201);
    check(
      "no create response carried a password",
      [createdA.text, createdB.text, createdS.text].every(
        (text) =>
          !text.includes(PASSWORD_A) &&
          !text.includes(PASSWORD_B) &&
          !text.includes(PASSWORD_S),
      ),
    );

    for (const [id, password] of [
      ["proxy-a", PASSWORD_A],
      ["proxy-b", PASSWORD_B],
      ["proxy-socks", PASSWORD_S],
    ]) {
      const stored = await call("PUT", `/api/proxies/${id}/password`, {
        body: { value: password },
      });
      check(`${id} password write returned 204`, stored.status === 204);
    }

    section("3. Register twelve providers and routes over HTTP");
    for (let index = 1; index <= FLEET; index += 1) {
      const created = await call("POST", "/api/providers", {
        body: {
          id: providerId(index),
          kind: "openai-compatible",
          displayName: `Fleet ${index}`,
          baseUrl: `http://127.0.0.1:${portOf(index)}/v1`,
          config: { allowLoopback: true },
        },
      });
      if (created.status !== 201) {
        check(`provider ${index} was created`, false);
      }
      await call("PUT", `/api/providers/${providerId(index)}/credential`, {
        body: { value: CREDENTIAL },
      });
      const route = await call("POST", "/api/routes", {
        body: {
          id: routeId(index),
          model: `model-${index}`,
          providerId: providerId(index),
        },
      });
      if (route.status !== 201) {
        check(`route ${index} was created`, false);
      }
    }
    const listed = await call("GET", "/api/providers");
    check(
      `all ${FLEET} providers are registered`,
      listed.json?.providers?.length === FLEET,
    );
    check(
      "every provider starts direct",
      (listed.json?.providers ?? []).every((entry) => entry.proxyId === undefined),
    );

    section("4. One bulk call assigns proxy A to all twelve providers");
    const assignedA = await call("POST", "/api/proxies/proxy-a/assign", {
      body: { providerIds: Array.from({ length: FLEET }, (_, i) => providerId(i + 1)) },
    });
    check("the bulk assign returned 200", assignedA.status === 200);
    check(`the bulk assign reported ${FLEET} providers`, assignedA.json?.providerCount === FLEET);
    check("the bulk assign reported the proxy enabled", assignedA.json?.proxyEnabled === true);
    const afterAssign = await call("GET", "/api/providers");
    check(
      "every provider now defaults to proxy A",
      (afterAssign.json?.providers ?? []).every((entry) => entry.proxyId === "proxy-a"),
    );

    section("5. A real chat through every provider traverses proxy A");
    {
      const results = [];
      for (let index = 1; index <= FLEET; index += 1) {
        results.push(await chat(index));
      }
      check("every chat returned 200", results.every((entry) => entry.status === 200));
      if (!results.every((entry) => entry.status === 200)) {
        // Diagnostics on failure. The router's own attempt log carries the upstream
        // failure code, which is what distinguishes "assignment wrong" from "tunnel
        // broken" — and it is already redacted by the runtime logger.
        const first = results.find((entry) => entry.status !== 200);
        console.error(`       first failing chat: ${first?.status} ${first?.text?.slice(0, 300)}`);
        console.error(`       last attempts:\n${captured.slice(-3).join("\n")}`);
      }
      check(
        "every chat reported proxy A",
        results.every((entry) => entry.proxy === "proxy-a"),
      );
      check(
        "every response came from its own origin",
        results.every((entry, position) => entry.content === `${COMPLETION}:${position + 1}`),
      );
      // The proxy's own log, not the router's claim.
      const seenPorts = new Set(proxyA.connects.map((entry) => entry.port));
      check(
        `proxy A logged a CONNECT for all ${FLEET} origins`,
        origins.every((origin) => seenPorts.has(origin.port)),
      );
      check("proxy B saw no traffic yet", proxyB.connects.length === 0);
      check("the socks5 proxy saw no traffic yet", proxyS.connects.length === 0);
    }

    section(`6. One bulk call moves ${MOVED} providers to proxy B, and the split holds`);
    const movedIds = Array.from({ length: MOVED }, (_, i) => providerId(i + 1));
    const assignedB = await call("POST", "/api/proxies/proxy-b/assign", {
      body: { providerIds: movedIds },
    });
    check("the reassign returned 200", assignedB.status === 200);
    check(`the reassign reported ${MOVED} providers`, assignedB.json?.providerCount === MOVED);
    {
      const aBefore = proxyA.connects.length;
      const bBefore = proxyB.connects.length;
      const results = [];
      for (let index = 1; index <= FLEET; index += 1) {
        results.push(await chat(index));
      }
      check("every chat after the split returned 200", results.every((e) => e.status === 200));
      check(
        `the first ${MOVED} providers now report proxy B`,
        results.slice(0, MOVED).every((entry) => entry.proxy === "proxy-b"),
      );
      check(
        "the remaining providers still report proxy A",
        results.slice(MOVED).every((entry) => entry.proxy === "proxy-a"),
      );
      check(
        "proxy B logged CONNECTs only for the moved providers",
        movedIds.every((_, position) => connectsFor(proxyB, position + 1) >= 1) &&
          proxyB.connects.every((entry) =>
            movedIds.some((_, position) => entry.port === portOf(position + 1)),
          ),
      );
      check("proxy A logged new CONNECTs for the rest", proxyA.connects.length > aBefore);
      check("proxy B logged new CONNECTs", proxyB.connects.length > bBefore);
    }

    section(`7. ${DIRECTED} providers set to Direct traverse no proxy at all`);
    const directIds = Array.from({ length: DIRECTED }, (_, i) => providerId(i + 1));
    const unassigned = await call("POST", "/api/proxies/proxy-b/unassign", {
      body: { providerIds: directIds },
    });
    check("the unassign returned 200", unassigned.status === 200);
    check(
      `the unassign reported ${DIRECTED} detached from proxy B`,
      unassigned.json?.detachedFromProxy === DIRECTED,
    );
    {
      const aBefore = proxyA.connects.length;
      const bBefore = proxyB.connects.length;
      const results = [];
      for (let index = 1; index <= DIRECTED; index += 1) {
        results.push(await chat(index));
      }
      check("every direct chat returned 200", results.every((entry) => entry.status === 200));
      check(
        "no direct chat reported a proxy",
        results.every((entry) => entry.proxy === null),
      );
      check("proxy A logged no new CONNECT", proxyA.connects.length === aBefore);
      check("proxy B logged no new CONNECT", proxyB.connects.length === bBefore);
    }

    section("8. A route override beats the provider default");
    {
      // Provider 12 still defaults to proxy A; pin its route to the socks5 proxy.
      const patched = await call("PATCH", `/api/routes/${routeId(FLEET)}`, {
        body: { proxyId: "proxy-socks" },
      });
      check("the route override was accepted", patched.status === 200);
      const sBefore = proxyS.connects.length;
      const aBefore = proxyA.connects.length;
      const overridden = await chat(FLEET);
      check("the overridden chat returned 200", overridden.status === 200);
      check("the overridden chat reports the socks5 proxy", overridden.proxy === "proxy-socks");
      check("the socks5 proxy logged the CONNECT", proxyS.connects.length > sBefore);
      check("proxy A was bypassed by the override", proxyA.connects.length === aBefore);

      // force-direct on the route beats a proxied provider.
      const forced = await call("PATCH", `/api/routes/${routeId(FLEET)}`, {
        body: { proxyId: null, forceDirect: true },
      });
      check("force-direct was accepted", forced.status === 200);
      const sBefore2 = proxyS.connects.length;
      const aBefore2 = proxyA.connects.length;
      const direct = await chat(FLEET);
      check("the force-direct chat returned 200", direct.status === 200);
      check("the force-direct chat reports no proxy", direct.proxy === null);
      check(
        "no proxy logged a CONNECT for the forced-direct route",
        proxyS.connects.length === sBefore2 && proxyA.connects.length === aBefore2,
      );
      await call("PATCH", `/api/routes/${routeId(FLEET)}`, { body: { forceDirect: false } });
    }

    section("9. usage reports the real counts");
    {
      const usageA = await call("GET", "/api/proxies/proxy-a/usage");
      const usageB = await call("GET", "/api/proxies/proxy-b/usage");
      // 12 assigned to A, first 6 moved to B, first 3 of those then set direct.
      const expectedB = MOVED - DIRECTED;
      const expectedA = FLEET - MOVED;
      check("usage for proxy A returned 200", usageA.status === 200);
      check(
        `proxy A reports ${expectedA} providers`,
        usageA.json?.providerCount === expectedA,
      );
      check(
        `proxy B reports ${expectedB} providers`,
        usageB.json?.providerCount === expectedB,
      );
      check(
        "usage lists ids only, with no password state",
        Array.isArray(usageA.json?.providerIds) &&
          !("passwordPresent" in (usageA.json ?? {})) &&
          !usageA.text.includes(PASSWORD_A),
      );
      const usageS = await call("GET", "/api/proxies/proxy-socks/usage");
      check(
        "the socks5 proxy reports no provider defaults",
        usageS.json?.providerCount === 0,
      );
    }

    section("10. Deleting proxy B degrades its providers to Direct without breaking them");
    {
      const attached = (await call("GET", "/api/proxies/proxy-b/usage")).json?.providerIds ?? [];
      check("proxy B had providers before deletion", attached.length > 0);
      const deleted = await call("DELETE", "/api/proxies/proxy-b");
      check("the delete returned 204", deleted.status === 204);
      const after = await call("GET", "/api/providers");
      const stillOnB = (after.json?.providers ?? []).filter(
        (entry) => entry.proxyId === "proxy-b",
      );
      check("no provider still references the deleted proxy", stillOnB.length === 0);
      check(
        "the affected providers survived the deletion",
        (after.json?.providers ?? []).length === FLEET,
      );
      // The real proof: they still complete a chat, now direct.
      const index = Number(attached[0]?.replace("fleet-", "") ?? 0);
      const bBefore = proxyB.connects.length;
      const revived = await chat(index);
      check("a degraded provider still completes a chat", revived.status === 200);
      check("the degraded provider now reports no proxy", revived.proxy === null);
      check("the deleted proxy logged nothing new", proxyB.connects.length === bBefore);
    }

    section("11. No proxy password is readable through the API");
    {
      const list = await call("GET", "/api/proxies");
      check("the proxy list returned 200", list.status === 200);
      check(
        "the list reports presence, never a value",
        (list.json?.proxies ?? []).every((entry) => typeof entry.passwordPresent === "boolean"),
      );
      check(
        "no password appears in the proxy list",
        !list.text.includes(PASSWORD_A) &&
          !list.text.includes(PASSWORD_B) &&
          !list.text.includes(PASSWORD_S),
      );
      const forged = await fetch(`${base}/api/proxies/proxy-a/password`, {
        method: "GET",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      check("there is no GET password route", forged.status === 404 || forged.status === 405);
    }
  } finally {
    await app.close();
    runtime.close();
    for (const socket of openSockets) {
      socket.destroy();
    }
    await new Promise((resolve) => proxyA.server.close(resolve));
    await new Promise((resolve) => proxyB.server.close(resolve));
    await new Promise((resolve) => proxyS.server.close(resolve));
    for (const origin of origins) {
      await new Promise((resolve) => origin.server.close(resolve));
    }
  }

  section("12. Scan the real bytes on disk, the logs, and every response body");
  {
    const bytes = readDatabaseBytes(dataDir);
    check("database bytes were read", bytes.byteLength > 0);
    for (const [label, secret] of [
      ["proxy A password", PASSWORD_A],
      ["proxy B password", PASSWORD_B],
      ["socks5 password", PASSWORD_S],
      ["provider credential", CREDENTIAL],
      ["api token", TOKEN],
      ["root key", KEK_HEX],
      ["prompt", PROMPT],
      ["completion", COMPLETION],
    ]) {
      check(`the ${label} is absent from db, -wal, and -shm`, !bytes.includes(Buffer.from(secret, "utf8")));
    }
    check(
      "provider metadata is present, proving the scan reads real content",
      bytes.includes(Buffer.from("fleet-1", "utf8")),
    );

    const logs = captured.join("\n");
    check("log output was captured", captured.length > 0);
    for (const [label, secret] of [
      ["proxy A password", PASSWORD_A],
      ["proxy B password", PASSWORD_B],
      ["socks5 password", PASSWORD_S],
      ["provider credential", CREDENTIAL],
      ["api token", TOKEN],
      ["prompt", PROMPT],
    ]) {
      check(`no ${label} in the logs`, !logs.includes(secret));
    }

    const combined = bodies.join("\n");
    check("response bodies were captured", combined.length > 0);
    for (const [label, secret] of [
      ["proxy A password", PASSWORD_A],
      ["proxy B password", PASSWORD_B],
      ["socks5 password", PASSWORD_S],
      ["provider credential", CREDENTIAL],
      ["api token", TOKEN],
      ["root key", KEK_HEX],
    ]) {
      check(`no ${label} in any response body`, !combined.includes(secret));
    }

    // The CONNECT preambles are the one place a proxy password legitimately appears, in
    // Basic form. Assert the *provider* credential never leaked into them.
    check(
      "no CONNECT preamble carried the provider credential",
      [...proxyA.raw, ...proxyB.raw].every((entry) => !entry.includes(CREDENTIAL)),
    );
    check(
      "no CONNECT preamble carried the other proxy's password",
      proxyA.raw.every((entry) => !entry.includes(PASSWORD_B)) &&
        proxyB.raw.every((entry) => !entry.includes(PASSWORD_A)),
    );
  }

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length > 0) {
    console.error("proxy ux smoke: FAIL");
    process.exit(1);
  }
  console.log("proxy ux smoke: PASS");
}

main().catch((error) => {
  console.error("proxy ux smoke: FAIL");
  console.error(error);
  process.exit(1);
});
