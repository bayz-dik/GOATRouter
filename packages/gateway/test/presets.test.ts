import assert from "node:assert/strict";
import test from "node:test";
import {
  CLIENT_CAPABILITIES,
  CLIENT_PRESETS,
  presetFor,
  type ClientPresetName,
} from "../src/index.js";

test("the preset table has exactly the four documented names", () => {
  assert.deepEqual(Object.keys(CLIENT_PRESETS).sort(), [
    "antigravity",
    "generic-openai",
    "hermes",
    "opencode",
  ]);
});

test("a preset is a default capability set and nothing else", () => {
  // The single most important assertion in this file. If a preset ever grew a
  // base URL, a header, or a behaviour hook, BAYZ would stop being
  // client-agnostic and start special-casing products at runtime.
  for (const [name, preset] of Object.entries(CLIENT_PRESETS)) {
    assert.deepEqual(
      Object.keys(preset).sort(),
      ["capabilities", "scopes"],
      `preset ${name} carries more than capabilities and scopes`,
    );
    assert.ok(Array.isArray(preset.capabilities));
    assert.ok(Array.isArray(preset.scopes));
  }
});

test("every preset capability is a member of the declared vocabulary", () => {
  for (const [name, preset] of Object.entries(CLIENT_PRESETS)) {
    for (const capability of preset.capabilities) {
      assert.ok(
        (CLIENT_CAPABILITIES as readonly string[]).includes(capability),
        `preset ${name} declares unknown capability ${capability}`,
      );
    }
    assert.equal(
      new Set(preset.capabilities).size,
      preset.capabilities.length,
      `preset ${name} repeats a capability`,
    );
  }
});

test("no preset grants a management or admin scope", () => {
  // A client preset seeds a *client* identity. If a preset handed out
  // `providers.write` or `admin`, every client created from it would hold
  // management authority, which is the blast radius 9C exists to shrink.
  for (const [name, preset] of Object.entries(CLIENT_PRESETS)) {
    for (const scope of preset.scopes) {
      assert.ok(
        !scope.endsWith(".write") && scope !== "admin",
        `preset ${name} grants ${scope}`,
      );
    }
  }
});

test("presetFor returns the generic default for an unknown name", () => {
  // Throwing would make an unrecognized client name a hard failure, which is
  // precisely the product-name coupling this package refuses. An unknown client
  // is a generic OpenAI client until it proves otherwise.
  assert.deepEqual(presetFor("some-future-client"), CLIENT_PRESETS["generic-openai"]);
  assert.deepEqual(presetFor(undefined), CLIENT_PRESETS["generic-openai"]);
  assert.deepEqual(presetFor(""), CLIENT_PRESETS["generic-openai"]);
  assert.deepEqual(presetFor(42), CLIENT_PRESETS["generic-openai"]);
  assert.deepEqual(presetFor(null), CLIENT_PRESETS["generic-openai"]);
});

test("presetFor is not fooled by a prototype-chain name", () => {
  for (const hostile of ["__proto__", "constructor", "toString", "valueOf"]) {
    assert.deepEqual(
      presetFor(hostile),
      CLIENT_PRESETS["generic-openai"],
      `${hostile} resolved to something other than the default`,
    );
  }
});

test("presetFor returns the named preset for each declared name", () => {
  for (const name of Object.keys(CLIENT_PRESETS) as ClientPresetName[]) {
    assert.deepEqual(presetFor(name), CLIENT_PRESETS[name]);
  }
});

test("presets are data, not dispatch", () => {
  // A function anywhere in a preset would be a behaviour hook, and a behaviour
  // hook keyed by product name is exactly the architecture that is forbidden.
  for (const [name, preset] of Object.entries(CLIENT_PRESETS)) {
    assert.notEqual(typeof preset, "function");
    for (const value of Object.values(preset)) {
      assert.notEqual(typeof value, "function", `preset ${name} holds a function`);
    }
    assert.deepEqual(
      JSON.parse(JSON.stringify(preset)),
      preset,
      `preset ${name} does not round-trip as JSON`,
    );
  }
  assert.equal(typeof presetFor("opencode"), "object");
});

test("presets are frozen so a caller cannot widen one at runtime", () => {
  const preset = presetFor("opencode");
  assert.ok(Object.isFrozen(preset));
  assert.ok(Object.isFrozen(preset.capabilities));
  assert.ok(Object.isFrozen(preset.scopes));
  assert.throws(() => (preset.capabilities as string[]).push("usage.read"));
});

test("the generic preset is the least-capable one", () => {
  // A generic client should not be assumed to support more than the protocol
  // guarantees. If a named preset were narrower than generic, the named preset
  // would be pointless.
  const generic = CLIENT_PRESETS["generic-openai"];
  for (const [name, preset] of Object.entries(CLIENT_PRESETS)) {
    assert.ok(
      preset.capabilities.length >= generic.capabilities.length,
      `preset ${name} is narrower than generic-openai`,
    );
  }
  assert.ok(generic.capabilities.includes("chat"));
  assert.ok(generic.capabilities.includes("models.list"));
});
