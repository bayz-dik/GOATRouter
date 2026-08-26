# Phase 9I — Fuzz / Chaos / Load / Soak

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Spec:** `docs/superpowers/specs/2026-08-27-bayz-phase9-goat-release-design.md` §13

**Depends on:** 9A, 9B, 9C, 9D, 9E, 9F, 9G (there is no point fuzzing a surface that does not exist yet)

**Goal:** Prove BAYZ does not crash, leak, or corrupt state under hostile input, component failure, sustained load, or long duration — with every capacity number measured on the named device rather than asserted.

**Locks:** No fuzz corpus contains a real credential. No load or capacity figure is stated without a transcript. A crash, an unhandled rejection, or a leaked handle is a FAIL, never a flake to retry. No new runtime dependency — the fuzzers are plain Node scripts using `node:crypto` for seeded randomness.

**Measured device reality:** Termux/Android ARM64, 8 logical CPUs, ~11.3 GiB total RAM with ~2.8 GiB available at planning time, Node v24.19.0. Every number this subprogram produces belongs to *this* device and must be labelled with it. Numbers from another host are `UNVERIFIED` here.

---

### Task 1 — Deterministic fuzz harness

**Create:** `scripts/fuzz/harness.mjs`
**Test:** `tests/fuzz-harness.test.mjs`

**Interface produced:**
```js
export function createRng(seed);                  // deterministic, xoshiro-style over node:crypto seed
export function fuzz({ name, seed, iterations, generate, run });
// returns { name, seed, iterations, failures: [{ iteration, input, error }] }
```

- [ ] RED `tests/fuzz-harness.test.mjs`: the same seed produces a byte-identical input sequence across two runs and across two processes (reproducibility is the whole point — a crash that cannot be replayed cannot be fixed); a different seed produces a different sequence; a `run` that throws is recorded as a failure with the **input that caused it** and the iteration index, and the harness keeps going to the iteration cap rather than stopping at the first failure; an `unhandledRejection` or `uncaughtException` during a run is attributed to the current iteration, not swallowed; the harness caps a single input at 1 MiB so a generator bug cannot exhaust memory; total wall time is bounded and the harness reports how many iterations it actually completed rather than claiming the requested count.
- [ ] RED same file: the harness refuses to run if `generate` returns a value containing a string matching `/sk-|Bearer |BEGIN [A-Z ]*PRIVATE KEY|^[0-9a-f]{64}$/` — a corpus must never carry credential-shaped data into a saved artifact.
- [ ] Verify RED: `node --test tests/fuzz-harness.test.mjs` fails with `ERR_MODULE_NOT_FOUND`.
- [ ] GREEN `scripts/fuzz/harness.mjs`, zero dependencies.
- [ ] Verify: `node --test tests/fuzz-harness.test.mjs` exits 0.
- [ ] Commit — `test: add the deterministic Bayz fuzz harness`

### Task 2 — Input-shape generators and the corpus

**Create:** `scripts/fuzz/generators.mjs`, `scripts/fuzz/corpus/` (seed files, committed)
**Test:** `tests/fuzz-generators.test.mjs`

- [ ] RED `tests/fuzz-generators.test.mjs`: generators exist for JSON values, UTF-8 and invalid-UTF-8 byte strings, header name/value pairs, URLs, identifiers, SSE byte streams, SOCKS5/CONNECT handshake bytes, and SQLite-hostile strings; the JSON generator emits `__proto__`, `constructor`, and `prototype` keys, deep nesting to 64, arrays of 10,000, `-0`, `1e400`, `NaN`-shaped strings, lone surrogates, and NUL bytes; the URL generator emits the alternate loopback encodings 9D refuses (`2130706433`, `0177.0.0.1`, `0x7f.0.0.1`) plus `file:`, `gopher:`, and userinfo forms; the identifier generator emits SQL-injection shapes, path traversal, and Unicode homoglyphs; every generator is pure given an rng.
- [ ] RED same file: the committed corpus under `scripts/fuzz/corpus/` is loadable, each file is under 64 KiB, the total corpus is under 2 MiB (so the repository stays small), and the credential-shape scan from Task 1 passes over every corpus file.
- [ ] Verify RED.
- [ ] GREEN. Corpus seeds are minimised hand-written cases plus any input a later task's crash produces.
- [ ] Verify: `node --test tests/fuzz-generators.test.mjs` exits 0.
- [ ] Commit — `test: add Bayz fuzz generators and seed corpus`

### Task 3 — Boundary fuzz targets

