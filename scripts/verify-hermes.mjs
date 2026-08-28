#!/usr/bin/env node
/**
 * Real-client verification for Hermes Agent — 9H Task 5.
 *
 * Hermes **is** installed on this host (`/root/.local/bin/hermes`, v0.20.5), correcting the
 * plan and spec §12 which both recorded it as absent. So this is a genuine real-client run,
 * not a harness shipped for some other machine.
 *
 * Isolation matters more here than for OpenCode: this agent *is* Hermes, and clobbering
 * `~/.hermes` would destroy the session doing the verification. Every run therefore gets a
 * throwaway `HERMES_HOME` and `HOME`, so the operator's live config, sessions, and
 * credentials are never read or written.
 *
 * Run `node scripts/verify-hermes.mjs`. The scenarios live in
 * `scripts/verify-hermes-scenarios.mjs`; the BAYZ-side fixtures are shared with the
 * OpenCode harness via `scripts/verify-client-lib.mjs`.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.env.BAYZ_VERIFY_HERMES_LOADER) {
  const relaunch = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url)],
    { stdio: "inherit", env: { ...process.env, BAYZ_VERIFY_HERMES_LOADER: "1" } },
  );
  process.exit(relaunch.status ?? 1);
}

await (await import("./verify-hermes-scenarios.mjs")).main();
