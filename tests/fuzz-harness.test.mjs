import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Phase 9I Task 1 — the deterministic fuzz harness.
 *
 * Every requirement here comes from the plan's Task 1 RED list. The one that shapes the
 * whole design is reproducibility **across processes**: a crash found at iteration 3,812 of
 * a 5,000-iteration run is worthless unless the exact input can be regenerated tomorrow, in
 * a different process, from nothing but the seed. So the seed must drive a pure function of
 * its own, not `Math.random()` seeded once, and not anything that reads the clock, the pid,
 * or `crypto.randomBytes` at generation time.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const HARNESS = join(HERE, "..", "scripts", "fuzz", "harness.mjs");

const { createRng, fuzz, FuzzError } = await import(HARNESS);

function drawSequence(rng, count = 24) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(rng.nextUint32());
  return out;
}

test("the same seed produces a byte-identical sequence twice in one process", () => {
  const first = drawSequence(createRng("phase9i-seed-1"));
  const second = drawSequence(createRng("phase9i-seed-1"));
  assert.deepEqual(second, first);

  /*
   * Not merely equal-looking: the sequence must be non-degenerate. A generator that
   * returned 0 forever would satisfy "identical twice" while being useless, so assert the
   * draws actually vary and span the 32-bit range.
   */
  assert.ok(new Set(first).size >= 20, `sequence is degenerate: ${JSON.stringify(first)}`);
  assert.ok(first.some((v) => v > 0xffffffff / 2), "no draw landed in the upper half");
  for (const value of first) {
    assert.ok(Number.isInteger(value) && value >= 0 && value <= 0xffffffff, `not a uint32: ${value}`);
  }
});

