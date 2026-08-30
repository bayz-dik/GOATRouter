# BAYZ resilience report — Phase 9I

- Device: Termux/Android ARM64 (Ubuntu proot), 8 CPUs, 11.0 GiB RAM
- Node: v24.19.0 (arm64)
- Commit: a6ce14e2911530d1a5da6dbf70a90dd029d683c6
- Written: 2026-08-29

Every row below carries exactly one verdict — `PASS`, `FAIL`, `UNVERIFIED`, or `N/A` — and every
`PASS` carries an evidence reference that resolves on disk. Capacity figures cite a
`transcript:` and nothing else, because a number without a device, timestamp and command behind it
is not evidence.

`PASS`/`FAIL` are used here rather than 9H's `VERIFIED`/`BLOCKED` vocabulary because this phase's
plan names those four verdicts explicitly, and a row here reports whether a *check* passed rather
than whether a *client capability* was observed. The distinction is deliberate: 9H rejected
`PASS`/`FAIL` as placeholders for compatibility claims, which is a different question from
"did this assertion hold".

Reproduce with:

```
node scripts/fuzz-run.mjs                    # 13 targets × 5,000 iterations
node scripts/chaos-smoke.mjs                 # 11 scenarios
node scripts/load-smoke.mjs                  # 5 concurrency levels, both series
node --expose-gc scripts/soak-smoke.mjs      # 600 s, samples every 15 s
node scripts/resilience-gate.mjs --enforce   # this report, gated
```

## Fuzz targets

Thirteen boundary targets, 5,000 iterations each at pinned seeds. Every thrown error is an instance
of the owning package's error type with a code from the existing vocabulary; no engine error escapes
a boundary. RSS growth bound is 64 MiB per target.

| item | status | evidence | notes |
|---|---|---|---|
| api-schema | PASS | smoke:fuzz#1-3 | seed `9i-api-schema-1`, 2,647 ms, RSS +13.7 MiB |
| authorization | PASS | smoke:fuzz#4-6 | seed `9i-authorization-1`, 5,604 ms, RSS +4.8 MiB; real `openSecretStorage` and identity manager |
| sse | PASS | smoke:fuzz#7-9 | seed `9i-sse-1`, 1,426 ms, RSS +39.5 MiB |
| tool-args | PASS | smoke:fuzz#10-12 | seed `9i-tool-args-1`, 2,416 ms, RSS +16.2 MiB |
| provider-response | PASS | smoke:fuzz#13-15 | seed `9i-provider-response-1`, 1,821 ms, RSS −0.3 MiB |
| provider-config | PASS | smoke:fuzz#16-18 | seed `9i-provider-config-1`, 1,241 ms, RSS +0.3 MiB |
| proxy-config | PASS | smoke:fuzz#19-21 | seed `9i-proxy-config-1`, 1,171 ms, RSS +0.0 MiB |
| socks5 | PASS | smoke:fuzz#22-24 | seed `9i-socks5-1`, 142,518 ms, RSS +22.8 MiB; real TCP sockets |
| telemetry | PASS | smoke:fuzz#25-27 | seed `9i-telemetry-1`, 1,191 ms, RSS +0.0 MiB |
| storage-envelope | PASS | smoke:fuzz#28-30 | seed `9i-storage-envelope-1`, 1,833 ms, RSS +0.4 MiB; real AES-GCM, every byte position bit-flipped |
| migration | PASS | smoke:fuzz#31-33 | seed `9i-migration-1`, 9,702 ms, RSS −59.2 MiB; real SQLite DDL in real transactions |
| url | PASS | smoke:fuzz#34-36 | seed `9i-url-1`, 1,494 ms, RSS +0.5 MiB |
| identifier | PASS | smoke:fuzz#37-39 | seed `9i-identifier-1`, 1,428 ms, RSS +0.3 MiB |
| seed reproducibility across processes | PASS | test:tests/fuzz-harness.test.mjs | 24 draws compared byte-for-byte in a spawned child |
| generator purity and corpus | PASS | test:tests/fuzz-generators.test.mjs | 93 corpus files, 111,914 bytes |
| no corpus file contains credential-shaped data | PASS | test:tests/fuzz-generators.test.mjs | a planted `Bearer …` file was caught, then removed |
| no new runtime dependency | PASS | test:tests/fuzz-harness.test.mjs | xoshiro128\*\* over SHA-256 seeding, `node:crypto` only |

