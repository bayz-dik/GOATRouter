import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  NONCE_CACHE_MAX,
  SIGNATURE_HEADER,
  SIGNING_SKEW_MS,
  NONCE_HEADER,
  TIMESTAMP_HEADER,
  canonicalRequest,
  createNonceCache,
  signRequest,
} from "../src/signing.js";
import { createBayzRuntime, type BayzRuntime } from "../src/runtime.js";

const KEY = Buffer.alloc(32, 0x5c).toString("hex");
const TOKEN = "signing-token-0123456789abcdef";

function dataDir(): string {
  return join(mkdtempSync(join(tmpdir(), "bayz-signing-")), ".bayz");
}

type Harness = { app: FastifyInstance; runtime: BayzRuntime; clientKey: string };

function harness(requireSigning: boolean): Harness {
  const runtime = createBayzRuntime(
    { host: "127.0.0.1", port: 20142, dataDir: dataDir(), dashboardRoot: "/nonexistent" },
    { env: { BAYZ_MASTER_KEY: KEY, BAYZ_API_TOKEN: TOKEN }, notify: () => {} },
  );
  const app = buildApp({
    logger: false,
    apiToken: TOKEN,
    runtime,
    registerTestRoutes: true,
    rateLimit: { max: 100000, authMax: 100000 },
    requireSigning,
  });
  const clientKey = runtime.identities.createIdentity({
    id: "signer",
    displayName: "Signer",
    scopes: ["providers.read", "chat.completions"],
  }).key;
  return { app, runtime, clientKey };
}

/** Sign with the real helper, so the test cannot pass against a different scheme. */
function signed(
  key: string,
  input: { method: string; url: string; body?: string; at?: number; nonce?: string },
): Record<string, string> {
  const headers = signRequest({
    key,
    method: input.method,
    url: input.url,
    body: input.body ?? "",
    ...(input.at === undefined ? {} : { at: input.at }),
    ...(input.nonce === undefined ? {} : { nonce: input.nonce }),
  });
  return { ...headers, authorization: `Bearer ${key}` };
}

/* ------------------------------------------------------------------ *
 * The canonical string
 * ------------------------------------------------------------------ */

test("the canonical string binds method, path, timestamp, nonce, and body hash", () => {
  const base = {
    method: "POST",
    url: "/api/providers",
    body: '{"id":"p1"}',
    at: 1_700_000_000_000,
    nonce: "n1",
  };
  const canonical = canonicalRequest(base);

  // Every component must change the string, or an attacker can vary it freely while
  // reusing a captured signature. Enumerated rather than sampled so a component added
  // later without being bound fails here.
  const variants: Array<Partial<typeof base>> = [
    { method: "GET" },
    { url: "/api/routes" },
    { body: '{"id":"p2"}' },
    { at: 1_700_000_000_001 },
    { nonce: "n2" },
  ];
  for (const variant of variants) {
    assert.notEqual(
      canonicalRequest({ ...base, ...variant }),
      canonical,
      `${Object.keys(variant)[0]} is not bound into the signature`,
    );
  }

  // The body is committed as a hash, not inline: a 1 MiB body would otherwise be
  // copied into the canonical string and hashed twice.
  assert.equal(canonical.includes('{"id":"p1"}'), false, "the body must not be inlined");
  assert.match(canonical, /[0-9a-f]{64}/);
});

test("the query string is bound, not just the path", () => {
  // `/api/usage/requests?limit=1` and `?limit=1000` are different requests; signing
  // only the path would let a captured signature be replayed against any parameters.
  assert.notEqual(
    canonicalRequest({
      method: "GET",
      url: "/api/usage/requests?limit=1",
      body: "",
      at: 1,
      nonce: "n",
    }),
    canonicalRequest({
      method: "GET",
      url: "/api/usage/requests?limit=1000",
      body: "",
      at: 1,
      nonce: "n",
    }),
  );
});

test("the signature is an HMAC-SHA256 over the canonical string keyed by the client key", () => {
  const key = randomBytes(32).toString("hex");
  const input = { method: "GET", url: "/api/status", body: "", at: 1, nonce: "n" };
  const headers = signRequest({ key, ...input });
  const expected = createHmac("sha256", key)
    .update(canonicalRequest(input), "utf8")
    .digest("hex");

  // Recomputed independently here rather than by calling the same helper, so a
  // rewrite of the scheme cannot silently pass.
  assert.equal(headers[SIGNATURE_HEADER], expected);
  assert.equal(headers[TIMESTAMP_HEADER], "1");
  assert.equal(headers[NONCE_HEADER], "n");
});

test("a generated nonce is unpredictable and a generated timestamp is now", () => {
  const key = randomBytes(32).toString("hex");
  const before = Date.now();
  const first = signRequest({ key, method: "GET", url: "/api/status" });
  const second = signRequest({ key, method: "GET", url: "/api/status" });

  // 16 bytes of randomness, hex. A short or repeating nonce would make replay
  // protection guessable rather than merely bounded.
  assert.equal(first[NONCE_HEADER]!.length, 32);
  assert.match(first[NONCE_HEADER]!, /^[0-9a-f]{32}$/);
  assert.notEqual(first[NONCE_HEADER], second[NONCE_HEADER]);
  const at = Number(first[TIMESTAMP_HEADER]);
  assert.ok(at >= before && at <= Date.now());
});

