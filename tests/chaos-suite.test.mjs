import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const scripts = join(root, "scripts");

/**
 * Guards on the chaos suite itself — 9I Task 4.
 *
 * The suite is 83 assertions against real sockets, real SQLite and real restarts, and it takes
 * minutes. These tests do not re-run it; they pin the properties that make its result *meaningful*
 * and that a careless edit could silently remove:
 *
 *   - a scenario that cannot be honestly exercised must say so, not quietly pass;
 *   - the runner must exit non-zero on any failure, or nothing downstream can gate on it;
 *   - no secret sentinel may reach a committed transcript or the log.
 *
 * A suite whose harness can rot is a suite whose green is worth nothing.
 */

const FILES = ["chaos-smoke.mjs", "chaos-lib.mjs", "chaos-part1.mjs", "chaos-part2.mjs", "chaos-part3.mjs"];

function source(name) {
  return readFileSync(join(scripts, name), "utf8");
}

test("every chaos file exists and is syntactically valid", () => {
  for (const name of FILES) {
    const result = spawnSync(process.execPath, ["--check", join(scripts, name)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${name} failed --check: ${result.stderr}`);
  }
});

test("the runner exits non-zero when any check fails", () => {
  const runner = source("chaos-smoke.mjs");
  /*
   * Reading the exit path rather than forcing a failure: the suite needs minutes and real
   * listeners, so the contract is asserted on the code that implements it.
   *
   * Two exit paths, both required. The inner run exits 1 when `failures` is non-empty; the outer
   * relaunch (which re-execs under the tsx loader so TypeScript sources can be imported) must
   * propagate that status rather than swallowing it. A relaunch that returned 0 regardless would
   * make every downstream gate meaningless while the log still printed `chaos: FAIL`.
   */
  assert.match(runner, /if \(failures\.length > 0\)[\s\S]{0,400}process\.exit\(1\)/, "the runner never exits 1 on failures");
  assert.match(runner, /process\.exit\(relaunch\.status \?\? 1\)/, "the relaunch does not propagate the child's exit status");
});

test("all eleven planned scenarios are registered with the runner", () => {
  const runner = source("chaos-smoke.mjs");
  const registered = [
    "providerDiesMidRequest",
    "providerDiesMidStream",
    "providerMalformed",
    "connectionResets",
    "timeouts",
    "proxyFailures",
    "dnsFailures",
    "credentialLifecycle",
    "restartMidStream",
    "storageFailures",
    "diskExhaustion",
  ];
  for (const name of registered) {
    assert.ok(runner.includes(name), `${name} is not registered in SCENARIOS`);
  }
  // Exported where the runner expects them, so a rename cannot leave a scenario silently unrun.
  const parts = `${source("chaos-part1.mjs")}${source("chaos-part2.mjs")}${source("chaos-part3.mjs")}`;
  for (const name of registered) {
    assert.match(parts, new RegExp(`export async function ${name}\\b`), `${name} is not exported`);
  }
});

test("a scenario that cannot run on this host records UNVERIFIED rather than passing silently", () => {
  const part3 = source("chaos-part3.mjs");
  /*
   * The two host-limited scenarios. Both must carry the UNVERIFIED marker *and* a reason: the
   * plan's rule is that an unrunnable scenario is recorded with why, never skipped and never
   * reported as if it had been exercised.
   */
  const unverified = part3.match(/UNVERIFIED:/g) ?? [];
  assert.ok(unverified.length >= 2, `expected at least two UNVERIFIED records, found ${unverified.length}`);
  assert.match(part3, /read-only-database injection/, "the read-only case is not recorded");
  assert.match(part3, /disk-full injection/, "the disk-full case is not recorded");
  assert.match(part3, /CAP_SYS_ADMIN/, "the disk-full record does not state the host reason");
});

test("the disk-full scenario probes its tmpfs instead of trusting the mount exit code", () => {
  const part3 = source("chaos-part3.mjs");
  /*
   * This is the regression that matters most in this file. `mount -t tmpfs` exits 0 under proot
   * while mounting nothing, and the first version of the scenario passed on a
   * `storage_unavailable` raised by a directory that had ceased to exist. The usability probe is
   * what makes the difference between measuring disk exhaustion and imagining it.
   */
  assert.match(part3, /ENOSPC/, "the scenario does not verify that the size limit is enforced");
  assert.match(part3, /usable\.ok/, "the scenario does not gate on a usability probe");
  assert.ok(
    !/if \(mount\.status === 0\) \{/.test(part3),
    "the scenario trusts mount's exit status, which is 0 under proot even when nothing is mounted",
  );
});

test("no chaos file can leak a credential sentinel into a transcript", () => {
  /*
   * The sentinels are deliberately distinctive so this test can find them. What must never
   * happen is a sentinel being *written to a file* — printing a redacted marker is fine, and the
   * suite's own assertions read origin-side observations rather than echoing secrets.
   */
  for (const name of FILES) {
    const text = source(name);
    const writes = text.match(/writeFileSync\([^)]*\)/g) ?? [];
    for (const call of writes) {
      assert.ok(
        !/CREDENTIAL|PROXY_PASSWORD|KEK_HEX|ADMIN_TOKEN/.test(call),
        `${name} writes a secret constant to a file: ${call}`,
      );
    }
  }
});

test("the suite runs its own integrity check after every scenario that touches storage", () => {
  const parts = `${source("chaos-part1.mjs")}${source("chaos-part2.mjs")}${source("chaos-part3.mjs")}`;
  const integrityCalls = parts.match(/assertIntegrity\(/g) ?? [];
  /*
   * Ten scenarios own a data directory (disk exhaustion runs its own check inline when a bounded
   * filesystem exists). A scenario that corrupts the database while its assertions pass would
   * otherwise look identical to one that did not.
   */
  assert.ok(
    integrityCalls.length >= 10,
    `expected at least ten integrity assertions across the scenarios, found ${integrityCalls.length}`,
  );
  assert.match(parts, /PRAGMA integrity_check/, "no scenario runs PRAGMA integrity_check");
});

test("scenario 2 asserts the no-failover-after-first-byte guarantee by observation", () => {
  const part1 = source("chaos-part1.mjs");
  /*
   * Mutation-proved: allowing the post-first-chunk path to `continue` the failover loop turns
   * checks 7, 8 and 10 red. The assertion has to be about what the *second origin observed*,
   * because an assertion about the client's error alone would survive that mutation.
   */
  assert.match(part1, /secondary\.state\.chatHits/, "the guarantee is not asserted against the second origin");
  assert.match(part1, /no failover is attempted after the first byte/, "the check is missing");
});

test("the timeout scenario configures requestTimeoutMs where the schema accepts it", () => {
  const part1 = source("chaos-part1.mjs");
  /*
   * A top-level `requestTimeoutMs` is accepted with 201 and silently ignored, leaving the route
   * on its 60 s default — the scenario then passes while testing nothing. It must be nested
   * inside `config`.
   */
  assert.match(
    part1,
    /config:\s*\{[^}]*requestTimeoutMs/s,
    "requestTimeoutMs is not nested inside config, so the route keeps its default deadline",
  );
});
