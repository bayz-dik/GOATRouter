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
| Termux/Android ARM64 | PASS (smoke:install#3-11) | PASS (smoke:install#12-19) | PASS (smoke:install#20) | PASS (smoke:install#29-31) | PASS (smoke:install#33-36) | PASS (smoke:install#40-42) | PASS (smoke:install#21-25) | PASS (smoke:install#43-50) | PASS (smoke:upgrade#3-7) | PASS (smoke:install#14-16) | PASS (smoke:install#54-60) |
| Windows x64 | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Windows ARM64 | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| macOS x64 | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| macOS ARM64 | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |

## Observations recorded so far

**Termux/Android ARM64 — upgrade from v1: `PASS`.** 9J Task 6 built a database at **every** prior
schema version v1 through v11, using the real `MIGRATIONS` list truncated to that version, and opened
each one with the **installed artifact** (`node_modules/.bin/bayz`). Every rung reached head v11,
`PRAGMA integrity_check` returned `ok` after each, and from v4 up — the first version with a `routes`
table — a real chat completed through the pre-upgrade route using the pre-upgrade encrypted
credential, which the fixture origin confirmed by matching the `Authorization` header it received.
83/83 checks (`scripts/upgrade-smoke.mjs`).

The matrix cell cites `smoke:upgrade#3-7`, the v1 rung specifically, because that is what the column
names. The full ladder is the script's own 83 checks.

Two honest limits on that row. v1–v3 predate the `routes` table, so those three rungs assert that the
database upgrades and the API still answers, not that a chat succeeds — there is no route to chat
through, and inventing one would test v11's schema rather than v1's. And the ladder starts from
databases this repository *constructs*; no v1-era BAYZ binary exists to have written one, so what is
proven is that the migration sequence is correct and complete, not that a database from a historical
release has been recovered.

**Termux/Android ARM64 — the other ten columns `PASS`, all from `scripts/install-smoke.mjs`
(64/64 checks).** Every one was observed against the **installed artifact**, not the workspace: the
tarball was installed into a clean temporary prefix with a temporary npm cache, and the checks drove
the binary npm linked at `node_modules/.bin/bayz`. A workspace-only run would prove nothing about
what an operator installs, because the workspace has ten `@bayz/*` symlinks a user will never have.

| column | evidence | what was observed |
|---|---|---|
| install | `smoke:install#3-11` | `npm install <tarball>` exit 0, 83 packages, bin linked and executable. `@bayz` was pointed at a registry that 404s everything and **was never asked** — so the artifact genuinely carries no workspace dependency. No `src/` or `test/` in the installed tree. |
| first boot | `smoke:install#12-19` | Data directory created from nothing; `/api/health` 200 unauthenticated; `/api/status` 401 without a token and 200 with it. |
| schema create | `smoke:install#20` | Fresh database reached schema head **v11**, compared against the source's own `TARGET_SCHEMA_VERSION` rather than a copied constant. |
| chat | `smoke:install#29-31` | A real completion through a real loopback origin, with the stored credential arriving upstream as `Authorization: Bearer …`. |
| stream | `smoke:install#33-36` | Real SSE: `text/event-stream`, the upstream delta, and `[DONE]`. A separate column because the streaming path fails independently — all four 9H defects were on it. |
| proxy | `smoke:install#40-42` | A proxy-bound route through a real HTTP `CONNECT` tunnel with Basic auth. The tunnel recorded the authorised connection to the origin port, and `x-bayz-proxy` named it. |
| dashboard serve | `smoke:install#21-25` | The shell and its hashed asset served **from the packaged files**, with no remote origin in either. |
| restart | `smoke:install#43-50` | Clean SIGTERM exit 0, no `-shm` residue, restart against the existing database, and provider + credential + route + identity all intact with a chat still succeeding. |
| data dir permissions | `smoke:install#14-16` | Observed `0700` on the directory and `0600` on both `bayz.db` and `master.key`. Also probed independently by `tests/portability.test.mjs`. |
| uninstall | `smoke:install#54-60` | `npm uninstall` exit 0, package and bin gone, and the data directory, database (byte length unchanged) and root key all still present. |

**`upgrade from v1` is the one column still `UNVERIFIED` on the primary platform** at the time this
section was written; Task 6 fills it from `scripts/upgrade-smoke.mjs`.

Permissions are **observed, not intended**: the probe reports the octal it saw, so a mount that could
not represent POSIX modes would record `UNVERIFIED: filesystem does not honour POSIX modes` with the
actual mode rather than failing. Both **Windows** rows keep `UNVERIFIED` in that column deliberately,
asserted by `tests/portability.test.mjs`. `0700` has no `chmod`-settable NTFS equivalent, so the code
takes the same tolerated best-effort path there — which is not the same claim as parity, and there is
no Windows machine here to find out what it actually does.

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
