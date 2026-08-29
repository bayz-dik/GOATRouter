/**
 * Chaos scenario library — 9I Task 4. Shared fixtures for `scripts/chaos-smoke.mjs`.
 *
 * Extends the Task 4/5 client-verification fixtures (`scripts/verify-client-lib.mjs`) rather
 * than duplicating them: the same `startBayz`, `startOrigin`, `startConnectProxy` and
 * connection tracker, so a chaos scenario runs against exactly the listener shape the 9H
 * harnesses proved real clients work against. Duplicating them would let the two drift, and
 * the drift would always favour whichever copy was looser.
 *
 * What is new here is **failure injection against real components**: an origin that dies
 * mid-stream, a proxy that hangs up mid-handshake, a socket reset at four separate points in a
 * request, a DNS resolver that answers differently on the second call, and a database file made
 * read-only. Every scenario asserts a *specific recovery* — a named error code, a specific
 * observable state, an origin hit count — because "no crash" is satisfied by a system that
 * silently loses data.
 */

import { existsSync, mkdtempSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const lib = await import("./verify-client-lib.mjs");

export const { startBayz, startConnectProxy, startOrigin, track, sockets } = lib;

export const ADMIN_TOKEN = "chaos-admin-token-0123456789";
export const KEK_HEX = Buffer.alloc(32, 0x2d).toString("hex");
export const CREDENTIAL = "CHAOS-PROVIDER-CREDENTIAL-9f8e7d";
export const PROXY_USER = "bayzproxy";
export const PROXY_PASSWORD = "CHAOS-PROXY-PASSWORD-4b5c6d";
export const MODEL = "chaos-model";

let checkNumber = 0;
const failures = [];
const notes = [];

/** Numbered check, so a resilience-report row can cite `smoke:chaos#N`. */
export function check(label, ok, detail) {
  checkNumber += 1;
  if (ok) {
    console.log(`  ok   ${String(checkNumber).padStart(2)}  ${label}`);
  } else {
    console.log(`  FAIL ${String(checkNumber).padStart(2)}  ${label}${detail === undefined ? "" : ` — ${detail}`}`);
    failures.push({ number: checkNumber, label, detail });
  }
  return ok;
}

/**
 * Record something measured but deliberately not asserted, or an honest UNVERIFIED.
 *
 * The plan requires disk-full to be recorded `UNVERIFIED` with a reason if it cannot be
 * simulated here, rather than skipped silently. This is how.
 */
export function note(text) {
  notes.push(text);
  console.log(`  note     ${text}`);
}

export function section(title) {
  console.log(`\n${title}`);
}

export function summary() {
  return { checkNumber, failures, notes };
}

export function freshDataDir(label) {
  return join(mkdtempSync(join(tmpdir(), `bayz-chaos-${label}-`)), ".bayz");
}

/**
 * Register a provider, a route, and a scoped client identity through the **real management
 * API** — not by writing rows directly. A scenario that seeded the database by hand would not
 * prove the path a real operator uses still works after a failure.
 *
 * `proxyId` binds through `POST /api/proxies/:id/assign` with `{ providerIds }`, the shape read
 * from `apps/server/src/routes/proxies.ts:150` — the endpoint lives on the *proxy*, not the
 * provider, and it refuses any other body shape with 400.
 */
export async function seed(bayz, { providerId = "chaos-origin", routeId = "chaos-route", port, model = MODEL, freeOnly = false, proxyId, extraProviderConfig, routeConfig } = {}) {
  await bayz.admin("POST", "/api/providers", {
    id: providerId,
    kind: "openai-compatible",
    displayName: "Chaos Origin",
    baseUrl: `http://127.0.0.1:${port}`,
    config: { allowLoopback: true, ...extraProviderConfig },
  });
  await bayz.admin("PUT", `/api/providers/${providerId}/credential`, { value: CREDENTIAL });
  if (proxyId !== undefined) {
    await bayz.admin("POST", `/api/proxies/${proxyId}/assign`, { providerIds: [providerId] });
  }
  await bayz.admin("POST", "/api/routes", {
    id: routeId,
    model,
    providerId,
    ...(freeOnly ? {} : { freeOnly: false }),
    ...(routeConfig === undefined ? {} : routeConfig),
  });
  const created = await bayz.admin("POST", "/api/identities", {
    id: "chaos-client",
    displayName: "Chaos Client",
    scopes: ["chat.completions", "models.read"],
  });
  return created.json?.key;
}

/** A chat request as a real OpenAI client would send it: bearer key, JSON body, real fetch. */
export async function chat(bayz, key, body, { signal, accept } = {}) {
  const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
  if (accept !== undefined) headers.accept = accept;
  const response = await fetch(`${bayz.base}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
  const text = await response.text();
  let json;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

/** Read an SSE response incrementally, so a mid-stream failure is observable. */
export async function readStream(bayz, key, body, { onFirstByte } = {}) {
  const response = await fetch(`${bayz.base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
  });

  const chunks = [];
  let firstByteSeen = false;
  let error;
  try {
    for await (const chunk of response.body ?? []) {
      chunks.push(Buffer.from(chunk));
      if (!firstByteSeen) {
        firstByteSeen = true;
        await onFirstByte?.();
      }
    }
  } catch (caught) {
    // A stream that dies mid-flight surfaces here; that *is* the observation.
    error = caught;
  }

  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    body: Buffer.concat(chunks).toString("utf8"),
    firstByteSeen,
    error: error === undefined ? undefined : `${error.name}: ${error.message}`,
  };
}

