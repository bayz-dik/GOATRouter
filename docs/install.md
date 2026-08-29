# Installing BAYZ Router

> Phase 9J. Task 3 single-sourced the data directory; Task 4 built the release artifact; Task 5 proved
> install, first boot, restart, and uninstall against that artifact.

## Supported platforms

Only **Termux/Android ARM64** is qualified. Every other platform is `UNVERIFIED` — see
`docs/superpowers/2026-08-27-bayz-platform-matrix.md` for the cell-by-cell state and the rule that
governs it. `UNVERIFIED` means nobody has run BAYZ there, not that it is known broken.

## Installing

BAYZ ships as a single self-contained tarball. Build it, then install it:

```sh
npm run build --workspace @bayz/dashboard   # the dashboard bundle is a prerequisite
npm run release:pack                        # writes packaging/out/bayz-router-<version>.tgz
npm install -g packaging/out/bayz-router-0.1.0.tgz
bayz --version
```

The tarball declares only the two external packages its bundled runtime actually imports
(`fastify`, `@fastify/static`); the ten `@bayz/*` workspace packages are compiled into it and need no
registry. See `packaging/README.md` for why it is one artifact rather than nine published packages.

Start it with the environment variables below. There is no config file:

```sh
BAYZ_API_TOKEN=<your token> bayz
```

Leaving `BAYZ_API_TOKEN` unset makes BAYZ generate one and print it **once** on first boot. That is
fine for a loopback install and is refused for any non-loopback bind — a generated token does not
count as operator intent. See the security posture section of the README.

## Where BAYZ keeps its data

One resolver decides this: `apps/server/src/data-dir.ts`. Nothing else in the repository asks the
operating system where your home directory is, and `tests/portability.test.mjs` fails if a second
place starts to.

The resolution is a **fallback chain, read in order**. The first match wins:

| order | condition | path |
|---|---|---|
| 1 | `BAYZ_DATA_DIR` is set | that path, made absolute against the current working directory |
| 2 | `~/.bayz` already exists | `~/.bayz` |
| 3 | Windows, `%LOCALAPPDATA%` set | `%LOCALAPPDATA%\bayz` |
| 4 | macOS | `~/Library/Application Support/bayz` |
| 5 | anything else, `$XDG_DATA_HOME` set to an absolute path | `$XDG_DATA_HOME/bayz` |
| 6 | anything else | `~/.local/share/bayz` |
| 7 | Windows with no `%LOCALAPPDATA%` | `~/.bayz` |

**Step 2 is the important one, and it is why the chain exists rather than a single platform path.**
`~/.bayz` was the only location BAYZ ever used before Phase 9J. If the resolver preferred a platform
path, every existing install would start from an empty database on its next upgrade: providers gone,
routes gone, and stored credentials unreadable, because the per-secret keys live in that directory and
go nowhere else. An existing `~/.bayz` therefore wins over every platform default, on every platform.
That is a compatibility guarantee, not an implementation detail, and it has its own test.

A relative `XDG_DATA_HOME` is ignored, as the XDG specification requires — honouring one would make
the daemon find a different database depending on which directory it was started from.

`BAYZ_DATA_DIR` set to an empty or whitespace-only value is **refused at startup** rather than
treated as unset. `BAYZ_DATA_DIR=` left in a shell profile or a container spec is a mistake, and
silently falling back to a default would put your database somewhere you did not choose and then work
perfectly, which is the hardest kind of misconfiguration to notice.

### Seeing which path was chosen

On startup BAYZ logs the resolved directory together with a `dataDirReason` field, one of:

- `BAYZ_DATA_DIR` — you set it explicitly.
- `existing` — an established `~/.bayz` was found and reused.
- `platform-default` — no `~/.bayz` existed, so a platform path was used. **A new, empty database.**
- `home-default` — the platform path was unavailable, so `~/.bayz` was used.

