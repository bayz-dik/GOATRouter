import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPABILITY_NAME_PATTERN,
  CAPABILITY_REGISTRY_MAX,
  CapabilityError,
  lookupCapability,
  registerCapability,
  registeredCapabilityNames,
  resetCapabilities,
  type CapabilityHandler,
} from "../src/index.js";

/**
 * The 9G Task 1 registry suite.
 *
 * The security property under test is *structural*: a capability exists only because
 * something registered it, so a model naming one it wants cannot bring it into being.
 * Nothing here filters a string or blocks a word — see the final section for why that
 * distinction is the whole design.
 */

/** A minimal well-formed handler. Deliberately does nothing interesting. */
function handler(
  name: string,
  overrides: Partial<CapabilityHandler<unknown, unknown>> = {},
): CapabilityHandler<unknown, unknown> {
  return {
    name,
    requiredScope: "chat.completions",
    parse: (raw: unknown) => raw,
    run: async (input: unknown) => input,
    ...overrides,
  };
}

/*
 * Every test resets the registry.
 *
 * The registry is process-wide, exactly like the router's outbound semaphore, because
 * a capability set that differed per caller would be a capability set an attacker
 * could influence. That makes explicit reset the only honest way to isolate tests —
 * without it, one registration would leak into every later assertion about emptiness.
 */
test.beforeEach(() => {
  resetCapabilities();
});

/* ------------------------------------------------------------------ *
 * Registration and lookup
 * ------------------------------------------------------------------ */

test("a registered handler is returned by lookup", () => {
  const echo = handler("echo.text");
  registerCapability(echo);

  const found = lookupCapability("echo.text");
  assert.equal(found, echo, "lookup must return the handler that was registered");
  assert.equal(found?.requiredScope, "chat.completions");
});

test("an unregistered name resolves to undefined", () => {
  registerCapability(handler("echo.text"));

  // A near-miss on a real registration is the interesting case: it proves lookup is
  // exact rather than prefix, suffix, or case tolerant.
  for (const name of [
    "echo",
    "echo.tex",
    "echo.texts",
    "echo.text ",
    " echo.text",
    "Echo.Text",
    "ECHO.TEXT",
    "echo.text.extra",
    "unregistered.capability",
  ]) {
    assert.equal(
      lookupCapability(name),
      undefined,
      `${JSON.stringify(name)} must not resolve`,
    );
  }
});

test("a prototype-chain name resolves to undefined, not to Object.prototype", () => {
  registerCapability(handler("echo.text"));

  /*
   * The reason the registry is a `Map` and not an object literal.
   *
   * With `{}` as the store, `store["toString"]` returns `Function`, `store["constructor"]`
   * returns `Object`, and `store["__proto__"]` returns `Object.prototype` — every one a
   * truthy value that a dispatcher would treat as a found capability and then try to
   * call. The model controls this name, so that is a remote path to invoking an
   * arbitrary builtin.
   */
  for (const name of [
    "__proto__",
    "constructor",
    "prototype",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
  ]) {
    const found = lookupCapability(name);
    assert.equal(found, undefined, `${name} resolved to something`);
    assert.equal(typeof found, "undefined", `${name} resolved to a ${typeof found}`);
  }
});

test("a non-string name resolves to undefined rather than throwing", () => {
  registerCapability(handler("echo.text"));

  /*
   * Lookup takes `unknown` and must tolerate it. The name arrives from parsed model
   * JSON, so it can be any JSON value plus anything a hostile payload coerces to —
   * and a *throw* here would turn "the model sent a number" into a 500 rather than a
   * clean `unknown_capability`. Refusal is the answer; a crash is not.
   */
  for (const name of [
    undefined,
    null,
    0,
    1,
    Number.NaN,
    true,
    false,
    {},
    [],
    ["echo.text"],
    { name: "echo.text" },
    { toString: () => "echo.text" },
    Symbol("echo.text"),
    () => "echo.text",
    9007199254740993n,
  ]) {
    assert.equal(lookupCapability(name), undefined, `${String(name)} resolved`);
  }
});

test("a duplicate registration is refused rather than silently replacing", () => {
  const first = handler("echo.text");
  registerCapability(first);

  // Replacing would be the dangerous default: a later import could swap the handler
  // behind a name an operator already reviewed, and nothing would report it.
  assert.throws(
    () => registerCapability(handler("echo.text")),
    (error: unknown) =>
      error instanceof CapabilityError && error.code === "capability_already_registered",
  );
  assert.equal(lookupCapability("echo.text"), first, "the original must survive");
});

/* ------------------------------------------------------------------ *
 * Name validation
 * ------------------------------------------------------------------ */

