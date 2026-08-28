# Hermes Agent → BAYZ — large-request

Captured by `scripts/verify-hermes.mjs` against the real `hermes` binary (v0.20.5) and a
real BAYZ listener, in a throwaway `HERMES_HOME` so the operator's live configuration was
never read or written. Secrets are redacted by name; ports, temp paths, UUIDs, and timings
are normalised so a re-run reproduces these bytes.

## Prompt size (characters)

```text
38000
```

## Largest upstream request body (bytes)

```text
95047
```

## Client stdout

```text
BAYZ-OK
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
  "routeId": "hm-route",
  "providerId": "hm-origin",
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