**Create:** `scripts/fuzz/targets/{api-schema,authorization,sse,tool-args,provider-response,provider-config,proxy-config,socks5,telemetry,storage-envelope,migration,url,identifier}.mjs`, `scripts/fuzz-run.mjs`

**Contract for every target:** the boundary must **reject or accept** — never crash, never hang, never throw a non-BAYZ error, and never mutate global state.

- [ ] For each of the thirteen targets: 5,000 iterations at a pinned seed; assert every thrown error is an instance of the owning package's error type with a fixed code from the existing vocabulary; assert no `RangeError`, `TypeError`, `ERR_INTERNAL_ASSERTION`, or `ERR_OUT_OF_RANGE` escapes; assert no iteration exceeds a 250 ms budget (a hang is a DoS, so a slow input is a failure with the input recorded); assert process RSS growth across the 5,000 iterations stays under 64 MiB.
- [ ] `authorization` target additionally: a 1 MiB bearer value, a bearer with embedded CR/LF, a bearer of 10,000 spaces, and a bearer that is valid for a *revoked* identity all end in `401` with no distinguishable timing class (bounded, documented as indicative).
- [ ] `sse` target additionally: interleaved partial frames, a frame split mid-UTF-8-sequence, a 64 KiB line, a 3 MiB total stream, `[DONE]` inside a JSON string, and a stream of pure `\r` bytes — each ends in a bounded outcome per 9B Task 1.
- [ ] `migration` target additionally: a database whose `user_version` is any value 0–255 including beyond the current head opens or fails closed, and **never silently downgrades or half-applies** — assert the schema after the attempt is either the original or the head, never in between.
- [ ] `storage-envelope` target additionally: a bit-flip in every byte position of a short envelope fails closed with `master_key_invalid` or `storage_unavailable`, never returning plaintext.
- [ ] `scripts/fuzz-run.mjs` runs every target, prints `ok N` / `FAIL N` per target so a smoke citation can reference `smoke:fuzz#N`, writes any failing input to `scripts/fuzz/corpus/regression/` (credential-scanned first), and exits non-zero on any failure.
- [ ] Verify: `node scripts/fuzz-run.mjs` exits 0.
- [ ] Commit — `test: add Bayz boundary fuzz targets`

### Task 4 — Chaos scenarios

**Create:** `scripts/chaos-smoke.mjs`
**Test:** covered by the script's own exit code

Each scenario runs against **real** components — a real listener, real origins, real proxies, a real database — and asserts a specific recovery, not merely "no crash".