## Chaos scenarios

Real listener on a real port, real loopback origins, a real HTTP CONNECT proxy, real SQLite with
real envelope crypto, a real process restart on the same port. Each scenario asserts a specific
recovery, and `PRAGMA integrity_check` runs after every scenario that owns a data directory.

| item | status | evidence | notes |
|---|---|---|---|
| provider dies mid-request | PASS | smoke:chaos#1-5 | stable envelope, `request.failed` recorded, next request to a healthy provider succeeds |
| provider dies mid-stream after the first byte | PASS | smoke:chaos#6-10 | no failover attempted — the second origin observed **zero** requests; no partial row written |
| provider malformed responses | PASS | smoke:chaos#11-15 | truncated JSON, wrong content-type, oversized body, HTML error page |
| connection reset at four points | PASS | smoke:chaos#16-22 | pre-request, post-headers, mid-body, mid-SSE |
| upstream total vs idle timeout | PASS | smoke:chaos#23-30 | distinguished by stage code `stream-total-timeout` vs `stream-idle-timeout`; total correctly preempts idle |
| proxy dies mid-handshake and mid-tunnel | PASS | smoke:chaos#31-44 | credential never written to a socket on handshake failure; on a granted tunnel the request traversed it rather than going direct |
| DNS failure and DNS rebinding | PASS | smoke:chaos#45-53 | second resolution re-checked; loopback and metadata refused `invalid_provider_config/egress-resolved-denied` |
| credential revoked mid-operation | PASS | smoke:chaos#54-58 | the deleted secret is never sent again — origin observed no `Authorization` header |
| client identity revoked mid-stream | PASS | smoke:chaos#59-63 | reconnect is 401, streaming and not; revocation is double-guarded (flag + key erasure) |
| BAYZ restarted mid-stream | PASS | smoke:chaos#64-73 | client stream terminates; schema, identities, providers, credential and route all survive; pre-restart key still works |
| SQLite reopen under a held WAL | PASS | smoke:chaos#74-79 | second connection opens at the same schema head, `integrity_check` ok under concurrent access |
| read-only database injection | UNVERIFIED | | `chmod 0444` does not prevent writes for this process — root under Termux/proot, and `paths.ts:56` documents that Android and FAT-derived mounts may not honour POSIX modes. The `storage_unavailable` path is covered by `@bayz/storage` unit tests. |
| disk exhaustion | UNVERIFIED | | No bounded filesystem is available: `mount -t tmpfs` exits **0** under proot while mounting nothing, leaving the mount point inaccessible. An earlier version of this scenario passed on a `storage_unavailable` raised by a vanished directory; the mount is now probed for `ENOSPC` before it is trusted. Filling the real filesystem is refused — `/tmp` is shared Android device storage with 211 GiB free. |
| the runner exits non-zero on any failure | PASS | test:tests/chaos-suite.test.mjs | both exit paths pinned, including the tsx relaunch propagating the child's status |
| `PRAGMA integrity_check` ok after every scenario | PASS | smoke:chaos#83 | ten storage-owning scenarios, clean in each |

Both UNVERIFIED rows are host limitations, not unexercised code, and both are in the chaos section —
so they **block** `--enforce` on this device by the documented policy below. That is the correct
outcome: a release cannot be declared from a host that cannot run two of the plan's failure
injections.

## Load points

Real `fetch` against a real listener, fast loopback origins, 3,288 requests per run. Every figure
below is from `transcript:docs/transcripts/load/load.md`. **No latency threshold is asserted** — a
performance gate on a shared Android device would fail on a warm day and teach everyone to ignore it.

