import assert from "node:assert/strict";
import test from "node:test";
import { ProviderError, parseProviderConfig } from "../src/index.js";

function config(headers: unknown): unknown {
  return { headers };
}

function refused(input: unknown, stageHint?: string): void {
  assert.throws(
    () => parseProviderConfig(input, "openai-compatible"),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "invalid_provider_config",
    `accepted ${JSON.stringify(input)?.slice(0, 80)}${stageHint ? ` (${stageHint})` : ""}`,
  );
}

test("a safe custom header is accepted and normalized to lower case", () => {
  const parsed = parseProviderConfig(
    config({ "X-Relay-Token": "abc123" }),
    "openai-compatible",
  );
  // Lower-cased on the way in so the denylist cannot be evaded by casing and so two
  // spellings of one header cannot both be set.
  assert.deepEqual(parsed.headers, { "x-relay-token": "abc123" });
});

test("the existing three config keys still work and an unknown key is still refused", () => {
  const parsed = parseProviderConfig(
    { timeoutMs: 5000, discoveryPath: "/v1/models", modelLimit: 10 },
    "openai-compatible",
  );
  assert.equal(parsed.timeoutMs, 5000);
  assert.equal(parsed.discoveryPath, "/v1/models");
  assert.equal(parsed.modelLimit, 10);
  assert.equal(parsed.headers, undefined);

  // The Phase 3 posture is preserved: unknown keys are a loud failure.
  refused({ unknownKey: 1 });
});

test("the denylist is enforced after the allowlist and every casing is refused", () => {
  // Order matters. A name can be perfectly well-formed and still be forbidden, so the
  // denylist runs on the already-normalized name rather than being folded into the
  // pattern — which is what makes `Authorization` and `AUTHORIZATION` both refused.
  for (const name of [
    "authorization",
    "Authorization",
    "AUTHORIZATION",
    "aUtHoRiZaTiOn",
    "proxy-authorization",
    "Proxy-Authorization",
    "host",
    "Host",
    "cookie",
    "set-cookie",
    "content-length",
    "transfer-encoding",
    "connection",
    "upgrade",
    "te",
    "trailer",
    "expect",
    "keep-alive",
    "sec-fetch-mode",
    "Sec-Fetch-Site",
    "proxy-connection",
    "Proxy-Anything",
  ]) {
    refused(config({ [name]: "value" }), name);
  }
});

test("a denied header is an error, never silently dropped", () => {
  // Dropping would leave the operator believing a header is being sent, and debugging
  // a relay that never receives it is miserable.
  assert.throws(
    () => parseProviderConfig(config({ authorization: "Bearer x" }), "openai-compatible"),
    (error: unknown) =>
      error instanceof ProviderError && error.stage === "config-header-denied",
  );
});

test("a name outside the allowlist pattern is refused", () => {
  for (const name of [
    "",
    " ",
    "-leading",
    "1leading",
    "has space",
    "has:colon",
    "has_underscore",
    "has.dot",
    "has/slash",
    "hasé",
    "x".repeat(65),
    "x\ny",
    "x\r\ny",
  ]) {
    refused(config({ [name]: "value" }), name);
  }
});

test("a trailing hyphen is permitted, matching the specified pattern", () => {
  // Corrected from an initial assumption that this should be refused. A header name
  // ending in a hyphen is a legal HTTP token and creates no injection or framing
  // hazard, so refusing it would restrict a relay for no security benefit. The
  // allowlist pattern is `^[A-Za-z][A-Za-z0-9-]{0,63}$` exactly as specified.
  const parsed = parseProviderConfig(
    config({ "x-relay-": "value" }),
    "openai-compatible",
  );
  assert.deepEqual(parsed.headers, { "x-relay-": "value" });
});

