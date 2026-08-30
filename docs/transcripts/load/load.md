# load

- Device: Termux/Android ARM64 (Ubuntu proot), 8 CPUs, 11.0 GiB RAM
- Node: v24.19.0 (arm64)
- Timestamp: 2026-08-30T15:50:50.818Z
- Commit: 4414f610319fb00ad86232550b4ca0a7b7096ad8
- Command: `node scripts/load-smoke.mjs`

Latency figures are from this device only. They are recorded for provenance, not asserted
against a threshold: a performance gate on a shared Android phone would fail on a warm day
and teach everyone to ignore it. The assertions in the run are stability and correctness
properties.

## Non-streaming

| concurrency | requested | ok | failed | p50 ms | p95 ms | p99 ms | max ms | req/s | peak in flight | codes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 100 | 100 | 0 | 21.4 | 29.9 | 34.9 | 48.0 | 45.6 | 1 | none |
| 8 | 200 | 200 | 0 | 136.6 | 185.5 | 262.7 | 291.4 | 55.2 | 8 | none |
| 32 | 320 | 320 | 0 | 479.3 | 946.8 | 2092.8 | 2359.0 | 60.0 | 32 | none |
| 128 | 512 | 512 | 0 | 840.4 | 8551.1 | 8921.0 | 9024.8 | 54.4 | 128 | none |
| 256 | 512 | 512 | 0 | 2911.6 | 10099.3 | 10564.2 | 10689.4 | 44.8 | 256 | none |

## Streaming

Time-to-first-byte is reported separately from total duration, because TTFB is the number a
client actually feels while the total includes the origin's own two-frame pacing.

| concurrency | requested | ok | failed | p50 ms | p95 ms | p99 ms | max ms | TTFB p50 | TTFB p95 | req/s | peak in flight | codes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 100 | 100 | 0 | 24.2 | 28.8 | 38.1 | 47.1 | 24.2 | 28.8 | 40.6 | 1 | none |
| 8 | 200 | 200 | 0 | 162.1 | 249.6 | 290.2 | 337.2 | 162.0 | 249.6 | 45.9 | 8 | none |
| 32 | 320 | 320 | 0 | 663.8 | 863.3 | 1275.0 | 1420.4 | 663.7 | 863.3 | 46.1 | 32 | none |
| 128 | 512 | 512 | 0 | 2885.9 | 5636.9 | 6593.5 | 6856.5 | 2885.8 | 5636.8 | 42.5 | 128 | none |
| 256 | 512 | 512 | 0 | 5286.4 | 10685.6 | 11234.3 | 11365.5 | 5286.4 | 10685.6 | 38.7 | 256 | none |

## Concurrency cap

- defaults read from packages/router/src/concurrency.ts: OUTBOUND_CONCURRENCY_DEFAULT=32, OUTBOUND_QUEUE_DEPTH_DEFAULT=256, MIN=1, MAX=512
- queue-full refusal: RouterError code=rate_limited stage=concurrency-queue-full
- outbound limit 4: 32 clients issued 64 requests; the origin never saw more than 4 concurrent upstream connections (client peak in flight 32), 64 ok / 0 failed in 1390 ms
- inbound gate 4: 16 simultaneous requests → 5 served, 11 refused 429 rate_limited (retry-after present on 11)

## Observations

- non-streaming telemetry: 1644 usage_requests rows (1644 ok), 1644 usage_attempts rows; origin served 1644 upstream requests
- streaming c=1: TTFB p50=24.2ms p95=28.8ms p99=38.0ms max=47.0ms over 100 streams
- streaming c=8: TTFB p50=162.0ms p95=249.6ms p99=290.2ms max=337.2ms over 200 streams
- streaming c=32: TTFB p50=663.7ms p95=863.3ms p99=1274.9ms max=1420.4ms over 320 streams
- streaming c=128: TTFB p50=2885.8ms p95=5636.8ms p99=6593.4ms max=6856.5ms over 512 streams
- streaming c=256: TTFB p50=5286.4ms p95=10685.6ms p99=11234.2ms max=11365.4ms over 512 streams
- streaming telemetry: 1644 usage_requests rows (1644 ok), 1644 usage_attempts rows; origin served 1644 upstream requests
- defaults read from packages/router/src/concurrency.ts: OUTBOUND_CONCURRENCY_DEFAULT=32, OUTBOUND_QUEUE_DEPTH_DEFAULT=256, MIN=1, MAX=512
- queue-full refusal: RouterError code=rate_limited stage=concurrency-queue-full
- outbound limit 4: 32 clients issued 64 requests; the origin never saw more than 4 concurrent upstream connections (client peak in flight 32), 64 ok / 0 failed in 1390 ms
- inbound gate 4: 16 simultaneous requests → 5 served, 11 refused 429 rate_limited (retry-after present on 11)
- after 3288 load requests: RSS 336.0 MiB, heap 56.3/228.2 MiB, external 6.8 MiB, open fds 40, host free 3754 MiB, load average 0.12 0.07 0.02

## Result

64/64 checks passed.

