# GOAT ROUTER — permanent server + terminal TUI (design approved)

Date: 2026-09-04 · UX only; no router/security/UI-intelligence changes.

## Product goal

The owner or a friend installs GOAT ROUTER, types `bayz`, and immediately
understands what to do. `bayz` = "make sure the server is running, then give me a
small operator control surface."

## Architecture facts the design must respect

1. The installed product is one self-contained tarball (scripts/pack.mjs). Its
   `bayz` bin (dist/bayz.mjs) currently only does --version / --help / update /
   --check-update, then imports server.mjs and runs **in the foreground**. The
   installed artifact has no daemon lifecycle today.
2. The proven daemon lifecycle (detached spawn, pidfile in the data dir, wait on
   the child's OWN log readiness + real health probe, foreign-EADDRINUSE not
   mistaken for GOAT, SIGTERM then SIGKILL) lives only in the repo-only
   `scripts/goat.mjs`, which requires the repo checkout + tsx. A normal user
   cannot reach it.
3. Default port 20128 is duplicated across config.ts (real), goat.mjs,
   doctor-lib.mjs, pack.mjs --help text, config.test.ts, and operator docs; and it
   appears as an *unrelated literal* in many server test fixture binds and fuzz
   corpus files (proxy-pivot SSRF vectors, capability adversarial, auth allowlist)
   that must be left alone.
4. Token security: `SecretStorage.find("api:token")` returns plaintext in-process
   and `resolveApiToken` keeps it on `runtime.apiToken`, but there is no API route
   that returns token material and the SQLite store is single-connection — locked
   by the running server. Rotation can only be done by a process that already
   holds the DB (the server itself), through the storage `put` path; reveal of a
   *lost* token is intentionally impossible, and the design must not weaken that.

## Design decisions

### D1. One shared lifecycle engine, two shells
Extract the proven pidfile+detach+log-tail-health logic out of scripts/goat.mjs
into a portable, importable module (scripts/lifecycle-lib.mjs) that ships in the
artifact (new entry, bundled). Both the repo goat.mjs and the packed bayz bin call
it. No second daemon system.

### D2. The packed `bayz` bin becomes the full operator CLI
`bayz`, `bayz start/stop/restart/status/doctor/backup/backup-verify/restore/
update`, `--version`, `--help`, `--check-update` all work from any directory after
`npm i -g`. No repo, no tsx, no BAYZ env ritual for normal use.

### D3. Bare `bayz` = inspect → auto-start → TUI
Running with no args (TTY): inspect state; already running => open TUI; else start
daemon, wait on GOAT's own health proof, then open TUI. Exiting the TUI never stops
the daemon. Only `bayz stop`, the Server>Stop menu, or OS termination stops it.

### D4. The TUI is a small operator surface
Clean, no dashboards/providers/routes/analytics inside it. Small GOAT branding; the
existing character is rendered only where inline images are trivially safe (we
ship the character bytes and the character's data URL inside the packaged bin, so
no new dependency); everywhere else (Termux/plain) a small monochrome goat and the
wordmark in terminal text. Image is never required.

### D5. API token menu follows the real security semantics
A freshly generated token was printed once at first boot and stored encrypted;
reveal of a lost token is impossible (DB single-connection + deliberate no-reveal).
The menu therefore reports Configured/Not-configured and offers Rotate (a real
replacement minted by the runtime and shown once), never a plaintext reveal of a
token the architecture cannot hand back. Rotation needs the running server to write
its own store, so it is driven through a local capability the server exposes.

## Implementation plan (failing tests first where required by the task)

1. Tests (tests/terminal-lifecycle.test.mjs + a server config-test update):
   A default port 20156 · B BAYZ_PORT override · C auto-start when stopped ·
   D reuse running · E exit leaves running · F Stop stops · G no duplicate daemon ·
   H foreign process on 20156 not GOAT · I terminal restore · J non-TTY no raw ·
   K no token on normal startup · L token menu semantics · M web URL configured
   port · N no-opener does not break TUI.
2. Port: config.ts => 20156; goat.mjs, doctor-lib.mjs, pack.mjs help, config.test.ts,
   operator docs to 20156. Do NOT touch unrelated 20128 literals (test binds, SSRF
   corpora) or 9Router.
3. Shared engine extraction (scripts/lifecycle-lib.mjs) + new packed bundle entry.
4. Packed bin command set + auto-start path.
5. TUI module (Node stdlib only).
6. Token rotate capability server-side.
7. Docs (README, docs/install.md, docs/operations.md) => `install` then `bayz`.
8. Real device proof on 20156 in a temp data dir; then full sequential verification.
9. Commit + push master. No release, no v0.1.2 tag touch.

## Out of scope
No new router/provider/security logic. No Web UI redesign. No release/publish.
