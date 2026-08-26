# Phase 9C — Client Identity, Scoped Keys, Capability Security

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Spec:** `docs/superpowers/specs/2026-08-27-bayz-phase9-goat-release-design.md` §7

**Depends on:** nothing (this is the first subprogram; 9A depends on it)

**Goal:** Replace the single shared admin token with per-client identities that are independently identifiable, scoped, revocable, rotatable, and auditable.

**Locks:** No client API may retrieve a provider credential or proxy password. A compromised client key must not reach another client, a provider credential, or admin authority. The Phase 6 `api:token` keeps working as the bootstrap admin identity.

**Migration numbering:** the spec's ledger (§4) labels this subprogram's migration v6 from the v5 baseline. 9C, 9D, and 9E all add migrations and run in parallel, so whichever lands second and third take the next free numbers and renumber their own plan text in the same commit. No test hardcodes the head version; every migration test reads the head from the migration table.

---

### Task 1 — Scope vocabulary

**Create:** `packages/identity/package.json`, `packages/identity/tsconfig.json`, `packages/identity/src/scopes.ts`, `packages/identity/src/errors.ts`, `packages/identity/src/index.ts`
**Modify:** root `package.json` (`runtime:build` gains `@bayz/identity` after `@bayz/telemetry` and before `@bayz/capability`, per the spec §4 build order)
**Test:** `packages/identity/test/scopes.test.ts`

**Interface produced:**
```ts
export const CLIENT_SCOPES = ["chat.completions","models.read","usage.read",
  "providers.read","providers.write","proxies.read","proxies.write",
  "routes.read","routes.write","admin"] as const;
export function assertScopes(value: unknown): ClientScope[];
export function satisfies(granted: ReadonlySet<ClientScope>, required: ClientScope): boolean;
```

- [ ] RED `scopes.test.ts`: the ten scopes are exactly as listed; `assertScopes` refuses an unknown scope, a duplicate, an empty array, more than 10 entries, and a non-array; `admin` satisfies every scope; `providers.write` does **not** imply `providers.read` (explicit grants only — implication is where privilege creep starts); no scope implies `admin`; `satisfies` is pure.
- [ ] RED same file: there is **no** scope that reads a secret — assert no scope name matches `/credential|password|secret|token|key/i`.
- [ ] Verify RED: `node --import tsx --test packages/identity/test/scopes.test.ts` fails with `ERR_MODULE_NOT_FOUND`.
- [ ] GREEN. Deps: `@bayz/security`, `@bayz/storage`.
- [ ] Verify: `npm run test --workspace @bayz/identity` and `npm run build --workspace @bayz/identity` exit 0; `node --test tests/runtime-structure.test.mjs` passes.
- [ ] Commit — `feat: add Bayz client scope vocabulary`

### Task 2 — Migration v6 and identity registry

**Modify:** `packages/storage/src/migrations.ts`, `packages/storage/test/migrations.test.ts`
**Create:** `packages/identity/src/repository.ts`
**Test:** `packages/identity/test/repository.test.ts`

**Schema:**
```sql
CREATE TABLE client_identities (
  id           TEXT PRIMARY KEY,
  display_name TEXT    NOT NULL,
  scopes_json  TEXT    NOT NULL,
  preset       TEXT,
  revoked      INTEGER NOT NULL CHECK (revoked IN (0,1)),
  expires_at   TEXT,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  last_used_at TEXT
);
```

- [ ] RED `packages/storage/test/migrations.test.ts`: fresh tables include `client_identities`; its exact 9-column set is pinned; it has **no** column named `key`, `secret`, `token`, `hash`, `credential`, or `password` — the key lives in the encrypted `secrets` table, not here; the bans on `combos` and `logs` stand.
- [ ] RED `packages/identity/test/repository.test.ts`: create/get/list/update/delete; an id outside `^[a-z0-9][a-z0-9-]{0,62}$` is refused pre-SQL; a duplicate id is `identity_already_exists`; `scopes_json` is re-validated on read and a tampered value yields `invalid_identity_config`; a revoked identity still lists (so an operator can see it) but `isUsable()` is false; an expired identity is unusable; `touch()` updates `last_used_at` only.
- [ ] Verify RED.
- [ ] GREEN: migration v6 + `createIdentityRepository(db)`.
- [ ] Verify: `npm run test --workspace @bayz/storage` exits 0; `npm run test --workspace @bayz/identity` exits 0; `node scripts/storage-smoke.mjs` still 42/42.
- [ ] Commit — `feat: add Bayz client identity registry`