- [ ] Provider dies mid-request: the client receives the stable envelope with `unreachable`, telemetry records `request.failed`, and the next request to a healthy provider succeeds.
- [ ] Provider dies mid-**stream**, after the first byte: the client sees a terminal error event, **no failover is attempted** (9B's honest semantics — assert the second origin observed zero requests), and no partial row is written.
- [ ] Proxy dies mid-handshake and mid-tunnel: distinct fixed codes, and the provider's own credential is never sent in the clear (assert the origin observed no request).
- [ ] Connection reset (RST) at each of: pre-request, post-headers, mid-body, mid-SSE.
- [ ] DNS failure and DNS *change* between resolve and connect: the second resolution is re-checked against the egress policy per 9D Task 1.
- [ ] Upstream timeout, and idle timeout distinct from total timeout.
- [ ] Credential revoked mid-operation: the in-flight request completes or fails cleanly, and the *next* request fails with `credential_missing` — never a stale success.
- [ ] Client identity revoked mid-stream: the stream terminates and a reconnect is `401`.
- [ ] BAYZ restarted mid-stream: the client sees a terminal error; on restart the schema opens, the identities and providers survive, and no orphaned row or lock remains.
- [ ] SQLite reopen under a held WAL, and an injected storage failure (a read-only database file) surfaces `storage_unavailable` and does not corrupt the file — assert `PRAGMA integrity_check` returns `ok` after every scenario.
- [ ] Disk-full simulation via a bounded temp filesystem if the platform allows it; if it cannot be simulated here, record `UNVERIFIED` with the reason rather than skipping silently.
- [ ] The script prints numbered checks and exits non-zero on any failure.
- [ ] Verify: `node scripts/chaos-smoke.mjs` exits 0; `PRAGMA integrity_check` clean in every scenario.
- [ ] Commit — `test: add the Bayz chaos scenario suite`

### Task 5 — Load measurement

**Create:** `scripts/load-smoke.mjs`, `docs/transcripts/load/` (populated at run time)

- [ ] Drive a real listener with real `fetch` at concurrency 1, 8, 32, 128, and 256 against fast loopback origins. Record p50, p95, p99, and max latency, throughput, error count by code, and the observed effect of the 9F concurrency cap (default 32) — specifically that the 33rd concurrent request **waits** rather than opening a socket, and that beyond the queue depth it is refused with `rate_limited` rather than queued forever.
- [ ] Record the same series for streaming requests, reporting time-to-first-byte separately from total duration, since TTFB is the number a client actually feels.
- [ ] Every reported figure is written to a transcript naming the device (Termux/Android ARM64, 8 CPUs, Node v24.19.0), the timestamp, the commit hash, and the exact command. **The script must refuse to print a summary table without writing its transcript.**
- [ ] Assert correctness under load, not just speed: every response is a valid envelope, no response carries another request's data (cross-talk guard using a per-request sentinel), and telemetry row count equals the completed request count.
- [ ] The script asserts *stability properties* (no crash, no unhandled rejection, error codes only from the known set, no cross-talk) and **does not** assert a latency threshold — a performance regression gate on a shared Android device would be noise.
- [ ] Verify: `node scripts/load-smoke.mjs` exits 0 and writes a transcript.
- [ ] Commit — `test: add Bayz load measurement with transcripts`

### Task 6 — Soak measurement

**Create:** `scripts/soak-smoke.mjs`, `docs/transcripts/soak/`

- [ ] Sustain mixed traffic — non-streaming chat, streaming chat, tool roundtrips, model listing, usage reads, and periodic management writes — for a documented duration with `--duration` configurable and a default short enough to run in CI (10 minutes) plus a documented long mode (2 hours).
- [ ] Sample every 15 s and record: heap used, heap total, external, RSS, active handle count, active request count, timer count, open file descriptors (`/proc/self/fd`), socket count, `bayz.db` size, WAL size, and telemetry row count.
- [ ] Assert, with the numbers in the transcript: heap and RSS have no positive linear trend beyond a documented tolerance across the second half of the run; handle, timer, and fd counts return to baseline ±2 after a quiet period; the WAL is checkpointed and does not grow without bound; telemetry rows are pruned to the retention bound rather than growing forever; `PRAGMA integrity_check` is `ok` at the end.
- [ ] A leak is a **FAIL with the sample series attached**, not a warning. A run that cannot complete on this device records `UNVERIFIED` with the reason and the partial series.
- [ ] Verify: `node scripts/soak-smoke.mjs` exits 0 and writes a transcript.
- [ ] Commit — `test: add Bayz soak measurement with resource series`

### Task 7 — Resilience report and gate wiring

**Create:** `docs/superpowers/2026-08-27-bayz-resilience-report.md`, `scripts/resilience-gate.mjs`
**Test:** `tests/resilience-report.test.mjs`

- [ ] RED `tests/resilience-report.test.mjs`: the report exists; every fuzz target, chaos scenario, load point, and soak metric appears as a row with exactly one of `PASS`, `FAIL`, `UNVERIFIED`, `N/A`; every `PASS` carries an evidence reference matching `^(smoke:[a-z-]+#\d+|test:[\w./-]+|transcript:[\w./-]+)$`; no capacity figure appears in the report without a `transcript:` reference on the same row; the device is named in the header.
- [ ] GREEN: write the report from the actual outputs of Tasks 3–6.
- [ ] `scripts/resilience-gate.mjs`: `--report` always exits 0; `--enforce` exits non-zero if any row is `FAIL`, or if any fuzz or chaos row is `UNVERIFIED`. Load and soak `UNVERIFIED` is permitted to block or not per an explicit documented decision — the gate names which, rather than leaving it implicit. 9L runs it with `--enforce`.
- [ ] Verify: `node --test tests/resilience-report.test.mjs` exits 0; `node scripts/resilience-gate.mjs --report` exits 0; `npm run runtime:verify` exits 0; `git diff --check` clean.
- [ ] Commit — `test: add the Bayz resilience report and gate`

## Completion checklist

- [ ] Fuzz harness is seed-reproducible across processes; failing inputs are saved as regression corpus.
- [ ] Thirteen fuzz targets, 5,000 iterations each, zero crashes, zero hangs, bounded RSS growth.
- [ ] Every fuzz error is a known BAYZ code; no engine error escapes a boundary.
- [ ] Chaos scenarios assert a specific recovery and `PRAGMA integrity_check` is `ok` after each.
- [ ] Mid-stream failure never triggers failover; mid-stream restart leaves no orphaned state.
- [ ] Load and soak figures exist only alongside transcripts naming this device.
- [ ] Soak proves no handle, timer, fd, WAL, or telemetry-row unbounded growth.
- [ ] No fuzz corpus file contains credential-shaped data.
- [ ] No new runtime dependency added.
