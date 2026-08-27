import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  CLIENT_PRESETS,
  GatewayError,
  denormalizeResponse,
  deriveProfile,
  normalizeRequest,
} from "../src/index.js";

const GATEWAY_SRC = new URL("../src/", import.meta.url).pathname;
const SERVER_ROUTES = new URL("../../../apps/server/src/routes/", import.meta.url)
  .pathname;
const PRODUCT_NAMES = ["opencode", "hermes", "antigravity", "cline"] as const;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Remove comments before matching.
 *
 * Without this, a comment explaining the no-product-name rule would itself trip
 * the rule — which would push future authors to stop documenting the reasoning,
 * the opposite of what the check is for.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

test("no product name appears in gateway source outside presets.ts", () => {
  for (const file of sourceFiles(GATEWAY_SRC)) {
    if (file.endsWith("presets.ts")) {
      continue;
    }
    const code = stripComments(readFileSync(file, "utf8"));
    for (const name of PRODUCT_NAMES) {
      assert.ok(
        !code.toLowerCase().includes(name),
        `${file} mentions the product name ${name}`,
      );
    }
  }
});

test("no product name appears in any server route handler", () => {
  for (const file of sourceFiles(SERVER_ROUTES)) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const name of PRODUCT_NAMES) {
      assert.ok(
        !code.toLowerCase().includes(name),
        `${file} mentions the product name ${name}`,
      );
    }
  }
});

test("presets.ts holds product names only as data keys", () => {
  const code = stripComments(
    readFileSync(join(GATEWAY_SRC, "presets.ts"), "utf8"),
  );
  // Every occurrence must be an object key or a union member, never part of a
  // conditional. A branch on a product name is precisely what is forbidden.
  for (const forbidden of [
    /if\s*\([^)]*opencode/i,
    /if\s*\([^)]*hermes/i,
    /if\s*\([^)]*antigravity/i,
    /===\s*["'`](opencode|hermes|antigravity|cline)/i,
    /switch\s*\([^)]*(opencode|hermes|antigravity)/i,
  ]) {
    assert.ok(!forbidden.test(code), `presets.ts branches on a product name`);
  }
});

test("no gateway file can reach a credential", () => {
  for (const file of sourceFiles(GATEWAY_SRC)) {
    const code = readFileSync(file, "utf8");
    for (const forbidden of [
      "SecretStorage",
      "SecretRepository",
      "scopedSecretStorage",
      "withCredential",
      "openSecretStorage",
      "@bayz/storage",
    ]) {
      assert.ok(!code.includes(forbidden), `${file} references ${forbidden}`);
    }
    assert.ok(
      !/getCredential|getPassword|reveal[A-Z]|readKey|revealKey/.test(code),
      `${file} declares a credential accessor`,
    );
  }
});

test("the gateway declares no storage dependency", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const deps = Object.keys(pkg.dependencies ?? {});
  assert.deepEqual(deps.sort(), ["@bayz/identity", "@bayz/security"]);
  assert.ok(!deps.includes("@bayz/storage"), "the gateway must hold no state");
});

test("the gateway imports no filesystem, process, or child process module", () => {
  for (const file of sourceFiles(GATEWAY_SRC)) {
    const code = readFileSync(file, "utf8");
    for (const forbidden of ["node:fs", "node:child_process", "node:net", "node:http"]) {
      assert.ok(!code.includes(forbidden), `${file} imports ${forbidden}`);
    }
  }
});

test("a derived profile cannot be widened after the scope check", () => {
  const profile = deriveProfile({
    path: "/v1/chat/completions",
    accept: undefined,
    body: { model: "m", messages: [] },
    grantedScopes: new Set(["chat.completions"]),
  });
  assert.equal(profile.capabilities.has("tools"), false);
  // A plain frozen Set still allows `add`, so freezing alone would let a caller
  // grant itself a capability the scope check refused. The mutators are replaced.
  assert.throws(
    () => (profile.capabilities as Set<never>).add("tools" as never),
    (error: unknown) =>
      error instanceof GatewayError && error.code === "invalid_profile",
  );
  assert.equal(profile.capabilities.has("tools"), false);
});

test("no preset can be widened at runtime", () => {
  for (const preset of Object.values(CLIENT_PRESETS)) {
    assert.throws(() => (preset.capabilities as string[]).push("usage.read"));
    assert.throws(() => (preset.scopes as string[]).push("admin"));
  }
});

test("a hostile 64 KiB accept header does not widen capabilities", () => {
  const hostile = `text/event-stream, ${"x".repeat(64 * 1024)}`;
  const profile = deriveProfile({
    path: "/v1/chat/completions",
    accept: hostile,
    body: { model: "m", messages: [] },
    grantedScopes: new Set(["chat.completions"]),
  });
  assert.equal(profile.capabilities.has("chat.stream"), false);
});

test("a ten-thousand-key body is refused before iteration", () => {
  const body: Record<string, unknown> = { model: "m", messages: [] };
  for (let index = 0; index < 10000; index += 1) {
    body[`k${index}`] = index;
  }
  const started = process.hrtime.bigint();
  assert.throws(
    () =>
      deriveProfile({
        path: "/v1/chat/completions",
        accept: undefined,
        body,
        grantedScopes: new Set(["chat.completions"]),
      }),
    (error: unknown) =>
      error instanceof GatewayError && error.code === "invalid_request",
  );
  // Generous bound, documented as indicative rather than proof: the point is that
  // the refusal does not walk 10,000 entries doing per-key work.
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 250, `refusal took ${elapsedMs}ms`);
});

test("normalization refuses a body whose prototype was replaced", () => {
  const profile = deriveProfile({
    path: "/v1/chat/completions",
    accept: undefined,
    body: { model: "m", messages: [] },
    grantedScopes: new Set(["chat.completions"]),
  });
  const hostile = Object.create({ model: "m", messages: [] });
  assert.throws(
    () => normalizeRequest(profile, hostile),
    (error: unknown) =>
      error instanceof GatewayError && error.code === "invalid_request",
  );
});

test("denormalization refuses a protocol it cannot render", () => {
  const profile = deriveProfile({
    path: "/v1/messages",
    accept: undefined,
    body: { model: "m", messages: [] },
    grantedScopes: new Set(["chat.completions"]),
  });
  assert.equal(profile.protocol, "anthropic");
  // Emitting an OpenAI body to an Anthropic client would be a fabricated
  // compatibility claim, so the refusal is the honest behaviour.
  assert.throws(
    () =>
      denormalizeResponse(profile, {
        id: "chatcmpl-x",
        created: 0,
        content: "hi",
        finishReason: undefined,
        model: undefined,
        usage: undefined,
      }),
    (error: unknown) =>
      error instanceof GatewayError && error.code === "capability_unsupported",
  );
});

test("no gateway source uses eval or dynamic function construction", () => {
  for (const file of sourceFiles(GATEWAY_SRC)) {
    const code = stripComments(readFileSync(file, "utf8"));
    assert.ok(!/\beval\s*\(/.test(code), `${file} uses eval`);
    assert.ok(!/new\s+Function\s*\(/.test(code), `${file} constructs a function`);
  }
});
