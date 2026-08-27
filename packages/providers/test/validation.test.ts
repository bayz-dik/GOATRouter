import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVIDER_KINDS,
  ProviderError,
  assertProviderId,
  defaultBaseUrl,
  normalizeBaseUrl,
  parseProviderConfig,
  type ProviderKind,
} from "../src/index.js";

function rejectsId(id: unknown): void {
  assert.throws(
    () => assertProviderId(id as string),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "invalid_provider_id",
    `id must be rejected: ${String(id)}`,
  );
}

function rejectsUrl(raw: unknown): void {
  assert.throws(
    () => normalizeBaseUrl(raw as string),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "invalid_provider_config",
    `url must be rejected: ${String(raw)}`,
  );
}

function rejectsConfig(input: unknown): void {
  assert.throws(
    () => parseProviderConfig(input, "openai-compatible"),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "invalid_provider_config",
    `config must be rejected: ${JSON.stringify(input)}`,
  );
}

test("ProviderError carries a fixed message and discards the cause", () => {
  const error = new ProviderError("provider_not_found", "get-provider");
  assert.ok(error instanceof Error);
  assert.equal(error.name, "ProviderError");
  assert.equal(error.code, "provider_not_found");
  assert.equal(error.stage, "get-provider");
  assert.match(error.message, /^provider_not_found: /);
  assert.match(error.message, /\(stage: get-provider\)$/);
  assert.equal(error.cause, undefined, "cause must never be attached");
});

test("a safe detail is appended and an unsafe one is dropped", () => {
  const named = new ProviderError(
    "invalid_provider_config",
    "config-header-denied",
    "authorization",
  );
  assert.equal(named.detail, "authorization");
  assert.match(named.message, /\(detail: authorization\)$/);

  // The detail is re-validated rather than trusted, because an error message reaches
  // logs and a UI. The charset stops markup, CRLF, and unbounded length.
  for (const hostile of [
    "a b",
    "<script>alert(1)</script>",
    "line\nbreak",
    "value: with colon",
    "x".repeat(65),
    "",
    "héader",
  ]) {
    const error = new ProviderError("invalid_provider_config", "stage", hostile);
    assert.equal(error.detail, undefined, JSON.stringify(hostile).slice(0, 24));
    assert.ok(!error.message.includes(hostile) || hostile.length === 0);
  }

  // Note the honest limit: a credential-shaped token would pass this charset. The
  // guarantee is therefore "the charset stops injection", plus the separate rule that
  // call sites pass a *name* they have already validated — never a value. The
  // `config-header-denied` site is the only producer today, and it passes the header
  // name it just rejected.
  assert.equal(
    new ProviderError("invalid_provider_config", "stage", "sk-looks-like-a-key").detail,
    "sk-looks-like-a-key",
  );
});

test("every provider error code has a distinct fixed message", () => {
  const codes = [
    "invalid_provider_id",
    "invalid_provider_config",
    "provider_already_exists",
    "provider_not_found",
    "credential_missing",
    "unsupported_operation",
    "unreachable",
    "auth_failed",
    "rate_limited",
    "upstream_error",
    "discovery_failed",
  ] as const;
  const messages = new Set<string>();
  for (const code of codes) {
    const message = new ProviderError(code).message;
    assert.match(message, new RegExp(`^${code}: `));
    messages.add(message);
  }
  assert.equal(messages.size, codes.length);
});

test("the supported provider kinds are exactly the five planned kinds", () => {
  // `custom-openai` added in 9D: a first-class generic relay, distinguished from
  // `openai-compatible` only so an operator can see which providers are their own
  // endpoints. It is treated as untrusted identically.
  assert.deepEqual([...PROVIDER_KINDS], [
    "openai-compatible",
    "openrouter",
    "gemini",
    "codex-oauth",
    "custom-openai",
  ]);
});

test("valid provider ids are accepted", () => {
  for (const id of ["p1", "openai", "local-llama-3", "a", "a".repeat(63), "9x"]) {
    assert.equal(assertProviderId(id), id);
  }
});

test("invalid provider ids are rejected before any storage work", () => {
  rejectsId("");
  rejectsId("Upper");
  rejectsId("-lead");
  rejectsId("trail-");
  rejectsId("has space");
  rejectsId("has_underscore");
  rejectsId("has.dot");
  rejectsId("a:b");
  rejectsId("a..b");
  rejectsId("a".repeat(64));
  rejectsId("p1; DROP TABLE providers");
  rejectsId("../../etc/passwd");
  rejectsId(42);
  rejectsId(undefined);
  rejectsId(null);
});

test("base urls are normalized", () => {
  assert.equal(normalizeBaseUrl("https://api.openai.com/v1"), "https://api.openai.com/v1");
  assert.equal(normalizeBaseUrl("HTTPS://API.OpenAI.COM/v1"), "https://api.openai.com/v1");
  assert.equal(normalizeBaseUrl("https://api.example.com/v1/"), "https://api.example.com/v1");
  assert.equal(normalizeBaseUrl("https://api.example.com/v1///"), "https://api.example.com/v1");
  assert.equal(normalizeBaseUrl("https://api.example.com"), "https://api.example.com");
  assert.equal(normalizeBaseUrl("http://127.0.0.1:11434"), "http://127.0.0.1:11434");
  assert.equal(normalizeBaseUrl("  http://127.0.0.1:8080/v1  "), "http://127.0.0.1:8080/v1");
  assert.equal(
    normalizeBaseUrl("https://api.example.com/v1?key=leak#frag"),
    "https://api.example.com/v1",
    "query and fragment must be stripped so no credential rides in the URL",
  );
});