/**
 * An origin that can be told to fail in a specific way mid-request.
 *
 * Distinct from `startOrigin`'s scripted-but-cooperative behaviour: this one is built to break.
 * `mode` is mutable so a scenario can flip it between calls without restarting the listener,
 * which is what "the *next* request succeeds" scenarios need.
 */
export async function startHostileOrigin({ host = "127.0.0.1", models = [{ id: MODEL }] } = {}) {
  const state = {
    chatHits: 0,
    mode: "ok",
    text: "CHAOS-OK",
    /** How many bytes of an SSE stream to emit before the chosen failure. */
    framesBeforeFailure: 1,
    holdMs: 0,
    lastAuthorization: undefined,
    sawCredential: false,
  };

  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", async () => {
      // Recorded so a proxy-failure scenario can assert the provider credential never went out.
      state.lastAuthorization = request.headers.authorization;
      if (typeof request.headers.authorization === "string" && request.headers.authorization.includes(CREDENTIAL)) {
        state.sawCredential = true;
      }

      if (!request.url?.includes("/chat/completions")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: models }));
        return;
      }

      state.chatHits += 1;
      const body = Buffer.concat(chunks).toString("utf8");
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = {};
      }
      const wantsStream = parsed.stream === true;

      if (state.holdMs > 0) await new Promise((resolve) => setTimeout(resolve, state.holdMs));

      switch (state.mode) {
        case "reset-pre-response":
          // RST before a single response byte: the socket dies with nothing written.
          request.socket.resetAndDestroy?.() ?? request.socket.destroy();
          return;

        case "reset-post-headers":
          response.writeHead(200, { "content-type": wantsStream ? "text/event-stream" : "application/json" });
          response.flushHeaders?.();
          setTimeout(() => request.socket.resetAndDestroy?.() ?? request.socket.destroy(), 5);
          return;

        case "reset-mid-body": {
          // Announce a length, send part of it, then reset — a truncated body, not a clean end.
          const full = JSON.stringify({
            id: "chatcmpl-chaos",
            model: models[0]?.id ?? MODEL,
            choices: [{ index: 0, message: { role: "assistant", content: state.text }, finish_reason: "stop" }],
          });
          response.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(full)) });
          response.write(full.slice(0, Math.max(1, Math.floor(full.length / 2))));
          setTimeout(() => request.socket.resetAndDestroy?.() ?? request.socket.destroy(), 5);
          return;
        }

        case "die-mid-stream": {
          /*
           * The scenario the plan cares most about: real frames first, then death. The first
           * byte having already reached the client is what makes failover dishonest here — the
           * client has seen part of an answer, and a retry would produce a second, different one.
           */
          response.writeHead(200, { "content-type": "text/event-stream" });
          for (let i = 0; i < state.framesBeforeFailure; i += 1) {
            response.write(
              `data: ${JSON.stringify({
                id: "chatcmpl-chaos",
                model: models[0]?.id ?? MODEL,
                choices: [{ index: 0, delta: { content: `part${i} ` }, finish_reason: null }],
              })}\n\n`,
            );
          }
          setTimeout(() => request.socket.resetAndDestroy?.() ?? request.socket.destroy(), 10);
          return;
        }

        case "malformed":
          response.writeHead(200, { "content-type": "application/json" });
          response.end('{"this is not": ');
          return;

        case "malformed-sse":
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end("data: {not json at all}\n\n");
          return;

        case "hang":
          // Headers, then silence: the idle-timeout path rather than the connect-timeout path.
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.flushHeaders?.();
          return;

        case "silent":
          // No response at all: the total-timeout path.
          return;

        case "http-500":
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "upstream exploded" } }));
          return;

        default: {
          if (!wantsStream) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                id: "chatcmpl-chaos",
                model: models[0]?.id ?? MODEL,
                choices: [{ index: 0, message: { role: "assistant", content: state.text }, finish_reason: "stop" }],
                usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
              }),
            );
            return;
          }
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-chaos",
              model: models[0]?.id ?? MODEL,
              choices: [{ index: 0, delta: { content: state.text }, finish_reason: null }],
            })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
            })}\n\n`,
          );
          response.end("data: [DONE]\n\n");
        }
      }
    });
  });

  server.on("connection", track);
  await new Promise((resolve) => server.listen(0, host, resolve));

  return {
    port: server.address().port,
    state,
    set(next) {
      Object.assign(state, next);
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * A proxy that can fail at a chosen stage.
 *
 * The credential assertion depends on this being a real TCP peer: if the tunnel never opens,
 * the provider's `Authorization` header must never have been written to any socket. A mock
 * would make that unfalsifiable.
 */
export async function startHostileProxy({ user = PROXY_USER, password = PROXY_PASSWORD } = {}) {
  const expected = Buffer.from(`${user}:${password}`, "utf8").toString("base64");
  const state = { mode: "ok", connects: [], bytesAfterConnect: 0, sawCredentialBytes: false };

  const server = createTcpServer((client) => {
    track(client);
    let head = Buffer.alloc(0);

    const onData = (chunk) => {
      head = Buffer.concat([head, Buffer.from(chunk)]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      client.off("data", onData);

      const request = head.subarray(0, end).toString("utf8");
      const authority = /^CONNECT (\S+)/.exec(request)?.[1];

      if (state.mode === "die-mid-handshake") {
        // The CONNECT arrived and the socket dies before any reply.
        client.destroy();
        return;
      }
      if (state.mode === "hang-handshake") {
        // Accept and say nothing: the handshake deadline must fire.
        return;
      }
      if (state.mode === "auth-fail" || !request.includes(expected)) {
        client.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
        client.end();
        return;
      }
      if (state.mode === "garbage") {
        client.write("NOT-HTTP-AT-ALL\r\n\r\n");
        client.end();
        return;
      }

      const port = Number(authority?.split(":")[1] ?? 0);
      state.connects.push({ authority, port });

      if (state.mode === "die-mid-tunnel") {
        // Tunnel granted, then killed — the provider request is in flight when it dies.
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        client.on("data", (bytes) => {
          state.bytesAfterConnect += bytes.length;
          if (bytes.includes(CREDENTIAL)) state.sawCredentialBytes = true;
          client.destroy();
        });
        return;
      }

      const rest = head.subarray(end + 4);
      const upstream = track(
        connect({ host: "127.0.0.1", port }, () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (rest.length > 0) upstream.write(rest);
          client.pipe(upstream);
          upstream.pipe(client);
        }),
      );
      upstream.on("error", () => client.destroy());
    };

    client.on("data", onData);
    client.on("error", () => {});
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    port: server.address().port,
    state,
    set(next) {
      Object.assign(state, next);
    },
    async close() {
      server.close();
    },
  };
}

/** `PRAGMA integrity_check` on a BAYZ database file. Required after every scenario. */
export async function integrityCheck(dataDir) {
  const { nodeSqliteDriver } = await import("../packages/storage/src/drivers/node-sqlite.ts");
  const path = join(dataDir, "bayz.db");
  if (!existsSync(path)) return "missing";
  const db = nodeSqliteDriver.open(path);
  try {
    const row = db.prepare("PRAGMA integrity_check").get();
    return row?.integrity_check ?? Object.values(row ?? {})[0] ?? "unknown";
  } finally {
    db.close?.();
  }
}
