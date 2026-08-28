#!/usr/bin/env node
/**
 * Release-blocking client compatibility gate — 9H Task 6.
 *
 * Reads `docs/superpowers/2026-08-27-bayz-client-compatibility-matrix.md` and answers one
 * question: **may a release be declared?** The answer is no while any Core 3 client
 * (`opencode`, `antigravity`, `hermes`) has a mandatory capability that was never verified,
 * or was attempted and failed.
 *
 * Two modes:
 *
 *   --report    always exits 0 and prints the current status. For humans and dashboards.
 *   --enforce   exits non-zero if anything blocks. 9L runs this.
 *
 * **`--enforce` is expected to exit non-zero today**, because `antigravity` is not installed
 * on this host and all 17 of its cells are `UNVERIFIED`. That is the gate working, not a
 * defect: a gate that passed in this state would be worthless.
 *
 * The plan's wording is `FAIL`/`UNVERIFIED`. This project's vocabulary has no `FAIL`; the
 * equivalent is `BLOCKED`. The gate blocks on both `BLOCKED` and `UNVERIFIED`, because "we
 * never tried" is not a smaller release risk than "we tried and it broke" — it is an unknown.
 *
 * The gate does not re-derive any status and does not run any client. It reads what the
 * matrix says; the matrix's own integrity — closed vocabulary, evidence resolvable on disk
 * for every claim — is `tests/matrix-integrity.test.mjs`'s job. Two tools, one question each.
 *
 * Policy and parsing live in `scripts/client-gate-lib.mjs`; reporting in
 * `scripts/client-gate-run.mjs`.
 */
await (await import("./client-gate-run.mjs")).main(process.argv.slice(2));
