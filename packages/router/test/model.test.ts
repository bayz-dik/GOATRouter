import assert from "node:assert/strict";
import test from "node:test";
import {
  RouterError,
  assertModelId,
  assertModelPattern,
  isModelId,
  matchesModelPattern,
  patternSpecificity,
} from "../src/index.js";

function rejectsId(model: unknown): void {
  assert.throws(
    () => assertModelId(model as string),
    (error: unknown) =>
      error instanceof RouterError && error.code === "invalid_model",
    `model must be rejected: ${String(model)}`,
  );
}

function rejectsPattern(pattern: unknown): void {
  assert.throws(
    () => assertModelPattern(pattern as string),
    (error: unknown) =>
      error instanceof RouterError && error.code === "invalid_route_config",
    `pattern must be rejected: ${String(pattern)}`,
  );
}

test("RouterError carries a fixed message and discards the cause", () => {
  const error = new RouterError("no_route", "select-route");
  assert.ok(error instanceof Error);
  assert.equal(error.name, "RouterError");
  assert.equal(error.code, "no_route");
  assert.equal(error.stage, "select-route");
  assert.match(error.message, /^no_route: /);
  assert.match(error.message, /\(stage: select-route\)$/);
  assert.equal(error.cause, undefined, "cause must never be attached");
});

test("every router error code has a distinct fixed message", () => {
  const codes = [
    "invalid_model",
    "invalid_route_id",
    "invalid_route_config",
    "invalid_request",
    "route_already_exists",
    "route_not_found",
    "no_route",
    "all_routes_failed",
    "invalid_response",
    "response_too_large",
  ] as const;
  const messages = new Set<string>();
  for (const code of codes) {
    const message = new RouterError(code).message;
    assert.match(message, new RegExp(`^${code}: `));
    messages.add(message);
  }
  assert.equal(messages.size, codes.length);
});

test("realistic model ids are accepted", () => {
  for (const model of [
    "gpt-4o",
    "gpt-4o-mini",
    "claude-3.5-sonnet",
    "anthropic/claude-3.5-sonnet",
    "google/gemini-flash-1.5",
    "llama3:8b",
    "mistral-7b-instruct-v0.2",
    "a",
    "deepseek-ai/DeepSeek-V3",
  ]) {
    assert.equal(assertModelId(model), model);
    assert.equal(isModelId(model), true);
  }
});

test("hostile or unusable model ids are rejected", () => {
  rejectsId("");
  rejectsId("   ");
  rejectsId("has space");
  rejectsId("has\ttab");
  rejectsId("has\nnewline");
  rejectsId("has\r\nCRLF");
  rejectsId("has\u0000null");
  rejectsId("../../etc/passwd");
  rejectsId("model/../secret");
  rejectsId("..");
  rejectsId("/leading-slash");
  rejectsId("model?query=1");
  rejectsId("model#frag");
  rejectsId("model%2e%2e");
  rejectsId("https://evil.example.com/model");
  rejectsId("model with 'quote");
  rejectsId("a".repeat(129));
  rejectsId("-leading-dash");
  rejectsId(42);
  rejectsId(null);
  rejectsId(undefined);
  assert.equal(isModelId("has space"), false);
});

test("an exact pattern and a single trailing wildcard are accepted", () => {
  assert.equal(assertModelPattern("gpt-4o"), "gpt-4o");
  assert.equal(assertModelPattern("gpt-4*"), "gpt-4*");
  assert.equal(assertModelPattern("anthropic/claude-3*"), "anthropic/claude-3*");
  assert.equal(assertModelPattern("a*"), "a*");
});

test("patterns that could become a regex or a broad match are rejected", () => {
  rejectsPattern("*");
  rejectsPattern("**");
  rejectsPattern("*gpt-4");
  rejectsPattern("gpt*4o");
  rejectsPattern("gpt-4*mini");
  rejectsPattern("gpt-4**");
  rejectsPattern(".*");
  rejectsPattern("^gpt");
  rejectsPattern("gpt$");
  rejectsPattern("(gpt|claude)");
  rejectsPattern("gpt-4+");
  rejectsPattern("gpt[34]");
  rejectsPattern("a{1,9999}");
  rejectsPattern("");
  rejectsPattern("   ");
  rejectsPattern("has space*");
  rejectsPattern(42);
});

test("an exact pattern matches only that model", () => {
  assert.equal(matchesModelPattern("gpt-4o", "gpt-4o"), true);
  assert.equal(matchesModelPattern("gpt-4o", "gpt-4o-mini"), false);
  assert.equal(matchesModelPattern("gpt-4o", "GPT-4O"), false);
  assert.equal(matchesModelPattern("gpt-4o", "gpt-4"), false);
});

test("a trailing wildcard matches by prefix only", () => {
  assert.equal(matchesModelPattern("gpt-4*", "gpt-4"), true);
  assert.equal(matchesModelPattern("gpt-4*", "gpt-4o"), true);
  assert.equal(matchesModelPattern("gpt-4*", "gpt-4o-mini"), true);
  assert.equal(matchesModelPattern("gpt-4*", "gpt-3.5"), false);
  assert.equal(matchesModelPattern("gpt-4*", "my-gpt-4o"), false);
  assert.equal(
    matchesModelPattern("anthropic/claude-3*", "anthropic/claude-3.5-sonnet"),
    true,
  );
  assert.equal(
    matchesModelPattern("anthropic/claude-3*", "google/claude-3.5-sonnet"),
    false,
  );
});

test("regex metacharacters in a stored pattern are matched literally", () => {
  // A pattern is never compiled to a regex, so a dot is a dot.
  assert.equal(matchesModelPattern("claude-3.5", "claude-3.5"), true);
  assert.equal(matchesModelPattern("claude-3.5", "claude-345"), false);
  assert.equal(matchesModelPattern("claude-3.5", "claude-3X5"), false);
});

test("matching validates both sides and refuses hostile input", () => {
  assert.throws(
    () => matchesModelPattern("gpt-4*", "../../etc/passwd"),
    (error: unknown) =>
      error instanceof RouterError && error.code === "invalid_model",
  );
  assert.throws(
    () => matchesModelPattern("*", "gpt-4o"),
    (error: unknown) =>
      error instanceof RouterError && error.code === "invalid_route_config",
  );
});

test("exact patterns outrank wildcards regardless of length", () => {
  assert.ok(
    patternSpecificity("gpt-4o") > patternSpecificity("gpt-4o-mini-long*"),
    "an exact match must always win over a wildcard",
  );
  assert.ok(
    patternSpecificity("gpt-4o-mini*") > patternSpecificity("gpt-4*"),
    "a longer prefix is more specific than a shorter one",
  );
  assert.equal(patternSpecificity("gpt-4o"), patternSpecificity("claude-3"));
});
