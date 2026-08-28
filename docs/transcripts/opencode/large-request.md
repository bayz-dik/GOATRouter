# OpenCode → BAYZ — large-request

Captured by `scripts/verify-opencode.mjs` against the real `opencode` binary
(v1.18.23) and a real BAYZ listener. Secrets are redacted by name; ports, temp
paths, UUIDs, and timings are normalised so a re-run reproduces these bytes.

## Prompt size (characters)

```text
38000
```

## Largest upstream request body (bytes)

```text
67447
```

## Client stdout

```text
BAYZ-OK
```

## Client stderr

```text

> build · probe-model
```

## Client exit

```text
code=0 signal=null
```

## BAYZ usage rows

```json
[
 {
  "requestId": "req_<UUID>",
  "occurredAt": "<TIMESTAMP>",
  "routeId": "oc-route",
  "providerId": "oc-origin",
  "model": "probe-model",
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
  "routeId": "oc-route",
  "providerId": "oc-origin",
  "model": "probe-model",
  "routingMode": "direct",
  "outcome": "ok",
  "latencyMs":<MS>,
  "attempts": 1,
  "promptTokens": 5,
  "completionTokens": 6
 }
]
```
