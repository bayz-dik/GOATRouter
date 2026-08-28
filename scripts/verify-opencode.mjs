#!/usr/bin/env node
/**
 * Real-client verification for OpenCode — 9H Task 4.
 *
 * This drives the **actual `opencode` binary installed on this host** (v1.18.23,
 * `/usr/local/bin/opencode`) as a user would: a real config file in a real isolated
 * HOME, a real child process, real stdout and stderr. There is no `fetch` standing in
 * for the client, no `app.inject`, and no script imitating OpenCode's requests —
 * because the failures this exists to catch are precisely the ones a hand-written
 * imitation would not make. Two of them turned up on the first run (see the header of
 * `docs/transcripts/opencode/README.md`), and neither was visible to any of the 55
 * generic protocol checks in `scripts/client-conformance.mjs`.
 *
 * BAYZ is real too: a real listener on a real port, a real SQLite database with real
 * envelope crypto, real scoped client identities created through the management API,
 * real loopback provider origins, and a real HTTP CONNECT proxy for the proxy cell.
 *
 * Every scenario writes a transcript to `docs/transcripts/opencode/`. A matrix cell
 * cites `transcript:docs/transcripts/opencode/<file>.md` and
 * `tests/matrix-integrity.test.mjs` resolves it.
 *
 * **This script refuses to self-certify.** A cell claimed `VERIFIED` or `PARTIAL`
 * whose transcript is not on disk when the run finishes fails the run non-zero. A
 * script's own opinion is not evidence.
 *
 * Transcripts are committed, so every volatile value is redacted deterministically —
 * secrets by name, and ports, temp paths, UUIDs, and timings by pattern, so a re-run
 * produces the same bytes rather than a diff nobody reads.
 *
 * Runs strictly sequentially: one real client process at a time. Each `opencode run`
 * takes roughly 20 seconds, so the whole suite is minutes, not seconds.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.env.BAYZ_VERIFY_OPENCODE_LOADER) {
  const relaunch = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url)],
    { stdio: "inherit", env: { ...process.env, BAYZ_VERIFY_OPENCODE_LOADER: "1" } },
  );
  process.exit(relaunch.status ?? 1);
}

await (await import("./verify-opencode-scenarios.mjs")).main();