| item | status | evidence | notes |
|---|---|---|---|
| concurrency 1, non-streaming | PASS | transcript:docs/transcripts/load/load.md | 100 requests, 0 failed, p50 26.5 ms, p99 43.9 ms, 36.8 req/s |
| concurrency 8, non-streaming | PASS | transcript:docs/transcripts/load/load.md | 200 requests, 0 failed, p50 188.5 ms, p99 339.0 ms, 42.1 req/s |
| concurrency 32, non-streaming | PASS | transcript:docs/transcripts/load/load.md | 320 requests, 0 failed, p50 702.9 ms, p99 2,773.0 ms, 43.0 req/s |
| concurrency 128, non-streaming | PASS | transcript:docs/transcripts/load/load.md | 512 requests, 0 failed, p50 1,282.8 ms, p99 11,430.5 ms, 42.5 req/s |
| concurrency 256, non-streaming | PASS | transcript:docs/transcripts/load/load.md | 512 requests, 0 failed, p50 3,428.4 ms, p99 12,828.4 ms, 37.0 req/s |
| concurrency 1, streaming | PASS | transcript:docs/transcripts/load/load.md | TTFB p50 27.2 ms, p95 33.7 ms |
| concurrency 8, streaming | PASS | transcript:docs/transcripts/load/load.md | TTFB p50 204.7 ms, p95 268.1 ms |
| concurrency 32, streaming | PASS | transcript:docs/transcripts/load/load.md | TTFB p50 847.6 ms, p95 1,085.6 ms |
| concurrency 128, streaming | PASS | transcript:docs/transcripts/load/load.md | TTFB p50 3,587.9 ms, p95 6,736.0 ms |
| concurrency 256, streaming | PASS | transcript:docs/transcripts/load/load.md | TTFB p50 6,240.3 ms, p95 12,999.3 ms |
| outbound cap queues past its limit | PASS | smoke:load#49-52 | limit 4, queue 2: callers 5 and 6 wait, caller 7 refused `rate_limited/concurrency-queue-full` |
| outbound cap bounds real upstream concurrency | PASS | smoke:load#56 | 32 clients, 64 requests, limit 4 — the origin never saw more than **4** concurrent connections |
| release is idempotent | PASS | smoke:load#53-54 | a double release hands exactly one permit to exactly one waiter |
| inbound gate refuses rather than queues | PASS | smoke:load#59-62 | 16 simultaneous against a gate of 4 → 5 served, 11 refused 429, every refusal carrying `retry-after` |
| no cross-talk under load | PASS | smoke:load#4 | a per-request sentinel, read back out of the request the origin received; the same check repeats at #9, #14, #19 and #24 for the other levels |
| telemetry rows equal completed requests | PASS | transcript:docs/transcripts/load/load.md | 1,644 `usage_requests` rows = 1,644 completed, per series, counted in SQL because `/api/usage/requests` caps `limit` at 200; asserted at smoke:load#13-14 |
| no unhandled rejection under load | PASS | smoke:load#63 | across all ten level runs |
| transcript written before any summary | PASS | test:tests/load-harness.test.mjs | `writeTranscript` throws if the file is absent |

## Soak metrics

600 s (10 minutes), sampled every 15 s, mixed traffic: non-streaming chat, streaming chat, two-leg
tool roundtrips, model listing, usage reads, and periodic management writes. 18,741 requests, **0
failures**. Full series in `transcript:docs/transcripts/soak/soak.md`.

| item | status | evidence | notes |
|---|---|---|---|
| heap has no positive trend beyond tolerance | PASS | transcript:docs/transcripts/soak/soak.md | second-half slope **+2.1 KiB/sample** over 20 samples, tolerance 256 KiB, post-GC floor |
| RSS has no positive trend beyond tolerance | PASS | transcript:docs/transcripts/soak/soak.md | second-half slope **+0.084 MiB/sample** over 20 samples, tolerance 1 MiB |
| handle count returns to baseline ±2 | PASS | transcript:docs/transcripts/soak/soak.md | 6 → 5 after a quiet period |
| timer count returns to baseline ±2 | PASS | transcript:docs/transcripts/soak/soak.md | 1 → 0 after a quiet period |
| file descriptor count returns to baseline ±2 | PASS | transcript:docs/transcripts/soak/soak.md | 28 → 30 after a quiet period |
| WAL is checkpointed and bounded | PASS | transcript:docs/transcripts/soak/soak.md | peak 3.97 MiB, final 3.97 MiB, ceiling 16 MiB |
| telemetry rows pruned to the retention bound | PASS | transcript:docs/transcripts/soak/soak.md | 200 rows retained from 18,741 requests, bound 200 via `BAYZ_USAGE_RETENTION` |
| pruning was actually exercised | PASS | smoke:soak#11 | the run crossed the bound by two orders of magnitude, so the assertion is not vacuous |
| `PRAGMA integrity_check` ok at the end | PASS | smoke:soak#13 | |
| every traffic kind exercised | PASS | transcript:docs/transcripts/soak/soak.md | 5,206 chat, 2,603 streaming, 2,603 tool, 2,603 model lists, 2,603 usage, 520 management; asserted at smoke:soak#4 |
| no unhandled rejection during the soak | PASS | smoke:soak#14 | |
| 2-hour long mode | UNVERIFIED | | `--long` is implemented and documented but has not been run on this device. A two-hour foreground run cannot be supervised here, and the host is documented to stall for up to 184 s at load average 0.12 (`scripts/fuzz/host-baseline.mjs`), which would make an unattended two-hour result unreadable. The 600 s CI mode ran four times. |

