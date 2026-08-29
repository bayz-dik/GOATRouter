# load

- Device: Termux/Android ARM64 (Ubuntu proot), 8 CPUs, 11.0 GiB RAM
- Node: v24.19.0 (arm64)
- Timestamp: 2026-08-29T05:38:23.345Z
- Commit: 7444f853fcd74821b201ab419c2f8c8325ffb22c
- Command: `node scripts/load-smoke.mjs`

Latency figures are from this device only. They are recorded for provenance, not asserted
against a threshold: a performance gate on a shared Android phone would fail on a warm day
and teach everyone to ignore it. The assertions in the run are stability and correctness
properties.

## Non-streaming

| concurrency | requested | ok | failed | p50 ms | p95 ms | p99 ms | max ms | req/s | peak in flight | codes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 100 | 100 | 0 | 26.5 | 38.7 | 43.9 | 45.5 | 36.8 | 1 | none |
| 8 | 200 | 200 | 0 | 188.5 | 231.6 | 339.0 | 372.7 | 42.1 | 8 | none |
| 32 | 320 | 320 | 0 | 702.9 | 1319.1 | 2773.0 | 3330.0 | 43.0 | 32 | none |
| 128 | 512 | 512 | 0 | 1282.8 | 11099.7 | 11430.5 | 11567.8 | 42.5 | 128 | none |
| 256 | 512 | 512 | 0 | 3428.4 | 12247.9 | 12828.4 | 12953.2 | 37.0 | 256 | none |

## Streaming

Time-to-first-byte is reported separately from total duration, because TTFB is the number a
client actually feels while the total includes the origin's own two-frame pacing.

| concurrency | requested | ok | failed | p50 ms | p95 ms | p99 ms | max ms | TTFB p50 | TTFB p95 | req/s | peak in flight | codes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 100 | 100 | 0 | 27.3 | 33.7 | 38.0 | 44.8 | 27.2 | 33.7 | 35.8 | 1 | none |
| 8 | 200 | 200 | 0 | 204.8 | 268.2 | 289.1 | 394.0 | 204.7 | 268.1 | 38.1 | 8 | none |
| 32 | 320 | 320 | 0 | 847.6 | 1085.7 | 1795.6 | 1953.4 | 847.6 | 1085.6 | 36.5 | 32 | none |
| 128 | 512 | 512 | 0 | 3587.9 | 6736.0 | 7872.3 | 8153.6 | 3587.9 | 6736.0 | 34.3 | 128 | none |
| 256 | 512 | 512 | 0 | 6240.4 | 12999.3 | 13682.3 | 13838.3 | 6240.3 | 12999.3 | 32.0 | 256 | none |

## Concurrency cap

- defaults read from packages/router/src/concurrency.ts: OUTBOUND_CONCURRENCY_DEFAULT=32, OUTBOUND_QUEUE_DEPTH_DEFAULT=256, MIN=1, MAX=512
- queue-full refusal: RouterError code=rate_limited stage=concurrency-queue-full
- outbound limit 4: 32 clients issued 64 requests; the origin never saw more than 4 concurrent upstream connections (client peak in flight 32), 64 ok / 0 failed in 1814 ms
- inbound gate 4: 16 simultaneous requests → 8 served, 8 refused 429 rate_limited (retry-after present on 8)

## Observations

- non-streaming telemetry: 1644 usage_requests rows (1644 ok), 1644 usage_attempts rows; origin served 1644 upstream requests
- streaming c=1: TTFB p50=27.2ms p95=33.7ms p99=37.9ms max=44.7ms over 100 streams
- streaming c=8: TTFB p50=204.7ms p95=268.1ms p99=289.0ms max=394.0ms over 200 streams
- streaming c=32: TTFB p50=847.6ms p95=1085.6ms p99=1795.6ms max=1953.4ms over 320 streams
- streaming c=128: TTFB p50=3587.9ms p95=6736.0ms p99=7872.2ms max=8153.6ms over 512 streams
- streaming c=256: TTFB p50=6240.3ms p95=12999.3ms p99=13682.2ms max=13838.3ms over 512 streams
- streaming telemetry: 1644 usage_requests rows (1644 ok), 1644 usage_attempts rows; origin served 1644 upstream requests
- defaults read from packages/router/src/concurrency.ts: OUTBOUND_CONCURRENCY_DEFAULT=32, OUTBOUND_QUEUE_DEPTH_DEFAULT=256, MIN=1, MAX=512
- queue-full refusal: RouterError code=rate_limited stage=concurrency-queue-full
- outbound limit 4: 32 clients issued 64 requests; the origin never saw more than 4 concurrent upstream connections (client peak in flight 32), 64 ok / 0 failed in 1814 ms
- inbound gate 4: 16 simultaneous requests → 8 served, 8 refused 429 rate_limited (retry-after present on 8)
- after 3288 load requests: RSS 353.2 MiB, heap 29.5/206.2 MiB, external 6.4 MiB, open fds 40, host free 2650 MiB, load average 0.12 0.07 0.02

## Result

64/64 checks passed.