test("the name pattern is pinned and enforced at registration", () => {
  // Pinned as an exported constant so a later widening has to change a value this
  // test asserts, rather than quietly admitting a shape dispatch cannot handle.
  assert.equal(CAPABILITY_NAME_PATTERN.source, "^[a-z][a-z0-9_.-]{2,63}$");

  for (const name of [
    "abc",
    "echo.text",
    "echo_text",
    "echo-text",
    "a".repeat(64),
    "z0.9_x-y",
  ]) {
    resetCapabilities();
    registerCapability(handler(name));
    assert.equal(lookupCapability(name)?.name, name, `${name} should be valid`);
  }
});

test("a name outside the pattern is refused", () => {
  for (const name of [
    "",
    "ab", // shorter than the three-character floor
    "a".repeat(65), // one past the ceiling
    "Echo.text", // uppercase
    "1echo", // must start with a letter
    ".echo", // must start with a letter
    "-echo",
    "_echo",
    "echo text", // whitespace
    "echo\ttext",
    "echo\ntext",
    "echo/text", // path separators: a name is not a path
    "echo\\text",
    "../echo",
    "echo:text",
    "echo@text",
    "echo#text",
    "echo%2etext",
    "echo\u0000text", // a NUL would truncate in any C-string consumer
    "echo.text\u200b", // zero-width space
    "ｅｃｈｏ.ｔｅｘｔ", // fullwidth homoglyphs
    "есho.text", // Cyrillic е and с
    "__proto__", // refused by the leading-letter rule
  ]) {
    resetCapabilities();
    assert.throws(
      () => registerCapability(handler(name)),
      (error: unknown) =>
        error instanceof CapabilityError && error.code === "invalid_capability_name",
      `${JSON.stringify(name)} was accepted as a name`,
    );
    assert.equal(lookupCapability(name), undefined, `${JSON.stringify(name)} was stored`);
  }
});

test("a reserved name is refused even though the pattern admits it", () => {
  /*
   * `constructor` and `prototype` are lowercase ASCII and match the pattern, so they
   * need their own guard — and the reason is *not* lookup safety. A `Map` has no
   * prototype-chain resolution, so `lookupCapability("constructor")` is already
   * `undefined`. The hazard is the consumer that does not exist yet: the moment
   * anything builds an object keyed by capability name — a tool schema list for a
   * model, a JSON summary for the dashboard — `{ constructor: … }` corrupts it.
   *
   * Asserted separately from the pattern test so the two guards cannot be conflated:
   * this one must keep working if the pattern is ever widened.
   */
  for (const name of ["constructor", "prototype"]) {
    resetCapabilities();
    assert.match(name, CAPABILITY_NAME_PATTERN, "the pattern must admit this name");
    assert.throws(
      () => registerCapability(handler(name)),
      (error: unknown) =>
        error instanceof CapabilityError &&
        error.code === "invalid_capability_name" &&
        error.stage === "register-reserved",
      `${name} was accepted`,
    );
    assert.equal(lookupCapability(name), undefined);
  }
});

test("a non-string name is refused at registration too", () => {
  for (const name of [undefined, null, 0, true, {}, [], Symbol("x"), () => "x"]) {
    resetCapabilities();
    assert.throws(
      () => registerCapability(handler(name as unknown as string)),
      (error: unknown) =>
        error instanceof CapabilityError && error.code === "invalid_capability_name",
    );
  }
});

test("a Unicode homoglyph of a registered name does not match it", () => {
  registerCapability(handler("echo.text"));

  // Both halves matter. The homoglyph cannot be registered (the ASCII-only pattern
  // refuses it) *and* it does not resolve to the real capability, so an attacker
  // cannot smuggle a lookalike past a reviewer or past the Map.
  for (const lookalike of ["есho.text", "echo.tеxt", "ｅcho.text", "echo․text"]) {
    assert.equal(lookupCapability(lookalike), undefined, `${lookalike} matched`);
    assert.throws(
      () => registerCapability(handler(lookalike)),
      (error: unknown) => error instanceof CapabilityError,
    );
  }
  assert.equal(registeredCapabilityNames().length, 1);
});

/* ------------------------------------------------------------------ *
 * Handler shape
 * ------------------------------------------------------------------ */

test("a handler missing parse or run is refused", () => {
  for (const broken of [
    { parse: undefined },
    { run: undefined },
    { parse: "not a function" as unknown as CapabilityHandler<unknown, unknown>["parse"] },
    { run: 42 as unknown as CapabilityHandler<unknown, unknown>["run"] },
  ]) {
    resetCapabilities();
    assert.throws(
      () => registerCapability(handler("echo.text", broken)),
      (error: unknown) =>
        error instanceof CapabilityError && error.code === "invalid_capability_handler",
    );
  }
});

