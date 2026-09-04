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

There are two update paths, depending on how GOAT ROUTER was installed.

### From a GitHub Release (recommended for installed users)

If you installed the `bayz` package from a GitHub Release, update straight from
the release feed:

```sh
bayz --version          # current version
bayz --check-update     # is a newer release available? (no install)
bayz update             # download latest stable, verify checksum, install
```

`bayz update`:

1. Reads the installed version.
2. Queries the official `bayz-dik/GOATRouter` GitHub Releases feed for the
   latest **stable** release (never a prerelease or draft).
3. If already current, exits cleanly with no change.
4. Downloads the release artifact and its `SHA256SUMS.txt`.
5. Verifies the SHA256 **before** installing. A mismatch blocks the install.
6. Reinstalls the verified artifact into the same npm prefix; the runtime data
   directory is never touched.
7. Verifies the installed `bayz --version` matches the release, and rolls back
   to the previous release if it does not.

If the network is unavailable or the feed errors, the current installation keeps
working and `bayz update` reports the failure without changing anything.

### Data safety on update

Updating never deletes, recreates, or copies the runtime data directory
(`bayz.db`, `master.key`, WAL files, encrypted credentials, providers, routes,
proxies, identities, the API token, usage). `npm install` replaces only the
installed package. Back up the data directory before a significant upgrade, as
described under "Data location".

### From source (when you have a repository checkout)

The developer-facing lifecycle CLI in the repository does a source update:

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

## Rollback

From a GitHub Release install, `bayz update` restores the previous release
automatically if the new one fails its version check after install. For a manual
rollback to an earlier release:

```sh
# Reinstall a specific release tarball you already have:
npm install -g bayz-router-0.0.0.tgz
```

From a source checkout, roll back to an earlier commit and rebuild. The data
directory is untouched and remains readable. **Downgrade is refused by the
schema**, not silently applied: a database built at a newer schema version
refuses to start with an older build.

## Backups and migration

See `docs/backup-restore.md` for the full backup / restore / cross-device
migration guide. Quick reference:

```sh
node scripts/goat.mjs backup                # create a backup
node scripts/goat.mjs backup-verify <file>  # verify without restoring
node scripts/goat.mjs restore <file>        # restore into a fresh runtime
node scripts/goat.mjs restore <file> --replace  # overwrite existing runtime
```

## Verification

```sh
node scripts/goat.mjs verify   # portability scan + version
```

## Diagnostics

```sh
node scripts/goat.mjs doctor             # read-only diagnostics
node scripts/goat.mjs doctor --json      # machine-readable JSON
node scripts/goat.mjs doctor --repair    # low-risk deterministic repairs only
```

See `docs/doctor.md` for the full diagnostic and safe-repair guide.

`npm run runtime:verify` runs the full test suite and build; on a constrained
phone run workspace tests and builds one at a time.
