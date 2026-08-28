# OpenCode → BAYZ — cancel

Captured by `scripts/verify-opencode.mjs` against the real `opencode` binary
(v1.18.23) and a real BAYZ listener. Secrets are redacted by name; ports, temp
paths, UUIDs, and timings are normalised so a re-run reproduces these bytes.

## How the client was cancelled

```text
SIGINT to the real opencode process once a request was in flight upstream
```

## Client exit

```text
code=null signal=SIGINT
```

## Client stderr

```text

> build · probe-model
```

## Upstream requests started

```text
1
```

## Upstream sockets destroyed before a response completed

```text
1
```
