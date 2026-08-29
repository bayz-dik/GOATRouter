# BAYZ platform support matrix — Phase 9J

- Primary device: Termux/Android ARM64 (Ubuntu proot), 8 CPUs, 11.0 GiB RAM
- Node v24.19.0 (arm64), npm 11.17.0
- Written: 2026-08-29 (Phase 9J Task 1)

This matrix records what has actually been **observed**, on which machine. It is not a
statement of intent, and it is not derived from reading the source: BAYZ has zero native runtime
dependencies and no POSIX-only script on any user path, which makes the code *plausibly* portable
and proves nothing about any particular platform.

Every cell starts `UNVERIFIED` and is promoted only by evidence from that platform. Tasks 2–6 fill
the Termux/Android ARM64 row from their own transcripts and smoke check numbers; every other row
stays `UNVERIFIED` until a real machine or a CI runner produces a transcript. `tests/platform-matrix.test.mjs`
enforces that rule mechanically — a `PASS` citing a transcript from a different platform, or citing a
smoke run on any non-primary platform, fails the test.

## Legend

| status | meaning |
|---|---|
| `PASS` | Observed working on that platform, with an evidence reference to the transcript or check that observed it. |
| `FAIL` | Observed broken on that platform. A `FAIL` blocks the release gate unconditionally. |
| `UNVERIFIED` | Has **not been run** on that platform. Says nothing about whether it works — only that nobody has looked. This is the honest default, not a soft failure. |
| `N/A` | The column does not apply to that platform. Used only where the capability genuinely does not exist there, never as a way to avoid measuring. |

## Matrix

| platform | install | first boot | schema create | chat | stream | proxy | dashboard serve | restart | upgrade from v1 | data dir permissions | uninstall |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Linux x64 | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Linux ARM64 | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Termux/Android ARM64 | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Windows x64 | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Windows ARM64 | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| macOS x64 | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| macOS ARM64 | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |

## What must not be claimed

Only **Termux/Android ARM64** is qualified by this repository. Every other platform above **must not
be described** as supported in the README, in release notes, in documentation, or in any user-facing
text, until its row carries evidence from that platform.

That includes the two platforms that will stay `UNVERIFIED` even once CI runs, because no hosted
runner exists for them:

- **Windows ARM64** — no hosted GitHub runner. Only a real device can fill this row.
- **Termux/Android ARM64** — no hosted runner either; it is filled here precisely because this is
  that device.

The remaining four (Linux x64, Linux ARM64, macOS x64, macOS ARM64) and Windows x64 are reachable by
the CI workflow in Task 7, which is committed locally and inert until pushed. Phase 9 prohibits
pushing, so those rows remain `UNVERIFIED` for now — the workflow's existence does not upgrade a
cell, and `tests/platform-matrix.test.mjs` is what stops it from doing so.

## Why the columns are these eleven

Each column is a distinct failure mode that has actually bitten a local-first daemon somewhere:

- **install** — the artifact resolves and unpacks with no registry access for private packages.
- **first boot** — the data directory and database are created from nothing, at the right mode.
- **schema create** — migrations reach head on a fresh database.
- **chat** / **stream** — the two gateway paths; streaming fails independently of non-streaming.
- **proxy** — outbound egress through a real tunnel, the most platform-sensitive network path.
- **dashboard serve** — the packaged static bundle is served from packaged files, no remote origin.
- **restart** — the database reopens with no lock or WAL residue.
- **upgrade from v1** — the ladder from the oldest schema, with data intact.
- **data dir permissions** — `0o700`/`0o600` where the filesystem can represent them, honestly
  recorded where it cannot.
- **uninstall** — removing the package leaves operator data alone.
