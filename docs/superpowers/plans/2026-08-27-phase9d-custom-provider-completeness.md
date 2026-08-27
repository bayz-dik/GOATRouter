# Phase 9D — Custom Provider Production Completeness

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Spec:** `docs/superpowers/specs/2026-08-27-bayz-phase9-goat-release-design.md` §8

**Depends on:** nothing (parallel with 9C)

**Goal:** Custom providers as first-class, generic, and untrusted — safe custom headers, capability detection, connection testing, and a real SSRF egress policy.

**Locks:** No provider brand hardcoded beyond an icon key. Provider metadata never becomes markup or a remote dependency. `authorization`, `proxy-authorization`, and `host` can never be set by provider config.

**Migration numbering — SETTLED:** the spec's ledger (§4) provisionally labelled this subprogram's migration v8. **This migration landed first and is v7.** 9E's provider-proxy migration therefore becomes **v8**, and 9E's plan text is updated to match in the same commit. No test hardcodes the head version; every migration test reads the head from the migration table.

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

- [x] RED `egress.test.ts`: with the default policy (`allowLoopback:false, allowPrivate:false`), each of these is refused — `127.0.0.1`, `127.1`, `0.0.0.0`, `[::1]`, `localhost`, `169.254.169.254`, `169.254.1.1`, `[fe80::1]`, `10.0.0.1`, `172.16.0.1`, `172.31.255.255`, `192.168.1.1`, `[fc00::1]`, `100.64.0.1`, `224.0.0.1`, `metadata.google.internal`, `metadata.goog`, `instance-data`; `2001:db8::1` and `api.openai.com` are allowed; with `allowLoopback:true`, `127.0.0.1` and `[::1]` are allowed but `169.254.169.254` is **still refused** (metadata is never a local-runtime use case); decimal (`2130706433`), octal (`0177.0.0.1`), and hex (`0x7f.0.0.1`) encodings of loopback are all refused; `172.15.0.1` and `172.32.0.1` are allowed (boundary correctness).
- [x] RED same file: `assertResolvedAddressAllowed` exists separately so the check can run **after** DNS resolution, immediately before connect, narrowing the rebinding window as far as Node permits. A comment states this is narrowing, not elimination.
- [x] Verify RED: `node --import tsx --test packages/providers/test/egress.test.ts` fails with `ERR_MODULE_NOT_FOUND`.
- [x] GREEN.
- [x] Verify: `npm run test --workspace @bayz/providers` exits 0.
- [x] Commit — `feat: add Bayz provider egress policy`

### Task 2 — Safe custom headers

**Modify:** `packages/providers/src/config.ts`
**Test:** `packages/providers/test/custom-headers.test.ts`

**Config gains:** `headers?: Record<string,string>`, `allowLoopback?: boolean`

- [x] RED `custom-headers.test.ts`: a header named `x-relay-token` with a printable value is accepted; the **denylist is enforced after the allowlist** and each of `authorization`, `Authorization`, `AUTHORIZATION`, `proxy-authorization`, `host`, `cookie`, `set-cookie`, `content-length`, `transfer-encoding`, `connection`, `upgrade`, `sec-fetch-mode`, `proxy-connection` is refused with `invalid_provider_config` — never silently dropped; a name outside `^[A-Za-z][A-Za-z0-9-]{0,63}$` is refused; a value containing CR, LF, NUL, or a non-ASCII byte is refused (header-injection guard); a value beyond 1024 chars is refused; more than 8 headers is refused; `headers: null` and `headers: []` are refused; a prototype-polluted header object is refused.
- [x] RED same file: the existing three keys still work, and an unknown key is still refused, so the Phase 3 posture is preserved.
- [x] Verify RED.
- [x] GREEN.
- [x] Verify: `npm run test --workspace @bayz/providers` exits 0; `node scripts/provider-smoke.mjs` still 36/36.
- [x] Commit — `feat: allow safe custom provider headers`

### Task 3 — Custom provider kind and URL validation

**Modify:** `packages/providers/src/url.ts`, `packages/providers/src/repository.ts`
**Test:** `packages/providers/test/custom-provider.test.ts`

