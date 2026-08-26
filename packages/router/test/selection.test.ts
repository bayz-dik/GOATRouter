import assert from "node:assert/strict";
import test from "node:test";
import { RouterError, resolveCandidates, selectRoute } from "../src/index.js";
import type { RouteRecord } from "../src/repository.js";

function route(overrides: Partial<RouteRecord> & { id: string }): RouteRecord {
  return {
    model: "gpt-4o",
    providerId: "p1",
    proxyId: undefined,
    priority: 100,
    enabled: true,
    config: { maxAttempts: 2, requestTimeoutMs: 60000 },
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

test("an exact match beats a wildcard even when the wildcard has higher priority", () => {
  const routes = [
    route({ id: "wild", model: "gpt-4*", priority: 1000 }),
    route({ id: "exact", model: "gpt-4o", priority: 0 }),
  ];
  assert.equal(selectRoute(routes, "gpt-4o").id, "exact");
});

test("a longer wildcard prefix beats a shorter one", () => {
  const routes = [
    route({ id: "broad", model: "gpt*", priority: 500 }),
    route({ id: "narrow", model: "gpt-4o*", priority: 500 }),
  ];
  assert.equal(selectRoute(routes, "gpt-4o-mini").id, "narrow");
});

test("priority orders routes of equal specificity", () => {
  const routes = [
    route({ id: "low", model: "gpt-4o", providerId: "p1", priority: 10 }),
    route({ id: "high", model: "gpt-4o", providerId: "p2", priority: 900 }),
    route({ id: "mid", model: "gpt-4o", providerId: "p3", priority: 500 }),
  ];
  assert.deepEqual(
    resolveCandidates(routes, "gpt-4o").map((candidate) => candidate.id),
    ["high", "mid", "low"],
  );
});

test("the id breaks a full tie so selection is reproducible", () => {
  const routes = [
    route({ id: "zeta", model: "gpt-4o", providerId: "p3" }),
    route({ id: "alpha", model: "gpt-4o", providerId: "p1" }),
    route({ id: "mid", model: "gpt-4o", providerId: "p2" }),
  ];
  assert.deepEqual(
    resolveCandidates(routes, "gpt-4o").map((candidate) => candidate.id),
    ["alpha", "mid", "zeta"],
  );
});

test("selection does not depend on insertion order", () => {
  const base = [
    route({ id: "a", model: "gpt-4o", providerId: "p1", priority: 200 }),
    route({ id: "b", model: "gpt-4*", providerId: "p2", priority: 900 }),
    route({ id: "c", model: "gpt-4o", providerId: "p3", priority: 200 }),
  ];
  const expected = resolveCandidates(base, "gpt-4o").map((r) => r.id);

  // Every permutation must produce the same ordering.
  const permutations = [
    [base[0]!, base[2]!, base[1]!],
    [base[1]!, base[0]!, base[2]!],
    [base[1]!, base[2]!, base[0]!],
    [base[2]!, base[0]!, base[1]!],
    [base[2]!, base[1]!, base[0]!],
  ];
  for (const permutation of permutations) {
    assert.deepEqual(
      resolveCandidates(permutation, "gpt-4o").map((r) => r.id),
      expected,
    );
  }
  assert.deepEqual(expected, ["a", "c", "b"]);
});

test("repeated calls are stable", () => {
  const routes = [
    route({ id: "a", model: "gpt-4*", providerId: "p1" }),
    route({ id: "b", model: "gpt-4*", providerId: "p2" }),
  ];
  const first = resolveCandidates(routes, "gpt-4o").map((r) => r.id);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.deepEqual(resolveCandidates(routes, "gpt-4o").map((r) => r.id), first);
  }
});

test("disabled routes are excluded entirely", () => {
  const routes = [
    route({ id: "off", model: "gpt-4o", providerId: "p1", enabled: false, priority: 1000 }),
    route({ id: "on", model: "gpt-4o", providerId: "p2", priority: 1 }),
  ];
  assert.deepEqual(
    resolveCandidates(routes, "gpt-4o").map((r) => r.id),
    ["on"],
  );
  assert.equal(selectRoute(routes, "gpt-4o").id, "on");
});

test("no matching route is no_route, not route_not_found", () => {
  const routes = [route({ id: "a", model: "claude-3*" })];
  assert.deepEqual(resolveCandidates(routes, "gpt-4o"), []);
  assert.throws(
    () => selectRoute(routes, "gpt-4o"),
    (error: unknown) => error instanceof RouterError && error.code === "no_route",
  );
});

test("every route disabled is also no_route", () => {
  const routes = [route({ id: "a", model: "gpt-4o", enabled: false })];
  assert.throws(
    () => selectRoute(routes, "gpt-4o"),
    (error: unknown) => error instanceof RouterError && error.code === "no_route",
  );
});

test("an empty registry is no_route", () => {
  assert.throws(
    () => selectRoute([], "gpt-4o"),
    (error: unknown) => error instanceof RouterError && error.code === "no_route",
  );
});

test("the requested model is validated before matching", () => {
  const routes = [route({ id: "a", model: "gpt-4*" })];
  for (const model of ["../../etc/passwd", "", "has space", "gpt-4o\r\n"]) {
    assert.throws(
      () => resolveCandidates(routes, model),
      (error: unknown) =>
        error instanceof RouterError && error.code === "invalid_model",
      `model must be rejected: ${model}`,
    );
  }
});

test("candidates preserve the proxy binding and config of each route", () => {
  const routes = [
    route({
      id: "viax",
      model: "gpt-4o",
      providerId: "p1",
      proxyId: "x1",
      config: { maxAttempts: 4, requestTimeoutMs: 5000 },
    }),
  ];
  const [candidate] = resolveCandidates(routes, "gpt-4o");
  assert.ok(candidate !== undefined);
  assert.equal(candidate.proxyId, "x1");
  assert.equal(candidate.config.maxAttempts, 4);
  assert.equal(candidate.config.requestTimeoutMs, 5000);
});

test("the input array is not mutated by selection", () => {
  const routes = [
    route({ id: "z", model: "gpt-4o", providerId: "p1", priority: 1 }),
    route({ id: "a", model: "gpt-4o", providerId: "p2", priority: 900 }),
  ];
  const order = routes.map((r) => r.id);
  resolveCandidates(routes, "gpt-4o");
  assert.deepEqual(routes.map((r) => r.id), order);
});
