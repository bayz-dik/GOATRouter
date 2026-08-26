import assert from "node:assert/strict";
import test from "node:test";
import {
  FAILURE_CATEGORIES,
  MAX_ATTEMPTS,
  MAX_LATENCY_MS,
  MAX_TOKENS,
  TelemetryError,
  normalizeFailureCategory,
  normalizeUsageEvent,
  usageRowFields,
} from "../src/index.js";

/**
 * The telemetry boundary is the single place a routing event becomes a stored row.
 * These tests exist to prove the boundary is a closed set of scalar metadata, not
 * a filter over whatever the caller happened to pass.
 */

const PROMPT = "PROMPT-SENTINEL-must-never-enter-telemetry";
const COMPLETION = "COMPLETION-SENTINEL-must-never-enter-telemetry";
const CREDENTIAL = "sk-telemetry-credential-must-never-enter";

function baseCompleted(): Record<string, unknown> {
  return {
    kind: "request.completed",
    requestId: "req_abc123",
    occurredAt: new Date().toISOString(),
    routeId: "r1",
    providerId: "p1",
    proxyId: "x1",
    model: "gpt-4o",
    routingMode: "combo",
    latencyMs: 412,
    attempts: 2,
    promptTokens: 100,
    completionTokens: 40,
    cachedTokens: 10,
  };
}

test("a well-formed completed event normalizes to exactly the closed field set", () => {
  const row = normalizeUsageEvent(baseCompleted());
  assert.ok(row !== undefined);
  assert.deepEqual(Object.keys(row).sort(), [...usageRowFields()].sort());
  assert.equal(row.outcome, "ok");
  assert.equal(row.failureCategory, undefined);
  assert.equal(row.model, "gpt-4o");
  assert.equal(row.routingMode, "combo");
  assert.equal(row.latencyMs, 412);
  assert.equal(row.attempts, 2);
  assert.equal(row.promptTokens, 100);
});

test("the row is a fresh object, so no caller reference can mutate stored state", () => {
  const event = baseCompleted();
  const row = normalizeUsageEvent(event)!;
  (event as { model: string }).model = "mutated";
  assert.equal(row.model, "gpt-4o");
  assert.equal(Object.getPrototypeOf(row), Object.prototype);
});

test("content-bearing keys cannot reach a row even when supplied", () => {
  const hostile = {
    ...baseCompleted(),
    prompt: PROMPT,
    messages: [{ role: "user", content: PROMPT }],
    completion: COMPLETION,
    content: COMPLETION,
    body: PROMPT,
    requestBody: PROMPT,
    responseBody: COMPLETION,
    systemPrompt: PROMPT,
    toolArguments: PROMPT,
    authorization: `Bearer ${CREDENTIAL}`,
    Authorization: `Bearer ${CREDENTIAL}`,
    apiKey: CREDENTIAL,
    credential: CREDENTIAL,
    password: CREDENTIAL,
    token: CREDENTIAL,
    cookie: CREDENTIAL,
    secret: CREDENTIAL,
    upstreamError: "<html>500</html>",
    stack: "/root/secret/path.ts:12",
  };

  const row = normalizeUsageEvent(hostile)!;
  const serialized = JSON.stringify(row);
  for (const sentinel of [PROMPT, COMPLETION, CREDENTIAL, "<html>", "/root/secret"]) {
    assert.equal(
      serialized.includes(sentinel),
      false,
      `a row must never carry ${sentinel.slice(0, 20)}`,
    );
  }
  // Copy-only construction: extra keys are absent, not merely blank.
  assert.deepEqual(Object.keys(row).sort(), [...usageRowFields()].sort());
});

test("nested content inside an allowed field is refused rather than coerced", () => {
  for (const model of [
    { toString: () => PROMPT },
    ["gpt-4o", PROMPT],
    { content: PROMPT },
  ]) {
    assert.equal(
      normalizeUsageEvent({ ...baseCompleted(), model }),
      undefined,
      "a non-string model must be dropped, never stringified",
    );
  }
});

test("a prototype-polluting event cannot poison a row or Object.prototype", () => {
  const raw = JSON.parse(
    `{"kind":"request.completed","requestId":"req_x","occurredAt":"${new Date().toISOString()}","model":"gpt-4o","routingMode":"direct","latencyMs":5,"attempts":1,"__proto__":{"polluted":true}}`,
  ) as Record<string, unknown>;
  const row = normalizeUsageEvent(raw);
  assert.ok(row !== undefined);
  assert.equal((row as unknown as Record<string, unknown>).polluted, undefined);
  assert.equal(({} as unknown as Record<string, unknown>).polluted, undefined);
});

