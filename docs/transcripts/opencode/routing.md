# OpenCode → BAYZ — routing

Captured by `scripts/verify-opencode.mjs` against the real `opencode` binary
(v1.18.23) and a real BAYZ listener. Secrets are redacted by name; ports, temp
paths, UUIDs, and timings are normalised so a re-run reproduces these bytes.

## Custom openai-compatible provider — client stdout

```text
BAYZ-OK
```

## Proxy-bound route — CONNECT authorities the proxy logged

```json
[
 {
  "authority": "127.0.0.1:<PORT>",
  "port": 40995
 },
 {
  "authority": "127.0.0.1:<PORT>",
  "port": 40995
 }
]
```

## Proxy-bound route — client exit

```text
code=0
```

## Combo — client stdout

```text
BAYZ-OK
```

## Combo — client exit

```text
code=0
```

## Failover (primary origin killed) — client stdout

```text
BAYZ-SECONDARY
```

## Failover — client exit

```text
code=0
```

## BAYZ usage rows (routingMode / attempts are the evidence)

```json
[
 {
  "requestId": "req_<UUID>",
  "occurredAt": "<TIMESTAMP>",
  "routeId": "oc-route-secondary",
  "providerId": "oc-secondary",
  "model": "probe-model",
  "routingMode": "failover",
  "outcome": "ok",
  "latencyMs":<MS>,
  "attempts": 2,
  "promptTokens": 5,
  "completionTokens": 6
 },
 {
  "requestId": "req_<UUID>",
  "occurredAt": "<TIMESTAMP>",
  "routeId": "oc-route-secondary",
  "providerId": "oc-secondary",
  "model": "probe-model",
  "routingMode": "failover",
  "outcome": "ok",
  "latencyMs":<MS>,
  "attempts": 2,
  "promptTokens": 5,
  "completionTokens": 6
 },
 {
  "requestId": "req_<UUID>",
  "occurredAt": "<TIMESTAMP>",
  "routeId": "oc-route",
  "providerId": "oc-origin",
  "model": "probe-model",
  "routingMode": "combo",
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
  "routingMode": "combo",
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
  "proxyId": "oc-proxy",
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
  "proxyId": "oc-proxy",
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
