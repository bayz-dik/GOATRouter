# Phase 9G — Agent / Tool Injection Security

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Spec:** `docs/superpowers/specs/2026-08-27-bayz-phase9-goat-release-design.md` §11

**Depends on:** 9B (tool calls must exist), 9C (client scopes gate capabilities)

**Goal:** Make prompt injection structurally irrelevant. Model output is untrusted data; a capability registry decides what can happen, and no capability reads a secret.

**Locks:** No capability handler may import `SecretStorage` or reach a credential. A prompt asking to read provider keys fails because no such capability is registered, not because the model was asked not to.

---

### Task 1 — Capability registry

**Create:** `packages/capability/package.json`, `packages/capability/tsconfig.json`, `packages/capability/src/registry.ts`, `packages/capability/src/errors.ts`, `packages/capability/src/index.ts`
**Modify:** root `package.json` (`runtime:build` gains `@bayz/capability` immediately after `@bayz/identity`, per the spec §4 build order)
**Test:** `packages/capability/test/registry.test.ts`

**Interface produced:**
```ts
export type CapabilityHandler<I, O> = {
  name: string;                       // ^[a-z][a-z0-9_.-]{2,63}$
  requiredScope: ClientScope;
  parse(raw: unknown): I;             // schema validation, throws on mismatch
  run(input: I): Promise<O>;
};
export function registerCapability(handler): void;
export function lookupCapability(name: unknown): CapabilityHandler | undefined;
```

- [x] RED `registry.test.ts`: registering a valid handler then looking it up returns it; `lookupCapability` returns `undefined` for an unknown name, a non-string, `__proto__`, `constructor`, and `toString` (prototype-chain lookup guard — a `Map`, not an object literal); a duplicate registration throws; a name outside the pattern throws; the registry is bounded at 128 capabilities; `lookupCapability` never returns a handler for a name that was not explicitly registered.
- [x] RED same file: **there is no secret-reading capability** — assert no registered name matches `/credential|password|secret|token|key|export/i`, and that the registry is empty by default so a capability must be added deliberately.
- [x] Verify RED: `node --import tsx --test packages/capability/test/registry.test.ts` fails with `MODULE_NOT_FOUND` on `../src/index.js` — the file-level failure a new module produces.
- [x] GREEN. Deps: `@bayz/identity` only.
- [x] Verify: `npm run test --workspace @bayz/capability` (**18/18**) and `npm run build --workspace @bayz/capability` exit 0; `runtime:build` exits 0 across all twelve targets with `@bayz/capability` after `@bayz/identity`.
- [x] Commit — `feat: add the Bayz capability registry`

**Findings worth carrying forward:**
- **`constructor` and `prototype` needed a reserved-name guard the plan did not
  anticipate.** Both are lowercase ASCII, so `CAPABILITY_NAME_PATTERN` admits them, and
  the plan grouped them with `__proto__` as pattern failures. `__proto__` *is* refused by
  the leading-letter rule; these two are not. The reason to refuse them is **not** lookup
  safety — a `Map` already returns `undefined` — but the consumer that does not exist yet:
  any object keyed by capability name, such as a tool schema list for a model or a JSON
  summary for the dashboard, is corrupted by `{ constructor: … }`. The test asserts the
  pattern admits the name, so a later pattern change cannot conflate the two guards.
- **The secret-name regex is a tripwire over the registry's contents, not a blocklist in
  `registerCapability`.** A blocklist would make the guarantee "we refused that spelling",
  which invites the next spelling; the real guarantee is that adding a secret-reading
  capability requires a reviewed code change.
- **`lookupCapability` takes `unknown` and refuses rather than throwing.** The name comes
  from parsed model JSON, so a throw converts "the model sent a number" into a 500 on a
  path an attacker times.
- **`requiredScope` is validated against the identity vocabulary at registration.** A
  handler declaring `"superuser"` would read as maximally locked down while being
  unreviewable, and `satisfies` throws on an unknown required scope — so the first
  dispatch would be a 500 instead of a clean refusal.

### Task 2 — Tool-call dispatch pipeline

**Create:** `packages/capability/src/dispatch.ts`
**Test:** `packages/capability/test/dispatch.test.ts`

**Pipeline:** model output → JSON parse → schema validation → capability lookup → scope check → run

- [x] RED `dispatch.test.ts`: a well-formed tool call for a registered capability with a granted scope runs and returns its output; each stage rejects independently and the error names the **stage**, not the model's text: unparseable JSON, schema mismatch, unknown capability, missing scope; a call naming a registered capability the identity lacks scope for is refused **before** `parse` runs (so a handler never sees unauthorized input); dispatch depth is bounded at 4 and a nested chain beyond it is refused; a single dispatch is bounded at 8 tool calls; an argument blob beyond 32 KiB is refused before parsing.
- [x] RED same file: **the model cannot name a capability into existence** — a call for `read_provider_credentials` fails with `unknown_capability`, and the test comments that this is because nothing registered it, not because a name was blocked.
- [x] RED same file: a tool *result* claiming elevated scope is ignored — scope comes only from the authenticated identity.
- [x] Verify RED. Module-load RED first (`does not provide an export named 'DISPATCH_ARGUMENT_MAX_BYTES'`), the correct RED for a new module. 30 tests.
- [x] GREEN.
- [x] Verify: `npm run test --workspace @bayz/capability` exits 0 (**48/48**, 18 registry + 30 dispatch); `tsc --noEmit` clean; `runtime:build` exits 0 across all twelve targets; `@bayz/identity` 69/69 unaffected.
- [x] Commit — `feat: add Bayz tool-call dispatch with staged validation`