test("a value containing CR, LF, NUL, or a non-ASCII byte is refused", () => {
  // Header injection: a value containing CRLF would end the header and let the
  // attacker write arbitrary further headers, or a body.
  for (const value of [
    "a\rb",
    "a\nb",
    "a\r\nb",
    "a\r\nX-Injected: yes",
    "a\u0000b",
    "a\u007fb",
    "café",
    "a\u2028b",
    "a\tb",
  ]) {
    refused(config({ "x-relay": value }), JSON.stringify(value));
  }
});

test("a printable ASCII value at the boundary length is accepted", () => {
  const parsed = parseProviderConfig(
    config({ "x-relay": "a".repeat(1024) }),
    "openai-compatible",
  );
  assert.equal((parsed.headers as Record<string, string>)["x-relay"]!.length, 1024);
  refused(config({ "x-relay": "a".repeat(1025) }));
});

test("an empty value is accepted but a non-string is refused", () => {
  // An empty header value is legal HTTP and some relays use its presence as a flag.
  const parsed = parseProviderConfig(config({ "x-flag": "" }), "openai-compatible");
  assert.equal((parsed.headers as Record<string, string>)["x-flag"], "");

  for (const value of [42, null, undefined, {}, [], true]) {
    refused(config({ "x-relay": value }));
  }
});

test("more than eight headers is refused", () => {
  const eight: Record<string, string> = {};
  for (let index = 0; index < 8; index += 1) {
    eight[`x-h${index}`] = "v";
  }
  const parsed = parseProviderConfig(config(eight), "openai-compatible");
  assert.equal(Object.keys(parsed.headers as object).length, 8);

  refused(config({ ...eight, "x-h8": "v" }));
});

test("a non-object headers value is refused", () => {
  for (const headers of [null, [], "x-relay: v", 42, true, new Map()]) {
    refused(config(headers));
  }
});

test("a prototype-polluted headers object is refused", () => {
  const hostile = JSON.parse('{"headers":{"__proto__":{"polluted":true}}}');
  refused(hostile);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);

  const replaced = { headers: Object.create({ "x-inherited": "v" }) };
  refused(replaced);
});

test("two spellings of one header cannot both be set", () => {
  // After normalization they are the same key, and silently keeping one would make
  // which value is sent depend on object insertion order.
  refused(config({ "X-Relay": "one", "x-relay": "two" }));
});

test("allowLoopback is accepted as a boolean and defaults to absent", () => {
  const parsed = parseProviderConfig({ allowLoopback: true }, "openai-compatible");
  assert.equal(parsed.allowLoopback, true);

  const bare = parseProviderConfig(undefined, "openai-compatible");
  assert.equal(bare.allowLoopback, undefined);

  for (const value of ["true", 1, null, {}]) {
    refused({ allowLoopback: value });
  }
});

test("allowPrivate is accepted as a boolean", () => {
  const parsed = parseProviderConfig({ allowPrivate: true }, "openai-compatible");
  assert.equal(parsed.allowPrivate, true);
  refused({ allowPrivate: "yes" });
});

test("the parsed headers object is a fresh copy", () => {
  const input = { headers: { "x-relay": "v" } };
  const parsed = parseProviderConfig(input, "openai-compatible");
  (parsed.headers as Record<string, string>)["x-relay"] = "mutated";
  assert.equal(input.headers["x-relay"], "v");
});

test("headers round-trip through JSON unchanged", () => {
  // The config is persisted as JSON, so anything that does not survive the round trip
  // would silently change on reload.
  const parsed = parseProviderConfig(
    config({ "x-relay": "v", "x-other": "" }),
    "openai-compatible",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), parsed);
});

test("supportsTools remains a tri-state boolean", () => {
  assert.equal(parseProviderConfig({ supportsTools: true }, "openai-compatible").supportsTools, true);
  assert.equal(parseProviderConfig({ supportsTools: false }, "openai-compatible").supportsTools, false);
  assert.equal(parseProviderConfig({}, "openai-compatible").supportsTools, undefined);
  refused({ supportsTools: "yes" });
});
