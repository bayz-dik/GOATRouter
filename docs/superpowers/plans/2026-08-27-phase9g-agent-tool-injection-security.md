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

- [x] RED `tool-dispatch.test.ts`: a tool call in an upstream response is dispatched only when the identity holds the capability's scope; an undispatchable call is returned to the client as a tool call for the client to handle (BAYZ does not silently swallow it), with a documented note that client-side tools remain the client's business; a dispatched capability's output becomes a `role:"tool"` message on the next turn; dispatch failures surface as a fixed-code error with no model text echoed; no tool argument reaches telemetry, logs, or the database.
- [x] Verify RED. Module-load RED first (`Cannot find module '../src/tool-loop.js'`). 17 tests.
- [x] GREEN. New `apps/server/src/tool-loop.ts`; `apps/server/package.json` gains `@bayz/capability`; nine 9G codes added to the HTTP error map. **`packages/gateway/src/normalize.ts` was not modified** — see below.
- [x] Verify: `npm run test --workspace @bayz/server` exits 0 (**336/336**, up from 319); `@bayz/router` **289/289**; `tsc --noEmit` clean for both; `node scripts/api-smoke.mjs` **70/70** (62/62 was the Phase 6 figure this plan was written against), `stream-smoke` 63/63, `router-smoke` 46/46.
- [x] Commit — `feat: dispatch Bayz tool calls through the capability registry`

**Findings worth carrying forward:**
- **A live bug in `wireBody`, found by this task and fixed here.** `ChatMessage` uses
  camelCase (`toolCalls`, `toolCallId`); the OpenAI wire contract is snake_case.
  `wireBody` serialized `request.messages` directly, so **every** tool roundtrip reached
  the upstream with `toolCalls` and `toolCallId` — names no provider recognises. The
  model was handed a conversation with the tool call and its result effectively missing.
  The 9B suite could not see it: its only outbound assertion was that the result
  *string* appeared somewhere in the body, which held either way because `content` needs
  no renaming. `wireMessages()` now translates, and
  `tools-response.test.ts` pins the key names.
- **`normalize.ts` was left alone, contrary to the plan's Modify list.** The gateway
  maps client request fields; nothing about server-side dispatch belongs there, and the
  `role:"tool"` messages the loop synthesises never pass through it. Touching it would
  have been change for the sake of matching a checklist.
- **The first turn must pass the request through untouched.** Seeding the loop with
  `[...request.messages]` turned a `{}` payload's clean 400 `invalid_request` into a 500
  on a spread of `undefined`. `router.chat` owns validation, so the conversation is only
  reconstructed *after* a turn returns tool calls — at which point the body is known to
  have validated. Caught by `chat-api.test.ts`, which pins that refusal.
- **A split batch is refused, not half-run.** Running the registered calls and handing
  the client-side ones back would perform a side effect and then return a conversation
  neither party can reconcile: the client cannot know which calls already ran, and the
  model's next turn would be missing a result it expects.
- **An unregistered call is forwarded, not refused.** BAYZ has nothing to run, and
  inventing a refusal would break every client that declares its own tools. This is also
  why a model naming `read_provider_credentials` gets a forwarded tool call rather than
  an error: the guarantee is that no capability reads a secret, not that a name was
  blocked.
- **Streaming does not dispatch, and the test says so rather than leaving it
  ambiguous.** A stream's 200 and headers are committed with the first byte, so a
  dispatch failure could only be a terminal event inside an already-successful response,
  while the non-streaming path can still answer 403 or 400. Forwarding tool calls to a
  streaming client is the correct fallback — exactly the 9B behaviour — and the handler
  is asserted not to run.
- **The reachable capability namespace is the intersection of two patterns.**
  `CAPABILITY_NAME_PATTERN` admits `.`; the router's 9B `TOOL_NAME_RE` does not. So
  `echo.text` is registrable and permanently unreachable — a model naming it has its
  whole response refused by `parseToolCalls` before the registry is consulted. Safe but
  silent, so it is pinned by a test.
- **The leak scan runs on both the rejected and the accepted path.** The successful path
  is where an argument could most plausibly be persisted, since it travelled to a
  handler and back out to the model. Telemetry rows, log lines, and the raw
  `bayz.db`/`-wal`/`-shm` bytes are all scanned, with a positive check that the scan
  reads real content.
- **Three mutations proved the suite can fail**, then were reverted: half-running a
  split batch (1 red), letting a tool result widen the effective scope (1 red), and
  removing the turn budget (1 red).

### Task 4 — Injection adversarial suite

**Create:** `packages/capability/test/injection-adversarial.test.ts`

- [x] RED, each asserting a *structural* refusal rather than a filtered string:
  - a prompt literally containing "read all provider API keys" produces no capability match;
  - a tool call named `secrets.read`, `providers.credential`, `admin.export` → `unknown_capability`;
  - arguments containing `../../etc/passwd`, a `file://` URL, or `http://169.254.169.254` are refused by the handler's schema, and the test notes that no filesystem or network capability is registered at all;
  - a model emitting a tool call the client never declared is refused;
  - a tool result containing a fake `scopes` field does not change the effective scope;
  - a recursive tool chain 10 deep is refused at depth 4;
  - 10,000 tool calls in one response are refused at 8;
  - a capability name using a Unicode homoglyph of a registered name does not match;
  - a `__proto__` capability name does not resolve to `Object.prototype`.
