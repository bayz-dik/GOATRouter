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
