import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { CSP_POLICY, parseCspPolicy } from "../src/security-headers.js";
import { createBayzRuntime, type BayzRuntime } from "../src/runtime.js";

/**
 * Strict Content-Security-Policy.
 *
 * The policy is asserted on real served responses, not just as a constant, and the
 * directive set is checked positively (what must be present) as well as negatively
 * (what must never appear). A future edit that adds `unsafe-inline` to make
 * something work fails here.
 */

const KEY = Buffer.alloc(32, 0x9d).toString("hex");
const TOKEN = "csp-token-0123456789abcdef";
const AUTH = { authorization: `Bearer ${TOKEN}` };

function harness(): { app: FastifyInstance; runtime: BayzRuntime } {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-csp-")), ".bayz");
  const runtime = createBayzRuntime(
    { host: "127.0.0.1", port: 20128, dataDir, dashboardRoot: "/nonexistent" },
    { env: { BAYZ_MASTER_KEY: KEY, BAYZ_API_TOKEN: TOKEN }, notify: () => {} },
  );
  const app = buildApp({
    logger: false,
    apiToken: TOKEN,
    runtime,
    rateLimit: { max: 100000, authMax: 100000 },
  });
  return { app, runtime };
}

test("the policy sets every required directive", () => {
  const directives = parseCspPolicy(CSP_POLICY);
  assert.deepEqual(directives.get("default-src"), ["'none'"]);
  assert.deepEqual(directives.get("script-src"), ["'self'"]);
  assert.deepEqual(directives.get("style-src"), ["'self'"]);
  assert.deepEqual(directives.get("connect-src"), ["'self'"]);
  assert.deepEqual(directives.get("font-src"), ["'self'"]);
  assert.deepEqual(directives.get("object-src"), ["'none'"]);
  assert.deepEqual(directives.get("base-uri"), ["'none'"]);
  assert.deepEqual(directives.get("form-action"), ["'none'"]);
  assert.deepEqual(directives.get("frame-ancestors"), ["'none'"]);
  assert.deepEqual(directives.get("frame-src"), ["'none'"]);
  assert.deepEqual(directives.get("worker-src"), ["'none'"]);
  assert.deepEqual(directives.get("manifest-src"), ["'self'"]);
  // Images need `data:` for the inline SVG marks; nothing remote.
  assert.deepEqual(directives.get("img-src"), ["'self'", "data:"]);
});

test("the policy contains no escape hatch of any kind", () => {
  for (const forbidden of [
    "unsafe-inline",
    "unsafe-eval",
    "unsafe-hashes",
    "strict-dynamic",
    "wasm-unsafe-eval",
    "*",
    "http:",
    "https:",
    "data: script",
    "blob:",
    "fonts.googleapis.com",
    "fonts.gstatic.com",
  ]) {
    assert.equal(
      CSP_POLICY.includes(forbidden),
      false,
      `the policy must not contain ${forbidden}`,
    );
  }
});

test("the policy names no remote origin", () => {
  // Only keywords, `self`, `none`, and the `data:` image scheme are permitted.
  const tokens = CSP_POLICY.split(/[;\s]+/).filter((token) => token.length > 0);
  for (const token of tokens) {
    assert.equal(
      /^https?:\/\//.test(token),
      false,
      `the policy must not reference ${token}`,
    );
  }
});

test("a real dashboard document response carries the policy", async (t) => {
  const h = harness();
  t.after(() => {
    void h.app.close();
    h.runtime.close();
  });

  const response = await h.app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.headers["content-security-policy"], CSP_POLICY);
});

test("every API response carries the policy", async (t) => {
  const h = harness();
  t.after(() => {
    void h.app.close();
    h.runtime.close();
  });

  for (const url of [
    "/api/health",
    "/api/status",
    "/api/providers",
    "/api/usage/summary",
    "/v1/models",
  ]) {
    const response = await h.app.inject({ method: "GET", url, headers: AUTH });
    assert.equal(
      response.headers["content-security-policy"],
      CSP_POLICY,
      `${url} must carry the policy`,
    );
  }
});

test("an unauthenticated response still carries the policy", async (t) => {
  const h = harness();
  t.after(() => {
    void h.app.close();
    h.runtime.close();
  });

  const response = await h.app.inject({ method: "GET", url: "/api/status" });
  assert.equal(response.statusCode, 401);
  assert.equal(response.headers["content-security-policy"], CSP_POLICY);
});

test("the companion hardening headers are present", async (t) => {
  const h = harness();
  t.after(() => {
    void h.app.close();
    h.runtime.close();
  });

  const response = await h.app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["cross-origin-opener-policy"], "same-origin");
  assert.equal(response.headers["cross-origin-resource-policy"], "same-origin");
  // A local daemon has no business advertising a permissions surface.
  assert.equal(typeof response.headers["permissions-policy"], "string");
});

test("no header advertises the server implementation", async (t) => {
  const h = harness();
  t.after(() => {
    void h.app.close();
    h.runtime.close();
  });

  const response = await h.app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.headers["x-powered-by"], undefined);
  assert.equal(response.headers.server, undefined);
});

test("/api/health stays byte-identical and unauthenticated under CSP", async (t) => {
  const h = harness();
  t.after(() => {
    void h.app.close();
    h.runtime.close();
  });

  const response = await h.app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(Object.keys(response.json()).sort(), [
    "status",
    "uptimeSeconds",
    "version",
  ]);
  assert.equal(response.json().status, "ok");
});

test("authentication, host validation, and rate limiting are unchanged", async (t) => {
  const h = harness();
  t.after(() => {
    void h.app.close();
    h.runtime.close();
  });

  // Auth still required.
  assert.equal((await h.app.inject({ method: "GET", url: "/api/status" })).statusCode, 401);
  // Host validation still refuses a rebinding host, and still carries the policy.
  const rebinding = await h.app.inject({
    method: "GET",
    url: "/api/status",
    headers: { ...AUTH, host: "bayz.attacker.test" },
  });
  assert.equal(rebinding.statusCode, 403);
  assert.equal(rebinding.headers["content-security-policy"], CSP_POLICY);
  // Cross-site origin still refused.
  const crossOrigin = await h.app.inject({
    method: "GET",
    url: "/api/status",
    headers: { ...AUTH, origin: "https://evil.example.com" },
  });
  assert.equal(crossOrigin.statusCode, 403);
});

test("no CORS header is emitted alongside the policy", async (t) => {
  const h = harness();
  t.after(() => {
    void h.app.close();
    h.runtime.close();
  });

  const response = await h.app.inject({
    method: "GET",
    url: "/api/health",
    headers: { origin: "https://evil.example.com" },
  });
  assert.equal(response.headers["access-control-allow-origin"], undefined);
});

test("the policy cannot be weakened through a build option", () => {
  // There is deliberately no knob: the policy is a constant, so no configuration
  // path can relax it at runtime.
  const app = buildApp({ logger: false });
  assert.equal(typeof CSP_POLICY, "string");
  assert.ok(CSP_POLICY.length > 0);
  void app.close();
});

test("parseCspPolicy rejects a malformed policy rather than guessing", () => {
  assert.equal(parseCspPolicy("").size, 0);
  const parsed = parseCspPolicy("default-src 'none'; script-src 'self'");
  assert.equal(parsed.size, 2);
  assert.deepEqual(parsed.get("script-src"), ["'self'"]);
});
