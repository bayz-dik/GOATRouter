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
 * Guards on the soak harness — 9I Task 6.
 *
 * A soak takes ten minutes; these tests do not run one. They pin the properties that decide whether
 * its green means anything:
 *
 *   - every metric the plan lists is actually sampled;
 *   - the trend is a slope over the second half, not a first-to-last delta;
 *   - a leak is a FAIL with the series attached, not a warning;
 *   - the pruning assertion cannot pass vacuously;
 *   - the transcript is written before any summary is printed.
 */

const FILES = ["soak-smoke.mjs", "soak-lib.mjs", "soak-traffic.mjs"];

function source(name) {
  return readFileSync(join(scripts, name), "utf8");
}

test("every soak file exists and is syntactically valid", () => {
  for (const name of FILES) {
    const result = spawnSync(process.execPath, ["--check", join(scripts, name)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${name} failed --check: ${result.stderr}`);
  }
});

test("every metric the plan names is sampled", () => {
  const lib = source("soak-lib.mjs");
  /*
   * The plan's list, item by item. A sample that quietly stopped recording file descriptors would
   * leave the fd assertion comparing undefined to undefined and passing.
   */
  for (const metric of ["heapUsed", "heapTotal", "external", "rss", "handles", "requestsActive", "timers", "fds", "dbBytes", "walBytes", "sockets"]) {
    assert.match(lib, new RegExp(`${metric}[,:]`), `the sample omits ${metric}`);
  }
  assert.match(lib, /readdirSync\("\/proc\/self\/fd"\)/, "open file descriptors are not read from /proc/self/fd");
});

test("the default duration is the plan's ten minutes and the long mode is two hours", () => {
  const runner = source("soak-smoke.mjs");
  assert.match(runner, /long \? 7200 : 600/, "the default and long durations do not match the plan (600 s / 7200 s)");
  assert.match(runner, /SAMPLE_INTERVAL_MS = 15_000/, "the sampling interval is not 15 s");
});

test("the run refuses an absurdly short duration rather than pretending to soak", () => {
  const runner = source("soak-smoke.mjs");
  /*
   * A soak whose duration can be set to one second is a soak that can be made to pass by not
   * running. The floor is a refusal with exit 2, not a clamp.
   */
  assert.match(runner, /durationSec < 30/, "there is no minimum duration");
  assert.match(runner, /process\.exit\(2\)/, "a too-short duration does not exit 2");
});

test("the trend is a least-squares slope over the second half, not a delta", () => {
  const lib = source("soak-lib.mjs");
  const runner = source("soak-smoke.mjs");
  /*
   * A first-to-last delta would let one late garbage collection or one host stall decide the verdict.
   * The slope is over the second half specifically, because the first half is warm-up.
   */
  assert.match(lib, /export function slope/, "there is no slope helper");
  assert.match(lib, /numerator \+= \(index - meanX\) \* \(values\[index\] - meanY\)/, "slope is not a least-squares fit");
  assert.match(runner, /samples\.slice\(Math\.floor\(samples\.length \/ 2\)\)/, "the trend is not taken over the second half");
});

test("a short run records the trend UNVERIFIED instead of asserting on too few points", () => {
  const runner = source("soak-smoke.mjs");
  /*
   * Found by running at --duration=45: two second-half samples make a "slope" that is just their
   * difference, and ordinary warm-up read as a 1,144 KiB/sample leak. The alternative — widening the
   * tolerance until the short run passed — would have destroyed the check at the real duration.
   */
  assert.match(runner, /MIN_TREND_SAMPLES/, "there is no minimum sample count for the trend");
  assert.match(runner, /UNVERIFIED: heap and RSS trend/, "a short run does not record UNVERIFIED");
});

test("a leak fails with the sample series attached", () => {
  const runner = source("soak-smoke.mjs");
  /*
   * The plan is explicit: a leak is a FAIL with the series attached, not a warning. The detail
   * string must carry the numbers, or a failure report would say "heap grew" and leave the reader
   * with nothing to judge.
   */
  assert.match(runner, /heap slope [\s\S]{0,120}series:/, "the heap failure detail does not attach the series");
  assert.match(runner, /RSS slope [\s\S]{0,120}series:/, "the RSS failure detail does not attach the series");
  assert.match(runner, /A leak is a FAIL with the series above attached/, "the transcript does not state the leak policy");
});

test("the pruning assertion cannot pass vacuously", () => {
  const runner = source("soak-smoke.mjs");
  const lib = source("soak-lib.mjs");
  /*
   * `DEFAULT_REQUEST_RETENTION` is 5,000 rows; a ten-minute run on this device does not reach it, so
   * pruning would never execute and "rows are pruned" would pass without the code ever running. The
   * retention is lowered through the documented env var — a real configuration value, not a weakened
   * limit — and a separate check proves the run actually crossed it.
   */
  assert.match(lib, /BAYZ_USAGE_RETENTION/, "retention is not configured through the documented env var");
  assert.match(runner, /pruning was actually exercised/, "there is no check that the retention bound was crossed");
  assert.match(runner, /counts\.requests <= SOAK_RETENTION/, "the pruning bound is not asserted");
});

test("the traffic mix covers every kind the plan lists", () => {
  const traffic = source("soak-traffic.mjs");
  for (const kind of ["chat", "stream", "tool", "models", "usage", "management"]) {
    assert.match(traffic, new RegExp(`counts\\.${kind} \\+= 1`), `the mix never counts ${kind}`);
  }
  const runner = source("soak-smoke.mjs");
  assert.match(runner, /every traffic kind was exercised/, "there is no check that every kind ran");
  // The tool roundtrip must be two legs, including the role:"tool" reply that broke in 9H Task 5.
  assert.match(traffic, /role: "tool", tool_call_id/, "the tool roundtrip does not send a tool result message");
});

test("the sampler runs on its own cadence, independent of request latency", () => {
  const traffic = source("soak-traffic.mjs");
  /*
   * If samples were taken inside the traffic loop, a slow patch would thin the series exactly where
   * it matters. `setInterval` keeps the cadence fixed regardless.
   */
  assert.match(traffic, /setInterval\(\(\) => \{[\s\S]{0,120}onSample/, "sampling is not on an independent interval");
  assert.match(traffic, /clearInterval\(sampler\)/, "the sampler is never cleared, which would leak a timer");
});

test("the relaunch forwards execArgv so --expose-gc survives", () => {
  const runner = source("soak-smoke.mjs");
  /*
   * The quiet-period check calls `globalThis.gc?.()`. Dropping the flag in the relaunch would make
   * that a silent no-op and the check would pass having measured an un-collected heap.
   */
  assert.match(runner, /\.\.\.process\.execArgv/, "the relaunch drops execArgv, losing --expose-gc");
});

test("the harness refuses to summarise without writing a transcript", () => {
  const lib = source("soak-lib.mjs");
  assert.match(lib, /throw new Error\([^)]*transcript was not written/, "writeTranscript does not fail when the file is absent");
  const runner = source("soak-smoke.mjs");
  const writeIndex = runner.indexOf("writeTranscript({");
  const printIndex = runner.lastIndexOf("checks passed`");
  assert.ok(writeIndex > 0 && printIndex > writeIndex, "the summary is printed before the transcript is written");
});

test("a written soak transcript carries its provenance and the full series", () => {
  const path = join(root, "docs/transcripts/soak/soak.md");
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  assert.match(text, /- Device: Termux\/Android ARM64/, "the transcript does not name the device");
  assert.match(text, /- Commit: [0-9a-f]{7,40}/, "the transcript does not record a commit");
  assert.match(text, /- Command: `node scripts\/soak-smoke\.mjs/, "the transcript does not record the command");
  assert.match(text, /\| t \(s\) \| requests \| heap MiB \|/, "the transcript carries no resource series");
  assert.match(text, /baseline \(before traffic\)/, "the transcript omits the baseline row");
  assert.match(text, /after quiet period/, "the transcript omits the quiet-period row");
});
