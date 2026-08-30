# load

- Device: Termux/Android ARM64 (Ubuntu proot), 8 CPUs, 11.0 GiB RAM
- Node: v24.19.0 (arm64)
- Timestamp: 2026-08-30T16:49:49.183Z
- Commit: 647126a092c79459b599f2ab8dcd2e19b48f1f7c
- Command: `node scripts/load-smoke.mjs`

Latency figures are from this device only. They are recorded for provenance, not asserted
against a threshold: a performance gate on a shared Android phone would fail on a warm day
and teach everyone to ignore it. The assertions in the run are stability and correctness
properties.

## Non-streaming

| concurrency | requested | ok | failed | p50 ms | p95 ms | p99 ms | max ms | req/s | peak in flight | codes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 100 | 100 | 0 | 28.3 | 37.1 | 57.6 | 60.8 | 34.4 | 1 | none |
| 8 | 200 | 200 | 0 | 197.0 | 241.0 | 322.2 | 354.4 | 39.6 | 8 | none |
| 32 | 320 | 320 | 0 | 776.3 | 1354.3 | 2927.0 | 3463.6 | 39.5 | 32 | none |
| 128 | 512 | 512 | 0 | 969.3 | 9406.4 | 9726.2 | 9809.9 | 50.8 | 128 | none |
| 256 | 512 | 512 | 0 | 2399.3 | 9013.8 | 9505.2 | 9641.0 | 48.7 | 256 | none |

## Streaming

Time-to-first-byte is reported separately from total duration, because TTFB is the number a
client actually feels while the total includes the origin's own two-frame pacing.

| concurrency | requested | ok | failed | p50 ms | p95 ms | p99 ms | max ms | TTFB p50 | TTFB p95 | req/s | peak in flight | codes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 100 | 100 | 0 | 28.9 | 34.1 | 41.0 | 41.4 | 28.8 | 34.0 | 35.2 | 1 | none |
| 8 | 200 | 200 | 0 | 227.5 | 291.0 | 308.8 | 424.2 | 227.4 | 290.9 | 35.0 | 8 | none |
| 32 | 320 | 320 | 0 | 647.2 | 1052.3 | 1718.1 | 1856.2 | 647.1 | 1052.3 | 45.5 | 32 | none |
| 128 | 512 | 512 | 0 | 2530.7 | 4363.6 | 5153.8 | 5297.6 | 2530.6 | 4363.6 | 49.8 | 128 | none |
| 256 | 512 | 512 | 0 | 4393.7 | 9971.4 | 10417.7 | 10505.2 | 4393.6 | 9971.3 | 42.8 | 256 | none |

## Concurrency cap

- defaults read from packages/router/src/concurrency.ts: OUTBOUND_CONCURRENCY_DEFAULT=32, OUTBOUND_QUEUE_DEPTH_DEFAULT=256, MIN=1, MAX=512
- queue-full refusal: RouterError code=rate_limited stage=concurrency-queue-full
- outbound limit 4: 32 clients issued 64 requests; the origin never saw more than 4 concurrent upstream connections (client peak in flight 32), 64 ok / 0 failed in 1222 ms
- inbound gate 4: 16 simultaneous requests → 4 served, 12 refused 429 rate_limited (retry-after present on 12)

## Observations

- non-streaming telemetry: 1644 usage_requests rows (1644 ok), 1644 usage_attempts rows; origin served 1644 upstream requests
- streaming c=1: TTFB p50=28.8ms p95=34.0ms p99=41.0ms max=41.3ms over 100 streams
- streaming c=8: TTFB p50=227.4ms p95=290.9ms p99=308.8ms max=424.1ms over 200 streams
- streaming c=32: TTFB p50=647.1ms p95=1052.3ms p99=1718.0ms max=1856.1ms over 320 streams
- streaming c=128: TTFB p50=2530.6ms p95=4363.6ms p99=5153.8ms max=5297.6ms over 512 streams
- streaming c=256: TTFB p50=4393.6ms p95=9971.3ms p99=10417.7ms max=10505.2ms over 512 streams
- streaming telemetry: 1644 usage_requests rows (1644 ok), 1644 usage_attempts rows; origin served 1644 upstream requests
- defaults read from packages/router/src/concurrency.ts: OUTBOUND_CONCURRENCY_DEFAULT=32, OUTBOUND_QUEUE_DEPTH_DEFAULT=256, MIN=1, MAX=512
- queue-full refusal: RouterError code=rate_limited stage=concurrency-queue-full
- outbound limit 4: 32 clients issued 64 requests; the origin never saw more than 4 concurrent upstream connections (client peak in flight 32), 64 ok / 0 failed in 1222 ms
- inbound gate 4: 16 simultaneous requests → 4 served, 12 refused 429 rate_limited (retry-after present on 12)
- after 3288 load requests: RSS 335.4 MiB, heap 40.7/199.5 MiB, external 6.6 MiB, open fds 40, host free 3249 MiB, load average 0.12 0.07 0.02

## Result

64/64 checks passed.