- [x] RED `custom-provider.test.ts`: `PROVIDER_KINDS` gains `custom-openai` and keeps the existing four; a `custom-openai` provider requires an explicit base URL; the base URL runs through `assertEgressAllowed` at creation so a metadata-endpoint provider cannot be stored at all; `allowLoopback: true` permits a local runtime; a provider created before this change still loads (backward compatibility); the icon key for `custom-openai` resolves to `custom` in the local table, not to a remote asset.
- [x] Verify RED.
- [x] GREEN.
- [x] Verify: `npm run test --workspace @bayz/providers` exits 0; `npm run test --workspace @bayz/storage` exits 0 (schema untouched — kind is a CHECK constraint, so migration v7 adds the value).
- [x] Modify `packages/storage/src/migrations.ts`: migration v7 recreates the `providers` kind CHECK to include `custom-openai`, preserving rows. RED first in `packages/storage/test/migrations.test.ts`: the new kind inserts, an unknown kind still fails, and existing rows survive the migration.
- [x] Commit — `feat: add the Bayz custom-openai provider kind`

### Task 4 — Header and egress enforcement in the HTTP path

**Modify:** `packages/providers/src/http.ts`, `packages/router/src/transport.ts`
**Test:** `packages/providers/test/egress-enforcement.test.ts`

- [x] RED `egress-enforcement.test.ts` against real loopback servers: a provider configured with `allowLoopback: true` reaches a local origin; the same provider with the flag absent is refused **before any socket opens** (assert the origin observed zero connections); custom headers arrive at the origin exactly as configured; a configured header cannot override `authorization` — the credential header wins and the config value is absent; `redirect: "error"` is asserted on both the discovery path and the chat transport, and a `302` yields `unreachable` rather than following; the resolved-address check runs before connect.
- [x] Verify RED.
- [x] GREEN.
- [x] Verify: `npm run test --workspace @bayz/providers` and `--workspace @bayz/router` exit 0; `node scripts/router-smoke.mjs` still 46/46.
- [x] Commit — `feat: enforce Bayz egress policy and safe headers on the wire`

### Task 5 — Capability detection and test connection

**Create:** `packages/providers/src/capabilities.ts`
**Modify:** `packages/providers/src/manager.ts`
**Test:** `packages/providers/test/capabilities.test.ts`

**Interface produced:** `detectCapabilities(id): Promise<ProviderCapabilities>`, `testConnection(id): Promise<ConnectionResult>`

- [x] RED `capabilities.test.ts`: `detectCapabilities` probes model discovery and reports `{ models: boolean; tools: "unknown"|"yes"|"no"; streaming: "unknown"|"yes"|"no" }` — **`unknown` is a real value**, because a discovery endpoint does not reveal tool support and guessing would be fabrication; `testConnection` returns `{ ok, latencyMs, modelCount }` on success and a fixed-code failure otherwise; a hostile 500 body never appears in the result; a 10,000-model discovery response is capped and reported as capped; a model name shaped for injection is skipped, not stored; results are not cached across a config change.
- [x] Verify RED.
- [x] GREEN.
- [x] Verify: `npm run test --workspace @bayz/providers` exits 0.
- [x] Commit — `feat: add Bayz provider capability detection and connection test`

### Task 6 — API and dashboard surface

**Modify:** `apps/server/src/routes/providers.ts`, `apps/dashboard/src/panels/ProvidersPanel.tsx`, `apps/dashboard/src/api/client.ts`
**Test:** `apps/server/test/custom-provider-api.test.ts`, `apps/dashboard/test/custom-provider-panel.test.tsx`

- [x] RED `custom-provider-api.test.ts`: `POST /api/providers/:id/test` returns the connection result and requires `providers.write`; a denied header in the create body is `400` naming the header; a metadata-endpoint base URL is `400`; `allowLoopback` is accepted and persisted; the response carries no header **values** back (they are config, but echoing them widens the surface for no benefit).
- [x] RED `custom-provider-panel.test.tsx`: the create form offers kind including `custom-openai`, a headers editor bounded to 8 rows, an explicit loopback opt-in checkbox with a warning, and a Test Connection button showing latency or an explicit failure code; a hostile header name shows an inline error; nothing renders a header value as markup.
- [x] Verify RED.
- [x] GREEN.
- [x] Verify: `npm run test --workspace @bayz/server` and `--workspace @bayz/dashboard` exit 0; `node scripts/dashboard-smoke.mjs` exits 0.
- [x] Commit — `feat: expose Bayz custom providers through the API and dashboard`

