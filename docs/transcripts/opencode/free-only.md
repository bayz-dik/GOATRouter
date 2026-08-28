# OpenCode → BAYZ — free-only

Captured by `scripts/verify-opencode.mjs` against the real `opencode` binary
(v1.18.23) and a real BAYZ listener. Secrets are redacted by name; ports, temp
paths, UUIDs, and timings are normalised so a re-run reproduces these bytes.

## Provider classification

```text
catalogue publish status=200; the origin publishes real pricing metadata over a non-loopback address, so its model classifies PAID
```

## Route as created (no freeOnly field was sent)

```json
{
 "id": "oc-paid-route",
 "model": "paid-model",
 "providerId": "oc-paid",
 "forceDirect": false,
 "freeOnly": true,
 "priority": 100,
 "enabled": true,
 "config": {
  "maxAttempts": 2,
  "requestTimeoutMs": 60000
 },
 "createdAt": "<TIMESTAMP>",
 "updatedAt": "<TIMESTAMP>"
}
```

## Real client against the free-only route — stderr

```text

> build · paid-model

Error: no_free_route: no free model was available and this route may not spend money (stage: chat-stream-free-only)
```

## Real client against the free-only route — exit

```text
code=1
```

## Upstream chat requests the PAID origin received

```text
0
```

## After an explicit freeOnly:false opt-out — client stdout

```text
BAYZ-OK
```

## After an explicit freeOnly:false opt-out — client exit

```text
code=0
```

## Upstream chat requests after the opt-out

```text
2
```

## BAYZ usage rows

```json
[
 {
  "requestId": "req_<UUID>",
  "occurredAt": "<TIMESTAMP>",
  "routeId": "oc-paid-route",
  "providerId": "oc-paid",
  "model": "paid-model",
  "routingMode": "direct",
  "outcome": "ok",
  "latencyMs":<MS>,
  "attempts": 1,
  "promptTokens": 5,
  "completionTokens": 6
 },
 {
  "requestId": "req_<UUID>",
  "occurredAt": "<TIMESTAMP>",
  "routeId": "oc-paid-route",
  "providerId": "oc-paid",
  "model": "paid-model",
  "routingMode": "direct",
  "outcome": "ok",
  "latencyMs":<MS>,
  "attempts": 1,
  "promptTokens": 5,
  "completionTokens": 6
 },
 {
  "requestId": "req_<UUID>",
  "occurredAt": "<TIMESTAMP>",
  "model": "paid-model",
  "routingMode": "direct",
  "outcome": "failed",
  "failureCategory": "unknown_error",
  "latencyMs":<MS>,
  "attempts": 0
 },
 {
  "requestId": "req_<UUID>",
  "occurredAt": "<TIMESTAMP>",
  "model": "paid-model",
  "routingMode": "direct",
  "outcome": "failed",
  "failureCategory": "unknown_error",
  "latencyMs":<MS>,
  "attempts": 0
 },
 {
  "requestId": "req_<UUID>",
  "occurredAt": "<TIMESTAMP>",
  "model": "paid-model",
  "routingMode": "direct",
  "outcome": "failed",
  "failureCategory": "unknown_error",
  "latencyMs":<MS>,
  "attempts": 0
 }
]
```