- [x] RED same file: source scan over `packages/capability/src` finds no import of `SecretStorage`, `SecretRepository`, `scopedSecretStorage`, `withCredential`, `node:fs`, or `node:child_process`.
- [x] Verify RED.
- [x] GREEN. Test-only task: no `src` file changed, and that is the result — 24 adversarial cases found nothing to fix in Tasks 1–3.
- [x] Verify: `npm run test --workspace @bayz/capability` exits 0 (**72/72**, 18 registry + 30 dispatch + 24 injection); `npm run build --workspace @bayz/capability` exits 0; `@bayz/identity` 69/69, `@bayz/gateway` 74/74, `@bayz/router` 289/289, `@bayz/server` 336/336; all twelve `runtime:build` targets exit 0, run one at a time; `api-smoke` 70/70 and `security-smoke` 82/82.
- [x] Commit — `test: add Bayz tool-injection adversarial suite`

**Findings worth carrying forward:**
- **Nothing needed fixing, and that is the finding.** Task 4 is the only 9G task that
  changed no `src` file. The suite was written to break Tasks 1–3 — homoglyph names,
  own-`__proto__` envelopes, forged authority fields, a 10,000-call flood, a
  self-dispatching recursive handler, a handler whose output is shaped like a request —
  and every case refused on the first run. Seven mutations were then applied to prove the
  suite is capable of failing (below), so the green is measured rather than assumed.
- **Seven mutations proved the suite can fail**, then were reverted, each verified by
  `git status` returning to a single untracked test file:
  1. `parse` moved before the scope gate → 2 red.
  2. `CAPABILITY_NAME_PATTERN` widened to `\p{L}` → 1 red (the homoglyph case).
  3. A `detail` field added to a refusal carrying the handler's own message → 2 red.
  4. The envelope unknown-key check deleted → 1 red (forged `scopes` accepted).
  5. `node:fs` imported by `registry.ts` → 1 red (the source scan).
  6. The registry `Map` swapped for an object literal → 1 red (`toString` resolved to a
     builtin the dispatcher would have called).
  7. An over-bound batch truncated to eight instead of refused, plus an invalid depth
     coerced to 1 → 1 red.
- **"The client never declared it" is not a refusal this layer can make, and the test
  says so instead of pretending otherwise.** The client's `tools` array is a declaration
  *to the model*; the registry is what this process will run. They are separate
  namespaces on purpose, so dispatch refuses an undeclared name for the same structural
  reason it refuses an invented one — nothing registered it. The narrower guarantee that
  is actually pinned is the load-bearing one: **BAYZ executes nothing it was not given.**
  Task 3's `tool-dispatch.test.ts` owns the forward-to-client half.
- **A refusal's field set is pinned, not just scanned for sentinels.** A leak scan can
  only find the sentinel it was told about; `Object.keys(outcome)` asserted as exactly
  `code`/`id`/`name`/`stage`/`status`, with every value a string under 128 characters,
  means there is nowhere for an unanticipated leak to sit. Mutation 3 is the realistic
  way that regresses — somebody adds a helpful `detail` — and it now fails on the way in.
- **The export surface is asserted, not just the imports.** A source scan covers what the
  package pulls *in*; the last place a handler could obtain a secret is what
  `@bayz/capability` and `@bayz/identity` hand *out*, since those are the only modules a
  capability is guaranteed to have imported. Both export lists are enumerated against
  `/credential|password|secret|reveal|decrypt|plaintext|unsafe/i`, with a positive check
  that a real namespace was read.
- **Forbidden module specifiers are named as well as allowlisted.** The allowlist is the
  real guarantee — it refuses everything but `@bayz/identity` — but `node:fs`,
  `node:child_process`, `node:net`, `node:vm`, `node:sqlite`, and the sibling `@bayz`
  packages are listed explicitly so a later relaxation of the allowlist still has to get
  past a named assertion.
- **Rejected data is proved not to reach privileged execution, with the complement
  asserted in the same batch.** A `routes.write` capability records every `parse` and
  `run`; four hostile calls aimed at it (forged scope, traversal argument, unknown key,
  unknown name) all refuse with `parsed() === 0` and `seen()` empty, while a legitimate
  call in the same batch completes. A dispatcher that refused the whole batch would pass
  a refusal-only test while handing any hostile call a denial-of-service lever.
- **Tool output cannot drive the next dispatch, tested with the scope deliberately
  granted.** The hostile handler returns `tool_calls`, `toolCalls`, `next`, and `then`
  fields naming a privileged capability, and the caller *does* hold `routes.write` — so if
  those fields were ever read, scope would not be what stopped them. Nothing ran.

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
