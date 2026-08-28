# Hermes Agent → BAYZ — error-surface-and-keys

Captured by `scripts/verify-hermes.mjs` against the real `hermes` binary (v0.20.5) and a
real BAYZ listener, in a throwaway `HERMES_HOME` so the operator's live configuration was
never read or written. Secrets are redacted by name; ports, temp paths, UUIDs, and timings
are normalised so a re-run reproduces these bytes.

## Unroutable model — client stdout

```text
HTTP 400: no_route: no enabled route matches the requested model (stage: chat-stream-select)
```

## Unroutable model — client stderr

(empty)

## Unroutable model — client exit

```text
code=0
```

## Rotation — management API status

```text
200
```

## Superseded key — client stdout

```text
HTTP 401: A valid API token is required
```

## Superseded key — client exit

```text
code=0
```

## Rotated key — client stdout

```text
BAYZ-OK
```

## Rotated key — client exit

```text
code=0
```

## Revocation — DELETE /api/identities/hermes status

```text
204
```

## After revocation — client stdout

```text
HTTP 401: A valid API token is required
```

## After revocation — client exit

```text
code=0
```
