# Bayz Router — Provider Manager Design (Phase 3)

Status: Accepted · Date: 2026-08-26 · Predecessor: Phase 2 Fortress (`2026-08-26-bayz-router-security-sqlite-design.md`, Revision 2)

## 1. Goal

Add provider registration, encrypted per-provider API-key custody, and untrusted
model discovery behind a `ProviderManager` boundary — without exposing any
credential read path, without touching the dashboard or `/api/health`, and
without any new dependency. Routing, proxying, combos, and usage remain out of
scope.

## 2. Non-goals

- No routing, proxies, routes, combos, usage tables, or HTTP routes for providers.
- No OAuth flow for `codex-oauth` (needs external account; deferred honestly).
- No zod or other validator dependency: validation is hand-rolled and typed,
  preserving the Termux/ARM64 zero-native-and-zero-extra-dependency rule.
  (Deviation from earlier sketch wording that said "zod": mechanism changes,
  guarantees do not — unknown keys still rejected, ranges still enforced.)
- No dashboard change. No change to `/api/health`.

## 3. Package layout

```text
packages/storage/
  src/errors.ts        MODIFY: + "invalid_argument" code
  src/scoped.ts        NEW:    scopedSecretStorage views over SecretStorage
  test/scoped.test.ts  NEW
packages/providers/
  package.json         NEW (@bayz/providers; deps: @bayz/storage only)
  tsconfig.json        NEW
  src/errors.ts        NEW: ProviderError (fixed messages, cause discarded)
  src/url.ts           NEW: normalizeBaseUrl
  src/config.ts        NEW: parseProviderConfig + kind defaults
  src/http.ts          NEW: capped fetch gateway (fetcher seam)
  src/discovery-openai.ts   NEW
  src/discovery-gemini.ts   NEW (OpenRouter reuses the OpenAI path)
  src/manager.ts       NEW: createProviderManager
  src/index.ts         NEW
  test/validation.test.ts, test/repository.test.ts, test/http-gateway.test.ts,
  test/discovery-openai.test.ts, test/discovery-gemini.test.ts,
  test/manager.test.ts, test/adversarial.test.ts
scripts/provider-smoke.mjs   NEW (non-mocked proof: real DB + real local HTTP)
```

## 4. Scoped secret views

`scopedSecretStorage(storage, scope)` returns a narrow view over
`SecretStorage`; `scope` is one segment or an ordered list of segments.

- Segment regex: `^[a-z0-9][a-z0-9-]{0,62}$`; field regex:
  `^[a-z0-9][a-z0-9._-]{0,62}$`; both additionally reject any `".."` substring;
  `":"` is impossible in both by construction.
- Physical secret name = `[...segments, field].join(":")`. Provider keys are
  stored as `provider:<providerId>:api_key`.
- View surface: `put/get/find/list/delete` on fields only; `list()` filters to
  the scope prefix and reports field-only names. Rotation stays a whole-storage
  concern and is deliberately absent from the view.
- Violations throw `StorageError("invalid_argument", stage)` — a new code added
  to `StorageErrorCode` with the usual fixed-message table.
- Isolation is two-way and tested: two scopes sharing a field name never see
  each other's values; deleting in one scope cannot touch the other.
- Corruption stays fail-closed: a tampered record under a scoped name throws
  `secret_corrupt`; it is never reported as absent or as empty.

## 5. Provider identity and registry

Migration v2 adds the only new table:

```sql
CREATE TABLE providers (
  id           TEXT PRIMARY KEY,
  kind         TEXT    NOT NULL CHECK (kind IN
               ('openai-compatible','openrouter','gemini','codex-oauth')),
  display_name TEXT    NOT NULL,
  base_url     TEXT    NOT NULL,
  enabled      INTEGER NOT NULL CHECK (enabled IN (0,1)),
  config_json  TEXT    NOT NULL,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
)
```

No credential column may ever appear here; credentials live only inside the
envelope-encrypted `secrets` table under scoped names. The Phase 2 test pinning
"no providers table" is updated: `providers` becomes the pinned v2 table while
the bans on `proxies`, `routes`, `routing`, `combos`, `usage`, `requests`,
`logs`, `clients` stand.

Provider id: `^[a-z0-9][a-z0-9-]{0,62}$` (same alphabet as a scope segment).
Violations are `ProviderError("invalid_provider_id")` **before** any SQL runs.

## 6. Errors

`ProviderError` mirrors `StorageError`: fixed caller-independent message table,
optional `stage`, original throw discarded (never attached as `cause`). Codes:

`invalid_provider_id`, `invalid_provider_config`, `provider_already_exists`,
`provider_not_found`, `credential_missing`, `unsupported_operation`,
`unreachable`, `auth_failed`, `rate_limited`, `upstream_error`,
`discovery_failed`.

Because the SQLite driver already translates every statement throw into
`storage_unavailable`, the repository never relies on driver error codes: it
pre-checks existence with `SELECT` and validates every CHECK-constrained field
client-side, so constraint violations are backstops, not control flow.

