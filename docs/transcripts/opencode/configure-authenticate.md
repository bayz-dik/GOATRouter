# OpenCode → BAYZ — configure-authenticate

Captured by `scripts/verify-opencode.mjs` against the real `opencode` binary
(v1.18.23) and a real BAYZ listener. Secrets are redacted by name; ports, temp
paths, UUIDs, and timings are normalised so a re-run reproduces these bytes.

## Client version

```text
1.18.23
```

## Configuration written (key redacted)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "bayz": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:<PORT>/v1",
        "apiKey": "<CLIENT-KEY-REDACTED>"
      },
      "models": {
        "probe-model": {
          "name": "probe-model"
        }
      }
    }
  },
  "model": "bayz/probe-model",
  "permission": {
    "bash": "allow",
    "edit": "allow",
    "webfetch": "deny"
  }
}
```

## opencode models bayz — stdout

```text
bayz/probe-model
```

## opencode models bayz — stderr

(empty)

## opencode run with a valid key — stdout

```text
BAYZ-OK
```

## opencode run with a valid key — exit

```text
code=0 signal=null
```

## opencode run with a corrupted key — stderr

```text

> build · probe-model

Error: A valid API token is required
```

## opencode run with a corrupted key — exit

```text
code=1 signal=null
```

## BAYZ gateway requests observed

```text
POST /v1/chat/completions
POST /v1/chat/completions
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
