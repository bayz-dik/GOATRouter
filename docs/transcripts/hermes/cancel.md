# Hermes Agent → BAYZ — cancel

Captured by `scripts/verify-hermes.mjs` against the real `hermes` binary (v0.20.5) and a
real BAYZ listener, in a throwaway `HERMES_HOME` so the operator's live configuration was
never read or written. Secrets are redacted by name; ports, temp paths, UUIDs, and timings
are normalised so a re-run reproduces these bytes.

## How the client was cancelled

```text
SIGINT to the real hermes process once a request was in flight upstream
```

## Client exit

```text
code=130 signal=null
```

## Client stderr

(empty)

## Upstream requests started

```text
1
```

## Upstream sockets destroyed before a response completed

```text
1
```
