import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_EGRESS_POLICY,
  ProviderError,
  assertEgressAllowed,
  assertResolvedAddressAllowed,
  isEgressAllowed,
} from "../src/index.js";

const DEFAULT = DEFAULT_EGRESS_POLICY;
const LOOPBACK_OK = { allowLoopback: true, allowPrivate: false };
const PRIVATE_OK = { allowLoopback: false, allowPrivate: true };

function refused(hostname: string, policy = DEFAULT): void {
  assert.throws(
    () => assertEgressAllowed(hostname, policy),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "invalid_provider_config",
    `accepted ${hostname}`,
  );
  assert.equal(isEgressAllowed(hostname, policy), false, `isEgressAllowed(${hostname})`);
}

function allowed(hostname: string, policy = DEFAULT): void {
  assertEgressAllowed(hostname, policy);
  assert.equal(isEgressAllowed(hostname, policy), true, `isEgressAllowed(${hostname})`);
}

test("the default policy denies loopback and private ranges", () => {
  assert.deepEqual(DEFAULT_EGRESS_POLICY, {
    allowLoopback: false,
    allowPrivate: false,
  });
  assert.ok(Object.isFrozen(DEFAULT_EGRESS_POLICY));
});

test("loopback in every spelling is refused by default", () => {
  for (const hostname of [
    "127.0.0.1",
    "127.0.0.2",
    "127.255.255.254",
    "0.0.0.0",
    "[::1]",
    "::1",
    "[::]",
    "localhost",
    "LOCALHOST",
    "localhost.",
    "ip6-localhost",
  ]) {
    refused(hostname);
  }
});

test("alternate integer encodings of loopback are refused", () => {
  // `fetch("http://2130706433")` reaches 127.0.0.1. A validator that only pattern-
  // matched dotted quads would wave every one of these through.
  for (const hostname of [
    "2130706433",
    "127.1",
    "127.0.1",
    "0177.0.0.1",
    "0x7f.0.0.1",
    "0x7f000001",
    "017700000001",
    "[::ffff:127.0.0.1]",
    "[0:0:0:0:0:ffff:7f00:1]",
  ]) {
    refused(hostname);
  }
});

test("link-local and cloud metadata endpoints are refused", () => {
  for (const hostname of [
    "169.254.169.254",
    "169.254.1.1",
    "169.254.0.0",
    "[fe80::1]",
    "fe80::1",
    "metadata.google.internal",
    "metadata.goog",
    "instance-data",
    "instance-data.ec2.internal",
    "metadata",
  ]) {
    refused(hostname);
  }
});

test("private ranges are refused by default", () => {
  for (const hostname of [
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "192.168.0.0",
    "[fc00::1]",
    "[fd00::1]",
    "100.64.0.1",
    "100.127.255.255",
  ]) {
    refused(hostname);
  }
});

test("multicast, reserved, and broadcast addresses are refused", () => {
  for (const hostname of [
    "224.0.0.1",
    "239.255.255.255",
    "255.255.255.255",
    "240.0.0.1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "192.0.0.1",
    "198.18.0.1",
    "[ff02::1]",
    "[::]",
  ]) {
    refused(hostname);
  }
});

test("boundary addresses just outside a private range are allowed", () => {
  // 172.16/12 covers 172.16.0.0 through 172.31.255.255 only. Off-by-one here would
  // either block legitimate hosts or allow private ones.
  for (const hostname of [
    "172.15.255.255",
    "172.32.0.0",
    "11.0.0.1",
    "9.255.255.255",
    "192.167.255.255",
    "192.169.0.0",
    "100.63.255.255",
    "100.128.0.0",
    "126.255.255.255",
    "128.0.0.1",
  ]) {
    allowed(hostname);
  }
});

test("public hostnames and addresses are allowed", () => {
  for (const hostname of [
    "api.openai.com",
    "openrouter.ai",
    "generativelanguage.googleapis.com",
    "8.8.8.8",
    "1.1.1.1",
    "[2001:db8::1]",
    "2001:4860:4860::8888",
    "example.com",
    "sub.domain.example.co.uk",
  ]) {
    allowed(hostname);
  }
});

test("allowLoopback permits a local runtime but never metadata", () => {
  // Local model runtimes are a first-class BAYZ use case, so loopback is opt-in
  // rather than impossible.
  for (const hostname of ["127.0.0.1", "[::1]", "localhost"]) {
    allowed(hostname, LOOPBACK_OK);
  }
  // Metadata is never a local-runtime use case, so no flag reaches it.
  for (const hostname of ["169.254.169.254", "metadata.google.internal", "[fe80::1]"]) {
    refused(hostname, LOOPBACK_OK);
  }
  // Nor does the loopback flag open private ranges.
  for (const hostname of ["10.0.0.1", "192.168.1.1"]) {
    refused(hostname, LOOPBACK_OK);
  }
});

