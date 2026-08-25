import assert from "node:assert/strict";
import test from "node:test";
import {
  ApiErrorSchema,
  ClientProtocolSchema,
  HealthSchema,
} from "../src/index.js";

test("accepts the stable health response", () => {
  const result = HealthSchema.parse({
    status: "ok",
    version: "0.1.0",
    uptimeSeconds: 12,
  });
  assert.equal(result.status, "ok");
});

test("rejects a health response with negative uptime", () => {
  assert.throws(() =>
    HealthSchema.parse({ status: "ok", version: "0.1.0", uptimeSeconds: -1 }),
  );
});

test("keeps API errors and client protocols stable", () => {
  const error = ApiErrorSchema.parse({
    error: {
      code: "internal_error",
      message: "Request failed",
      requestId: "req_123",
    },
  });
  assert.equal(error.error.requestId, "req_123");
  assert.equal(ClientProtocolSchema.parse("openai"), "openai");
  assert.equal(ClientProtocolSchema.parse("anthropic"), "anthropic");
});
