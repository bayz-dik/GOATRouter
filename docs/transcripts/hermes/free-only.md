# Hermes Agent → BAYZ — free-only

Captured by `scripts/verify-hermes.mjs` against the real `hermes` binary (v0.20.5) and a
real BAYZ listener, in a throwaway `HERMES_HOME` so the operator's live configuration was
never read or written. Secrets are redacted by name; ports, temp paths, UUIDs, and timings
are normalised so a re-run reproduces these bytes.

## Provider classification

```text
catalogue publish status=200; the origin publishes real pricing metadata over a non-loopback address, so its model classifies PAID
```

## Route as created (no freeOnly field was sent)

```json
{
 "id": "hm-paid-route",
 "model": "paid-model",
 "providerId": "hm-paid",
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

## Real client against the free-only route — stdout

```text
HTTP 409: no_free_route: no free model was available and this route may not spend money (stage: chat-stream-free-only)
```

## Real client against the free-only route — exit

```text
code=0
```

## Upstream chat requests the PAID origin received

```text
0
```

## After an explicit freeOnly:false opt-out — client stdout

```text
BAYZ-OK
```

## Upstream chat requests after the opt-out

```text
1
```

## BAYZ usage rows

```json
[
 {
  "requestId": "req_<UUID>",
  "occurredAt": "<TIMESTAMP>",
  "routeId": "hm-paid-route",
  "providerId": "hm-paid",
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
 }
]
```
