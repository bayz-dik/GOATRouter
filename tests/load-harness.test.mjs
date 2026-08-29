import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const scripts = join(root, "scripts");

/**
 * Guards on the load harness — 9I Task 5.
 *
 * The load run itself takes minutes and drives thousands of real requests; these tests do not
 * repeat it. They pin the properties that make its numbers trustworthy, each of which a careless
 * edit could remove while leaving the run green:
 *
 *   - a summary table may never be printed without a transcript on disk;
 *   - the five concurrency levels the plan names are actually the levels run;
 *   - no latency threshold is asserted (the plan forbids it — a perf gate on a shared phone is noise);
 *   - the cross-talk guard reads what the response actually carried, not a value the harness knew;
 *   - the cap proof observes the origin, not the client.
 */

const FILES = ["load-smoke.mjs", "load-lib.mjs", "load-cap.mjs"];

function source(name) {
  return readFileSync(join(scripts, name), "utf8");
}

test("every load file exists and is syntactically valid", () => {
  for (const name of FILES) {
    const result = spawnSync(process.execPath, ["--check", join(scripts, name)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${name} failed --check: ${result.stderr}`);
  }
});

test("the plan's five concurrency levels are the levels driven", () => {
  const runner = source("load-smoke.mjs");
  /*
   * Read from the non-quick branch specifically. `--quick` exists for iteration and its reduced
   * levels must not be mistaken for the real series — the transcript marks itself when quick, and
   * this test makes sure the full path still carries all five.
   *
   * The slice is anchored on the ternary's `: [` and the following comment. An earlier version
   * anchored on `] : [`, which does not appear: the quick branch's last entry is followed by a
   * newline before the bracket, so the marker never matched and the slice was empty — a test that
   * would have passed no matter what levels were configured.
   */
  const start = runner.indexOf("  : [");
  const end = runner.indexOf("/** Codes a load run");
  assert.ok(start > 0 && end > start, "could not locate the full LEVELS branch");
  const full = runner.slice(start, end);
  for (const level of [1, 8, 32, 128, 256]) {
    assert.match(full, new RegExp(`concurrency: ${level},`), `concurrency ${level} is not in the full series`);
  }
  // And the quick branch must not be mistaken for it.
  assert.match(runner, /quick[\s\S]{0,200}concurrency: 1,/, "the quick branch is missing");
});

test("the harness refuses to summarise without writing a transcript", () => {
  const lib = source("load-lib.mjs");
  /*
   * The plan's wording is "must refuse to print a summary table without writing its transcript".
   * Implemented as a throw, not a warning: a capacity figure whose provenance is not on disk is
   * indistinguishable from one somebody typed.
   */
  assert.match(lib, /throw new Error\([^)]*transcript was not written/, "writeTranscript does not fail when the file is absent");
  const runner = source("load-smoke.mjs");
  const writeIndex = runner.indexOf("writeTranscript({");
  const printIndex = runner.indexOf("console.log(table(");
  assert.ok(writeIndex > 0, "the runner never writes a transcript");
  assert.ok(printIndex > writeIndex, "the summary table is printed before the transcript is written");
});

test("the transcript names the device, timestamp, commit and command", () => {
  const lib = source("load-lib.mjs");
  for (const field of ["Device:", "Node:", "Timestamp:", "Commit:", "Command:"]) {
    assert.ok(lib.includes(field), `the transcript header omits ${field}`);
  }
  assert.match(lib, /Termux\/Android ARM64/, "the device is not named");
});

test("no latency threshold is asserted anywhere in the load harness", () => {
  /*
   * The plan is explicit that a performance gate on a shared Android device would be noise. A
   * check comparing a percentile against a constant would be exactly that, so its absence is a
   * property worth pinning: someone adding `p95 < 500` later should have to delete this test and
   * think about why.
   */
  for (const name of FILES) {
    const text = source(name);
    const suspicious = text.match(/check\([^)]*\b(p50|p95|p99|totalMs|ttfbMs)\b[^)]*[<>]=?\s*\d/gs) ?? [];
    assert.equal(suspicious.length, 0, `${name} asserts a latency threshold: ${suspicious[0]}`);
  }
});

test("the cross-talk guard compares the response's own sentinel", () => {
  const runner = source("load-smoke.mjs");
  /*
   * The guard must compare `entry.echoed` — what came back — against `entry.sentinel`, what was
   * sent. A check that only counted responses, or that compared a value the harness generated
   * against itself, would pass while two requests were being spliced together.
   */
  assert.match(runner, /entry\.echoed[\s\S]{0,80}entry\.sentinel/, "the cross-talk check does not compare echoed against sent");
  const lib = source("load-lib.mjs");
  assert.match(lib, /parsed\?\.messages\?\.\[0\]\?\.content/, "the origin does not read the sentinel from the request it received");
});

test("the cap proof observes upstream concurrency at the origin", () => {
  const cap = source("load-cap.mjs");
  /*
   * "The 33rd request waits rather than opening a socket" is only observable where the socket would
   * be opened. A client-side assertion would be satisfied by a system that opened 200 sockets and
   * was merely slow.
   */
  assert.match(cap, /origin\.state\.maxConcurrent/, "the cap proof does not observe the origin's concurrency");
  assert.match(cap, /originMaxConcurrent <= limit/, "the cap proof does not bound origin concurrency by the limit");
});

test("the cap proof restores the process-wide limit it changed", () => {
  const cap = source("load-cap.mjs");
  /*
   * A 4-permit semaphore left installed would silently throttle every later measurement in the
   * same process — and the run would still be green, which is what makes it dangerous.
   */
  assert.match(cap, /const previous = concurrency\.outboundSemaphore\(\)\.limit/, "the previous limit is never captured");
  assert.match(cap, /configureOutboundConcurrency\(\{ limit: previous \}\)/, "the previous limit is never restored");
  assert.match(cap, /the process-wide limit is restored/, "there is no check that the restore happened");
});

test("the queue-full assertion cannot hang the run", () => {
  const cap = source("load-cap.mjs");
  /*
   * Mutation A (removing the queue-full rejection) made a bare `await` hang, and Node exited 13
   * with "unsettled top-level await" — red, but reporting that the harness broke rather than that
   * the bound was gone. The race turns the same mutation into a named failing check.
   */
  assert.match(cap, /Promise\.race\(\[[\s\S]{0,300}semaphore\.acquire\(\)/, "the queue-full acquire is not raced against a timeout");
  assert.match(cap, /the queue is unbounded/, "there is no message naming the unbounded-queue defect");
});

test("both concurrency mechanisms are proved, and distinguished", () => {
  const cap = source("load-cap.mjs");
  /*
   * Outbound queues then refuses; inbound refuses immediately with no queue. Conflating them would
   * misdescribe the system, so both are exercised and the difference is stated.
   */
  assert.match(cap, /proveInboundGate/, "the inbound gate is not proved");
  assert.match(cap, /auth\.ts:190/, "the inbound gate's implementation is not cited");
  assert.match(cap, /retry-after/, "the inbound refusal's retry-after is not checked");
});

test("a written transcript, if present, carries its provenance", () => {
  /*
   * Only meaningful once a run has happened; skipped rather than failed when absent so the test is
   * useful in a fresh clone without forcing a multi-minute run.
   */
  const path = join(root, "docs/transcripts/load/load.md");
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  assert.match(text, /- Device: Termux\/Android ARM64/, "the transcript does not name the device");
  assert.match(text, /- Commit: [0-9a-f]{7,40}/, "the transcript does not record a commit");
  assert.match(text, /- Command: `node scripts\/load-smoke\.mjs/, "the transcript does not record the command");
  assert.match(text, /\| concurrency \|/, "the transcript carries no results table");
  for (const level of [1, 8, 32, 128, 256]) {
    assert.match(text, new RegExp(`^\\| ${level} \\|`, "m"), `the transcript omits concurrency ${level}`);
  }
});
