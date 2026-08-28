# OpenCode → BAYZ — restart-reconnect

Captured by `scripts/verify-opencode.mjs` against the real `opencode` binary
(v1.18.23) and a real BAYZ listener. Secrets are redacted by name; ports, temp
paths, UUIDs, and timings are normalised so a re-run reproduces these bytes.

## Before restart — client stdout

```text
BAYZ-OK
```

## Before restart — client exit

```text
code=0
```

## Restart

```text
BAYZ closed and restarted on the same port with the same SQLite data directory; the client config was not touched
```

## After restart — client stdout

```text
BAYZ-OK
```

## After restart — client exit

```text
code=0
```

## BAYZ usage rows after restart

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