If an install looks empty when you expected existing data, that field is the first thing to read: a
`platform-default` where you expected `existing` means BAYZ is looking somewhere your old data is not.
Nothing is lost in that situation — point `BAYZ_DATA_DIR` at the old directory.

The reason is an enum and the log line carries no environment dump, so no key or token can ride along
with it.

## Permissions

The data directory is created `0700` and `bayz.db` with its `-wal` and `-shm` sidecars are set
`0600`, on filesystems that can represent POSIX modes. On this device both were **observed** at those
modes (`tests/portability.test.mjs` probes the real filesystem and prints the octal it saw).

Where a filesystem cannot represent them — some Android and FAT-derived mounts, and Windows, where
`0700` has no `chmod`-settable NTFS equivalent — the `chmod` failure is tolerated and BAYZ still
starts. That is a deliberate choice: hard-failing would make BAYZ unusable on a first-class target.
It also means the mode is **best-effort, not a guarantee**, and the platform matrix records
`UNVERIFIED` rather than `PASS` wherever it has not been observed. A directory that genuinely cannot
be created is still fatal.

## Restarting and upgrading

Stopping and restarting reopens the same database in place. Providers, proxies, routes, scoped
identities, stored credentials, and telemetry all survive; no lock or WAL residue blocks startup.
`node scripts/install-smoke.mjs` proves this against the installed artifact, and
`node scripts/upgrade-smoke.mjs` proves the migration ladder from every prior schema version.

Upgrading is installing a newer artifact over the old one. On first start the new binary applies any
outstanding migrations to the existing database, in order, inside a transaction. Nothing is
destructive:

- Every pre-existing secret still decrypts after the upgrade — the root key is unchanged.
- Every provider, proxy, route, identity, and telemetry row survives with its values intact.
- A **downgrade is refused, not attempted.** A database written by a newer BAYZ than the binary
  opening it fails closed with a distinct error rather than being "migrated backwards", because there
  is no safe way to remove a column that already holds data.
- A crash part-way through a migration leaves the database at its **pre-migration** version with no
  half-applied DDL, so the upgrade can simply be retried.

### If one provider's configuration is unreadable

A single provider row whose stored config JSON cannot be parsed yields `invalid_provider_config` for
**that provider only**. BAYZ **still starts**, the database still migrates, every stored credential
still decrypts, and every other provider still works. One bad row is not a bricked install.

To repair it, delete the offending provider through the API and recreate it:

```sh
curl -X DELETE -H "Authorization: Bearer $BAYZ_API_TOKEN" \
  http://127.0.0.1:20128/api/providers/<id>
```

`DELETE /api/providers/<id>` removes the provider's credential in the same call, so the credential
must be set again after recreating it.

Note that listing providers reads every row, so `GET /api/providers` surfaces the failure rather than
silently omitting the bad entry. That is deliberate: hiding a corrupt provider from the operator who
has to fix it would be worse than reporting it.

## Removing BAYZ

Uninstalling the package **never deletes your data**:

```sh
npm uninstall -g bayz-router
```

That removes the program and leaves the data directory exactly as it was. Verified by
`scripts/install-smoke.mjs`, which compares the database byte length across the uninstall.

To remove your data as well, delete the resolved data directory — the one the startup log named. It
holds `bayz.db` (with `bayz.db-wal` and `bayz.db-shm`), `master.key`, and the integrity witness:

```sh
rm -rf ~/.bayz                  # or the platform path from the table above
```

**This is irreversible.** `master.key` is the root key that wraps every per-secret DEK. Deleting the
directory destroys the keys along with the ciphertext, so every stored provider credential and proxy
password becomes permanently unrecoverable — a backup of `bayz.db` alone is useless without
`master.key`, and vice versa. Nothing in BAYZ can recover a deleted data directory, and no copy of
the encryption key exists anywhere else.

If you want a backup before deleting, copy the **whole** directory, and treat that copy as
credential-bearing: it is protected only by its `0600` file modes.

