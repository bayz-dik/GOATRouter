# final-gate

- Device: Termux/Android ARM64 (Ubuntu proot), 8 CPUs, 11.0 GiB RAM
- Node: v24.19.0 (arm64)
- Started: 2026-08-30T23:36:13+07:00
- Ended: 2026-08-30T23:59:55+07:00
- Commit: 647126a092c79459b599f2ab8dcd2e19b48f1f7c
- Command: `node scripts/release-gate.mjs --enforce --full --no-audit`

The authoritative Phase 9L Task 7 execution: one uninterrupted invocation of the aggregate
release gate over all 32 steps, including the long class. `--no-audit` is passed because no
registry is reachable from this host; every other step ran unmodified.

This file is the raw run output. It is the source a `transcript:` citation points at, so nothing
here is summarised or rounded — the readiness statement derives its Task 7 section from these
very lines rather than from a retyped copy of them.

## Step verdicts

```
  PASS runtime:verify               176s  exit 0 — > tsc -p tsconfig.json --noEmit
  PASS smoke:api                    4s  exit 0 — (Use `node --trace-warnings ...` to show where the warning was created)
  PASS smoke:chaos                  71s  exit 0 — (node:9521) [FSTDEP023] FastifyDeprecation: disableRequestLogging option is deprecated. Use the logC
  PASS smoke:custom-provider        5s  exit 0 — (Use `node --trace-warnings ...` to show where the warning was created)
  PASS smoke:dashboard              12s  exit 0 — dashboard smoke: PASS
  PASS smoke:identity               5s  exit 0 — (Use `node --trace-warnings ...` to show where the warning was created)
  PASS smoke:injection              4s  exit 0 — (Use `node --trace-warnings ...` to show where the warning was created)
  PASS smoke:install                47s  exit 0 — install smoke: PASS
  PASS smoke:provider               2s  exit 0 — provider smoke: PASS
  PASS smoke:proxy                  2s  exit 0 — proxy smoke: PASS
  PASS smoke:proxy-ux               5s  exit 0 — (Use `node --trace-warnings ...` to show where the warning was created)
  PASS smoke:router                 3s  exit 0 — router smoke: PASS
  PASS smoke:security               15s  exit 0 — (Use `node --trace-warnings ...` to show where the warning was created)
  PASS smoke:storage                2s  exit 0 — storage smoke: PASS
  PASS smoke:stream                 5s  exit 0 — (Use `node --trace-warnings ...` to show where the warning was created)
  PASS smoke:upgrade                65s  exit 0 — upgrade smoke: PASS
  PASS smoke:usage                  4s  exit 0 — (Use `node --trace-warnings ...` to show where the warning was created)
  PASS suite                        28s  exit 0 — ℹ duration_ms 28312.649002
  PASS fuzz                         183s  exit 0 — fuzz: PASS
  PASS dependency-closure           0s  exit 0 — dependency closure: PASS
  PASS lockfile-check               0s  exit 0 — lockfile integrity: PASS
  PASS offline-check                93s  exit 0 — offline check: PASS
  PASS diff-check                   1s  exit 0
  PASS clean-tree                   1s  working tree clean
  FAIL gate:client                  0s  exit 1 — tests/matrix-integrity.test.mjs, which resolves every citation on disk.
  FAIL gate:resilience              0s  exit 1 — resilience-gate: BLOCKED — 2 blocking row(s), 0 integrity violation(s)
  PASS gate:platform                0s  exit 0 — platform gate: PASS
  PASS gate:supply-chain            0s  exit 0 — supply-chain gate: PASS
  FAIL gate:feature                 0s  exit 1 — feature gate: FAIL — 2 blocking item(s)
  PASS gate:security posture        0s  derived from smoke:security (exit 0 — (Use `node --trace-warnings ...` to show where the warning was created))
  PASS smoke:load                   82s  exit 0 — (node:23267) [FSTDEP023] FastifyDeprecation: disableRequestLogging option is deprecated. Use the log
  PASS smoke:soak                   606s  exit 0 — (Use `node --trace-warnings ...` to show where the warning was created)
```

## Blocking items

```
blocking (3):
  - gate:client: FAIL — exit 1 — tests/matrix-integrity.test.mjs, which resolves every citation on disk.
  - gate:resilience: FAIL — exit 1 — resilience-gate: BLOCKED — 2 blocking row(s), 0 integrity violation(s)
  - gate:feature: FAIL — exit 1 — feature gate: FAIL — 2 blocking item(s)
```

## Outcome

```
release gate: FAIL — 3 blocking item(s)
RELEASE_GATE_EXIT=1
currently UNVERIFIED (67)
```

The gate exits non-zero by design: 3 composed gates block on documented,
unfabricated evidence, and 67 items remain honestly `UNVERIFIED`. No status was adjusted.