test("hostile or unusable base urls are rejected", () => {
  rejectsUrl("");
  rejectsUrl("   ");
  rejectsUrl("not a url");
  rejectsUrl("/v1/models");
  rejectsUrl("api.example.com/v1");
  rejectsUrl("ftp://example.com");
  rejectsUrl("file:///etc/passwd");
  rejectsUrl("javascript:alert(1)");
  rejectsUrl("data:text/plain,hi");
  rejectsUrl("https://user:pass@example.com/v1");
  rejectsUrl("https://user@example.com/v1");
  rejectsUrl(`https://example.com/${"a".repeat(2100)}`);
  rejectsUrl(42);
  rejectsUrl(undefined);
});

test("url rejection messages never echo the offending input", () => {
  try {
    normalizeBaseUrl("https://user:sk-super-secret@evil.example.com/v1?token=abc");
    assert.fail("expected a rejection");
  } catch (error) {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.message.includes("sk-super-secret"), false);
    assert.equal(error.message.includes("evil.example.com"), false);
  }
});

test("openrouter has a default base url and other kinds require one", () => {
  assert.equal(defaultBaseUrl("openrouter"), "https://openrouter.ai/api");
  for (const kind of ["openai-compatible", "gemini", "codex-oauth"] as ProviderKind[]) {
    assert.equal(defaultBaseUrl(kind), undefined);
  }
});

test("an omitted config takes documented defaults", () => {
  assert.deepEqual(parseProviderConfig(undefined, "openai-compatible"), {
    timeoutMs: 30000,
    discoveryPath: "/v1/models",
    modelLimit: 100,
  });
  assert.deepEqual(parseProviderConfig({}, "gemini"), {
    timeoutMs: 30000,
    discoveryPath: "/v1beta/models",
    modelLimit: 100,
  });
  assert.equal(parseProviderConfig({}, "openrouter").discoveryPath, "/v1/models");
});

test("explicit config values inside range are preserved", () => {
  assert.deepEqual(
    parseProviderConfig(
      { timeoutMs: 1000, discoveryPath: "/models", modelLimit: 1 },
      "openai-compatible",
    ),
    { timeoutMs: 1000, discoveryPath: "/models", modelLimit: 1 },
  );
  assert.deepEqual(
    parseProviderConfig(
      { timeoutMs: 120000, discoveryPath: "/v1/models", modelLimit: 500 },
      "openai-compatible",
    ),
    { timeoutMs: 120000, discoveryPath: "/v1/models", modelLimit: 500 },
  );
});

test("out-of-range and non-integer numbers are rejected", () => {
  rejectsConfig({ timeoutMs: 999 });
  rejectsConfig({ timeoutMs: 120001 });
  rejectsConfig({ timeoutMs: 1500.5 });
  rejectsConfig({ timeoutMs: Number.NaN });
  rejectsConfig({ timeoutMs: Number.POSITIVE_INFINITY });
  rejectsConfig({ timeoutMs: "30000" });
  rejectsConfig({ modelLimit: 0 });
  rejectsConfig({ modelLimit: 501 });
  rejectsConfig({ modelLimit: 2.5 });
  rejectsConfig({ modelLimit: -1 });
});

test("discoveryPath must be a safe absolute path", () => {
  rejectsConfig({ discoveryPath: "" });
  rejectsConfig({ discoveryPath: "models" });
  rejectsConfig({ discoveryPath: "https://evil.example.com/models" });
  rejectsConfig({ discoveryPath: "//evil.example.com/models" });
  rejectsConfig({ discoveryPath: "/v1/../../secret" });
  rejectsConfig({ discoveryPath: "/v1/models?key=leak" });
  rejectsConfig({ discoveryPath: "/v1/models#frag" });
  rejectsConfig({ discoveryPath: "/v1/mo dels" });
  rejectsConfig({ discoveryPath: "/v1/models\n" });
  rejectsConfig({ discoveryPath: `/${"a".repeat(600)}` });
  rejectsConfig({ discoveryPath: 7 });
});

test("unknown keys are rejected, which makes header smuggling unrepresentable", () => {
  rejectsConfig({ headers: { Authorization: "Bearer sk-attacker" } });
  rejectsConfig({ Authorization: "Bearer sk-attacker" });
  rejectsConfig({ authorization: "Bearer sk-attacker" });
  rejectsConfig({ apiKey: "sk-attacker" });
  rejectsConfig({ proxy: "http://127.0.0.1:9050" });
  rejectsConfig({ timeoutMs: 30000, extra: true });
  rejectsConfig({ __proto__: { polluted: true }, timeoutMs: 30000 });
});

test("non-object configs are rejected", () => {
  rejectsConfig(null);
  rejectsConfig("timeoutMs=1");
  rejectsConfig(42);
  rejectsConfig([]);
  rejectsConfig(true);
});

test("parsing returns a fresh object and does not mutate its input", () => {
  const input = { timeoutMs: 5000 };
  const parsed = parseProviderConfig(input, "openai-compatible");
  assert.deepEqual(input, { timeoutMs: 5000 });
  assert.notEqual(parsed, input);
  parsed.timeoutMs = 9000;
  assert.equal(parseProviderConfig(input, "openai-compatible").timeoutMs, 5000);
});
