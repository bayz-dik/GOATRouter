/**
 * Runner for `scripts/verify-hermes.mjs` — 9H Task 5.
 *
 * Sequential by construction: one real client process at a time, one scenario at a time.
 * Hermes is slow to start (plugins, skills, a large tool registry), so the whole suite is
 * minutes rather than seconds — that is expected, not a hang.
 */
const s = await import("./verify-hermes-scenarios.mjs");
const part1 = await import("./verify-hermes-part1.mjs");
const part2 = await import("./verify-hermes-part2.mjs");

const { CAPABILITIES, audit, cells, failures, findExecutable, record, section, sockets } = s;

export async function run() {
  console.log("Hermes Agent real-client verification — 9H Task 5");

  const executable = findExecutable("hermes");
  if (executable === undefined) {
    /*
     * Per the Task 5 plan: absence prints a clear line and exits 0. Absence is not a BAYZ
     * failure, but it is not success either — no transcript is written, so
     * tests/matrix-integrity.test.mjs cannot let any hermes cell read VERIFIED.
     */
    console.log("\nUNVERIFIED: hermes not installed on this host");
    console.log("  No executable file named `hermes` exists on PATH. Checked as a real file");
    console.log("  rather than via `command -v`, which a shell builtin would satisfy — the");
    console.log("  measurement error 9H Task 1 caught with `continue`.");
    console.log(`  All ${CAPABILITIES.length} hermes matrix cells stay UNVERIFIED and no transcript is written.`);
    console.log("\nhermes verification: UNVERIFIED (client absent) — exiting 0");
    return;
  }

  console.log(`  client: ${executable}`);
  const { runClient } = await import("./verify-client-lib.mjs");
  const versionRun = await runClient("hermes", ["--version"], { env: process.env, timeoutMs: 90000 });
  const version = versionRun.stdout.trim();
  console.log(`  version: ${version.split("\n")[0]}`);
  console.log("\n  Isolation: every scenario runs in a throwaway HERMES_HOME and HOME, so the");
  console.log("  operator's live ~/.hermes is never read or written. This agent is itself");
  console.log("  Hermes; clobbering that directory would destroy the session verifying it.");

  await part1.wiring(version);
  await part1.chatStream();
  await part1.tools();
  await part1.largeRequest();
  await part2.cancel();
  await part2.errorsAndKeys();
  await part2.routing();
  await part2.restart();
  await part2.freeOnly();

  section("Evidence check — a claim without a transcript fails the run");
  const tally = audit();

  section("Matrix row — copy these verdicts into the hermes row");
  for (const capability of CAPABILITIES) {
    const cell = cells[capability];
    if (cell === undefined) {
      continue;
    }
    const citation = cell.transcript === undefined ? cell.note : `transcript:${cell.transcript} — ${cell.note}`;
    console.log(`| ${capability} | ${cell.status} | ${citation} |`);
  }
  console.log(`\n  tally: ${JSON.stringify(tally)}`);

  for (const socket of sockets) {
    socket.destroy();
  }

  if (failures.length > 0) {
    console.error(`\nhermes verification: FAIL (${failures.length})`);
    for (const entry of failures) {
      console.error(`  - ${entry}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("\nhermes verification: PASS");
}