### Task 7 — Adversarial suite and custom-provider smoke

**Create:** `packages/providers/test/custom-adversarial.test.ts`, `scripts/custom-provider-smoke.mjs`

- [ ] RED `custom-adversarial.test.ts`: a provider-supplied icon descriptor that is markup, a URL, or a data URI resolves to the local generic mark (extending the Phase 7 rule to `custom-openai`); a 5 MiB discovery response is refused; a discovery payload with 50,000 models is capped at 500; a model name containing `<script>` is skipped; an error body containing a credential sentinel never reaches a stored row or a response; a hostile `Host` header cannot be injected through config; a provider whose base URL resolves to `169.254.169.254` is refused at connect even if DNS changed after creation.
- [ ] `scripts/custom-provider-smoke.mjs`: real listener; register a `custom-openai` relay against a real loopback origin with `allowLoopback: true` and a custom header; prove discovery, chat, and test-connection work; register a second provider targeting `169.254.169.254` and prove creation is refused; prove a denied header is refused; scan db/wal/shm/logs/responses for the credential and error-body sentinels.
- [ ] Verify: `node scripts/custom-provider-smoke.mjs` exits 0; `npm run runtime:verify` exits 0; `git diff --check` clean.
- [ ] Commit — `test: add Bayz custom provider adversarial suite and smoke`

## Completion checklist

- [x] Egress policy refuses loopback, link-local, private, CGNAT, multicast, and metadata by default, including alternate IP encodings.
- [x] Loopback is opt-in per provider; metadata is never allowed.
- [x] Resolved-address re-check runs before connect; documented as narrowing, not eliminating, rebinding.
- [x] Custom headers allowlisted then denylisted; a denied header is a 400.
- [x] `authorization`, `proxy-authorization`, `host` unsettable from config.
- [x] `custom-openai` kind added via migration v7 (settled numbering) preserving existing rows.
- [x] Capability detection reports `unknown` rather than guessing.
- [x] Provider icon metadata still cannot become markup or a remote fetch.

---

## AMENDMENT — Free-first model economics (spec §25)

Added after this plan was committed. Two extra tasks, executed after Task 5 and
before Task 6, so the API and dashboard surface in Task 6 can expose economics.

### Task 5a — Model economics classification

**Create:** `packages/providers/src/economics.ts`
**Test:** `packages/providers/test/economics.test.ts`

**Interface produced:**
```ts
export const MODEL_ECONOMICS = ["FREE_VERIFIED","FREE_TIER","FREE_PREVIEW","LOCAL","PAID","UNKNOWN"] as const;
export type ModelEconomics = (typeof MODEL_ECONOMICS)[number];
export function isFreeEconomics(value: ModelEconomics): boolean;   // true for the three FREE_* plus LOCAL
export function classifyModelEconomics(input: {
  kind: ProviderKind;
  entry: unknown;          // the raw catalogue entry, untrusted
  allowLoopback: boolean;  // a loopback provider is a local runtime
}): ModelEconomics;
```

