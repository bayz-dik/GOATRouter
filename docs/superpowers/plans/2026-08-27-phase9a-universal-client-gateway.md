# Phase 9A — Universal Client Gateway

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Spec:** `docs/superpowers/specs/2026-08-27-bayz-phase9-goat-release-design.md` §5

**Depends on:** 9C (client identity supplies the scope set a profile is built from)

**Goal:** A `packages/gateway` package that models clients by protocol and capability, never by product name, so a new compatible client needs no BAYZ source change.

**Locks:** No product name in the request-handling path (source-scan enforced). No credential read path. No content persistence. Flux Core untouched.

---

### Task 1 — Package scaffold and capability vocabulary

**Create:** `packages/gateway/package.json`, `packages/gateway/tsconfig.json`, `packages/gateway/src/capabilities.ts`, `packages/gateway/src/index.ts`
**Modify:** root `package.json` (`runtime:build` gains `@bayz/gateway` after `@bayz/proxy` and before `@bayz/router`, per the spec §4 build order)
**Test:** `packages/gateway/test/capabilities.test.ts`

- [ ] RED `packages/gateway/test/capabilities.test.ts`: `CLIENT_CAPABILITIES` is exactly `["chat","chat.stream","models.list","tools","tools.parallel","cancel","usage.read"]`; `isClientCapability` accepts each and rejects `""`, `"admin"`, `42`, `null`, `"chat.STREAM"`; `CLIENT_QUIRKS` is a frozen set; every quirk name matches `^[a-z][a-z0-9-]{2,31}$`.
- [ ] Verify RED: `node --import tsx --test packages/gateway/test/capabilities.test.ts` fails with `ERR_MODULE_NOT_FOUND`.
- [ ] GREEN: scaffold with deps `@bayz/security` only (no storage — the gateway holds no state).
- [ ] Verify: `npm run test --workspace @bayz/gateway` and `npm run build --workspace @bayz/gateway` both exit 0; `node --test tests/runtime-structure.test.mjs` still passes.
- [ ] Commit — `feat: add Bayz client capability vocabulary`

### Task 2 — Client profile derivation

**Create:** `packages/gateway/src/profile.ts`
**Test:** `packages/gateway/test/profile.test.ts`

**Interface produced:**
```ts
export type ClientProfile = {
  protocol: "openai" | "anthropic";
  capabilities: ReadonlySet<ClientCapability>;
  quirks: ReadonlySet<ClientQuirk>;
};
export function deriveProfile(input: {
  path: string;
  accept: string | undefined;
  body: unknown;
  grantedScopes: ReadonlySet<string>;
}): ClientProfile;
```

- [ ] RED `profile.test.ts`: `/v1/chat/completions` derives `protocol: "openai"`; `Accept: text/event-stream` plus `stream: true` derives `chat.stream`; `tools` in the body derives `tools`; a granted scope of only `chat.completions` yields a profile *without* `usage.read` even when the body requests it; an unknown path derives no capabilities rather than defaulting to all; a body that is not a plain object derives an empty capability set; `deriveProfile` is pure (same input, deep-equal output).
- [ ] RED same file: **capability is the intersection of request intent and granted scope** — a request asking for `tools` with a scope set lacking `chat.completions` yields an empty set.
- [ ] Verify RED.
- [ ] GREEN `profile.ts`.
- [ ] Verify: `npm run test --workspace @bayz/gateway` exits 0.
- [ ] Commit — `feat: derive Bayz client profiles from protocol and scope`

### Task 3 — Named presets as configuration only

**Create:** `packages/gateway/src/presets.ts`
**Test:** `packages/gateway/test/presets.test.ts`

