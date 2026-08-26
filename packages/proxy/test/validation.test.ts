import assert from "node:assert/strict";
import test from "node:test";
import {
  PROXY_KINDS,
  ProxyError,
  assertProxyId,
  parseProxyConfig,
  parseProxyEndpoint,
  parseProxyHost,
} from "../src/index.js";

function rejectsId(id: unknown): void {
  assert.throws(
    () => assertProxyId(id as string),
    (error: unknown) =>
      error instanceof ProxyError && error.code === "invalid_proxy_id",
    `id must be rejected: ${String(id)}`,
  );
}

function rejectsHost(host: unknown): void {
  assert.throws(
    () => parseProxyHost(host as string),
    (error: unknown) =>
      error instanceof ProxyError && error.code === "invalid_proxy_config",
    `host must be rejected: ${String(host)}`,
  );
}

function rejectsConfig(input: unknown): void {
  assert.throws(
    () => parseProxyConfig(input),
    (error: unknown) =>
      error instanceof ProxyError && error.code === "invalid_proxy_config",
    `config must be rejected: ${JSON.stringify(input)}`,
  );
}

test("ProxyError carries a fixed message and discards the cause", () => {
  const error = new ProxyError("auth_failed", "socks5-userpass");
  assert.ok(error instanceof Error);
  assert.equal(error.name, "ProxyError");
  assert.equal(error.code, "auth_failed");
  assert.equal(error.stage, "socks5-userpass");
  assert.match(error.message, /^auth_failed: /);
  assert.match(error.message, /\(stage: socks5-userpass\)$/);
  assert.equal(error.cause, undefined, "cause must never be attached");
});

test("every proxy error code has a distinct fixed message", () => {
  const codes = [
    "invalid_proxy_id",
    "invalid_proxy_config",
    "proxy_already_exists",
    "proxy_not_found",
    "password_missing",
    "unsupported_operation",
    "unreachable",
    "refused",
    "timeout",
    "auth_failed",
    "forbidden",
    "protocol_error",
    "proxy_error",
  ] as const;
  const messages = new Set<string>();
  for (const code of codes) {
    const message = new ProxyError(code).message;
    assert.match(message, new RegExp(`^${code}: `));
    messages.add(message);
  }
  assert.equal(messages.size, codes.length);
});

test("the supported proxy kinds are exactly socks5 and http", () => {
  assert.deepEqual([...PROXY_KINDS], ["socks5", "http"]);
});

test("valid proxy ids are accepted", () => {
  for (const id of ["p1", "tor", "home-vps-1", "a", "a".repeat(63)]) {
    assert.equal(assertProxyId(id), id);
  }
});

test("invalid proxy ids are rejected", () => {
  rejectsId("");
  rejectsId("Upper");
  rejectsId("-lead");
  rejectsId("trail-");
  rejectsId("has space");
  rejectsId("has_underscore");
  rejectsId("a:b");
  rejectsId("a..b");
  rejectsId("a".repeat(64));
  rejectsId("p1'; DROP TABLE proxies; --");
  rejectsId(42);
  rejectsId(undefined);
});

test("bare hostnames and IP literals are accepted and lowercased", () => {
  assert.equal(parseProxyHost("127.0.0.1"), "127.0.0.1");
  assert.equal(parseProxyHost("localhost"), "localhost");
  assert.equal(parseProxyHost("Proxy.Example.COM"), "proxy.example.com");
  assert.equal(parseProxyHost("  proxy.example.com  "), "proxy.example.com");
  assert.equal(parseProxyHost("[::1]"), "[::1]");
  assert.equal(parseProxyHost("[2001:db8::1]"), "[2001:db8::1]");
  assert.equal(parseProxyHost("a-b.c-d.example"), "a-b.c-d.example");
  assert.equal(parseProxyHost("xn--80ak6aa92e.com"), "xn--80ak6aa92e.com");
});

test("a host that is really a URL or carries structure is rejected", () => {
  rejectsHost("socks5://127.0.0.1");
  rejectsHost("http://proxy.example.com");
  rejectsHost("proxy.example.com/path");
  rejectsHost("user@proxy.example.com");
  rejectsHost("proxy.example.com:1080");
  rejectsHost("proxy.example.com?a=b");
  rejectsHost("proxy.example.com#frag");
  rejectsHost("proxy example.com");
  rejectsHost("proxy.example.com\r\nHost: evil");
  rejectsHost("proxy.example\r\n.com");
  rejectsHost("proxy\u0000.example.com");
  rejectsHost("");
  rejectsHost("   ");
  rejectsHost(".leading.dot");
  rejectsHost("trailing.dot.");
  rejectsHost("-lead.example.com");
  rejectsHost("trail-.example.com");
  rejectsHost("double..dot.example.com");
  rejectsHost(`${"a".repeat(64)}.example.com`);
  rejectsHost(`${"a".repeat(250)}.${"b".repeat(60)}`);
  rejectsHost("[::1");
  rejectsHost("::1");
  rejectsHost("[not:hex:zz]");
  rejectsHost(42);
  rejectsHost(undefined);
});