The heap trend is measured as a **post-collection floor**, not raw `heapUsed`. Two identical 600 s
runs of the raw metric produced second-half slopes of **−338** and **+295** KiB/sample — same code,
opposite verdicts either side of the tolerance — because `heapUsed` is a sawtooth and a fixed
cadence samples whichever tooth it lands on. Forcing a double GC before each sample gives **+2.1**
and **+8.4** KiB/sample across two runs. The tolerance was not widened; the measurement was fixed.
Both runs are in `transcript:docs/transcripts/soak/soak.md`, and the floor is computed by
`scripts/soak-lib.mjs`.

## Mutation proofs

Every check that guards a real guarantee was proved to fail when that guarantee is removed. All
mutations were reverted byte-identically and the suites confirmed green afterwards.

| item | status | evidence | notes |
|---|---|---|---|
| request allow-list closure | PASS | test:tests/fuzz-generators.test.mjs | gutting `isPlainObject` + the unknown-key loop → `api-schema` red at iteration 31 on `{"prototype":1}` |
| no failover after the first byte | PASS | test:tests/chaos-suite.test.mjs | letting the post-first-chunk path `continue` → chaos #7/#8/#10 red |
| resolved-address egress re-check | PASS | test:tests/chaos-suite.test.mjs | disabling the re-check → chaos #49/#50 red |
| identity revocation | PASS | test:tests/chaos-suite.test.mjs | needed **both** the `revoked` flag and key erasure disabled before #61/#62 went red — double-guarded |
| outbound queue bound | PASS | test:tests/load-harness.test.mjs | removing the queue-full rejection → load #35 red, "the queue is unbounded" |
| release idempotence | PASS | test:tests/load-harness.test.mjs | non-idempotent release → load #36/#37 red, `inFlight` drifts to −1 |
| semaphore on the transport path | PASS | test:tests/load-harness.test.mjs | skipping `acquire` → load #38 red, origin saw 6 against a limit of 4 |
| telemetry retention pruning | PASS | test:tests/soak-harness.test.mjs | disabling `prune` → soak #11 red, 2,960 rows against a bound of 200 |
| handle and timer leak detection | PASS | test:tests/soak-harness.test.mjs | leaking one interval per request → soak #6/#7 red, 2,665 handles and 2,660 timers against a baseline of 6 and 1 |

## Gate policy

`scripts/resilience-gate.mjs` reads this report.

- `--report` always exits 0 and prints every row, every integrity violation, and the tally.
- `--enforce` exits non-zero if **any** row is `FAIL`, or if any **fuzz or chaos** row is
  `UNVERIFIED`, or if the report is malformed, missing, empty, or does not name the device.
- No flag, both flags, or an unknown flag exits 2.

**The explicit decision the plan asks for:** fuzz and chaos `UNVERIFIED` **blocks**; load and soak
`UNVERIFIED` **does not**. Fuzz and chaos rows are correctness and failure-handling properties, where
"not checked" is indistinguishable from "broken" for a security boundary. Load and soak rows are
capacity measurements whose feasibility depends on the host — this device cannot mount a bounded
filesystem or supervise a two-hour run — and a gate that refused every release from such a host would
be routed around within a week. Non-blocking `UNVERIFIED` rows are printed explicitly under
`--enforce` so nobody can claim they were hidden.

Current state on this device: `--report` exits 0; `--enforce` exits **1**, blocked by the two chaos
rows that need mount privileges and POSIX mode enforcement. That is the intended behaviour, not a
defect — the same shape as 9H's client gate blocking because `antigravity` is absent. A CI host with
those privileges runs both scenarios unchanged.
