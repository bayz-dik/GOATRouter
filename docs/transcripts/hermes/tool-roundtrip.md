# Hermes Agent → BAYZ — tool-roundtrip

Captured by `scripts/verify-hermes.mjs` against the real `hermes` binary (v0.20.5) and a
real BAYZ listener, in a throwaway `HERMES_HOME` so the operator's live configuration was
never read or written. Secrets are redacted by name; ports, temp paths, UUIDs, and timings
are normalised so a re-run reproduces these bytes.

## Prompt

```text
Use the terminal tool to run: echo BAYZ-TOOL-RAN
```

## Client stdout

```text
TOOL-ROUNDTRIP-COMPLETE
```

## Client stderr

(empty)

## Client exit

```text
code=0 signal=null
```

## Tool definitions the client advertised on the last turn

```text
2
```

## The tool result message the client sent back

```json
{
 "role": "tool",
 "content": "{\"output\": \"BAYZ-TOOL-RAN\", \"exit_code\": 0, \"error\": null}",
 "tool_call_id": "call_verify_1"
}
```

## Upstream chat requests

```text
2
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
 },
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
  "promptTokens": 7,
  "completionTokens": 3
 }
]
```
