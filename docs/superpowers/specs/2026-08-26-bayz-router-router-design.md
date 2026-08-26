# Bayz Router — Router Design (Phase 5)

Status: Accepted · Date: 2026-08-26 · Predecessors: Phase 2 Fortress, Phase 3 Provider Manager, Phase 4 Proxy Manager

## 1. Goal

Give Bayz its own request path: an OpenAI-compatible chat-completions client that
selects a provider for a requested model, attaches the provider credential,
routes through a proxy when one is bound, and returns a normalized response.
This is what closes the Phase 4 `fetch` gap — the router owns the socket, so it
can honor a proxy.

## 2. Non-goals

- No combos (multi-provider fan-out / merge). That is its own phase.
- No usage accounting or persistence of request bodies. Prompts are the most
  sensitive data in the system; Phase 5 stores none of them.
- No HTTP route and no dashboard control. The router is a library API, like the
  managers before it.
- No streaming (SSE) in this phase. A correct streaming implementation needs
  incremental parsing plus cancellation semantics, and shipping a half-verified
  version would be worse than not shipping it. The design reserves the seam.
- No automatic retry across providers on a *content* error — only on transport
  and rate-limit failures, where retrying is semantically safe.

## 3. Package layout

```text
packages/storage/
  src/migrations.ts        MODIFY: migration v4 adds `routes`
  test/migrations.test.ts  MODIFY: pin v4, keep the remaining bans
packages/router/
  package.json             NEW (@bayz/router; deps: security, storage, providers, proxy)
  tsconfig.json            NEW
  src/errors.ts            NEW: RouterError, fixed messages, cause discarded
  src/model.ts             NEW: model-name validation and pattern matching
  src/repository.ts        NEW: route registry CRUD
  src/request.ts           NEW: strict chat-request validation
  src/response.ts          NEW: strict upstream-response normalization
  src/transport.ts         NEW: request path over node:http/https (+ proxy agent)
  src/router.ts            NEW: createRouter
  src/index.ts             NEW
  test/*.test.ts           NEW: model, repository, request, response, transport,
                                router, adversarial
scripts/router-smoke.mjs   NEW (non-mocked: real origin + real CONNECT proxy)
```

## 4. Route registry

Migration v4 adds exactly one table:

```sql
CREATE TABLE routes (
  id          TEXT PRIMARY KEY,
  model       TEXT    NOT NULL,
  provider_id TEXT    NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  proxy_id    TEXT             REFERENCES proxies(id) ON DELETE SET NULL,
  priority    INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 1000),
  enabled     INTEGER NOT NULL CHECK (enabled IN (0,1)),
  config_json TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
)
```

Foreign keys are already enforced (`PRAGMA foreign_keys = ON` since Phase 2), so
a route cannot name a provider that does not exist. `ON DELETE CASCADE` on the
provider means deleting a provider removes its routes rather than leaving
dangling ones; `ON DELETE SET NULL` on the proxy means deleting a proxy degrades
routes to direct rather than silently breaking them. A unique index on
`(model, provider_id)` prevents duplicate bindings for the same pair.

`model` is a pattern: either an exact model id or a single trailing-`*` prefix
(`gpt-4*`). No general globbing and no regex — an operator-supplied regex is a
denial-of-service surface, and the wildcard covers the real use case.

## 5. Selection

`selectRoute(model)` picks among enabled routes whose pattern matches, ordered by:

1. exact match before wildcard match (specificity beats configuration order),
2. then higher `priority`,
3. then lower `id` lexicographically, so selection is deterministic and
   reproducible rather than dependent on row order.

`resolveRoutes(model)` returns the full ordered candidate list, which is what
failover walks. A model with no enabled matching route is `no_route`, distinct
from `provider_not_found` — the operator's next action differs.

## 6. Request validation

`parseChatRequest(input)` accepts exactly: `model` (validated model id),
`messages` (1–256 entries, each `{ role: "system"|"user"|"assistant", content:
string }` with content 1–128000 chars), and optionally `temperature` (0–2),
`maxTokens` (1–128000), `topP` (0–1), `stop` (≤4 strings of ≤64 chars each).
Unknown keys are rejected, prototypes must be plain, and the total serialized
body is capped at 1 MiB. Rejecting unknown keys is what prevents a caller from
smuggling `stream: true` or provider-specific fields the router has not verified.

## 7. Response normalization

`parseChatResponse(body)` requires `choices[0].message.content` to be a string
and caps the returned content at 512 KiB. `usage` is accepted only when every
present field is a non-negative integer; a malformed `usage` yields `undefined`
rather than failing the whole response, because token counts are informational
while content is not. Everything else in the upstream body is discarded — an
upstream cannot inject fields into a Bayz response object.

## 8. Transport

`sendChatRequest` performs a POST over `node:https`/`node:http` with:

- `Authorization: Bearer <credential>` for the OpenAI-compatible family, or
  `x-goog-api-key` for Gemini — same rules as Phase 3 discovery, never in a URL.
- The proxy agent from `ProxyManager.agentFor(proxyId)` when the route binds one.
  This is the whole point of Phase 5: because the router uses `node:http`, the
  Phase 4 agent works and a request genuinely traverses the proxy.
- A hard response byte cap (2 MiB default), a request timeout from the provider
  config, and `JSON.parse` exactly once on strict UTF-8.
- Status mapping identical to Phase 3: 401/403 → `auth_failed`, 429 →
  `rate_limited`, other ≥400 → `upstream_error`, transport failure →
  `unreachable`. No upstream body reaches an error message.

## 9. Failover

`chat(request)` walks the candidate routes in order. It advances to the next
candidate only on `unreachable`, `rate_limited`, or `upstream_error` — a
transport-class failure where another provider may legitimately succeed. It stops
immediately on `auth_failed` (a credential problem the operator must fix, and
retrying elsewhere would mask it), `credential_missing`, and on any validation
error. If every candidate fails, the last failure is raised with its own code, not
a generic one.

Each attempt is logged through `redactSecrets` with the route id, provider id,
whether a proxy was used, latency, and outcome — never a prompt, never a
completion, never a credential.

## 10. Threat-model notes

- Prompts and completions are never persisted and never logged. The router's log
  records metadata only.
- Model names reach a URL path, so they are slug-validated before use.
- Route patterns are prefix-only; no operator input becomes a regex.
- Response size caps bound memory against a hostile or misbehaving upstream.
- The credential read path stays inside `ProviderManager`; the router asks the
  manager to send, it does not fetch a key. Concretely: `ProviderManager` gains a
  `withCredential(id, fn)` scoped-use method rather than a getter, so the source
  scan that forbids `getCredential` still holds.

## 11. Verification

Per-task RED→GREEN, then the phase gate: `npm run runtime:test`,
`npm run runtime:verify`, `node --test tests/runtime-structure.test.mjs`, all four
smoke scripts, a secret scan, and `git diff --check`. `router-smoke.mjs` proves a
real chat request completing both directly and through a real `CONNECT` proxy,
with prompt text absent from the database and from all logs.
