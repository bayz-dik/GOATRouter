# GOAT ROUTER backup / restore / migration

Back up, restore, and move a complete GOAT ROUTER runtime (including encrypted
provider credentials, routes, proxies, identities, the API token, and usage
history) to another device.

Everything is Node-standard-library based, so it works on Termux + Ubuntu/proot
+ Android ARM64 without systemd, Docker, or other external tools.

## What is backed up

The authoritative runtime state is exactly three files in the data directory:

- `bayz.db` — all domain state (providers, routes, proxies, identities, usage)
  plus the encrypted secret envelopes
- `master.key` — the key-encryption-key required to decrypt those envelopes
- `integrity.json` — the open-counter witness used for rollback detection

WAL / SHM sidecars are transient (removed on a clean close), and `bayz.pid` /
`bayz.log` are lifecycle-only, so they are not part of a backup.

A backup is a single gzipped tar archive containing a `manifest.json` (format
version, GOAT ROUTER version, creation time, source data dir, and a SHA256 of
each file) plus the three files. No plaintext secret ever enters the manifest.

## Commands

```sh
# Create a backup (default: <dataDir>/bayz-backup-<timestamp>.tgz)
node scripts/goat.mjs backup

# Choose the output path
BAYZ_BACKUP_OUTPUT=/sdcard/goat-backup.tgz node scripts/goat.mjs backup

# Verify a backup without restoring it
node scripts/goat.mjs backup-verify /path/to/backup.tgz

# Restore into a fresh device runtime
node scripts/goat.mjs restore /path/to/backup.tgz

# Restore over an existing runtime (a safety backup is made first)
node scripts/goat.mjs restore /path/to/backup.tgz --replace
```

## How it stays consistent

If the server is running when you run `backup`, GOAT ROUTER stops it cleanly
(which checkpoints the WAL), creates the archive, then restarts the server and
verifies health. Restore likewise stops a running server first, swaps the data
directory atomically, and restarts.

## Restore safety

Restore verifies the archive structure, the manifest, and every SHA256 before
touching anything, then extracts into a staging directory before an atomic swap.
It refuses to run over a runtime that already contains data unless you pass
`--replace`, in which case it first writes a safety copy of the existing
`bayz.db`, `master.key`, and `integrity.json`. Path traversal and absolute
archive entries are rejected; a malformed or checksum-failing archive is refused
without disturbing the current runtime.

## Locating the data directory

The data directory is resolved in this order: `BAYZ_DATA_DIR`, an existing
`~/.bayz`, then the platform default (`~/.local/share/bayz` on Linux/Termux).
`node scripts/goat.mjs status` prints it.

## Encryption warning

A backup is as sensitive as the database itself: it contains the encrypted
credential envelopes **and** the key that decrypts them. Store it somewhere
protected. Anyone with the backup can restore it onto their own GOAT ROUTER and
decrypt your provider credentials.

## Cross-device migration workflow

1. On the old device: `node scripts/goat.mjs backup` (or with a chosen output).
2. Copy the `.tgz` to the new device (e.g. to a removable or shared folder).
3. On the new device, install GOAT ROUTER, then run
   `node scripts/goat.mjs restore /path/to/backup.tgz`.
4. Start the server (`node scripts/goat.mjs start`) and open the dashboard.

The encrypted credentials decrypt because the backup carries the matching
`master.key`; the API token, identities, routes, providers, proxies, and usage
history all come across with the database.

## Failure behavior

- Corrupted archive → rejected (no restore).
- Checksum mismatch → rejected.
- Missing `master.key` or `bayz.db` in the source → backup refused.
- Path-traversal archive entry → rejected.
- Restore into a populated runtime without `--replace` → refused.
- Failed/interrupted restore → the original runtime stays usable (atomic swap).
- Backup while running → controlled stop, consistent snapshot, restart.
