# Bayz Router — Local HTTP API Design (Phase 6)

Status: Accepted · Date: 2026-08-26 · Predecessors: Phases 1–5

## 1. Goal

Expose the Provider, Proxy, and Router managers over an authenticated local HTTP
API, plus an OpenAI-compatible `POST /v1/chat/completions`. This is the first
phase that puts any of this behind a network listener, so authentication and
binding are the central concerns, not an afterthought.

## 2. Non-goals

- No public/remote exposure by default. The listener stays on `127.0.0.1` unless
  `BAYZ_ALLOW_REMOTE` is set, and setting it without a token is a startup error.
- No streaming endpoint. Phase 5 does not implement SSE, so `stream: true` is
  rejected with a clear error rather than accepted and quietly ignored.
- No combos, no usage endpoints, no dashboard change. The dashboard continues to
  be served as static files exactly as Phase 1 built it.
- No cookie/session auth, no user accounts, no OAuth. A single local operator
  token is the correct scope for a localhost daemon; anything more would be
  security theatre with more attack surface.
- No credential read endpoint. There is no route that returns a provider key or a
  proxy password, in any form.

## 3. Authentication

A bearer token, held in the existing encrypted store under the secret name
`api:token`.

- `BAYZ_API_TOKEN` in the environment takes precedence when set, for
  container/systemd use where the operator manages secrets externally.
- Otherwise, on first start the server generates a 32-byte random token, stores
  it, and prints it **once** to stdout with an explicit "shown only once" notice.
  It is never logged again and never returned by any endpoint.
- Comparison uses `timingSafeEqual` on fixed-length SHA-256 digests, so neither
  length nor content leaks through timing.
- Every `/api/*` and `/v1/*` route requires the token. Missing or malformed →
  `401`; wrong → `401` with the identical body, so an attacker cannot distinguish
  "no token" from "wrong token".
- `GET /api/health` stays **unauthenticated and byte-identical** to Phase 1
  (`{status, version, uptimeSeconds}`). It is the one deliberate exception: it is
  a liveness probe that reveals nothing, and a regression test pins its shape.

Rate limiting: a fixed-window counter per remote address (default 120 requests /
minute, 10 for failed auth) implemented in-process with no dependency. Exceeding
it yields `429`. This is a brute-force brake, not a DDoS defence, and the README
will say so.

## 4. Routes

```text
GET    /api/health                      (unauthenticated, unchanged)
GET    /api/status                      runtime + storage summary, no key material

GET    /api/providers                   list (credentialPresent only)
POST   /api/providers                   create
GET    /api/providers/:id               fetch
PATCH  /api/providers/:id               update
DELETE /api/providers/:id               delete
PUT    /api/providers/:id/credential    set (write-only)
DELETE /api/providers/:id/credential    clear
POST   /api/providers/:id/discover      model discovery

GET    /api/proxies                     list (passwordPresent only)
POST   /api/proxies                     create
GET    /api/proxies/:id                 fetch
PATCH  /api/proxies/:id                 update
DELETE /api/proxies/:id                 delete
PUT    /api/proxies/:id/password        set (write-only)
DELETE /api/proxies/:id/password        clear
POST   /api/proxies/:id/check           reachability check

GET    /api/routes                      list
POST   /api/routes                      create
GET    /api/routes/:id                  fetch
PATCH  /api/routes/:id                  update
DELETE /api/routes/:id                  delete

POST   /v1/chat/completions             OpenAI-compatible chat
GET    /v1/models                       models across enabled routes
```

Nothing else. No `PUT /api/providers` bulk import, no debug endpoint, no
`/api/secrets`.

## 5. Error envelope

Phase 1 already established `{ error: { code, message }, requestId }`. Phase 6
maps domain codes to status without inventing new prose:

- `invalid_*`, `no_route` → `400`
- auth failure → `401`
- `forbidden` → `403`
- `*_not_found` → `404`
- `*_already_exists` → `409`
- `rate_limited` → `429`
- `unsupported_operation` → `501`
- `unreachable`, `upstream_error`, `auth_failed` (upstream), `proxy_error` → `502`
- `timeout` → `504`
- anything unrecognized → `500` with a generic message

The message is always the domain error's fixed text. Since every error class in
Phases 2–5 already refuses to interpolate secrets or upstream bodies, this mapping
cannot leak by construction — and a test asserts no response body contains a
stored credential.

## 6. Request handling

- Body limit 1 MiB (matching the router's own cap), enforced by Fastify.
- `content-type: application/json` required for bodies; anything else → `415`.
- Path parameters are validated by the same id validators the managers use, before
  any storage call.
- No CORS headers are emitted. A browser on another origin must not be able to
  drive a localhost daemon, and permissive CORS on `127.0.0.1` is exactly how
  local-daemon CSRF happens.
- `PUT .../credential` and `PUT .../password` accept `{ value: string }` and
  return `204` with no body. Write-only by construction.

## 7. Threat-model notes

- Loopback default plus mandatory token means a stolen `bayz.db` is still the main
  exposure, unchanged from Phase 2.
- The token is a secret with the same custody as any provider key: envelope
  encrypted, no read endpoint, printed once at generation.
- Timing-safe comparison on digests avoids both length and content oracles.
- Rate limiting bounds offline-style brute force against the token.
- No CORS, no cookies, so no ambient-authority browser attack path.
- Prompts remain unpersisted; the API adds no request log containing bodies.

## 8. Verification

Per-task RED→GREEN. The phase gate adds `scripts/api-smoke.mjs`: a real server on
a free port, real HTTP requests, proving 401 without a token, 200 with it,
byte-identical `/api/health`, a full provider→route→chat flow against a real
loopback origin, absence of any credential in every response body, and that
`/v1/chat/completions` rejects `stream: true`.
