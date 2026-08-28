# OpenCode → BAYZ — tool-roundtrip

Captured by `scripts/verify-opencode.mjs` against the real `opencode` binary
(v1.18.23) and a real BAYZ listener. Secrets are redacted by name; ports, temp
paths, UUIDs, and timings are normalised so a re-run reproduces these bytes.

## Prompt

```text
Run the bash tool with: echo BAYZ-TOOL-RAN
```

## Client stdout

```text
TOOL-ROUNDTRIP-COMPLETE
```

## Client stderr (tool execution is echoed here)

```text

> build · probe-model

$ echo BAYZ-TOOL-RAN
BAYZ-TOOL-RAN
```

## Client exit

```text
code=0 signal=null
```

## Tool count the client advertised

```text
9
```

## The tool result message the client sent back

```json
{
 "role": "tool",
 "content": "BAYZ-TOOL-RAN\n",
 "tool_call_id": "call_verify_1"
}
```

## Upstream chat requests

```text
3
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
  "promptTokens": 7,
  "completionTokens": 3
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
