import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HealthSchema } from "@bayz/contracts";
import { buildApp } from "../src/app.js";

test("GET /api/health reports the exact shipped package version by default", async (t) => {
  // Version drift regression: the health endpoint must report the version of the
  // package this server actually ships, so a release that forgets to bump the
  // version string cannot silently answer with a stale one. The manifest is
  // resolved the same way src/version.ts resolves it.
  const manifestUrl = new URL("../package.json", import.meta.url);
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(manifestUrl), "utf8"),
  ) as { version: string };

  // No `version` option: the app's default (from src/version.ts) applies.
  const app = buildApp({ logger: false });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.statusCode, 200);
  const body = HealthSchema.parse(response.json());
  assert.equal(body.status, "ok");
  assert.equal(body.version, manifest.version);
  assert.ok(body.uptimeSeconds >= 0);
});

test("GET /api/health honors an explicit version override", async (t) => {
  const manifestUrl = new URL("../package.json", import.meta.url);
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(manifestUrl), "utf8"),
  ) as { version: string };

  const app = buildApp({ version: manifest.version, logger: false });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.statusCode, 200);
  const body = HealthSchema.parse(response.json());
  assert.equal(body.status, "ok");
  assert.equal(body.version, manifest.version);
  assert.ok(body.uptimeSeconds >= 0);
});

test("preserves a valid client request ID", async (t) => {
  const app = buildApp({ logger: false });
  t.after(() => app.close());
  const response = await app.inject({
    method: "GET",
    url: "/api/health",
    headers: { "x-request-id": "req_client_123" },
  });
  assert.equal(response.headers["x-request-id"], "req_client_123");
});

test("returns a redacted stable error envelope", async (t) => {
  const app = buildApp({ logger: false, registerTestRoutes: true });
  t.after(() => app.close());
  const response = await app.inject({
    method: "GET",
    url: "/__test/error",
    headers: { "x-request-id": "req_error_123" },
  });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), {
    error: {
      code: "internal_error",
      message: "Request failed",
      requestId: "req_error_123",
    },
  });
  assert.doesNotMatch(response.body, /sk-secret/);
});
