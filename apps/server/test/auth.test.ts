import assert from "node:assert/strict";
import test from "node:test";
import { HealthSchema } from "@bayz/contracts";
import { buildApp } from "../src/app.js";

const TOKEN = "test-token-0123456789abcdef";
const AUTH = { authorization: `Bearer ${TOKEN}` };

function guardedApp(overrides: { rateLimit?: { max?: number; authMax?: number } } = {}) {
  return buildApp({
    logger: false,
    apiToken: TOKEN,
    registerTestRoutes: true,
    ...(overrides.rateLimit === undefined ? {} : { rateLimit: overrides.rateLimit }),
  });
}

test("GET /api/health stays unauthenticated and contract-identical", async (t) => {
  const app = guardedApp();
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.statusCode, 200);
  const body = HealthSchema.parse(response.json());
  assert.deepEqual(
    Object.keys(response.json()).sort(),
    ["status", "uptimeSeconds", "version"],
    "the Phase 1 health contract must not gain a field",
  );
  assert.equal(body.status, "ok");
});

test("a guarded route rejects a request with no Authorization header", async (t) => {
  const app = guardedApp();
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/__test/guarded" });
  assert.equal(response.statusCode, 401);
  const body = response.json();
  assert.equal(body.error.code, "unauthorized");
  assert.equal(typeof body.error.message, "string");
  assert.equal(typeof body.error.requestId, "string");
  assert.equal(response.headers["www-authenticate"], "Bearer");
});

test("every malformed Authorization shape fails closed", async (t) => {
  const app = guardedApp({ rateLimit: { authMax: 1000 } });
  t.after(() => app.close());

  for (const authorization of [
    "",
    "   ",
    TOKEN,
    `Bearer`,
    `Bearer `,
    `Bearer  ${TOKEN}`,
    `bearer${TOKEN}`,
    `Basic ${Buffer.from(`x:${TOKEN}`).toString("base64")}`,
    `Token ${TOKEN}`,
    `Bearer ${TOKEN} extra`,
    `Bearer ${TOKEN}\r\nX-Injected: 1`,
    `Bearer ${TOKEN.toUpperCase()}`,
    `Bearer ${TOKEN}x`,
    `Bearer ${TOKEN.slice(0, -1)}`,
  ]) {
    const response = await app.inject({
      method: "GET",
      url: "/__test/guarded",
      headers: { authorization },
    });
    assert.equal(
      response.statusCode,
      401,
      `authorization must be rejected: ${JSON.stringify(authorization)}`,
    );
  }
});

test("a duplicated Authorization header is ambiguous and fails closed", async (t) => {
  const app = guardedApp({ rateLimit: { authMax: 1000 } });
  t.after(() => app.close());

  // Fastify joins repeated headers with a comma; either way the value is no
  // longer a single bearer token and must not be accepted.
  const response = await app.inject({
    method: "GET",
    url: "/__test/guarded",
    headers: { authorization: `Bearer ${TOKEN}, Bearer ${TOKEN}` },
  });
  assert.equal(response.statusCode, 401);
});

test("a wrong token is indistinguishable from a missing one", async (t) => {
  const app = guardedApp({ rateLimit: { authMax: 1000 } });
  t.after(() => app.close());

  const missing = await app.inject({
    method: "GET",
    url: "/__test/guarded",
    headers: { "x-request-id": "req_fixed" },
  });
  const wrong = await app.inject({
    method: "GET",
    url: "/__test/guarded",
    headers: { authorization: "Bearer wrong-token-value-xxxxxxx", "x-request-id": "req_fixed" },
  });

  assert.equal(missing.statusCode, wrong.statusCode);
  assert.deepEqual(
    missing.json(),
    wrong.json(),
    "an attacker must not learn whether a token was supplied",
  );
});

test("the correct token is accepted", async (t) => {
  const app = guardedApp();
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/__test/guarded",
    headers: AUTH,
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });
});

test("a token supplied as a query parameter is not accepted", async (t) => {
  const app = guardedApp({ rateLimit: { authMax: 1000 } });
  t.after(() => app.close());

  // A URL-borne token would land in logs; only the header is honored.
  const response = await app.inject({
    method: "GET",
    url: `/__test/guarded?token=${TOKEN}`,
  });
  assert.equal(response.statusCode, 401);
});

test("an unknown guarded path is authenticated before it is resolved", async (t) => {
  const app = guardedApp({ rateLimit: { authMax: 1000 } });
  t.after(() => app.close());

  const unauthenticated = await app.inject({ method: "GET", url: "/api/does-not-exist" });
  assert.equal(
    unauthenticated.statusCode,
    401,
    "route existence must not be discoverable without a token",
  );

  const authenticated = await app.inject({
    method: "GET",
    url: "/api/does-not-exist",
    headers: AUTH,
  });
  assert.equal(authenticated.statusCode, 404);
});

test("no response carries a permissive CORS header", async (t) => {
  const app = guardedApp();
  t.after(() => app.close());

  for (const url of ["/api/health", "/__test/guarded"]) {
    const response = await app.inject({
      method: "GET",
      url,
      headers: { ...AUTH, origin: "https://evil.example.com" },
    });
    for (const header of [
      "access-control-allow-origin",
      "access-control-allow-credentials",
      "access-control-allow-headers",
    ]) {
      assert.equal(
        response.headers[header],
        undefined,
        `${header} must never be emitted (${url})`,
      );
    }
  }
});

test("a cross-origin browser request to a guarded route is refused", async (t) => {
  const app = guardedApp({ rateLimit: { authMax: 1000 } });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/__test/guarded",
    headers: { ...AUTH, origin: "https://evil.example.com" },
    payload: {},
  });
  assert.equal(
    response.statusCode,
    403,
    "an Origin from another site must not drive the local daemon",
  );
  assert.equal(response.json().error.code, "forbidden_origin");
});

