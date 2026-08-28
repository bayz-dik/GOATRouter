#!/usr/bin/env node
/**
 * Real-client verification for Antigravity — 9H Task 5.
 *
 * **Antigravity is not installed on this host.** This script exists so a machine that has
 * it can produce evidence without anyone writing a harness first, and so the absence is
 * recorded as a measurement rather than a gap in the matrix.
 *
 * Per the Task 5 plan: if the client is absent it prints
 * `UNVERIFIED: antigravity not installed on this host` and **exits 0**. Absence is not a
 * failure of BAYZ — but it is not success either, so every cell stays `UNVERIFIED` and
 * this script writes **no transcript**. `tests/matrix-integrity.test.mjs` then cannot let
 * any Antigravity cell read `VERIFIED`, because there is nothing on disk for it to cite.
 *
 * Why the presence check does not stop at `command -v`:
 *
 * Task 1 caught a real measurement error of exactly this kind — `command -v continue`
 * "found" a client that was actually the shell's `continue` builtin. So a candidate must
 * be an executable *file* on disk, and it must survive a `--version` invocation. A name
 * that resolves but cannot run is absence, not presence.
 *
 * The configuration form is deliberately **not** guessed. `docs/clients/antigravity.md`
 * documents no config block for the same reason: OpenCode uses JSON with camelCase
 * `options.baseURL`, Hermes uses YAML with snake_case `model.base_url` and a host-derived
 * env var, and there is no safe default between them. When the client exists, the person
 * running this will read its real config file and fill in `configureAntigravity` below —
 * the scaffolding is here, the invention is not.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.env.BAYZ_VERIFY_ANTIGRAVITY_LOADER) {
  const relaunch = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url)],
    { stdio: "inherit", env: { ...process.env, BAYZ_VERIFY_ANTIGRAVITY_LOADER: "1" } },
  );
  process.exit(relaunch.status ?? 1);
}

const { CAPABILITIES } = await import("./verify-client-lib.mjs");
const { existsSync, statSync } = await import("node:fs");
const { delimiter, join } = await import("node:path");

const CLIENT = "antigravity";

/**
 * Locate a real executable file named `antigravity` on PATH.
 *
 * `spawnSync("command", ["-v", ...])` is deliberately avoided: a shell builtin or an alias
 * satisfies it without an executable existing, which is the Task 1 `continue` mistake.
 */
function findExecutable(name) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    const candidate = join(dir, name);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // An unreadable PATH entry is not a match.
    }
  }
  return undefined;
}

console.log("Antigravity real-client verification — 9H Task 5");

const executable = findExecutable(CLIENT);

if (executable === undefined) {
  console.log(`\nUNVERIFIED: ${CLIENT} not installed on this host`);
  console.log("  No executable file named `antigravity` exists on PATH.");
  console.log("  Checked as an executable file, not via `command -v`: a shell builtin or");
  console.log("  alias would satisfy that check without a client existing, which is the");
  console.log("  measurement error 9H Task 1 caught with `continue`.");
  console.log("");
  console.log(`  All ${CAPABILITIES.length} antigravity matrix cells stay UNVERIFIED, and this run writes no`);
  console.log("  transcript — so tests/matrix-integrity.test.mjs cannot let any of them read");
  console.log("  VERIFIED, because there is nothing on disk to cite.");
  console.log("");
  console.log("  This is not a BAYZ failure and not an Antigravity failure. Nothing was");
  console.log("  attempted, so nothing is known — which is exactly what UNVERIFIED means, as");
  console.log("  distinct from BLOCKED (attempted and did not work).");
  console.log("");
  console.log("  On a host that has the client: read its real configuration file, fill in");
  console.log("  configureAntigravity() in this script from what that file actually contains,");
  console.log("  and the nine scenarios in scripts/verify-opencode-scenarios.mjs port across");
  console.log("  unchanged — the BAYZ-side fixtures are already shared in");
  console.log("  scripts/verify-client-lib.mjs.");
  console.log("");
  console.log("antigravity verification: UNVERIFIED (client absent) — exiting 0");
  process.exit(0);
}

/*
 * The client exists. Refuse to guess its configuration rather than emit a plausible
 * config block and a green run: a harness that invents field names produces a transcript
 * that looks like evidence and is not. Exits non-zero so this cannot be mistaken for a
 * completed verification.
 */
console.error(`\nFOUND: ${executable}`);
console.error("");
console.error("  This host has an antigravity executable, but this harness has no measured");
console.error("  configuration form for it — the client was absent when the harness was");
console.error("  written, so nothing about its config file was ever read.");
console.error("");
console.error("  Refusing to proceed rather than guess. Inventing a config shape would");
console.error("  produce a transcript that looks like evidence but tests a client");
console.error("  configuration no user has. Read the real config file, implement");
console.error("  configureAntigravity() from it, then re-run.");
console.error("");
console.error("antigravity verification: INCOMPLETE (client present, config form unmeasured)");
process.exit(1);
