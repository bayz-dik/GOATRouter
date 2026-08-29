#!/usr/bin/env node
/**
 * Chaos scenario suite — 9I Task 4.
 *
 * Every scenario runs against **real** components: a real BAYZ listener on a real port, real
 * loopback origins, a real HTTP CONNECT proxy, a real SQLite database with real envelope crypto.
 * There is no `app.inject`, no stubbed transport, and no mocked socket, because the failures this
 * suite exists to catch — a stream that dies after its first byte, a proxy that hangs up
 * mid-handshake, a database file that turns read-only — only exist at those seams.
 *
 * Each scenario asserts a **specific recovery**, not merely "no crash". A gateway that reports a
 * failure correctly and is then left unusable has still failed, so nearly every scenario ends by
 * proving the *next* request works. `PRAGMA integrity_check` runs after every scenario.
 *
 * Numbered `ok N` / `FAIL N` output, so a resilience-report row can cite `smoke:chaos#N`.
 * Numbers are contractual: append, never insert.
 *
 * Exits non-zero on any failed check.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.env.BAYZ_CHAOS_LOADER) {
  const relaunch = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, BAYZ_CHAOS_LOADER: "1" },
  });
  process.exit(relaunch.status ?? 1);
}

const lib = await import("./chaos-lib.mjs");
const part1 = await import("./chaos-part1.mjs");
const part2 = await import("./chaos-part2.mjs");
const part3 = await import("./chaos-part3.mjs");

console.log("BAYZ chaos scenarios");
console.log(`  node ${process.version}, ${process.arch}`);

const SCENARIOS = [
  part1.providerDiesMidRequest,
  part1.providerDiesMidStream,
  part1.providerMalformed,
  part1.connectionResets,
  part1.timeouts,
  part2.proxyFailures,
  part2.dnsFailures,
  part2.credentialLifecycle,
  part3.restartMidStream,
  part3.storageFailures,
  part3.diskExhaustion,
];

for (const scenario of SCENARIOS) {
  await scenario();
}

const { checkNumber, failures, notes } = lib.summary();

console.log("");
if (notes.length > 0) {
  console.log("Measured but not asserted:");
  for (const entry of notes) console.log(`  - ${entry}`);
  console.log("");
}

console.log(`${checkNumber - failures.length}/${checkNumber} checks passed`);
if (failures.length > 0) {
  console.log("");
  for (const failure of failures) console.log(`  FAIL ${failure.number}  ${failure.label}`);
  console.log("chaos: FAIL");
  process.exit(1);
}
console.log("chaos: PASS");

// Sockets tracked by the shared fixtures must not keep the process alive.
for (const socket of lib.sockets) socket.destroy();
