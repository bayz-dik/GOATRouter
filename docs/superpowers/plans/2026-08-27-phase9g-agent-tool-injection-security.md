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

- [ ] RED `registry.test.ts`: registering a valid handler then looking it up returns it; `lookupCapability` returns `undefined` for an unknown name, a non-string, `__proto__`, `constructor`, and `toString` (prototype-chain lookup guard — a `Map`, not an object literal); a duplicate registration throws; a name outside the pattern throws; the registry is bounded at 128 capabilities; `lookupCapability` never returns a handler for a name that was not explicitly registered.
- [ ] RED same file: **there is no secret-reading capability** — assert no registered name matches `/credential|password|secret|token|key|export/i`, and that the registry is empty by default so a capability must be added deliberately.
- [ ] Verify RED: `node --import tsx --test packages/capability/test/registry.test.ts` fails with `ERR_MODULE_NOT_FOUND`.
- [ ] GREEN. Deps: `@bayz/identity` only.
- [ ] Verify: `npm run test --workspace @bayz/capability` and `npm run build --workspace @bayz/capability` exit 0.
- [ ] Commit — `feat: add the Bayz capability registry`

### Task 2 — Tool-call dispatch pipeline

**Create:** `packages/capability/src/dispatch.ts`
**Test:** `packages/capability/test/dispatch.test.ts`

**Pipeline:** model output → JSON parse → schema validation → capability lookup → scope check → run

- [ ] RED `dispatch.test.ts`: a well-formed tool call for a registered capability with a granted scope runs and returns its output; each stage rejects independently and the error names the **stage**, not the model's text: unparseable JSON, schema mismatch, unknown capability, missing scope; a call naming a registered capability the identity lacks scope for is refused **before** `parse` runs (so a handler never sees unauthorized input); dispatch depth is bounded at 4 and a nested chain beyond it is refused; a single dispatch is bounded at 8 tool calls; an argument blob beyond 32 KiB is refused before parsing.
- [ ] RED same file: **the model cannot name a capability into existence** — a call for `read_provider_credentials` fails with `unknown_capability`, and the test comments that this is because nothing registered it, not because a name was blocked.
- [ ] RED same file: a tool *result* claiming elevated scope is ignored — scope comes only from the authenticated identity.
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/capability` exits 0.
- [ ] Commit — `feat: add Bayz tool-call dispatch with staged validation`

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
