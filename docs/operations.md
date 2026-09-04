# GOAT ROUTER operations

This guide covers the lifecycle of an installed GOAT ROUTER on Termux/Android
ARM64: start, stop, restart, status, update, backup, and rollback. Everything is
proot-friendly — no systemd, no shell scripts, no daemon manager.

## The lifecycle CLI

A single Node CLI provides the common operations. From the repository root:

```sh
node scripts/goat.mjs start
node scripts/goat.mjs stop
node scripts/goat.mjs restart
node scripts/goat.mjs status
```

The same commands are available as npm scripts:

```sh
npm run goat:start
npm run goat:stop
npm run goat:restart
npm run goat:status
```

The CLI runs the server as a background process tracked by a pidfile inside the
data directory. It waits for a real `/api/health` response rather than a sleep,
so it reports readiness only once the server actually answers.

## Install

From a clean Termux/Ubuntu environment:

```sh
npm run goat:install
```

This checks the Node/npm version, installs dependencies, builds the runtime,
packs the release artifact, verifies the required files, and installs the
artifact globally (`bayz`). It never touches operator data.

You can also follow the manual steps in `docs/install.md`.

## Start and the API token

On first start, GOAT ROUTER generates a local API token, stores it encrypted,
and prints it once:

```sh
node scripts/goat.mjs start
# ...
# GOAT ROUTER generated a local API token (shown only once):
#   <64-hex token>
# Open the dashboard and enter this token to unlock it.
```

The token is printed only on the first boot of a data directory. It is never
printed again, and it is not persisted in plaintext. Save it before opening the
dashboard, or the service has no way to hand it back.

If you already have a token, export it before starting:

```sh
BAYZ_API_TOKEN=<your-token> node scripts/goat.mjs start
```

`BAYZ_API_TOKEN` is never copied into the database, so an externally managed
token stays under the operator's control.

## Dashboard unlock

Open the dashboard at `http://127.0.0.1:20128` (or your `BAYZ_PORT` / `BAYZ_HOST`
if set) and enter the token. The dashboard keeps it in memory only — it is never
written to browser storage.

## Status

```sh
node scripts/goat.mjs status
# GOAT ROUTER 0.1.0
#   data dir:  /root/.local/share/bayz
#   pid:       5047
#   health:    ok
```

## Data location

The data directory is resolved by the same resolver the server uses
(`apps/server/src/data-dir.ts`), in this order:

1. `BAYZ_DATA_DIR`, if set.
2. An existing `~/.bayz` (backward compatibility).
3. The platform default: `$XDG_DATA_HOME/bayz` or `~/.local/share/bayz` on
   Linux/Termux; `%LOCALAPPDATA%\bayz` on Windows; `~/Library/Application
   Support/bayz` on macOS.
4. `~/.bayz` when no platform path is available.

The directory holds `bayz.db`, the WAL files, `master.key`, and lifecycle files
(`bayz.pid`, `bayz.log`). The startup log records which directory and why.

**Backup expectation:** back up the entire selected directory. `bayz.db` alone
cannot be restored without `master.key` — the DEKs needed to decrypt provider
credentials live in that same directory, so losing any part of the directory
makes the encrypted credentials unrecoverable.

## Update

The safe update flow preserves your data and credentials:

```sh
node scripts/goat.mjs update
```

This:

1. Refuses to run if the working tree has uncommitted tracked changes. Update
   never discards your changes.
2. Fetches the latest code and fast-forwards.
3. Reinstalls dependencies and rebuilds.
4. Runs the portability scan as a verification gate.
5. Restarts a running server cleanly (or tells you how to start it).

Operator data is never touched. A running server is stopped with SIGTERM (with a
grace period) and restarted against the same data directory. The database's own
migration ladder upgrades the schema on the next start, exactly as it does on a
normal boot — see `scripts/upgrade-smoke.mjs` for the ladder proof.

If the working tree is dirty, update refuses rather than overwriting your work:

```console
$ node scripts/goat.mjs update
goat: The working tree has uncommitted tracked changes. Commit or stash them
first; update never discards your changes.
```

## Rollback limitations

This repository manages GOAT ROUTER from source, not from an immutable release
feed. `goat:update` fast-forwards to the latest commit on the current branch; it
is not a binary-package updater.

- To roll back to an earlier commit, `git checkout <commit>` and rebuild. The
  data directory is untouched and remains readable.
- **Downgrade is refused by the schema**, not silently applied. A database built
  at a newer schema version refuses to start with an older build, so you cannot
  start an older GOAT ROUTER against a database it would not understand. The
  refusal names the storage stage rather than failing opaquely.
- Always keep a backup of the data directory before any update or rollback, as
  described above.

## Verification

```sh
node scripts/goat.mjs verify   # portability scan + version
```

`npm run runtime:verify` runs the full test suite and build; on a constrained
phone run workspace tests and builds one at a time.
