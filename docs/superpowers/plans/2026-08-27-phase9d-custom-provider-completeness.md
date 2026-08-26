# Phase 9D — Custom Provider Production Completeness

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Spec:** `docs/superpowers/specs/2026-08-27-bayz-phase9-goat-release-design.md` §8

**Depends on:** nothing (parallel with 9C)

**Goal:** Custom providers as first-class, generic, and untrusted — safe custom headers, capability detection, connection testing, and a real SSRF egress policy.

**Locks:** No provider brand hardcoded beyond an icon key. Provider metadata never becomes markup or a remote dependency. `authorization`, `proxy-authorization`, and `host` can never be set by provider config.

**Migration numbering:** the spec's ledger (§4) labels this subprogram's migration v8, assuming 9C takes v6 and 9E takes v7 from the v5 baseline. 9D and 9E run in **parallel**, so if this migration lands before 9E's it takes v7 and 9E takes v8 — whichever lands second renumbers and updates both plan texts in the same commit. No test hardcodes the head version; every migration test reads the head from the migration table.

---

### Task 1 — SSRF egress policy

**Create:** `packages/providers/src/egress.ts`
**Test:** `packages/providers/test/egress.test.ts`

**Interface produced:**
```ts
export type EgressPolicy = { allowLoopback: boolean; allowPrivate: boolean };
export function assertEgressAllowed(hostname: string, policy: EgressPolicy): void;
export function assertResolvedAddressAllowed(address: string, policy: EgressPolicy): void;
```

- [ ] RED `egress.test.ts`: with the default policy (`allowLoopback:false, allowPrivate:false`), each of these is refused — `127.0.0.1`, `127.1`, `0.0.0.0`, `[::1]`, `localhost`, `169.254.169.254`, `169.254.1.1`, `[fe80::1]`, `10.0.0.1`, `172.16.0.1`, `172.31.255.255`, `192.168.1.1`, `[fc00::1]`, `100.64.0.1`, `224.0.0.1`, `metadata.google.internal`, `metadata.goog`, `instance-data`; `2001:db8::1` and `api.openai.com` are allowed; with `allowLoopback:true`, `127.0.0.1` and `[::1]` are allowed but `169.254.169.254` is **still refused** (metadata is never a local-runtime use case); decimal (`2130706433`), octal (`0177.0.0.1`), and hex (`0x7f.0.0.1`) encodings of loopback are all refused; `172.15.0.1` and `172.32.0.1` are allowed (boundary correctness).
- [ ] RED same file: `assertResolvedAddressAllowed` exists separately so the check can run **after** DNS resolution, immediately before connect, narrowing the rebinding window as far as Node permits. A comment states this is narrowing, not elimination.
- [ ] Verify RED: `node --import tsx --test packages/providers/test/egress.test.ts` fails with `ERR_MODULE_NOT_FOUND`.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/providers` exits 0.
- [ ] Commit — `feat: add Bayz provider egress policy`

### Task 2 — Safe custom headers

**Modify:** `packages/providers/src/config.ts`
**Test:** `packages/providers/test/custom-headers.test.ts`

**Config gains:** `headers?: Record<string,string>`, `allowLoopback?: boolean`

- [ ] RED `custom-headers.test.ts`: a header named `x-relay-token` with a printable value is accepted; the **denylist is enforced after the allowlist** and each of `authorization`, `Authorization`, `AUTHORIZATION`, `proxy-authorization`, `host`, `cookie`, `set-cookie`, `content-length`, `transfer-encoding`, `connection`, `upgrade`, `sec-fetch-mode`, `proxy-connection` is refused with `invalid_provider_config` — never silently dropped; a name outside `^[A-Za-z][A-Za-z0-9-]{0,63}$` is refused; a value containing CR, LF, NUL, or a non-ASCII byte is refused (header-injection guard); a value beyond 1024 chars is refused; more than 8 headers is refused; `headers: null` and `headers: []` are refused; a prototype-polluted header object is refused.
- [ ] RED same file: the existing three keys still work, and an unknown key is still refused, so the Phase 3 posture is preserved.
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/providers` exits 0; `node scripts/provider-smoke.mjs` still 36/36.
- [ ] Commit — `feat: allow safe custom provider headers`

### Task 3 — Custom provider kind and URL validation

**Modify:** `packages/providers/src/url.ts`, `packages/providers/src/repository.ts`
**Test:** `packages/providers/test/custom-provider.test.ts`