## 7. URL normalization

`normalizeBaseUrl(raw)`: must parse as absolute http(s); userinfo (`user:pass@`)
rejected; query and fragment stripped; scheme and host lowercased (URL does
this); trailing slashes trimmed; final string capped at 2048 chars. Any failure
is `invalid_provider_config`. Raw input is never echoed into the message.

Kind defaults when `baseUrl` omitted: `openrouter` → `https://openrouter.ai/api`;
everything else requires an explicit base URL (local servers differ too much).

## 8. Strict config

Accepted keys exactly: `timeoutMs` (int 1000–120000, default 30000),
`discoveryPath` (path-only `^\/[A-Za-z0-9._~!$&'()*+,;=:@%-]*$`, no `".."`,
default `/v1/models`; Gemini kind default `/v1beta/models`), `modelLimit`
(int 1–500, default 100). Unknown keys rejected (`invalid_provider_config`),
which structurally makes header-smuggling config impossible — no key that could
carry an `Authorization`-like value parses. Config is persisted as validated JSON
in `config_json` and re-validated on read; corruption there surfaces as
`invalid_provider_config` (stage `load-config`).

## 9. Upstream HTTP gateway

`fetchCapped({ url, method, headers, body, timeoutMs, maxBytes, fetcher })`
where `fetcher: typeof fetch = fetch` is injected (tests pass fakes; production
passes global `fetch`). `AbortSignal.timeout(timeoutMs)` bounds every request;
the response body is streamed through a hard byte cap (`maxBytes`, default
64 KiB) and overflow aborts mid-stream. Timeout/network failures map to
`unreachable`; callers choose whether oversized bodies and bad JSON surface as
`upstream_error` (gateway default) or `discovery_failed` (discovery paths).
No error message ever contains upstream response bytes, raw URLs of peers, or
header values.

## 10. Untrusted discovery

Discovery responses are attacker-controlled whenever a base URL points anywhere
but loopback. Rules:

- Body decoded as strict UTF-8, parsed once with `JSON.parse`.
- Top level must be an array or `{ data: [...] }` (OpenAI family) /
  `{ models: [...] }` (Gemini); anything else is `discovery_failed`.
- Entries that are not objects, or whose `id` (Gemini: `name` minus a leading
  `models/`) fails `^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$`, are
  skipped — one malformed entry cannot poison or block the rest.
- Result capped at `min(modelLimit, 500)` unique ids, order-preserving.
- Status mapping: 401/403 → `auth_failed`; 429 → `rate_limited`; other ≥400 →
  `upstream_error`; all with fixed messages.
- Auth: OpenAI family sends `Authorization: Bearer <key>` when a credential is
  present; Gemini sends `x-goog-api-key` — never a query parameter. When no
  credential is present, `openai-compatible` proceeds unauthenticated (local
  runtimes on Termux), while `gemini` and `openrouter` fail fast with
  `credential_missing` before any network I/O.
- `codex-oauth`: creation succeeds, but `setCredential`, `discoverModels`
  throw `unsupported_operation`; `hasCredential`/`deleteCredential` remain pure
  storage queries and answer honestly.

## 11. ProviderManager

Factory `createProviderManager({ db, storage, fetcher?, clock? })`. Public
surface: `createProvider`, `getProvider`, `listProviders`, `updateProvider`,
`deleteProvider`, `setEnabled` (via `updateProvider`), `setCredential`,
`hasCredential`, `credentialPresent`, `deleteCredential`, `discoverModels`,
`close`. There is deliberately **no** `getCredential`: plaintext leaves the
manager only toward the upstream gateway, never to callers. An executable
source-scan test enforces the absence of the string `getCredential` in
`src/`.

`deleteProvider` removes the row and best-effort deletes the scoped credential.
`hasCredential` decrypts, so a tampered credential throws `secret_corrupt`
instead of reporting `false`.

## 12. Threat-model notes

- Credential exposure ceiling unchanged from Phase 2: root-read of `bayz.db`
  yields envelopes, never keys; KEK custody rules apply untouched.
- SSRF posture: discovery goes only to the admin-configured normalized base URL
  plus a constrained path; no redirect following is enabled beyond fetch
  defaults, bodies are size-capped and never echoed, timeouts bound hangs.
- SQL injection: ids/fields are regex-constrained before SQL; statements are
  parameterized throughout.
- Log hygiene: manager logs go through `redactSecrets`; only ids, kinds, and
  counts are logged.

## 13. Verification

Per-task RED→GREEN with `node --import tsx --test`, workspace suites, `tsc
--noEmit` builds, then the phase gate: `npm run runtime:test`,
`npm run runtime:verify`, `node --test tests/runtime-structure.test.mjs`,
`node scripts/storage-smoke.mjs`, `node scripts/provider-smoke.mjs`,
`git diff --check`.