test("an endpoint pairs a validated host with a validated port", () => {
  assert.deepEqual(parseProxyEndpoint({ host: "127.0.0.1", port: 1080 }), {
    host: "127.0.0.1",
    port: 1080,
  });
  assert.deepEqual(parseProxyEndpoint({ host: "Proxy.EXAMPLE.com", port: 65535 }), {
    host: "proxy.example.com",
    port: 65535,
  });
  assert.equal(parseProxyEndpoint({ host: "[::1]", port: 1 }).port, 1);
});

test("out-of-range and non-integer ports are rejected", () => {
  for (const port of [0, -1, 65536, 1.5, Number.NaN, "1080", null, undefined]) {
    assert.throws(
      () => parseProxyEndpoint({ host: "127.0.0.1", port: port as number }),
      (error: unknown) =>
        error instanceof ProxyError && error.code === "invalid_proxy_config",
      `port must be rejected: ${String(port)}`,
    );
  }
});

test("host rejection messages never echo the offending input", () => {
  try {
    parseProxyHost("user:hunter2-secret@evil.example.com");
    assert.fail("expected a rejection");
  } catch (error) {
    assert.ok(error instanceof ProxyError);
    assert.equal(error.message.includes("hunter2-secret"), false);
    assert.equal(error.message.includes("evil.example.com"), false);
  }
});

test("an omitted config takes documented defaults", () => {
  assert.deepEqual(parseProxyConfig(undefined), {
    connectTimeoutMs: 10000,
    healthCheckHost: "1.1.1.1",
    healthCheckPort: 443,
  });
  assert.deepEqual(parseProxyConfig({}), {
    connectTimeoutMs: 10000,
    healthCheckHost: "1.1.1.1",
    healthCheckPort: 443,
  });
});

test("explicit config values inside range are preserved and normalized", () => {
  assert.deepEqual(
    parseProxyConfig({
      connectTimeoutMs: 500,
      healthCheckHost: "Example.COM",
      healthCheckPort: 80,
    }),
    { connectTimeoutMs: 500, healthCheckHost: "example.com", healthCheckPort: 80 },
  );
  assert.equal(parseProxyConfig({ connectTimeoutMs: 60000 }).connectTimeoutMs, 60000);
});

test("out-of-range or non-integer config numbers are rejected", () => {
  rejectsConfig({ connectTimeoutMs: 499 });
  rejectsConfig({ connectTimeoutMs: 60001 });
  rejectsConfig({ connectTimeoutMs: 1000.5 });
  rejectsConfig({ connectTimeoutMs: "10000" });
  rejectsConfig({ connectTimeoutMs: Number.POSITIVE_INFINITY });
  rejectsConfig({ healthCheckPort: 0 });
  rejectsConfig({ healthCheckPort: 65536 });
  rejectsConfig({ healthCheckPort: 443.5 });
});

test("a health-check host is validated like any other host", () => {
  rejectsConfig({ healthCheckHost: "https://example.com" });
  rejectsConfig({ healthCheckHost: "example.com:443" });
  rejectsConfig({ healthCheckHost: "example.com\r\nX: y" });
  rejectsConfig({ healthCheckHost: "" });
  rejectsConfig({ healthCheckHost: 42 });
});

test("unknown config keys are rejected, so no command or header can be smuggled", () => {
  rejectsConfig({ command: "curl evil.example.com" });
  rejectsConfig({ headers: { "Proxy-Authorization": "Basic abc" } });
  rejectsConfig({ password: "hunter2" });
  rejectsConfig({ exec: "/bin/sh" });
  rejectsConfig({ connectTimeoutMs: 10000, extra: true });
  rejectsConfig({ __proto__: { polluted: true }, connectTimeoutMs: 10000 });
});

test("non-object configs are rejected", () => {
  rejectsConfig(null);
  rejectsConfig("connectTimeoutMs=1");
  rejectsConfig(42);
  rejectsConfig([]);
  rejectsConfig(true);
});

test("parsing returns a fresh object and does not mutate its input", () => {
  const input = { connectTimeoutMs: 5000 };
  const parsed = parseProxyConfig(input);
  assert.deepEqual(input, { connectTimeoutMs: 5000 });
  assert.notEqual(parsed, input);
  parsed.connectTimeoutMs = 9000;
  assert.equal(parseProxyConfig(input).connectTimeoutMs, 5000);
});
