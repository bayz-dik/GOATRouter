# Hermes Agent → BAYZ — routing

Captured by `scripts/verify-hermes.mjs` against the real `hermes` binary (v0.20.5) and a
real BAYZ listener, in a throwaway `HERMES_HOME` so the operator's live configuration was
never read or written. Secrets are redacted by name; ports, temp paths, UUIDs, and timings
are normalised so a re-run reproduces these bytes.

## Custom openai-compatible provider — client stdout

```text
BAYZ-OK
```

## Proxy-bound route — CONNECT authorities the proxy logged

```json
[
 {
  "authority": "127.0.0.1:<PORT>",
  "port": 41809
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

## Failover (primary origin killed) — client stdout

```text
BAYZ-SECONDARY
```

## BAYZ usage rows (routingMode / attempts are the evidence)

```json
[
 {
  "requestId": "req_<UUID>",
  "occurredAt": "<TIMESTAMP>",
  "routeId": "hm-route-secondary",
  "providerId": "hm-secondary",
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
  "routeId": "hm-route",
  "providerId": "hm-origin",
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
  "routeId": "hm-route",
  "providerId": "hm-origin",
  "proxyId": "hm-proxy",
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
