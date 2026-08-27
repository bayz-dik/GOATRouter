import assert from "node:assert/strict";
import test from "node:test";
import {
  CLIENT_SCOPES,
  DEFAULT_CLIENT_SCOPES,
  IdentityError,
  assertScopes,
  isClientScope,
  satisfies,
  type ClientScope,
} from "../src/index.js";

test("the scope vocabulary is exactly the ten approved scopes", () => {
  assert.deepEqual(CLIENT_SCOPES, [
    "chat.completions",
    "models.read",
    "usage.read",
    "providers.read",
    "providers.write",
    "proxies.read",
    "proxies.write",
    "routes.read",
    "routes.write",
    "admin",
  ]);
  assert.equal(CLIENT_SCOPES.length, 10);
  assert.ok(Object.isFrozen(CLIENT_SCOPES));
});

test("no scope reads a secret", () => {
  // The strongest structural guarantee in this package: there is no vocabulary
  // word that could ever authorize retrieving a credential, so no route can be
  // written that grants one. A future scope named `providers.credential` would
  // fail here before it could reach a handler.
  for (const scope of CLIENT_SCOPES) {
    assert.ok(
      !/credential|password|secret|token|key/i.test(scope),
      `scope ${scope} names a secret`,
    );
  }
});

test("isClientScope accepts every scope and refuses everything else", () => {
  for (const scope of CLIENT_SCOPES) {
    assert.equal(isClientScope(scope), true);
  }
  for (const bad of [
    "",
    " ",
    "Admin",
    "ADMIN",
    "chat",
    "chat.completions ",
    "providers",
    "providers.*",
    "__proto__",
    "constructor",
    "toString",
    42,
    null,
    undefined,
    true,
    {},
    [],
    Symbol("admin"),
  ]) {
    assert.equal(isClientScope(bad), false, `accepted ${String(bad)}`);
  }
});

test("assertScopes returns a validated array", () => {
  assert.deepEqual(assertScopes(["chat.completions"]), ["chat.completions"]);
  assert.deepEqual(assertScopes(["admin", "usage.read"]), ["admin", "usage.read"]);
  assert.deepEqual(assertScopes([...CLIENT_SCOPES]), [...CLIENT_SCOPES]);
});

test("assertScopes refuses an unknown scope, a duplicate, and an empty array", () => {
  const cases: unknown[] = [
    ["chat.completions", "not-a-scope"],
    ["chat.completions", "chat.completions"],
    [],
    ["chat.completions", ...CLIENT_SCOPES],
    "chat.completions",
    null,
    undefined,
    {},
    { 0: "chat.completions", length: 1 },
    ["chat.completions", null],
    ["chat.completions", 1],
  ];
  for (const value of cases) {
    assert.throws(
      () => assertScopes(value),
      (error: unknown) =>
        error instanceof IdentityError && error.code === "invalid_scope",
      `accepted ${JSON.stringify(value)}`,
    );
  }
});

test("assertScopes refuses more than ten entries", () => {
  // Ten is the whole vocabulary, so an eleventh entry can only be a duplicate or
  // an unknown value. The count check exists so a huge hostile array is refused
  // before it is scanned.
  const oversized = Array.from({ length: 11 }, () => "chat.completions");
  assert.throws(
    () => assertScopes(oversized),
    (error: unknown) => error instanceof IdentityError && error.code === "invalid_scope",
  );
});

test("assertScopes does not mutate or alias its input", () => {
  const input = ["chat.completions", "models.read"];
  const output = assertScopes(input);
  output.push("admin" as ClientScope);
  assert.deepEqual(input, ["chat.completions", "models.read"]);
});

test("admin satisfies every scope", () => {
  const granted = new Set<ClientScope>(["admin"]);
  for (const scope of CLIENT_SCOPES) {
    assert.equal(satisfies(granted, scope), true, `admin failed ${scope}`);
  }
});

test("no scope implies admin", () => {
  for (const scope of CLIENT_SCOPES) {
    if (scope === "admin") {
      continue;
    }
    assert.equal(
      satisfies(new Set([scope]), "admin"),
      false,
      `${scope} implied admin`,
    );
  }
});

test("write does not imply read", () => {
  // Implication is where privilege creep starts. An operator who granted
  // `providers.write` intending only a create form should not also have handed
  // over the ability to enumerate every provider.
  const pairs: ReadonlyArray<readonly [ClientScope, ClientScope]> = [
    ["providers.write", "providers.read"],
    ["proxies.write", "proxies.read"],
    ["routes.write", "routes.read"],
  ];
  for (const [write, read] of pairs) {
    assert.equal(satisfies(new Set([write]), read), false, `${write} implied ${read}`);
    assert.equal(satisfies(new Set([read]), write), false, `${read} implied ${write}`);
  }
});

test("satisfies is pure and rejects a non-scope requirement", () => {
  const granted = new Set<ClientScope>(["chat.completions", "models.read"]);
  const before = [...granted];
  assert.equal(satisfies(granted, "chat.completions"), true);
  assert.equal(satisfies(granted, "usage.read"), false);
  assert.deepEqual([...granted], before);
  assert.throws(
    () => satisfies(granted, "not-a-scope" as ClientScope),
    (error: unknown) => error instanceof IdentityError && error.code === "invalid_scope",
  );
});

test("satisfies is not fooled by a prototype-chain member", () => {
  const granted = new Set<ClientScope>(["chat.completions"]);
  for (const hostile of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    assert.throws(
      () => satisfies(granted, hostile as ClientScope),
      (error: unknown) => error instanceof IdentityError && error.code === "invalid_scope",
      `accepted ${hostile}`,
    );
  }
});

test("the default client grant is chat and models only", () => {
  // A client key is for talking to models. It must not arrive holding any
  // management authority, so the default is asserted rather than left to a
  // caller's convention.
  assert.deepEqual(DEFAULT_CLIENT_SCOPES, ["chat.completions", "models.read"]);
  assert.ok(Object.isFrozen(DEFAULT_CLIENT_SCOPES));
  for (const scope of DEFAULT_CLIENT_SCOPES) {
    assert.ok(isClientScope(scope));
    assert.ok(!scope.endsWith(".write"));
    assert.notEqual(scope, "admin");
  }
});