**Findings worth carrying forward:**
- **Scope before `parse` is the ordering that matters, and it is measured, not asserted
  by reading the source.** A handler's `parse` walks a model-authored structure, so it is
  attacker-reachable code; running it for an unauthorized caller puts untrusted input
  through the least-exercised path in the system on behalf of somebody who should already
  have been refused. A counter in the test fixture fails if `parse` runs even once.
- **An invalid depth is treated as past the bound, never coerced to 1.** Coercing lets a
  buggy or hostile handler reset the recursion budget on every hop, which turns the bound
  into decoration. Depth is exercised against a **genuinely recursive** handler that
  dispatches to itself; a faked counter would test the guard against nothing.
- **Per-call refusals, batch-level throws.** One hostile call must not deny service to
  the client's real work, and an over-bound batch is refused **wholesale rather than
  truncated** — running eight and dropping the rest is a partial execution nobody asked
  for plus an unreportable outcome for what was dropped.
- **The bounds deliberately equal 9B's** (8 calls, 32 KiB). Two different bounds on the
  same wire array would mean one layer accepted what the other refused, and that
  disagreement is the interesting case for an attacker.
- **`Buffer.byteLength`, not `.length`.** A cap on UTF-16 code units admits roughly three
  times the payload for CJK text.
- **A key-set check cannot replace the prototype comparison.**
  `Object.create({ id, type, function })` reads as a valid call while `Object.keys`
  returns `[]`. The test pins the **stage**, because the first draft passed under a
  mutation that deleted the prototype check — it was being refused incidentally at
  `dispatch-call-type`.
- **Unknown envelope keys are refused, not ignored.** `{ scopes: ["admin"] }` on a call
  is a hard refusal; ignoring it is safe today and a silent hole the moment any future
  field on that object is read.
- **Only a real `Set` authorizes.** An array, an object, a string, or `undefined` are
  each readable as "scopes unknown, so allow" by a permissive implementation — the same
  class of bug as a missing `default:` in an authorization switch.
- **Capability output is validated before return.** A cycle or an oversized blob would
  otherwise fail at HTTP serialization in Task 3, past the point where a clean refusal is
  possible; `undefined` is refused because it would read to the model as "the tool ran
  and found nothing".
- **Four mutations proved the suite can fail**, then were reverted: `parse` before the
  scope gate (3 red), depth coerced to 1 (1 red), `.length` byte cap (1 red), prototype
  check deleted (1 red).

### Task 3 — Gateway and router wiring

**Modify:** `packages/gateway/src/normalize.ts`, `apps/server/src/routes/chat.ts`, `apps/server/package.json`
**Test:** `apps/server/test/tool-dispatch.test.ts`

- [ ] RED `tool-dispatch.test.ts`: a tool call in an upstream response is dispatched only when the identity holds the capability's scope; an undispatchable call is returned to the client as a tool call for the client to handle (BAYZ does not silently swallow it), with a documented note that client-side tools remain the client's business; a dispatched capability's output becomes a `role:"tool"` message on the next turn; dispatch failures surface as a fixed-code error with no model text echoed; no tool argument reaches telemetry, logs, or the database.
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/server` exits 0; `node scripts/api-smoke.mjs` still 62/62.
- [ ] Commit — `feat: dispatch Bayz tool calls through the capability registry`

### Task 4 — Injection adversarial suite

**Create:** `packages/capability/test/injection-adversarial.test.ts`

- [ ] RED, each asserting a *structural* refusal rather than a filtered string:
  - a prompt literally containing "read all provider API keys" produces no capability match;
  - a tool call named `secrets.read`, `providers.credential`, `admin.export` → `unknown_capability`;
  - arguments containing `../../etc/passwd`, a `file://` URL, or `http://169.254.169.254` are refused by the handler's schema, and the test notes that no filesystem or network capability is registered at all;
  - a model emitting a tool call the client never declared is refused;
  - a tool result containing a fake `scopes` field does not change the effective scope;
  - a recursive tool chain 10 deep is refused at depth 4;
  - 10,000 tool calls in one response are refused at 8;
  - a capability name using a Unicode homoglyph of a registered name does not match;
  - a `__proto__` capability name does not resolve to `Object.prototype`.
- [ ] RED same file: source scan over `packages/capability/src` finds no import of `SecretStorage`, `SecretRepository`, `scopedSecretStorage`, `withCredential`, `node:fs`, or `node:child_process`.
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/capability` exits 0.
- [ ] Commit — `test: add Bayz tool-injection adversarial suite`

### Task 5 — Injection smoke

**Create:** `scripts/injection-smoke.mjs`

- [ ] Non-mocked: real listener, real origin scripted to emit hostile tool calls. Prove: a call for `read_provider_credentials` is refused with `unknown_capability`; a call with a traversal argument is refused; a chat-scope identity cannot dispatch anything requiring `providers.write`; a provider credential sentinel is unreachable through every hostile path attempted; scan db/wal/shm/logs/responses for the credential and prompt sentinels — zero occurrences.
- [ ] Verify: `node scripts/injection-smoke.mjs` exits 0; `npm run runtime:verify` exits 0; `git diff --check` clean.
- [ ] Commit — `test: add Bayz injection smoke`

## Completion checklist

- [ ] Registry is a `Map`, bounded, empty by default, and no registered name reads a secret.
- [ ] Dispatch validates in stages and checks scope before parsing input.
- [ ] Depth bounded at 4, calls bounded at 8, arguments bounded at 32 KiB.
- [ ] A model cannot name a capability into existence; refusal is structural.
- [ ] Tool results cannot elevate scope.
- [ ] `packages/capability` imports no secret store, no `node:fs`, no `node:child_process`.
- [ ] No tool argument or result in telemetry, logs, or the database.