test("allowPrivate permits a LAN host but never loopback or metadata", () => {
  for (const hostname of ["10.0.0.1", "192.168.1.5", "172.16.0.1", "[fc00::1]"]) {
    allowed(hostname, PRIVATE_OK);
  }
  refused("127.0.0.1", PRIVATE_OK);
  refused("169.254.169.254", PRIVATE_OK);
});

test("both flags together still refuse metadata and multicast", () => {
  const both = { allowLoopback: true, allowPrivate: true };
  allowed("127.0.0.1", both);
  allowed("10.0.0.1", both);
  // Even with everything opted in, an SSRF against a cloud metadata service or a
  // multicast group is never a legitimate provider target.
  refused("169.254.169.254", both);
  refused("metadata.google.internal", both);
  refused("224.0.0.1", both);
});

test("a malformed hostname is refused", () => {
  for (const hostname of [
    "",
    " ",
    ".",
    "..",
    "-leading.example.com",
    "has space.com",
    "a".repeat(300),
    "http://example.com",
    "example.com:443",
    "example.com/path",
    "user@example.com",
    "[not-an-ip]",
    "999.999.999.999",
    "1.2.3.4.5",
    "exa mple.com",
    "exam\u0000ple.com",
    "exam\nple.com",
  ]) {
    refused(hostname);
  }
});

test("a non-string hostname is refused", () => {
  for (const hostname of [undefined, null, 42, {}, [], true]) {
    assert.throws(
      () => assertEgressAllowed(hostname as unknown as string, DEFAULT),
      (error: unknown) => error instanceof ProviderError,
      `accepted ${JSON.stringify(hostname)}`,
    );
  }
});

test("an internationalised or punycode host is handled without crashing", () => {
  // A provider URL can legitimately be punycode. What matters is that it is judged as
  // a name rather than crashing the parser.
  allowed("xn--80ak6aa92e.com");
  refused("xn--");
});

test("the resolved-address check exists separately from the hostname check", () => {
  // Deliberately two functions. The hostname check runs at configuration time; the
  // address check runs after DNS resolution and immediately before connect, which is
  // what narrows the rebinding window. It cannot eliminate it — Node gives no hook
  // between `dns.lookup` and the socket connect for the *same* resolution — and the
  // implementation comment says so rather than claiming otherwise.
  assertResolvedAddressAllowed("93.184.216.34", DEFAULT);
  for (const address of [
    "127.0.0.1",
    "169.254.169.254",
    "10.0.0.1",
    "::1",
    "fe80::1",
    "fc00::1",
    "224.0.0.1",
  ]) {
    assert.throws(
      () => assertResolvedAddressAllowed(address, DEFAULT),
      (error: unknown) =>
        error instanceof ProviderError && error.code === "invalid_provider_config",
      `accepted resolved address ${address}`,
    );
  }
});

test("the resolved-address check refuses a hostname, not just a bad address", () => {
  // It is given the output of DNS resolution. A name arriving here means the caller
  // wired it up wrong, and silently accepting would skip the check entirely.
  for (const value of ["example.com", "localhost", "", "not-an-address"]) {
    assert.throws(
      () => assertResolvedAddressAllowed(value, DEFAULT),
      (error: unknown) => error instanceof ProviderError,
      `accepted ${value} as a resolved address`,
    );
  }
});

test("the resolved-address check honours the loopback opt-in", () => {
  assertResolvedAddressAllowed("127.0.0.1", LOOPBACK_OK);
  assertResolvedAddressAllowed("::1", LOOPBACK_OK);
  assert.throws(() => assertResolvedAddressAllowed("169.254.169.254", LOOPBACK_OK));
});

test("an IPv4-mapped IPv6 resolved address is judged by its IPv4 value", () => {
  // Otherwise `::ffff:127.0.0.1` would pass an IPv6-only check and then connect to
  // loopback.
  assert.throws(() => assertResolvedAddressAllowed("::ffff:127.0.0.1", DEFAULT));
  assert.throws(() => assertResolvedAddressAllowed("::ffff:10.0.0.1", DEFAULT));
  assertResolvedAddressAllowed("::ffff:93.184.216.34", DEFAULT);
});

test("the error names no hostname", () => {
  // The rejected value is operator- or attacker-controlled text that reaches logs.
  try {
    assertEgressAllowed("169.254.169.254", DEFAULT);
    assert.fail("should have thrown");
  } catch (error) {
    assert.ok(error instanceof ProviderError);
    assert.ok(!error.message.includes("169.254"));
  }
});

test("the check is pure and does not mutate the policy", () => {
  const policy = { allowLoopback: false, allowPrivate: false };
  const before = { ...policy };
  assert.throws(() => assertEgressAllowed("127.0.0.1", policy));
  assert.deepEqual(policy, before);
});