### Task 3 — Key custody, rotation, revocation

**Create:** `packages/identity/src/manager.ts`
**Test:** `packages/identity/test/manager.test.ts`

**Interface produced:**
```ts
createIdentity(input): { identity: IdentityView; key: string };  // key returned ONCE
verifyKey(presented: string): IdentityView | undefined;
rotateKey(id): { key: string };                                  // returned ONCE
revoke(id): void;
```

- [ ] RED `manager.test.ts`: `createIdentity` returns a 32-byte hex key exactly once and stores it at `client:<id>:key` via `scopedSecretStorage`; there is **no** method that returns an existing key (source scan for `getKey|readKey|revealKey`); `verifyKey` matches with `timingSafeEqual` over SHA-256 digests so length is not an oracle; a wrong key returns `undefined`; a revoked identity's key stops verifying immediately and after a reopen; `rotateKey` invalidates the old key and the new one works; two identities' keys are independent — revoking one leaves the other verifying; the key never appears in a returned `IdentityView`.
- [ ] RED same file: **blast radius** — an identity manager instance cannot read `provider:*:api_key` or `proxy:*:password`; assert the scoped view's physical prefix is exactly `client:<id>:`.
- [ ] RED same file: the key is absent from `bayz.db`/`-wal`/`-shm` bytes after creation (envelope encryption proof).
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/identity` exits 0.
- [ ] Commit — `feat: add Bayz client key custody with rotation and revocation`

### Task 4 — Server authentication by identity

**Modify:** `apps/server/src/auth.ts`, `apps/server/src/runtime.ts`, `apps/server/package.json`
**Test:** `apps/server/test/identity-auth.test.ts`

- [ ] RED `identity-auth.test.ts`: the Phase 6 `api:token` still authenticates and carries `admin` (backward-compatibility guard); a client key authenticates and carries only its granted scopes; a revoked key is `401`; an expired key is `401`; a malformed bearer is `401` identically to a missing one; the request is decorated with `request.identity` and no handler can see the raw key; `/api/health` remains unauthenticated; rate limiting and Host/Origin checks are unchanged.
- [ ] RED same file: failed identity lookups are rate limited on the existing auth budget, so key guessing is throttled.
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/server` exits 0; `node scripts/api-smoke.mjs` still 62/62.
- [ ] Commit — `feat: authenticate Bayz requests by client identity`

### Task 5 — Scope enforcement on every route

**Modify:** `apps/server/src/routes/{providers,proxies,routes,usage,chat}.ts`, `apps/server/src/app.ts` (`/api/status`)
**Test:** `apps/server/test/scope-enforcement.test.ts`

**Measured route surface to cover:** `providers.ts` declares 8 handlers, `proxies.ts` 8, `routes.ts` 5, `usage.ts` 4, plus `/api/status` — **26 authenticated routes**, and `/api/health` which stays anonymous. The enumeration is taken from Fastify's own table rather than this list, so a route added later cannot escape the check.