- [ ] RED `custom-provider.test.ts`: `PROVIDER_KINDS` gains `custom-openai` and keeps the existing four; a `custom-openai` provider requires an explicit base URL; the base URL runs through `assertEgressAllowed` at creation so a metadata-endpoint provider cannot be stored at all; `allowLoopback: true` permits a local runtime; a provider created before this change still loads (backward compatibility); the icon key for `custom-openai` resolves to `custom` in the local table, not to a remote asset.
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/providers` exits 0; `npm run test --workspace @bayz/storage` exits 0 (schema untouched — kind is a CHECK constraint, so migration v8 adds the value).
- [ ] Modify `packages/storage/src/migrations.ts`: migration v8 recreates the `providers` kind CHECK to include `custom-openai`, preserving rows. RED first in `packages/storage/test/migrations.test.ts`: the new kind inserts, an unknown kind still fails, and existing rows survive the migration.
- [ ] Commit — `feat: add the Bayz custom-openai provider kind`

### Task 4 — Header and egress enforcement in the HTTP path

**Modify:** `packages/providers/src/http.ts`, `packages/router/src/transport.ts`
**Test:** `packages/providers/test/egress-enforcement.test.ts`

- [ ] RED `egress-enforcement.test.ts` against real loopback servers: a provider configured with `allowLoopback: true` reaches a local origin; the same provider with the flag absent is refused **before any socket opens** (assert the origin observed zero connections); custom headers arrive at the origin exactly as configured; a configured header cannot override `authorization` — the credential header wins and the config value is absent; `redirect: "error"` is asserted on both the discovery path and the chat transport, and a `302` yields `unreachable` rather than following; the resolved-address check runs before connect.
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/providers` and `--workspace @bayz/router` exit 0; `node scripts/router-smoke.mjs` still 46/46.
- [ ] Commit — `feat: enforce Bayz egress policy and safe headers on the wire`

### Task 5 — Capability detection and test connection

**Create:** `packages/providers/src/capabilities.ts`
**Modify:** `packages/providers/src/manager.ts`
**Test:** `packages/providers/test/capabilities.test.ts`

**Interface produced:** `detectCapabilities(id): Promise<ProviderCapabilities>`, `testConnection(id): Promise<ConnectionResult>`

- [ ] RED `capabilities.test.ts`: `detectCapabilities` probes model discovery and reports `{ models: boolean; tools: "unknown"|"yes"|"no"; streaming: "unknown"|"yes"|"no" }` — **`unknown` is a real value**, because a discovery endpoint does not reveal tool support and guessing would be fabrication; `testConnection` returns `{ ok, latencyMs, modelCount }` on success and a fixed-code failure otherwise; a hostile 500 body never appears in the result; a 10,000-model discovery response is capped and reported as capped; a model name shaped for injection is skipped, not stored; results are not cached across a config change.
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/providers` exits 0.
- [ ] Commit — `feat: add Bayz provider capability detection and connection test`

### Task 6 — API and dashboard surface

**Modify:** `apps/server/src/routes/providers.ts`, `apps/dashboard/src/panels/ProvidersPanel.tsx`, `apps/dashboard/src/api/client.ts`
**Test:** `apps/server/test/custom-provider-api.test.ts`, `apps/dashboard/test/custom-provider-panel.test.tsx`

- [ ] RED `custom-provider-api.test.ts`: `POST /api/providers/:id/test` returns the connection result and requires `providers.write`; a denied header in the create body is `400` naming the header; a metadata-endpoint base URL is `400`; `allowLoopback` is accepted and persisted; the response carries no header **values** back (they are config, but echoing them widens the surface for no benefit).
- [ ] RED `custom-provider-panel.test.tsx`: the create form offers kind including `custom-openai`, a headers editor bounded to 8 rows, an explicit loopback opt-in checkbox with a warning, and a Test Connection button showing latency or an explicit failure code; a hostile header name shows an inline error; nothing renders a header value as markup.
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/server` and `--workspace @bayz/dashboard` exit 0; `node scripts/dashboard-smoke.mjs` exits 0.
- [ ] Commit — `feat: expose Bayz custom providers through the API and dashboard`

### Task 7 — Adversarial suite and custom-provider smoke

**Create:** `packages/providers/test/custom-adversarial.test.ts`, `scripts/custom-provider-smoke.mjs`

- [ ] RED `custom-adversarial.test.ts`: a provider-supplied icon descriptor that is markup, a URL, or a data URI resolves to the local generic mark (extending the Phase 7 rule to `custom-openai`); a 5 MiB discovery response is refused; a discovery payload with 50,000 models is capped at 500; a model name containing `<script>` is skipped; an error body containing a credential sentinel never reaches a stored row or a response; a hostile `Host` header cannot be injected through config; a provider whose base URL resolves to `169.254.169.254` is refused at connect even if DNS changed after creation.
- [ ] `scripts/custom-provider-smoke.mjs`: real listener; register a `custom-openai` relay against a real loopback origin with `allowLoopback: true` and a custom header; prove discovery, chat, and test-connection work; register a second provider targeting `169.254.169.254` and prove creation is refused; prove a denied header is refused; scan db/wal/shm/logs/responses for the credential and error-body sentinels.
- [ ] Verify: `node scripts/custom-provider-smoke.mjs` exits 0; `npm run runtime:verify` exits 0; `git diff --check` clean.
- [ ] Commit — `test: add Bayz custom provider adversarial suite and smoke`

## Completion checklist

- [ ] Egress policy refuses loopback, link-local, private, CGNAT, multicast, and metadata by default, including alternate IP encodings.
- [ ] Loopback is opt-in per provider; metadata is never allowed.
- [ ] Resolved-address re-check runs before connect; documented as narrowing, not eliminating, rebinding.
- [ ] Custom headers allowlisted then denylisted; a denied header is a 400.
- [ ] `authorization`, `proxy-authorization`, `host` unsettable from config.
- [ ] `custom-openai` kind added via migration v8 preserving existing rows.
- [ ] Capability detection reports `unknown` rather than guessing.
- [ ] Provider icon metadata still cannot become markup or a remote fetch.
