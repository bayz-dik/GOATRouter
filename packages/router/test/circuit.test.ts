import assert from "node:assert/strict";
import test from "node:test";
import { CircuitBreaker, type CircuitState } from "../src/circuit.js";

/*
 * Pure unit tests for the circuit breaker. Time is injected so the 30-second
 * cooldown is tested with elapsed ticks, never a real sleep.
 */

/** Advance time by manually moving the injected clock. */
function clock() {
  let now = 1_000_000;
  return {
    now: () => now,
    tick(ms: number): void {
      now += ms;
    },
  };
}

function breaker(overrides: { threshold?: number; cooldownMs?: number } = {}) {
  const time = clock();
  return {
    time,
    cb: new CircuitBreaker({
      threshold: overrides.threshold ?? 3,
      cooldownMs: overrides.cooldownMs ?? 30_000,
      now: time.now,
    }),
  };
}

test("closed allows calls and reports closed", () => {
  const { cb } = breaker();
  assert.equal(cb.allow("p1"), true);
  assert.equal(cb.state("p1"), "closed");
});

test("after threshold transient failures the circuit opens and rejects", () => {
  const { cb } = breaker({ threshold: 3 });
  // Two failures: still closed.
  cb.onTransientFailure("p1");
  cb.onTransientFailure("p1");
  assert.equal(cb.state("p1"), "closed");
  assert.equal(cb.allow("p1"), true);
  // Third failure: opens.
  cb.onTransientFailure("p1");
  assert.equal(cb.state("p1"), "open");
  assert.equal(cb.allow("p1"), false, "an open circuit must reject routing");
});

test("a successful call resets the transient streak", () => {
  const { cb } = breaker({ threshold: 3 });
  cb.onTransientFailure("p1");
  cb.onTransientFailure("p1");
  // Not tripped yet, a success resets.
  cb.onSuccess("p1");
  cb.onTransientFailure("p1");
  cb.onTransientFailure("p1");
  assert.equal(cb.state("p1"), "closed", "streak must have been reset");
  assert.equal(cb.allow("p1"), true);
});

test("a tripped circuit stays open until the cooldown elapses, then half-open probe", () => {
  const { cb, time } = breaker({ threshold: 1, cooldownMs: 30_000 });
  cb.onTransientFailure("p1");
  assert.equal(cb.state("p1"), "open");
  // Still within cooldown: rejected.
  time.tick(29_000);
  assert.equal(cb.allow("p1"), false, "must reject during cooldown");
  assert.equal(cb.state("p1"), "open");
  // Cooldown elapsed: allow the one half-open probe.
  time.tick(1_001);
  assert.equal(cb.allow("p1"), true, "cooldown elapsed; one probe allowed");
  assert.equal(cb.state("p1"), "half_open");
});

test("a half-open probe that succeeds closes the circuit and resets failures", () => {
  const { cb, time } = breaker({ threshold: 2, cooldownMs: 30_000 });
  cb.onTransientFailure("p1");
  cb.onTransientFailure("p1");
  assert.equal(cb.state("p1"), "open");
  time.tick(31_000);
  assert.equal(cb.allow("p1"), true); // probe
  assert.equal(cb.state("p1"), "half_open");
  cb.onSuccess("p1");
  assert.equal(cb.state("p1"), "closed");
  // Failures reset: one more failure must not trip it.
  cb.onTransientFailure("p1");
  assert.equal(cb.state("p1"), "closed");
  assert.equal(cb.allow("p1"), true);
});

test("a half-open probe that fails opens the circuit again", () => {
  const { cb, time } = breaker({ threshold: 2, cooldownMs: 30_000 });
  cb.onTransientFailure("p1");
  cb.onTransientFailure("p1");
  assert.equal(cb.state("p1"), "open");
  time.tick(31_000);
  assert.equal(cb.allow("p1"), true); // probe
  cb.onTransientFailure("p1");
  assert.equal(cb.state("p1"), "open", "failed probe must re-open");
  assert.equal(cb.allow("p1"), false);
  // A fresh cooldown must expire before another probe.
  time.tick(29_000);
  assert.equal(cb.allow("p1"), false);
  time.tick(2_000);
  assert.equal(cb.allow("p1"), true);
});

test("only one probe is allowed per half-open interval", () => {
  const { cb, time } = breaker({ threshold: 1, cooldownMs: 30_000 });
  cb.onTransientFailure("p1");
  time.tick(31_000);
  assert.equal(cb.allow("p1"), true);
  assert.equal(cb.allow("p1"), false, "a second probe in the same window is refused");
  assert.equal(cb.state("p1"), "half_open");
});

test("circuits are per-provider and independent", () => {
  const { cb } = breaker({ threshold: 1 });
  cb.onTransientFailure("p1");
  assert.equal(cb.state("p1"), "open");
  assert.equal(cb.allow("p1"), false);
  assert.equal(cb.allow("p2"), true, "another provider must be unaffected");
  assert.equal(cb.state("p2"), "closed");
});

test("success in half-open resets failures so a single prior failure does not re-trip", () => {
  const { cb, time } = breaker({ threshold: 3, cooldownMs: 30_000 });
  for (let i = 0; i < 3; i += 1) cb.onTransientFailure("p1");
  time.tick(31_000);
  assert.equal(cb.allow("p1"), true);
  cb.onSuccess("p1");
  cb.onTransientFailure("p1");
  cb.onTransientFailure("p1");
  assert.equal(cb.state("p1"), "closed");
});

test("state returns the documented enum values only", () => {
  const { cb } = breaker();
  const seen = new Set<CircuitState>();
  for (const providerId of ["x", "y"]) {
    seen.add(cb.state(providerId));
  }
  cb.onTransientFailure("x");
  cb.onTransientFailure("x");
  cb.onTransientFailure("x");
  seen.add(cb.state("x"));
  for (const value of seen) {
    assert.ok(["closed", "open", "half_open"].includes(value), value);
  }
});