- [ ] RED `scope-enforcement.test.ts`: enumerate every route from Fastify's own table (as `api-adversarial.test.ts` already does) and assert each declares a required scope; a `chat.completions`-only identity gets `403` on **every** management route (all 26, enumerated — not a hardcoded subset) and `200` on chat; `providers.read` cannot write; `usage.read` cannot purge (`DELETE /api/usage/requests`); only `admin` may create or revoke an identity; a `403` body uses the stable envelope and names the missing scope without leaking what exists.
- [ ] RED same file: a chat-scope identity receives `404` — not `403` — on a credential **read** attempt (`GET /api/providers/p1/credential`), because revealing that a path exists is itself information. Note the measured shape: `PUT` and `DELETE` on that path exist (write and clear), `GET` does not, so Fastify's router answers `404` on method mismatch. The test asserts the `404` **and** that `PUT`/`DELETE` on the same path return `403` for a chat-scope identity, since those are the routes an attacker would actually reach.
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/server` exits 0.
- [ ] Commit — `feat: enforce Bayz scopes on every API route`

### Task 6 — Identity management API and audit

**Create:** `apps/server/src/routes/identities.ts`
**Modify:** `packages/storage/src/migrations.ts` (v6 adds `identity_audit`)
**Test:** `apps/server/test/identities-api.test.ts`

**Routes:** `GET/POST /api/identities`, `GET/PATCH/DELETE /api/identities/:id`, `POST /api/identities/:id/rotate`

- [ ] RED `identities-api.test.ts`: create returns the key exactly once in the creation response and never again; `GET` returns presence and scopes but no key; rotate returns the new key once; delete revokes; every route requires `admin`; the audit table records identity id, scope used, route, outcome, and timestamp — and **no key, no credential, no body**; an audit query is metadata-only; the audit table has no content-bearing column (schema-pinned).
- [ ] RED same file: audit rows are bounded by count retention, reusing the Phase 8 pruning pattern, and pruning touches only `identity_audit`.
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/server` exits 0; `npm run runtime:verify` exits 0.
- [ ] Commit — `feat: add Bayz identity management API with metadata audit`

### Task 7 — Dashboard identity panel

**Create:** `apps/dashboard/src/panels/IdentitiesPanel.tsx`
**Modify:** `apps/dashboard/src/App.tsx`, `apps/dashboard/src/api/client.ts`, `apps/dashboard/src/api/types.ts`
**Test:** `apps/dashboard/test/identities-panel.test.tsx`

- [ ] RED `identities-panel.test.tsx`: list shows id, name, scopes, revoked state, last-used; create shows the key **once** in a copy-to-clipboard-free block (no clipboard API, keeping CSP-clean) with an explicit "shown only once" notice; the key is absent from the DOM after acknowledgement; rotate shows the new key once; revoke is confirmable; a hostile display name renders as inert text; no panel renders anything matching `/credential|password/`; preset selection seeds scopes and is editable.
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/dashboard` exits 0; `node scripts/dashboard-smoke.mjs` exits 0 with no new remote dependency and no inline style/script.
- [ ] Commit — `feat: add Bayz identity panel to the dashboard`

### Task 8 — Adversarial suite and identity smoke

**Create:** `packages/identity/test/adversarial.test.ts`, `scripts/identity-smoke.mjs`

- [ ] RED `adversarial.test.ts`: source scan over `packages/identity/src` finds no key-read accessor and no `provider:`/`proxy:` secret name; a hostile scopes payload (prototype pollution, 10,000 entries, nested objects) is refused; a key of 1 MiB is refused before hashing; timing across 1,000 wrong-key verifications shows no length correlation (statistical, generous bound, documented as indicative not proof); an identity id shaped for SQL injection is refused pre-SQL and the table survives.
- [ ] `scripts/identity-smoke.mjs`: real listener; create three identities (opencode/hermes/antigravity presets); prove each authenticates independently; revoke the opencode key and prove hermes and antigravity still work, provider credentials remain unreadable, and admin routes remain closed to all three; rotate hermes and prove the old key fails; scan db/wal/shm/logs/responses for all three keys — zero occurrences.
- [ ] Verify: `node scripts/identity-smoke.mjs` exits 0; `npm run runtime:verify` exits 0; `git diff --check` clean.
- [ ] Commit — `test: add Bayz identity adversarial suite and smoke`

## Completion checklist

- [ ] Ten scopes, no scope reads a secret, `admin` explicit and non-implied.
- [ ] Migration v6 adds `client_identities` and `identity_audit`, neither content-bearing.
- [ ] Keys stored envelope-encrypted at `client:<id>:key`; absent from disk bytes.
- [ ] No key-read accessor anywhere (source-scan proven).
- [ ] Phase 6 `api:token` still works as bootstrap admin.
- [ ] Every route declares a scope; enumeration-proven.
- [ ] Blast radius proven: revoking one client leaves others and all credentials intact.
- [ ] Audit is metadata-only and count-bounded.
