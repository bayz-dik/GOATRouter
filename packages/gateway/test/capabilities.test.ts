import assert from "node:assert/strict";
import test from "node:test";
import {
  CLIENT_CAPABILITIES,
  CLIENT_QUIRKS,
  GatewayError,
  assertClientCapability,
  isClientCapability,
  isClientQuirk,
} from "../src/index.js";

test("the capability vocabulary is exactly the seven approved capabilities", () => {
  assert.deepEqual(CLIENT_CAPABILITIES, [
    "chat",
    "chat.stream",
    "models.list",
    "tools",
    "tools.parallel",
    "cancel",
    "usage.read",
  ]);
  assert.equal(CLIENT_CAPABILITIES.length, 7);
  assert.ok(Object.isFrozen(CLIENT_CAPABILITIES));
});

test("isClientCapability accepts each capability and rejects everything else", () => {
  for (const capability of CLIENT_CAPABILITIES) {
    assert.equal(isClientCapability(capability), true);
  }
  for (const bad of [
    "",
    " ",
    "admin",
    "chat.STREAM",
    "Chat",
    "chat ",
    "tools.*",
    "__proto__",
    "constructor",
    "toString",
    42,
    null,
    undefined,
    true,
    {},
    [],
  ]) {
    assert.equal(isClientCapability(bad), false, `accepted ${String(bad)}`);
  }
});

test("assertClientCapability throws a gateway error for a non-capability", () => {
  assert.equal(assertClientCapability("chat"), "chat");
  assert.throws(
    () => assertClientCapability("chat.STREAM"),
    (error: unknown) =>
      error instanceof GatewayError && error.code === "invalid_capability",
  );
});

test("no capability names a secret or an administrative power", () => {
  // A capability is what a *client* may ask BAYZ to do. There is deliberately no
  // capability for reading a credential or performing management, because the
  // gateway must not be able to express such a request at all.
  for (const capability of CLIENT_CAPABILITIES) {
    assert.ok(
      !/credential|password|secret|token|key|admin|write|delete/i.test(capability),
      `capability ${capability} names a privileged operation`,
    );
  }
});

test("the quirk vocabulary is a frozen set of well-formed names", () => {
  assert.ok(Object.isFrozen(CLIENT_QUIRKS));
  assert.ok(Array.isArray(CLIENT_QUIRKS));
  for (const quirk of CLIENT_QUIRKS) {
    assert.match(quirk, /^[a-z][a-z0-9-]{2,31}$/, `quirk ${quirk} is malformed`);
  }
  assert.equal(new Set(CLIENT_QUIRKS).size, CLIENT_QUIRKS.length);
});

test("isClientQuirk rejects an undeclared quirk", () => {
  for (const quirk of CLIENT_QUIRKS) {
    assert.equal(isClientQuirk(quirk), true);
  }
  // An undocumented quirk must not be accepted: every quirk exists to work around
  // observed wire-format divergence, and one nobody observed is a guess.
  for (const bad of ["made-up-quirk", "", "__proto__", 1, null, {}]) {
    assert.equal(isClientQuirk(bad), false, `accepted ${String(bad)}`);
  }
});

test("no product name appears in the capability vocabulary", () => {
  const joined = `${CLIENT_CAPABILITIES.join(" ")} ${CLIENT_QUIRKS.join(" ")}`;
  for (const name of ["opencode", "hermes", "antigravity", "cline", "continue"]) {
    assert.ok(!joined.includes(name), `vocabulary mentions ${name}`);
  }
});