/* ------------------------------------------------------------------ *
 * The nonce cache
 * ------------------------------------------------------------------ */

test("the nonce cache accepts once and refuses a repeat", () => {
  const cache = createNonceCache(4);
  assert.equal(cache.remember("a"), true);
  assert.equal(cache.remember("a"), false, "a replayed nonce must be refused");
  assert.equal(cache.remember("b"), true);
});

test("the nonce cache is bounded and evicts oldest first", () => {
  const cache = createNonceCache(3);
  for (const nonce of ["a", "b", "c"]) {
    assert.equal(cache.remember(nonce), true);
  }
  assert.equal(cache.size(), 3);

  // A fourth entry evicts `a`, so `a` becomes acceptable again. That is a real and
  // deliberate limitation: an unbounded cache is a memory leak an attacker controls,
  // so replay protection is bounded by the cache depth *and* by the timestamp window.
  // Only a replay that arrives late enough to be evicted but early enough to still be
  // inside the skew window can succeed, which is what the window is sized for.
  assert.equal(cache.remember("d"), true);
  assert.equal(cache.size(), 3);
  assert.equal(cache.remember("a"), true, "eviction is FIFO and is bounded by the skew window");
  assert.equal(cache.remember("d"), false, "the newest entries are still held");
});

test("the default nonce cache depth is the documented 4096", () => {
  assert.equal(NONCE_CACHE_MAX, 4096);
  const cache = createNonceCache();
  for (let i = 0; i < NONCE_CACHE_MAX; i += 1) {
    cache.remember(`n${i}`);
  }
  assert.equal(cache.size(), NONCE_CACHE_MAX);
  cache.remember("overflow");
  assert.equal(cache.size(), NONCE_CACHE_MAX, "the cache must not grow past its bound");
});

/* ------------------------------------------------------------------ *
 * Wire behaviour
 * ------------------------------------------------------------------ */

test("signing is not required unless it was turned on", async (t) => {
  const { app, runtime, clientKey } = harness(false);
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  // Regression guard: every existing loopback install authenticates with a bearer
  // and no signature headers at all.
  const response = await app.inject({
    method: "GET",
    url: "/api/providers",
    headers: { authorization: `Bearer ${clientKey}` },
  });
  assert.equal(response.statusCode, 200);
});

test("with signing required, an unsigned request is refused", async (t) => {
  const { app, runtime, clientKey } = harness(true);
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/providers",
    headers: { authorization: `Bearer ${clientKey}` },
  });
  assert.equal(response.statusCode, 401);
  const body = response.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, "signature_required");
  // The message must not reveal which of the three headers was missing, or it becomes
  // a guide to constructing a valid request.
  assert.equal(body.error.message.includes(NONCE_HEADER), false);
});

test("a correctly signed request is accepted", async (t) => {
  const { app, runtime, clientKey } = harness(true);
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/providers",
    headers: signed(clientKey, { method: "GET", url: "/api/providers" }),
  });
  assert.equal(response.statusCode, 200);
});

test("a signed POST with a body is accepted and a tampered body is refused", async (t) => {
  const { app, runtime, clientKey } = harness(true);
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const url = "/v1/chat/completions";
  const body = JSON.stringify({
    model: "some-model",
    messages: [{ role: "user", content: "hi" }],
  });
  const headers = {
    ...signed(clientKey, { method: "POST", url, body }),
    "content-type": "application/json",
  };

  // A real registered route, so the assertion is not satisfied by a 404 that never
  // reached signature verification. No route binding exists for the model, so the
  // router refuses — but it refuses with a *routing* error, which proves the request
  // got past the signature gate.
  const accepted = await app.inject({ method: "POST", url, headers, payload: body });
  assert.notEqual(accepted.statusCode, 401, "a correctly signed body must verify");
  assert.equal(
    (accepted.json() as { error: { code: string } }).error.code,
    "no_route",
    "the request must reach the router, not stop at the signature gate",
  );

  // One byte changed, same signature.
  const tampered = await app.inject({
    method: "POST",
    url,
    headers,
    payload: JSON.stringify({
      model: "some-model",
      messages: [{ role: "user", content: "hj" }],
    }),
  });
  assert.equal(tampered.statusCode, 401);
  assert.equal(
    (tampered.json() as { error: { code: string } }).error.code,
    "signature_invalid",
  );
});