test("failure categories are a closed enum and arbitrary text cannot survive", () => {
  for (const category of FAILURE_CATEGORIES) {
    assert.equal(normalizeFailureCategory(category), category);
  }
  for (const hostile of [
    "<html>gateway timeout</html>",
    `upstream said ${CREDENTIAL}`,
    "arbitrary provider prose",
    "",
    "   ",
    42,
    null,
    { code: "auth_failed" },
    ["auth_failed"],
  ]) {
    assert.equal(
      normalizeFailureCategory(hostile),
      "unknown_error",
      `must normalize: ${String(hostile).slice(0, 30)}`,
    );
  }
});

test("a failed event records a normalized category and no upstream text", () => {
  const row = normalizeUsageEvent({
    ...baseCompleted(),
    kind: "request.failed",
    failureCategory: `rate_limited from ${CREDENTIAL}`,
  })!;
  assert.equal(row.outcome, "failed");
  assert.equal(row.failureCategory, "unknown_error");
  assert.equal(JSON.stringify(row).includes(CREDENTIAL), false);
});

test("unknown token counts stay unknown and are never coerced to zero", () => {
  for (const value of [undefined, null, "unknown", Number.NaN, {}]) {
    const row = normalizeUsageEvent({
      ...baseCompleted(),
      promptTokens: value,
      completionTokens: value,
      cachedTokens: value,
    })!;
    assert.equal(row.promptTokens, undefined, `must stay unknown for ${String(value)}`);
    assert.equal(row.completionTokens, undefined);
    assert.equal(row.cachedTokens, undefined);
  }
});

test("a genuine zero token count is preserved and distinguishable from unknown", () => {
  const row = normalizeUsageEvent({
    ...baseCompleted(),
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
  })!;
  assert.equal(row.promptTokens, 0);
  assert.equal(row.completionTokens, 0);
  assert.equal(row.cachedTokens, 0);
});

test("numeric bounds are enforced rather than clamped into a lie", () => {
  for (const latencyMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_LATENCY_MS + 1, "5"]) {
    assert.equal(
      normalizeUsageEvent({ ...baseCompleted(), latencyMs }),
      undefined,
      `latency must be refused: ${String(latencyMs)}`,
    );
  }
  for (const attempts of [-1, 0.5, MAX_ATTEMPTS + 1, Number.NaN]) {
    assert.equal(
      normalizeUsageEvent({ ...baseCompleted(), attempts }),
      undefined,
      `attempts must be refused: ${String(attempts)}`,
    );
  }
  for (const tokens of [-1, 2.5, MAX_TOKENS + 1, -Number.MAX_SAFE_INTEGER]) {
    const row = normalizeUsageEvent({ ...baseCompleted(), promptTokens: tokens });
    // An out-of-range token count degrades to unknown: the request itself is still
    // worth recording, but a bogus number must not be stored as fact.
    assert.equal(row?.promptTokens, undefined, `tokens must degrade: ${String(tokens)}`);
  }
});

test("boundary numeric values are accepted", () => {
  const row = normalizeUsageEvent({
    ...baseCompleted(),
    latencyMs: MAX_LATENCY_MS,
    attempts: MAX_ATTEMPTS,
    promptTokens: MAX_TOKENS,
  })!;
  assert.equal(row.latencyMs, MAX_LATENCY_MS);
  assert.equal(row.attempts, MAX_ATTEMPTS);
  assert.equal(row.promptTokens, MAX_TOKENS);
});

test("identifiers are slug-validated and hostile shapes are refused", () => {
  for (const field of ["requestId", "routeId", "providerId", "proxyId"] as const) {
    for (const value of [
      "a".repeat(200),
      "has space",
      "a/../b",
      "a\r\nb",
      "a\u0000b",
      "<script>x</script>",
      "Bearer abc123",
    ]) {
      const row = normalizeUsageEvent({ ...baseCompleted(), [field]: value });
      if (field === "requestId") {
        assert.equal(row, undefined, `${field} must be refused: ${value.slice(0, 20)}`);
      } else {
        // Optional ids degrade to absent rather than failing the whole record.
        assert.equal(row?.[field], undefined, `${field} must degrade: ${value.slice(0, 20)}`);
      }
    }
  }
});

