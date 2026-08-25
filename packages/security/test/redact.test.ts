import assert from "node:assert/strict";
import test from "node:test";
import { redactSecrets } from "../src/index.js";

test("redacts secret fields recursively without mutating input", () => {
  const input = {
    authorization: "Bearer secret",
    nested: {
      apiKey: "sk-provider",
      proxyPassword: "proxy-secret",
      safe: "visible",
    },
    rows: [{ cookie: "session=secret", model: "gpt-test" }],
  };

  const output = redactSecrets(input);

  assert.deepEqual(output, {
    authorization: "[REDACTED]",
    nested: {
      apiKey: "[REDACTED]",
      proxyPassword: "[REDACTED]",
      safe: "visible",
    },
    rows: [{ cookie: "[REDACTED]", model: "gpt-test" }],
  });
  assert.equal(input.nested.apiKey, "sk-provider");
});

test("preserves null, primitives, and dates", () => {
  const when = new Date("2026-08-25T00:00:00Z");
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets("safe"), "safe");
  assert.equal(redactSecrets(when), when);
});