test("a stale or future timestamp is refused", async (t) => {
  const { app, runtime, clientKey } = harness(true);
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  for (const offset of [-(SIGNING_SKEW_MS + 5_000), SIGNING_SKEW_MS + 5_000]) {
    const response = await app.inject({
      method: "GET",
      url: "/api/providers",
      headers: signed(clientKey, {
        method: "GET",
        url: "/api/providers",
        at: Date.now() + offset,
      }),
    });
    assert.equal(response.statusCode, 401, `offset ${offset} was accepted`);
    assert.equal(
      (response.json() as { error: { code: string } }).error.code,
      "signature_stale",
    );
  }

  // Inside the window both directions are fine: a client clock is never exact, and
  // refusing a 5-second skew would make the feature unusable.
  for (const offset of [-(SIGNING_SKEW_MS - 5_000), SIGNING_SKEW_MS - 5_000]) {
    const response = await app.inject({
      method: "GET",
      url: "/api/providers",
      headers: signed(clientKey, {
        method: "GET",
        url: "/api/providers",
        at: Date.now() + offset,
      }),
    });
    assert.equal(response.statusCode, 200, `offset ${offset} was refused`);
  }
});

test("the documented skew is 60 seconds either way", () => {
  assert.equal(SIGNING_SKEW_MS, 60_000);
});

test("a replayed request is refused even though it is otherwise valid", async (t) => {
  const { app, runtime, clientKey } = harness(true);
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const headers = signed(clientKey, { method: "GET", url: "/api/providers" });

  const first = await app.inject({ method: "GET", url: "/api/providers", headers });
  assert.equal(first.statusCode, 200);

  // Byte-identical replay: correct signature, in-window timestamp, valid key.
  const replay = await app.inject({ method: "GET", url: "/api/providers", headers });
  assert.equal(replay.statusCode, 401);
  assert.equal(
    (replay.json() as { error: { code: string } }).error.code,
    "signature_replayed",
  );
});

test("a signature from a different key is refused", async (t) => {
  const { app, runtime, clientKey } = harness(true);
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const other = runtime.identities.createIdentity({
    id: "other",
    displayName: "Other",
    scopes: ["providers.read"],
  }).key;

  // Signed by `other`, presented as `clientKey`. Verification must use the key the
  // bearer identifies, not whichever key produces a match.
  const headers = signRequest({ key: other, method: "GET", url: "/api/providers", body: "" });
  const response = await app.inject({
    method: "GET",
    url: "/api/providers",
    headers: { ...headers, authorization: `Bearer ${clientKey}` },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(
    (response.json() as { error: { code: string } }).error.code,
    "signature_invalid",
  );
});

test("a malformed signature is refused without a length oracle", async (t) => {
  const { app, runtime, clientKey } = harness(true);
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  // Wrong length, wrong alphabet, empty, and absurdly long: each must produce the
  // same refusal, so comparison cost cannot be used to learn the digest width.
  for (const signature of ["", "zz", "not-hex", "a".repeat(63), "a".repeat(65), "a".repeat(20000)]) {
    const headers = signed(clientKey, { method: "GET", url: "/api/providers" });
    const response = await app.inject({
      method: "GET",
      url: "/api/providers",
      headers: { ...headers, [SIGNATURE_HEADER]: signature },
    });
    assert.equal(response.statusCode, 401, `signature ${signature.length} accepted`);
    assert.equal(
      (response.json() as { error: { code: string } }).error.code,
      "signature_invalid",
    );
  }
});

test("a malformed timestamp or nonce is refused", async (t) => {
  const { app, runtime, clientKey } = harness(true);
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const base = signed(clientKey, { method: "GET", url: "/api/providers" });
  const cases: Array<Record<string, string>> = [
    { [TIMESTAMP_HEADER]: "not-a-number" },
    { [TIMESTAMP_HEADER]: "" },
    { [TIMESTAMP_HEADER]: "-1" },
    { [TIMESTAMP_HEADER]: "1e10" },
    { [NONCE_HEADER]: "" },
    { [NONCE_HEADER]: "a".repeat(4096) },
  ];
  for (const override of cases) {
    const response = await app.inject({
      method: "GET",
      url: "/api/providers",
      headers: { ...base, ...override },
    });
    assert.equal(
      response.statusCode,
      401,
      `${JSON.stringify(override)} was accepted`,
    );
  }
});

test("the health probe is never signature-gated", async (t) => {
  const { app, runtime } = harness(true);
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  // A supervisor cannot sign. Gating liveness behind signing would turn the feature
  // into a guaranteed restart loop.
  const response = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.statusCode, 200);
});

test("the bootstrap token can sign too, so remote posture is not admin-only-broken", async (t) => {
  const { app, runtime } = harness(true);
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/status",
    headers: signed(TOKEN, { method: "GET", url: "/api/status" }),
  });
  // `admin` over the wire is refused elsewhere; over loopback with a signature the
  // bootstrap token must still work, or enabling signing would lock the operator out
  // of their own listener.
  assert.equal(response.statusCode, 200);
});

test("no signature material appears in a refusal body", async (t) => {
  const { app, runtime, clientKey } = harness(true);
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const headers = signed(clientKey, { method: "GET", url: "/api/providers" });
  const response = await app.inject({
    method: "GET",
    url: "/api/providers",
    headers: { ...headers, [SIGNATURE_HEADER]: "0".repeat(64) },
  });
  assert.equal(response.statusCode, 401);
  const body = response.body;
  assert.equal(body.includes(clientKey), false, "the client key must not be echoed");
  assert.equal(
    body.includes(headers[SIGNATURE_HEADER]!),
    false,
    "the expected signature must not be echoed",
  );
});