test("an id field cannot smuggle content past the length cap", () => {
  // A credential long enough to matter is refused on length alone.
  const long = `${CREDENTIAL}-${"x".repeat(64)}`;
  assert.equal(normalizeUsageEvent({ ...baseCompleted(), requestId: long }), undefined);
  assert.equal(
    normalizeUsageEvent({ ...baseCompleted(), providerId: long })?.providerId,
    undefined,
  );

  /*
   * A short slug-shaped string is accepted, and deliberately so: the boundary
   * cannot tell a credential-shaped slug from a legitimate id, and guessing would
   * reject real ids. The actual guarantee is upstream — `requestId` is generated by
   * the server and `providerId`/`routeId`/`proxyId` come from the registry, so no
   * user-supplied value reaches these fields at all. The router test asserts that
   * end of the contract.
   */
  assert.equal(
    normalizeUsageEvent({ ...baseCompleted(), requestId: "req_generated_by_server" })
      ?.requestId,
    "req_generated_by_server",
  );
});

test("a model id is validated and an over-long one is refused", () => {
  assert.equal(normalizeUsageEvent({ ...baseCompleted(), model: "a".repeat(200) }), undefined);
  assert.equal(normalizeUsageEvent({ ...baseCompleted(), model: "has space" }), undefined);
  assert.equal(normalizeUsageEvent({ ...baseCompleted(), model: "" }), undefined);
  assert.equal(
    normalizeUsageEvent({ ...baseCompleted(), model: "anthropic/claude-3.5-sonnet" })?.model,
    "anthropic/claude-3.5-sonnet",
  );
});

test("routing mode is a closed enum", () => {
  for (const mode of ["direct", "combo", "failover"]) {
    assert.equal(normalizeUsageEvent({ ...baseCompleted(), routingMode: mode })?.routingMode, mode);
  }
  for (const mode of ["DIRECT", "unknown", "", 42, null]) {
    assert.equal(
      normalizeUsageEvent({ ...baseCompleted(), routingMode: mode }),
      undefined,
      `mode must be refused: ${String(mode)}`,
    );
  }
});

test("timestamps outside a sane window are replaced with now", () => {
  const now = Date.now();
  for (const occurredAt of [
    new Date(now + 72 * 3600_000).toISOString(),
    new Date(now - 72 * 3600_000).toISOString(),
    "not-a-date",
    "",
    42,
    null,
  ]) {
    const row = normalizeUsageEvent({ ...baseCompleted(), occurredAt })!;
    const parsed = Date.parse(row.occurredAt);
    assert.ok(Number.isFinite(parsed), `must be a real timestamp for ${String(occurredAt)}`);
    assert.ok(Math.abs(parsed - now) < 60_000, "must fall back to now");
  }
});

test("a timestamp within the window is preserved", () => {
  const recent = new Date(Date.now() - 60_000).toISOString();
  assert.equal(normalizeUsageEvent({ ...baseCompleted(), occurredAt: recent })?.occurredAt, recent);
});

test("an unknown or malformed event kind is dropped entirely", () => {
  for (const event of [
    undefined,
    null,
    42,
    "request.completed",
    [],
    {},
    { kind: "request.exfiltrate", requestId: "req_a" },
    { kind: "" },
  ]) {
    assert.equal(
      normalizeUsageEvent(event),
      undefined,
      `must drop: ${JSON.stringify(event)?.slice(0, 40)}`,
    );
  }
});

test("attempt events normalize to the attempt field set", () => {
  const attempt = normalizeUsageEvent({
    kind: "provider.attempted",
    requestId: "req_abc123",
    occurredAt: new Date().toISOString(),
    routeId: "r1",
    providerId: "p1",
    model: "gpt-4o",
    routingMode: "combo",
    latencyMs: 88,
    attempts: 1,
  })!;
  assert.equal(attempt.kind, "provider.attempted");
  assert.equal(attempt.outcome, "ok");

  const failed = normalizeUsageEvent({
    kind: "provider.failed",
    requestId: "req_abc123",
    occurredAt: new Date().toISOString(),
    routeId: "r1",
    providerId: "p1",
    model: "gpt-4o",
    routingMode: "failover",
    latencyMs: 91,
    attempts: 1,
    failureCategory: "rate_limited",
  })!;
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.failureCategory, "rate_limited");
});

test("a provider id is required for an attempt event", () => {
  assert.equal(
    normalizeUsageEvent({
      kind: "provider.attempted",
      requestId: "req_abc123",
      occurredAt: new Date().toISOString(),
      model: "gpt-4o",
      routingMode: "combo",
      latencyMs: 5,
      attempts: 1,
    }),
    undefined,
    "an attempt without a provider identifies nothing",
  );
});

test("TelemetryError carries a fixed message and discards the cause", () => {
  const error = new TelemetryError("invalid_event", "normalize");
  assert.ok(error instanceof Error);
  assert.equal(error.name, "TelemetryError");
  assert.equal(error.code, "invalid_event");
  assert.match(error.message, /^invalid_event: /);
  assert.equal(error.cause, undefined);
});
