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

const SENSITIVE_NAMES = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "apiKey",
  "api_key",
  "api-key",
  "password",
  "proxyPassword",
  "proxy_password",
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "clientSecret",
  "client_secret",
  "masterKey",
  "master_key",
  "privateKey",
  "private_key",
  "secret",
  "credential",
  "dek",
  "kek",
  "wrappedDek",
  "passphrase",
  "ciphertext",
];

test("redacts every sensitive field name", () => {
  for (const name of SENSITIVE_NAMES) {
    const output = redactSecrets({ [name]: "sk-live-plaintext" }) as Record<
      string,
      unknown
    >;
    assert.equal(
      output[name],
      "[REDACTED]",
      `expected ${name} to be redacted`,
    );
  }
});

test("redacts sensitive names across casing and separator variants", () => {
  const variants = (name: string): string[] => {
    const bare = name.toLowerCase().replace(/[-_]/g, "");
    return [
      bare,
      bare.toUpperCase(),
      name.toUpperCase(),
      name.replace(/_/g, "-"),
      name.replace(/-/g, "_"),
      bare.charAt(0).toUpperCase() + bare.slice(1),
    ];
  };

  for (const name of SENSITIVE_NAMES) {
    for (const variant of variants(name)) {
      const output = redactSecrets({ [variant]: "sk-live-plaintext" }) as Record<
        string,
        unknown
      >;
      assert.equal(
        output[variant],
        "[REDACTED]",
        `expected variant ${variant} of ${name} to be redacted`,
      );
    }
  }
});

test("does not redact non-secret neighbours that merely contain a secret word", () => {
  const input = {
    model: "gpt-test",
    tokenCount: 1234,
    secretName: "provider:openai:api_key",
    cookieConsent: true,
    passwordPolicy: "min-12",
    keyId: "kek_ab12",
    algorithm: "aes-256-gcm",
    schemaVersion: 1,
  };

  assert.deepEqual(redactSecrets(input), input);
});

test("redacts sensitive fields nested inside arrays and deep objects", () => {
  const output = redactSecrets({
    level1: {
      level2: [
        { kek: "raw-kek-bytes", keep: "visible" },
        { nested: { wrappedDek: "raw-dek", also: "visible" } },
      ],
    },
  }) as Record<string, unknown>;

  assert.deepEqual(output, {
    level1: {
      level2: [
        { kek: "[REDACTED]", keep: "visible" },
        { nested: { wrappedDek: "[REDACTED]", also: "visible" } },
      ],
    },
  });
});