test("a handler whose required scope is not in the vocabulary is refused", () => {
  /*
   * The scope has to come from `@bayz/identity`'s ten-word vocabulary. A handler
   * declaring `"superuser"` would sit in the registry with a scope no identity can
   * ever hold — which reads as "locked down" but is really an unreviewable rule that
   * `satisfies` would throw on at dispatch time, turning a config error into a 500.
   */
  for (const scope of [
    "superuser",
    "admin.all",
    "",
    "ADMIN",
    "chat",
    undefined,
    null,
    0,
    {},
  ]) {
    resetCapabilities();
    assert.throws(
      () =>
        registerCapability(
          handler("echo.text", {
            requiredScope: scope as unknown as CapabilityHandler<
              unknown,
              unknown
            >["requiredScope"],
          }),
        ),
      (error: unknown) =>
        error instanceof CapabilityError && error.code === "invalid_capability_scope",
      `scope ${String(scope)} was accepted`,
    );
  }
});

test("every scope in the identity vocabulary is accepted", () => {
  // The complement of the test above: the guard must not be so tight that a
  // legitimate scope is unusable.
  for (const scope of [
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
  ] as const) {
    resetCapabilities();
    registerCapability(handler("echo.text", { requiredScope: scope }));
    assert.equal(lookupCapability("echo.text")?.requiredScope, scope);
  }
});

/* ------------------------------------------------------------------ *
 * Bounds
 * ------------------------------------------------------------------ */

test("the registry is bounded at 128 capabilities", () => {
  assert.equal(CAPABILITY_REGISTRY_MAX, 128);

  for (let index = 0; index < CAPABILITY_REGISTRY_MAX; index += 1) {
    registerCapability(handler(`cap.${String(index).padStart(3, "0")}`));
  }
  assert.equal(registeredCapabilityNames().length, CAPABILITY_REGISTRY_MAX);

  // Bounded because the registry is walked and because an unbounded one is a slow
  // leak for any embedder that registers in a loop. Refused, not evicted: evicting
  // would silently remove a capability an operator is relying on.
  assert.throws(
    () => registerCapability(handler("cap.128")),
    (error: unknown) =>
      error instanceof CapabilityError && error.code === "capability_registry_full",
  );
  assert.equal(lookupCapability("cap.128"), undefined);
  assert.equal(registeredCapabilityNames().length, CAPABILITY_REGISTRY_MAX);
});

/* ------------------------------------------------------------------ *
 * The load-bearing property: nothing is registered by default
 * ------------------------------------------------------------------ */

test("the registry is empty until something registers deliberately", () => {
  // If this package shipped a default capability, every deployment would have it
  // whether the operator reviewed it or not. Empty means the set is opt-in.
  assert.deepEqual(registeredCapabilityNames(), []);
  assert.equal(lookupCapability("echo.text"), undefined);
});

test("no registered capability name suggests reading a secret", () => {
  /*
   * Asserted over the registry's actual contents, not as a name blocklist.
   *
   * That distinction is the entire 9G design. A blocklist would mean
   * `read_provider_credentials` is refused *because the word matched*, which invites
   * the obvious next question — what about `fetch_pr0vider_k3ys`? The real guarantee
   * is that no capability reads a secret because none is registered and none can be
   * added without a code change and a review. This test is the tripwire on that
   * invariant, and it deliberately does not prevent the name from being registered:
   * it proves nobody did.
   */
  const forbidden = /credential|password|secret|token|key|export/i;
  for (const name of registeredCapabilityNames()) {
    assert.equal(
      forbidden.test(name),
      false,
      `a registered capability is named ${name}, which suggests secret access`,
    );
  }

  // And the names a hostile prompt would reach for resolve to nothing, which is the
  // property a dispatcher relies on.
  for (const name of [
    "read_provider_credentials",
    "secrets.read",
    "providers.credential",
    "admin.export",
    "export_secrets",
    "api_key.read",
    "master_key.read",
    "proxy.password",
  ]) {
    assert.equal(lookupCapability(name), undefined, `${name} resolved`);
  }
});

test("resetting the registry empties it", () => {
  registerCapability(handler("echo.text"));
  assert.equal(registeredCapabilityNames().length, 1);
  resetCapabilities();
  assert.deepEqual(registeredCapabilityNames(), []);
  assert.equal(lookupCapability("echo.text"), undefined);
});

test("the reported name list is a copy, not the live registry", () => {
  registerCapability(handler("echo.text"));
  const names = registeredCapabilityNames();
  names.push("injected.capability");
  // A caller mutating the returned array must not be able to make a capability
  // appear — or, worse, disappear from the secret-name tripwire above.
  assert.deepEqual(registeredCapabilityNames(), ["echo.text"]);
  assert.equal(lookupCapability("injected.capability"), undefined);
});