test("the same seed produces a byte-identical sequence in a separate process", () => {
  /*
   * This is the requirement that cannot be faked by module-level caching: a fresh process
   * shares no state with this one.
   */
  const dir = mkdtempSync(join(tmpdir(), "bayz-fuzz-repro-"));
  const child = join(dir, "child.mjs");
  writeFileSync(
    child,
    [
      `const { createRng } = await import(${JSON.stringify(HARNESS)});`,
      `const rng = createRng("phase9i-seed-1");`,
      `const out = [];`,
      `for (let i = 0; i < 24; i += 1) out.push(rng.nextUint32());`,
      `process.stdout.write(JSON.stringify(out));`,
    ].join("\n"),
  );

  const result = spawnSync(process.execPath, [child], { encoding: "utf8" });
  assert.equal(result.status, 0, `child failed: ${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), drawSequence(createRng("phase9i-seed-1")));
});

test("a different seed produces a different sequence", () => {
  const a = drawSequence(createRng("phase9i-seed-1"));
  const b = drawSequence(createRng("phase9i-seed-2"));
  assert.notDeepEqual(b, a);

  // A one-character seed change must not merely shift the stream by a step.
  assert.notDeepEqual(b.slice(0, 12), a.slice(1, 13));

  // Numeric and string seeds are both accepted and are distinct spaces.
  assert.notDeepEqual(drawSequence(createRng(1)), drawSequence(createRng("1")));
});

test("the rng helpers stay inside their documented bounds", () => {
  const rng = createRng("bounds");
  for (let i = 0; i < 500; i += 1) {
    const f = rng.next();
    assert.ok(f >= 0 && f < 1, `next() out of range: ${f}`);
    const n = rng.int(3, 7);
    assert.ok(Number.isInteger(n) && n >= 3 && n <= 7, `int() out of range: ${n}`);
    assert.equal(rng.int(9, 9), 9);
    const bytes = rng.bytes(4);
    assert.equal(bytes.length, 4);
    assert.ok(bytes.every((b) => b >= 0 && b <= 255));
    assert.ok(["a", "b"].includes(rng.pick(["a", "b"])));
  }
  assert.equal(typeof rng.bool(), "boolean");
});

test("a throwing run is recorded with the input and the iteration, and the run continues", async () => {
  const seen = [];
  const result = await fuzz({
    name: "throwing",
    seed: "throw-seed",
    iterations: 10,
    generate: (rng) => ({ n: rng.int(0, 1000) }),
    run: (input, { iteration }) => {
      seen.push(iteration);
      if (iteration === 2 || iteration === 7) throw new Error(`boom at ${iteration}`);
    },
  });

  assert.equal(result.name, "throwing");
  assert.equal(result.seed, "throw-seed");
  assert.equal(result.iterations, 10);

  /*
   * The harness must not stop at the first failure. A boundary that breaks on one shape
   * usually breaks on several, and finding them in one run beats ten edit-rerun cycles.
   */
  assert.equal(result.completed, 10);
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  assert.equal(result.failures.length, 2);
  assert.deepEqual(
    result.failures.map((f) => f.iteration),
    [2, 7],
  );
  for (const failure of result.failures) {
    assert.match(failure.error, /boom at/);
    assert.ok(failure.input && typeof failure.input.n === "number", "failing input was not captured");
  }

  // The captured input must be the one that actually failed, replayable from the seed.
  const replay = createRng("throw-seed");
  const expected = [];
  for (let i = 0; i < 10; i += 1) expected.push({ n: replay.int(0, 1000) });
  assert.deepEqual(result.failures[0].input, expected[2]);
  assert.deepEqual(result.failures[1].input, expected[7]);
});

test("an async rejection inside run is recorded, not swallowed", async () => {
  const result = await fuzz({
    name: "async-reject",
    seed: "s",
    iterations: 4,
    generate: () => ({}),
    run: async (_input, { iteration }) => {
      if (iteration === 1) await Promise.reject(new Error("async boom"));
    },
  });
  assert.equal(result.completed, 4);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].iteration, 1);
  assert.match(result.failures[0].error, /async boom/);
});

test("an unhandledRejection escaping a run is attributed to that iteration", async () => {
  const result = await fuzz({
    name: "unhandled",
    seed: "s",
    iterations: 4,
    generate: () => ({}),
    run: (_input, { iteration }) => {
      // A floating promise: nothing awaits it, so it surfaces as an unhandledRejection.
      if (iteration === 2) Promise.reject(new Error("floating boom"));
    },
  });

  assert.equal(result.completed, 4);
  const attributed = result.failures.filter((f) => /floating boom/.test(f.error));
  assert.equal(attributed.length, 1, `expected exactly one attribution, got ${JSON.stringify(result.failures)}`);
  assert.equal(attributed[0].iteration, 2, "the rejection was attributed to the wrong iteration");
  assert.equal(attributed[0].kind, "unhandledRejection");
});

test("an uncaughtException escaping a run is attributed to that iteration", async () => {
  const result = await fuzz({
    name: "uncaught",
    seed: "s",
    iterations: 4,
    generate: () => ({}),
    run: (_input, { iteration }) => {
      if (iteration === 1) {
        setImmediate(() => {
          throw new Error("detached boom");
        });
      }
    },
  });

  assert.equal(result.completed, 4);
  const attributed = result.failures.filter((f) => /detached boom/.test(f.error));
  assert.equal(attributed.length, 1, `expected exactly one attribution, got ${JSON.stringify(result.failures)}`);
  assert.equal(attributed[0].iteration, 1);
  assert.equal(attributed[0].kind, "uncaughtException");
});

test("process listeners are restored after a run", async () => {
  const before = {
    rejection: process.listenerCount("unhandledRejection"),
    exception: process.listenerCount("uncaughtException"),
  };
  await fuzz({ name: "listeners", seed: "s", iterations: 2, generate: () => ({}), run: () => {} });
  assert.equal(process.listenerCount("unhandledRejection"), before.rejection);
  assert.equal(process.listenerCount("uncaughtException"), before.exception);
});

test("a single input is capped at 1 MiB so a generator bug cannot exhaust memory", async () => {
  await assert.rejects(
    fuzz({
      name: "huge",
      seed: "s",
      iterations: 3,
      generate: () => "x".repeat(1024 * 1024 + 1),
      run: () => {},
    }),
    (error) => {
      assert.ok(error instanceof FuzzError, `expected FuzzError, got ${error?.constructor?.name}`);
      assert.equal(error.code, "input_too_large");
      return true;
    },
  );

  // Exactly at the bound is allowed: the cap is a limit, not a margin.
  const ok = await fuzz({
    name: "at-bound",
    seed: "s",
    iterations: 1,
    generate: () => "x".repeat(1024 * 1024),
    run: () => {},
  });
  assert.equal(ok.failures.length, 0);
});

test("total wall time is bounded and the harness reports what it actually completed", async () => {
  const result = await fuzz({
    name: "bounded",
    seed: "s",
    iterations: 1_000_000,
    timeBudgetMs: 150,
    generate: () => ({}),
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
  });

  assert.equal(result.iterations, 1_000_000, "the requested count must be reported as requested");
  assert.ok(result.completed > 0, "nothing ran");
  assert.ok(
    result.completed < 1_000_000,
    "the time budget did not stop the run — an honest harness must not claim the requested count",
  );
  assert.equal(result.truncated, true, "a shortened run must say so");
  assert.ok(result.durationMs >= 100, `duration looks wrong: ${result.durationMs}`);
});

test("a per-iteration budget turns a hang into a recorded failure", async () => {
  /*
   * Task 3 asserts a 250 ms per-iteration budget across every target: a boundary that takes
   * unbounded time on a hostile input is a denial-of-service, so slowness is a failure with
   * the input recorded, not a performance note.
   */
  const result = await fuzz({
    name: "slow",
    seed: "s",
    iterations: 3,
    iterationBudgetMs: 40,
    generate: (rng) => ({ n: rng.int(0, 9) }),
    run: async (_input, { iteration }) => {
      if (iteration === 1) await new Promise((resolve) => setTimeout(resolve, 160));
    },
  });

  assert.equal(result.completed, 3);
  const slow = result.failures.filter((f) => f.kind === "budget");
  assert.equal(slow.length, 1);
  assert.equal(slow[0].iteration, 1);
  assert.ok(slow[0].input, "the slow input must be recorded so it can be replayed");
  assert.match(slow[0].error, /budget/i);
});

test("a never-settling iteration is cut off rather than hanging the run", async () => {
  /*
   * The distinction Mutation F exposed: the post-hoc elapsed check catches an iteration that
   * is *slow but finishes*, while only the timer race catches one that never settles at all.
   * A boundary that hangs forever on a hostile input is the actual denial-of-service case,
   * and without this test the timer could be disabled with the suite still green.
   */
  const started = Date.now();
  const result = await fuzz({
    name: "hang",
    seed: "s",
    iterations: 3,
    iterationBudgetMs: 60,
    generate: (rng) => ({ n: rng.int(0, 9) }),
    run: (_input, { iteration }) =>
      iteration === 1 ? new Promise(() => {}) : undefined, // never resolves
  });

  assert.equal(result.completed, 3, "the run must survive a hung iteration");
  assert.ok(
    Date.now() - started < 5000,
    "the hung iteration was not cut off — the run waited on a promise that never settles",
  );

  const hung = result.failures.filter((f) => f.kind === "budget");
  assert.equal(hung.length, 1);
  assert.equal(hung[0].iteration, 1);
  assert.ok(hung[0].input, "the hanging input must be recorded so it can be replayed");
});

test("the harness refuses to run when a generated input carries credential-shaped data", async () => {
  const shapes = [
    "sk-livekeymaterialgoeshere",
    "Bearer abcdefghijklmnop",
    "-----BEGIN RSA PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----",
    "a".repeat(64),
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  ];

  for (const shape of shapes) {
    await assert.rejects(
      fuzz({ name: "cred", seed: "s", iterations: 2, generate: () => shape, run: () => {} }),
      (error) => {
        assert.ok(error instanceof FuzzError, `expected FuzzError for ${shape}`);
        assert.equal(error.code, "credential_shape");
        return true;
      },
      `credential shape not refused: ${shape}`,
    );
  }
});

test("the credential scan reaches nested values and object keys", async () => {
  const nested = { a: [{ b: { c: ["Bearer sneaky-value"] } }] };
  await assert.rejects(
    fuzz({ name: "nested", seed: "s", iterations: 1, generate: () => nested, run: () => {} }),
    (error) => error instanceof FuzzError && error.code === "credential_shape",
  );

  await assert.rejects(
    fuzz({
      name: "keyed",
      seed: "s",
      iterations: 1,
      generate: () => ({ "sk-in-the-key": 1 }),
      run: () => {},
    }),
    (error) => error instanceof FuzzError && error.code === "credential_shape",
  );
});

test("ordinary hostile input is not mistaken for a credential", async () => {
  /*
   * The scan must not be so eager that it blocks the corpus this phase actually needs.
   * 63 and 65 hex characters are not the 64-hex shape; "sk" alone is not "sk-".
   */
  const result = await fuzz({
    name: "benign",
    seed: "s",
    iterations: 1,
    generate: () => ({
      proto: "__proto__",
      sql: "'; DROP TABLE identities; --",
      hex63: "a".repeat(63),
      hex65: "a".repeat(65),
      sk: "sk",
      bearer: "Bearer",
      nul: "a\u0000b",
      surrogate: "\ud800",
    }),
    run: () => {},
  });
  assert.equal(result.failures.length, 0);
});

test("the scan also covers what a target reports, not just what a generator produced", async () => {
  /*
   * Failing inputs are written to the regression corpus by Task 3. If a boundary echoed a
   * credential back inside an error message, saving that failure would commit the secret.
   */
  await assert.rejects(
    fuzz({
      name: "leaky-error",
      seed: "s",
      iterations: 1,
      generate: () => ({ ok: true }),
      run: () => {
        throw new Error("upstream said: sk-leakedvaluefromtheprovider");
      },
    }),
    (error) => error instanceof FuzzError && error.code === "credential_shape",
  );
});

test("fuzz validates its own arguments rather than producing a meaningless zero-failure run", async () => {
  const bad = [
    { name: "", seed: "s", iterations: 1, generate: () => ({}), run: () => {} },
    { name: "n", seed: undefined, iterations: 1, generate: () => ({}), run: () => {} },
    { name: "n", seed: "s", iterations: 0, generate: () => ({}), run: () => {} },
    { name: "n", seed: "s", iterations: -1, generate: () => ({}), run: () => {} },
    { name: "n", seed: "s", iterations: 1.5, generate: () => ({}), run: () => {} },
    { name: "n", seed: "s", iterations: 1, generate: "nope", run: () => {} },
    { name: "n", seed: "s", iterations: 1, generate: () => ({}), run: "nope" },
  ];
  for (const options of bad) {
    await assert.rejects(
      fuzz(options),
      (error) => error instanceof FuzzError && error.code === "fuzz_options",
      `not rejected: ${JSON.stringify(Object.keys(options))}`,
    );
  }
});