- [ ] RED `presets.test.ts`: `CLIENT_PRESETS` has keys `opencode`, `hermes`, `antigravity`, `generic-openai`; each preset is a *default capability set* and nothing else (no URL, no header, no behaviour hook); `presetFor("unknown-client")` returns the `generic-openai` default rather than throwing; every preset's capabilities are a subset of `CLIENT_CAPABILITIES`.
- [ ] RED same file: presets are data, not dispatch — `presetFor` never returns a function, and `JSON.parse(JSON.stringify(preset))` round-trips identically.
- [ ] Verify RED.
- [ ] GREEN `presets.ts`.
- [ ] Verify: `npm run test --workspace @bayz/gateway` exits 0.
- [ ] Commit — `feat: add Bayz client presets as configuration data`

### Task 4 — Protocol normalization

**Create:** `packages/gateway/src/normalize.ts`
**Test:** `packages/gateway/test/normalize.test.ts`

**Interface produced:** `normalizeRequest(profile, body): NormalizedChatRequest`, `denormalizeResponse(profile, response): unknown`

- [ ] RED `normalize.test.ts`: an OpenAI body normalizes to the shape `packages/router/src/request.ts` already accepts; a documented quirk (`max-tokens-string`) converts `max_tokens: "512"` to `maxTokens: 512` and an undocumented one is refused; normalization strips no field silently — an unknown key is an error, matching the Phase 5 posture; `denormalizeResponse` for `protocol: "openai"` produces exactly the field set `apps/server/src/routes/chat.ts` emits today.
- [ ] RED same file: no product name appears in any normalization branch — assert `normalizeRequest.toString()` contains none of `opencode`, `hermes`, `antigravity`, `cline`, `continue`.
- [ ] Verify RED.
- [ ] GREEN `normalize.ts`.
- [ ] Verify: `npm run test --workspace @bayz/gateway` exits 0.
- [ ] Commit — `feat: add Bayz protocol normalization`

### Task 5 — Server wiring

**Modify:** `apps/server/src/routes/chat.ts`, `apps/server/src/runtime.ts`, `apps/server/package.json` (add `@bayz/gateway`)
**Test:** `apps/server/test/gateway.test.ts`

- [ ] RED `apps/server/test/gateway.test.ts`: a chat request carrying an identity with only `chat.completions` succeeds; the same request with a `models.read`-only identity is `403`; `GET /v1/models` requires `models.read`; the response shape for a `generic-openai` profile is byte-identical to the Phase 6 shape (regression guard); `/api/health` unchanged.
- [ ] Verify RED.
- [ ] GREEN: route the chat and models handlers through `deriveProfile` + `normalizeRequest`.
- [ ] Verify: `npm run test --workspace @bayz/server` exits 0 with no prior test modified except documented pins; `node scripts/api-smoke.mjs` still 62/62.
- [ ] Commit — `feat: route Bayz chat through the client gateway`

### Task 6 — Adversarial and source-scan enforcement

**Test:** `packages/gateway/test/adversarial.test.ts`

- [ ] RED `adversarial.test.ts`: source scan over `packages/gateway/src` and `apps/server/src/routes` finds no occurrence of `opencode`, `hermes`, `antigravity`, `cline`, `continue` outside `presets.ts` (comments stripped before matching, so documentation of the rule does not trip it); no gateway file imports `SecretStorage`, `SecretRepository`, or anything matching `/getCredential|getPassword/`; a profile cannot be mutated after derivation (frozen sets); a hostile `Accept` header of 64 KiB is bounded; a body with 10,000 keys is refused, not iterated.
- [ ] Verify RED.
- [ ] GREEN as needed.
- [ ] Verify: `npm run runtime:verify` exits 0; `git diff --check` clean.
- [ ] Commit — `test: add Bayz gateway adversarial coverage`

## Completion checklist

- [ ] `@bayz/gateway` tests and build exit 0; `runtime:verify` exits 0.
- [ ] No product name in any runtime path (source-scan proven).
- [ ] Capability set is the intersection of request intent and granted scope.
- [ ] Phase 6 chat/models response shapes unchanged (regression proven).
- [ ] `api-smoke` still 62/62; no prior smoke count regressed.
- [ ] No gateway file can reach a credential.