test("a loopback origin is allowed", async (t) => {
  const app = guardedApp();
  t.after(() => app.close());

  for (const origin of [
    "http://127.0.0.1:20128",
    "http://localhost:20128",
    "http://[::1]:20128",
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/__test/guarded",
      headers: { ...AUTH, origin },
      payload: {},
    });
    assert.equal(response.statusCode, 200, `origin must be allowed: ${origin}`);
  }
});

test("a rebinding Host header is refused", async (t) => {
  const app = guardedApp({ rateLimit: { authMax: 1000 } });
  t.after(() => app.close());

  for (const host of [
    "evil.example.com",
    "evil.example.com:20128",
    "bayz.attacker.test",
  ]) {
    const response = await app.inject({
      method: "GET",
      url: "/__test/guarded",
      headers: { ...AUTH, host },
    });
    assert.equal(
      response.statusCode,
      403,
      `DNS rebinding host must be refused: ${host}`,
    );
    assert.equal(response.json().error.code, "forbidden_host");
  }
});

test("loopback Host values are accepted", async (t) => {
  const app = guardedApp();
  t.after(() => app.close());

  for (const host of ["127.0.0.1:20128", "localhost:20128", "[::1]:20128", "127.0.0.1"]) {
    const response = await app.inject({
      method: "GET",
      url: "/__test/guarded",
      headers: { ...AUTH, host },
    });
    assert.equal(response.statusCode, 200, `host must be allowed: ${host}`);
  }
});

test("an operator-supplied bind Host is served, matching a non-loopback deploy", async (t) => {
  // A LAN bind is reached by a client whose Host is the bound address. The real
  // entry supplies that address through `allowedHosts`; this is the guard honouring it.
  const app = buildApp({
    logger: false,
    apiToken: TOKEN,
    registerTestRoutes: true,
    rateLimit: { authMax: 1000 },
    allowedHosts: ["10.103.211.130"],
  });
  t.after(() => app.close());

  for (const host of ["10.103.211.130:20159", "10.103.211.130"]) {
    const ok = await app.inject({
      method: "GET",
      url: "/__test/guarded",
      headers: { ...AUTH, host },
    });
    assert.equal(ok.statusCode, 200, `the bound Host must be served: ${host}`);
  }
  // An unrelated hostname still fails closed against the same allowlist.
  const evil = await app.inject({
    method: "GET",
    url: "/__test/guarded",
    headers: { ...AUTH, host: "evil.example.com" },
  });
  assert.equal(evil.statusCode, 403);
  assert.equal(evil.json().error.code, "forbidden_host");
  // And an unauthorised request to the bound Host is still refused, not served.
  const unauth = await app.inject({
    method: "GET",
    url: "/__test/guarded",
    headers: { host: "10.103.211.130:20159" },
  });
  assert.equal(unauth.statusCode, 401);
});

test("health is still reachable under a hostile Host without leaking anything", async (t) => {
  const app = guardedApp({ rateLimit: { authMax: 1000 } });
  t.after(() => app.close());

  // Health is a liveness probe; it must not become an oracle either way, so it
  // is still guarded against rebinding.
  const response = await app.inject({
    method: "GET",
    url: "/api/health",
    headers: { host: "evil.example.com" },
  });
  assert.equal(response.statusCode, 403);
});

test("failed authentication is rate limited well below normal traffic", async (t) => {
  const app = guardedApp({ rateLimit: { authMax: 3, max: 1000 } });
  t.after(() => app.close());

  const codes: number[] = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await app.inject({ method: "GET", url: "/__test/guarded" });
    codes.push(response.statusCode);
  }
  assert.deepEqual(codes.slice(0, 3), [401, 401, 401]);
  assert.ok(
    codes.slice(3).every((code) => code === 429),
    `expected 429 after the auth budget, got ${codes.join(",")}`,
  );

  const limited = await app.inject({ method: "GET", url: "/__test/guarded" });
  assert.equal(limited.json().error.code, "rate_limited");
  assert.equal(limited.headers["retry-after"], "60");
});

test("a valid token is also rate limited, at a higher budget", async (t) => {
  const app = guardedApp({ rateLimit: { max: 4, authMax: 100 } });
  t.after(() => app.close());

  const codes: number[] = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: "/__test/guarded",
      headers: AUTH,
    });
    codes.push(response.statusCode);
  }
  assert.deepEqual(codes.slice(0, 4), [200, 200, 200, 200]);
  assert.ok(codes.slice(4).every((code) => code === 429));
});

test("rate limiting does not lock out the health probe", async (t) => {
  const app = guardedApp({ rateLimit: { authMax: 1, max: 1 } });
  t.after(() => app.close());

  await app.inject({ method: "GET", url: "/__test/guarded" });
  await app.inject({ method: "GET", url: "/__test/guarded" });
  const health = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(
    health.statusCode,
    200,
    "a liveness probe must not be starved by an attacker's failed logins",
  );
});

test("an unauthenticated body is never parsed or echoed", async (t) => {
  const app = guardedApp({ rateLimit: { authMax: 1000 } });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/__test/guarded",
    payload: { secret: "sk-should-never-be-echoed" },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.includes("sk-should-never-be-echoed"), false);
});

test("the error envelope shape is unchanged for auth failures", async (t) => {
  const app = guardedApp({ rateLimit: { authMax: 1000 } });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/__test/guarded",
    headers: { "x-request-id": "req_envelope_check" },
  });
  assert.deepEqual(Object.keys(response.json()), ["error"]);
  assert.deepEqual(
    Object.keys(response.json().error).sort(),
    ["code", "message", "requestId"],
  );
  assert.equal(response.json().error.requestId, "req_envelope_check");
});
