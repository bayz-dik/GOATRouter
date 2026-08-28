# OpenCode → BAYZ — error-surface-and-keys

Captured by `scripts/verify-opencode.mjs` against the real `opencode` binary
(v1.18.23) and a real BAYZ listener. Secrets are redacted by name; ports, temp
paths, UUIDs, and timings are normalised so a re-run reproduces these bytes.

## Unroutable model — client stderr

```text

> build · model-that-has-no-route

Error: no_route: no enabled route matches the requested model (stage: chat-stream-select)
```

## Unroutable model — client exit

```text
code=1
```

## Rotation — management API response status

```text
200
```

## After rotation, using the superseded key — client stderr

```text

> build · probe-model

Error: A valid API token is required
```

## After rotation, using the superseded key — client exit

```text
code=1
```

## After rotation, using the new key — client stdout

```text
BAYZ-OK
```

## After rotation, using the new key — client exit

```text
code=0
```

## Revocation — DELETE /api/identities/opencode status

```text
204
```

## After revocation — client stderr

```text

> build · probe-model

Error: A valid API token is required
```

## After revocation — client exit

```text
code=1
```