- [x] RED `economics.test.ts`: the six values are exactly as listed and frozen; `isFreeEconomics` is true for `FREE_VERIFIED`, `FREE_TIER`, `FREE_PREVIEW`, and `LOCAL`, and **false for `UNKNOWN` and `PAID`** — the `UNKNOWN` case is asserted first and explicitly, because treating it as free is the failure mode that costs real money.
- [x] RED same file, `FREE_VERIFIED` requires proof: an OpenRouter-style entry with `pricing: { prompt: "0", completion: "0", request: "0", image: "0" }` classifies `FREE_VERIFIED`; the same entry with **any** priced dimension non-zero classifies `PAID`; an entry with `pricing` present but a dimension **missing** classifies `UNKNOWN`, not `FREE_VERIFIED`, because a missing field is not a proven zero; `pricing: {}` is `UNKNOWN`; `pricing: null`, `pricing: "free"`, `pricing: 0`, and a prototype-polluted `pricing` are all `UNKNOWN`; a non-numeric string such as `"0.0000000abc"` is `UNKNOWN` rather than parsed leniently, since `parseFloat` would return 0 and silently invent a free model.
- [x] RED same file, negative and exponent handling: `"0.0"`, `"0e0"`, and `"-0"` are zero and therefore free; `"1e-9"` is non-zero and therefore `PAID`; a negative price is `UNKNOWN` because it is nonsense metadata rather than a discount.
- [x] RED same file, the other classifications: a `gemini` or `openai-compatible` provider with `allowLoopback: true` classifies `LOCAL` regardless of entry content, because a local runtime has no per-token cost to the operator; an entry carrying an id ending `:free` on a provider whose catalogue also gave zero pricing stays `FREE_VERIFIED` (pricing wins over a name convention); an id ending `:free` with **no** pricing metadata classifies `UNKNOWN` — **a name is not proof**, and this is asserted with a comment naming the attack: a hostile or careless catalogue could name every paid model `:free`.
- [x] RED same file, `FREE_TIER` and `FREE_PREVIEW`: an entry with an explicit boolean-ish free-tier marker in a documented field classifies `FREE_TIER`; a documented preview/promotional marker classifies `FREE_PREVIEW`; neither is inferred from a description string, an id substring, or a heuristic — the test asserts that a `description` containing the word "free" changes nothing.
- [x] RED same file, no hardcoded catalogue: a source scan over `packages/providers/src` finds no per-model price literal and no hardcoded model-name-to-economics table, so `classifyModelEconomics` cannot drift into a maintained price list.
- [x] RED same file, purity and bounds: the classifier is pure; a 1 MiB entry is bounded rather than walked; a deeply nested entry does not recurse without bound.
- [x] Verify RED: `node --import tsx --test packages/providers/test/economics.test.ts` fails with `ERR_MODULE_NOT_FOUND`.
- [x] GREEN.
- [x] Verify: `npm run test --workspace @bayz/providers` exits 0.
- [x] Commit — `feat: classify Bayz model economics from provider metadata`

### Task 5b — Discovery returns economics

**Modify:** `packages/providers/src/model-list.ts`, `packages/providers/src/discovery-openai.ts`, `packages/providers/src/discovery-gemini.ts`, `packages/providers/src/manager.ts`
**Test:** `packages/providers/test/discovery-economics.test.ts`

**Interface change:** `discoverModels(id)` keeps returning `string[]` for backward compatibility; a new `discoverModelCatalogue(id): Promise<ModelCatalogueEntry[]>` returns `{ id, economics }`. Both go through one collector, so the two cannot disagree about which models exist.

- [x] RED `discovery-economics.test.ts`: `discoverModelCatalogue` returns one entry per model with its classification; the model id set is **identical** to `discoverModels`, asserted by comparing both outputs from one upstream response, because a divergence would let the UI offer a model routing cannot reach; the existing `modelLimit` cap and dedupe apply identically; a malformed entry is skipped by the same rule as before; an entry whose economics cannot be determined appears with `UNKNOWN` rather than being dropped — hiding it would be a silent capability loss.
- [x] RED same file: a Gemini provider yields `LOCAL` when loopback-opted-in and `UNKNOWN` otherwise, since the Gemini catalogue carries no pricing; the test asserts `UNKNOWN` rather than assuming Google's free tier, and comments that the free tier is real but not machine-provable from the response.
- [x] RED same file: the raw catalogue entry never reaches the returned value — only `{ id, economics }` — so a hostile `description` or nested object cannot ride along into storage, telemetry, or the dashboard.
- [x] RED same file: no pricing value or catalogue body appears in any log line the manager emits (the existing `redactSecrets` path is asserted, count only).
- [x] Verify RED.
- [x] GREEN.
- [x] Verify: `npm run test --workspace @bayz/providers` exits 0; `node scripts/provider-smoke.mjs` still 36/36 (the existing `discoverModels` contract is unchanged, which is the point of keeping it).
- [x] Commit — `feat: return model economics from Bayz discovery`

### Amended completion checklist additions

- [x] Six economics values; `UNKNOWN` and `PAID` are not free.
- [x] `FREE_VERIFIED` only from complete zero pricing metadata; a missing dimension is `UNKNOWN`.
- [x] A `:free` id suffix alone never yields a free classification.
- [x] No hardcoded price table or model-name economics map (source-scan proven).
- [x] `discoverModels` and `discoverModelCatalogue` agree on the model id set.
- [x] No raw catalogue entry escapes the classifier.
