# GOAT ROUTER diagnostics (`doctor`)

A read-only diagnostic command that inspects the environment and runtime and
reports each check as `PASS` / `WARN` / `FAIL`, without printing any secret.

```sh
# Human-readable diagnostics
node scripts/goat.mjs doctor

# Machine-readable JSON (no secrets)
node scripts/goat.mjs doctor --json

# Apply only low-risk, deterministic repairs
node scripts/goat.mjs doctor --repair
```

## Exit codes

- `0` — healthy (warnings alone do not fail)
- `1` — one or more real failures
- `2` — the diagnostic command itself could not complete

## What it checks

- **Node.js** version (requires >= 24)
- **npm** availability
- **runtime files** present (server entry, dashboard bundle)
- **data directory** exists / resolvable
- **permissions** on the data directory (best-effort; proot may not honor modes)
- **master key** present
- **database** present
- **integrity metadata** present
- **database integrity** via read-only `PRAGMA integrity_check`
- **schema** version vs the migration ledger
- **encrypted state** — key present and DB readable (never decrypts a secret)
- **pidfile** / **process** — running, or stale pidfile
- **configured port** / **health** — is a real GOAT ROUTER answering? A foreign
  service (e.g. 9Router) that happens to answer `{"status":"ok"}` is **not**
  mistaken for GOAT
- **API authentication** — only reported when a server is up (never probes with
  a real token)
- **provider state** — external provider connectivity is a WARN, never a core
  FAIL
- **backup capability**, **disk space**, **memory**
- **log** — surfaces startup errors (EADDRINUSE, failed start, storage errors)
  without dumping the log or leaking secrets

## Port conflict / 9Router awareness

`doctor` never kills another process. If the configured port is occupied by a
non-GOAT service such as 9Router, it reports that it is not a healthy GOAT
listener rather than a false failure. If GOAT is configured on a different port,
no false failure is raised.

## Safe repair (`--repair`)

Only deterministic, low-risk repairs are performed:

- remove a stale pidfile (proven dead)
- create a missing data directory

`--repair` never regenerates `master.key` over existing encrypted data, deletes
or overwrites `bayz.db`, rotates tokens, removes providers/routes, restores a
backup, or kills a process. Any destructive or ambiguous repair is refused and
reported so the operator can act manually.

## Secret safety

`doctor` never prints API tokens, provider API keys, decrypted secrets, or key
material. Log excerpts are redacted (Bearer tokens, `sk-*` keys, Google API
keys, 64-hex literals). The real database is opened read-only for integrity
checks and never mutated.
