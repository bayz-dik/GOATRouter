# BAYZ CI notes

> Written 2026-08-29 (Phase 9J Task 7). Companion to
> `docs/superpowers/2026-08-27-bayz-platform-matrix.md`.

## The workflow is committed and inert

`.github/workflows/platform-matrix.yml` exists in this repository and **has never run**. Phase 9
prohibits adding or pushing to a GitHub remote, and a workflow file does nothing until it is pushed
to one. It is committed now so the qualification story is reviewable, not so it can be claimed as
evidence.

No matrix cell cites it. `tests/ci-workflow.test.mjs` asserts that: the five CI-only platform rows
must contain no `PASS`, and no cell may name the workflow file. A workflow that has never executed is
not a measurement.

The trigger is `workflow_dispatch` only — no `push`, no `pull_request`, no `schedule`. If a remote is
added later, this file must not start acting before someone re-reads it. It also declares
`permissions: contents: read` and contains no `secrets.` reference, no `NPM_TOKEN`, no `npm publish`,
and no release action.

## What it would cover

Five hosted runners: `ubuntu-latest`, `ubuntu-24.04-arm`, `windows-latest`, `macos-latest`, and
`macos-13`. Each runs `npm ci`, the dependency-closure and portability gates, every workspace test
suite sequentially, `runtime:build`, the root `tests/` directory, `pack.mjs` plus its self-test, then
`install-smoke.mjs` and `upgrade-smoke.mjs` against the packed artifact, and finally
`platform-gate.mjs --report`.

Tests run one workspace per step rather than through `npm run test --workspaces`. The fan-out of the
parallel form exhausts the futex table on constrained hosts — it cannot run on the primary device at
all — so CI uses the same bounded sequence, which also keeps a CI failure directly comparable to a
local one.

`fail-fast: false`, because the purpose is to learn which platforms work. Cancelling the matrix on
the first failure would hide every row after it.

## Platforms with no hosted runner

Two matrix rows cannot be filled by this workflow, because **no hosted runner exists** for them:

- **Termux/Android ARM64** — GitHub Actions has no Android runner. This is the primary device, so its
  row is filled by real local runs (`smoke:install`, `smoke:upgrade`, `test:` citations) rather than
  by CI.
- **Windows ARM64** — GitHub's `windows-11-arm` images exist but are not available to this
  repository, and nothing here has been executed on Windows ARM64 by any means. That row stays
  `UNVERIFIED` and must be described that way to users.

`windows-latest` and `macos-13` cover Windows x64 and macOS x64; `macos-latest` covers macOS ARM64;
`ubuntu-latest` and `ubuntu-24.04-arm` cover Linux x64 and Linux ARM64. All five remain `UNVERIFIED`
until the workflow actually runs somewhere.

## Two known differences between CI and this device

Recorded so a future green CI run is not read as proving more than it does.

1. **`0o700` / `0o600` on Windows.** The permission assertions in
   `packages/storage/src/paths.ts` are best-effort by design; NTFS has no `chmod`-settable
   equivalent. A Windows CI pass would mean "BAYZ starts and works", not "the data directory is
   private". The matrix keeps both Windows rows' permission cells `UNVERIFIED` and a test asserts
   they stay that way.
2. **`node:sqlite`.** The storage driver is Node's built-in SQLite, so the SQLite version travels
   with the Node build rather than the OS. This device runs SQLite 3.53.3 via Node v24.19.0; a runner
   on a different Node patch may bind a different SQLite. That is a real variable a CI pass would
   exercise, and one of the reasons the CI-only rows should not be assumed from the Termux row.
