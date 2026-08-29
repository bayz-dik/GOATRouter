# Installing BAYZ Router

> Phase 9J. The install, first-boot, restart, and uninstall procedures are added by Task 5; this
> document currently covers **where BAYZ keeps its data**, which Task 3 single-sourced.

## Supported platforms

Only **Termux/Android ARM64** is qualified. Every other platform is `UNVERIFIED` — see
`docs/superpowers/2026-08-27-bayz-platform-matrix.md` for the cell-by-cell state and the rule that
governs it. `UNVERIFIED` means nobody has run BAYZ there, not that it is known broken.

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
