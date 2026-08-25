import assert from "node:assert/strict";
import test from "node:test";
import { HealthSchema } from "@bayz/contracts";
import { buildApp } from "../src/app.js";

test("GET /api/health returns the typed Core health response", async (t) => {
  const app = buildApp({ version: "0.1.0", logger: false });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.statusCode, 200);
  const body = HealthSchema.parse(response.json());
  assert.equal(body.status, "ok");
  assert.equal(body.version, "0.1.0");
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
