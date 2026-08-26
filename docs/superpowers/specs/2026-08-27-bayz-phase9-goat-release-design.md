# BAYZ — Phase 9 GOAT Release Program Design

Status: Accepted · Date: 2026-08-27 · Predecessors: Phases 1–8 (all verified), Flux Core V2 (LOCKED)

## 1. Goal

Turn BAYZ from a verified router implementation into a feature-complete,
client-agnostic, fortress-hardened, cross-platform, release-ready local-first AI
router.

Phase 9 is not a test phase. It contains remaining mandatory product capability
(streaming, tool calling, scoped client keys, custom-provider completeness,
multi-proxy UX) *and* the release qualification program.

## 2. Verified baseline this program must preserve

Established and proven in Phases 1–8. Nothing below may regress:

| Capability | Evidence |
|---|---|
| Envelope-encrypted secrets, per-secret DEK | `packages/storage`, 160 tests, storage smoke 42/42 |
| Provider credential isolation, no read path | `withCredential` only; getter scan clean |
| Proxy manager, SOCKS5 + HTTP CONNECT | `packages/proxy`, 105 tests, proxy smoke 39/39 |
| Router with deterministic selection + failover | `packages/router`, 140 tests, router smoke 46/46 |
| Authenticated local API, no anonymous route but health | `apps/server`, 142 tests, api smoke 62/62 |
| Operator dashboard, memory-only token | `apps/dashboard`, 253 tests, dashboard smoke 48/48 |
| Strict CSP on every response | `apps/server/src/security-headers.ts`, verified on real response |
| Metadata-only usage telemetry | `packages/telemetry`, 55 tests, usage smoke 119/119 |
| Live Flux Core from real telemetry | `apps/dashboard/src/flux/adapter.ts` |
| Many-provider constellation 1–120 | `flux-verify-states.test.tsx` |
| Zero content/credential persistence | six-sentinel drill across db/wal/shm/logs/responses |

Current shape: 7 packages (`contracts`, `security`, `storage`, `telemetry`,
`providers`, `proxy`, `router`), 2 apps (`server`, `dashboard`), 9 build targets,
74 test files, 7 smoke scripts, schema v5, and **5 directly declared external
runtime dependencies** (`fastify`, `@fastify/static`, `react`, `react-dom`, `zod`)
whose transitive closure is **86 external packages** out of 270 lockfile entries.
Both numbers matter: the five are the deliberate choices, the 86 are what actually
ships, and 9J Task 2 pins both so a transitive native module cannot appear
unnoticed.

## 3. Gaps found by inspection

These are the real, measured deltas Phase 9 must close. Each is cited to the file
that proves it.

1. **Streaming is refused, not implemented.** `apps/server/src/routes/chat.ts:18`
   rejects any request containing `stream`. `packages/router/src/transport.ts`
   buffers the whole response.
2. **No tool/function calling.** `packages/router/src/request.ts` rejects unknown
   keys, so `tools` and `tool_choice` are refused by design.
3. **One shared admin token.** `apps/server/src/api-token.ts` stores exactly one
   secret, `api:token`. There is no per-client identity, scope, or revocation.
4. **No SSRF egress policy.** `packages/providers/src/url.ts` validates scheme and
   rejects userinfo but performs no IP-range, link-local, or metadata-endpoint
   check. A provider base URL may target `169.254.169.254` today.
5. **No custom headers on providers.** `packages/providers/src/config.ts:26` allows
   only `timeoutMs`, `discoveryPath`, `modelLimit`. Relays needing a non-standard
   header cannot be configured.
6. **Proxy binds to routes only, never to providers.**
   `packages/proxy` + `packages/router/src/repository.ts`: `proxy_id` lives on
   `routes`. Assigning one proxy to twenty providers means editing twenty routes.
7. **No bulk UX.** Zero occurrences of bulk/select-all in
   `apps/dashboard/src/panels/*.tsx`.
8. **No concurrency cap.** No semaphore or in-flight limit anywhere in
   `packages/*/src` or `apps/*/src`. Rate limiting is per-minute count only.
9. **OS keystore is an unimplemented interface.**
   `packages/storage/src/key-provider.ts:246` — `available = false`, and this device
   has no `secret-tool`, `security`, or `keyctl`.
10. **No security posture ladder.** `apps/server/src/config.ts` requires
    `BAYZ_ALLOW_REMOTE` for a non-loopback host and `runtime.ts` requires an explicit
    token, but there is no TLS requirement, no mTLS, no request signing, and no
    posture-dependent tightening.
11. **No packaging, no SBOM, no upgrade path.** No release artifact, no signing, no
    install script, no migration-from-old-schema test beyond the in-repo ladder.

## 4. Subprogram architecture

Twelve independently reviewable subprograms. The boundary follows the existing
workspace layout so no subprogram spans more packages than it must.

```text
9A Universal Client Gateway ......... packages/gateway (new)
9B Streaming + Tool Calling ........ packages/router, apps/server
9C Client Identity / Scoped Keys ... packages/identity (new), apps/server
9D Custom Provider Completeness .... packages/providers
9E Multi-Proxy Easy UX ............. packages/proxy, packages/router, apps/*
9F Fortress Security Expansion ..... packages/storage, packages/security, apps/server
9G Agent / Tool Injection Security . packages/gateway, packages/capability (new)
9H Client Compatibility Matrix ..... scripts/, docs/
9I Fuzz / Chaos / Load / Soak ...... scripts/, per-package fuzz tests
9J Cross-Platform / Packaging ...... scripts/, packaging/
9K Supply Chain / Release Integrity  scripts/, sbom/
9L Feature Completeness Gate ....... docs/, scripts/
```

### Dependency order

```text
9C ──┬──> 9A ──> 9B ──> 9G ──┐
     │                       ├──> 9H ──┐
9D ──┤                       │         ├──> 9I ──┐
9E ──┴───────────────────────┘         │         ├──> 9L
9C(T1) ──> 9F(T2,6,7) ─────────────────┤         │
9F(T1,3,4,5,8) ────────────────────────┘         │
9J ──> 9K ───────────────────────────────────────┘
```

9I sits after 9F as well as 9H: its load measurement must observe the 9F outbound
concurrency cap, and its chaos scenarios must exercise 9G's tool dispatch. Fuzzing
a surface that does not exist yet measures nothing.

- **9C before 9A**: the gateway needs a caller identity to scope capabilities.
- **9A before 9B**: streaming and tool calls are capabilities the gateway
  negotiates; building them first would hardcode a client assumption.
- **9B before 9G**: tool-call injection defence needs tool calls to exist.
- **9E parallel**: UX depends only on the proxy/route model, not on the gateway.
- **9F mostly parallel**: its storage and security work needs nothing. Its
  root-key-rotation route, posture ladder, and request signing need 9C's scope
  vocabulary, because `admin`-gating and "no `admin` scope over the wire" cannot be
  expressed without it. The 9F plan splits its tasks accordingly rather than
  pretending the whole subprogram is independent.
- **9H after 9A/9B/9E**: real clients need streaming, tools, and working UX.
- **9I after 9F/9G too**: load measurement must observe the concurrency cap, and
  chaos must exercise tool dispatch.
- **9L last**: it is the gate, not a feature.

### Migration numbering ledger

Three subprograms add schema migrations and two of them run in parallel, so the
numbers cannot be assigned statically without a collision. The baseline is v5.

| Subprogram | Change | Intended version |
|---|---|---|
| 9C | `client_identities`, `identity_audit` | v6 |
| 9E | `providers.proxy_id` | v7 |
| 9D | `providers.kind` CHECK gains `custom-openai` | v8 |

**Rule**: the intended version above is a *plan-time* label, not a contract. 9D
and 9E are parallel, so whichever lands second takes the next free number and
updates its own plan text and the other's cross-reference in the same commit. No
test hardcodes a head version — every migration test reads the head from the
migration table, and `9J` Task 6 walks the ladder from v1 to whatever head is.
Renumbering is a documentation edit; skipping or reusing a number is a defect.

### Build order after Phase 9

Three subprograms each add a package and each says "`runtime:build` gains" its own
entry, so the total order is fixed here to prevent a conflicting edit. Topological,
dependencies first:

```text
contracts → security → storage → telemetry → identity → capability
          → providers → proxy → gateway → router → dashboard → server
```

`identity` depends on `security` and `storage`. `capability` depends on `identity`
only. `gateway` depends on `security` only — it holds no state, which is why it
sits after `proxy` yet needs nothing from it. Twelve build targets, up from nine.

### Subprogram plan documents

```text
9A docs/superpowers/plans/2026-08-27-phase9a-universal-client-gateway.md
9B docs/superpowers/plans/2026-08-27-phase9b-streaming-and-tools.md
9C docs/superpowers/plans/2026-08-27-phase9c-client-identity-scoped-keys.md
9D docs/superpowers/plans/2026-08-27-phase9d-custom-provider-completeness.md
9E docs/superpowers/plans/2026-08-27-phase9e-multi-proxy-easy-ux.md
9F docs/superpowers/plans/2026-08-27-phase9f-fortress-security.md
9G docs/superpowers/plans/2026-08-27-phase9g-agent-tool-injection-security.md
9H docs/superpowers/plans/2026-08-27-phase9h-client-compatibility-matrix.md
9I docs/superpowers/plans/2026-08-27-phase9i-fuzz-chaos-load-soak.md
9J docs/superpowers/plans/2026-08-27-phase9j-cross-platform-packaging.md
9K docs/superpowers/plans/2026-08-27-phase9k-supply-chain-release-integrity.md
9L docs/superpowers/plans/2026-08-27-phase9l-feature-completeness-gate.md
```

## 5. 9A — Universal Client Gateway

**Architecture is locked: BAYZ is client-agnostic.** No `if (client === "opencode")`
in the runtime path. Clients are modelled by *capability*, not by product name.

New package `packages/gateway` owns a `ClientProfile`:

```ts
type ClientCapability =
  | "chat" | "chat.stream" | "models.list"
  | "tools" | "tools.parallel" | "cancel" | "usage.read";

type ClientProfile = {
  protocol: "openai" | "anthropic";
  capabilities: ReadonlySet<ClientCapability>;
  quirks: ReadonlySet<ClientQuirk>;
};
```

A profile is derived from the *request*: protocol path, `Accept` header, body
shape, and the negotiated client identity's granted scopes. Never from a product
name. `ClientQuirk` exists for genuine wire-format divergence (e.g. a client that
sends `max_tokens` as a string), and each quirk must cite the observed behaviour
that justifies it.

Named presets (`opencode`, `hermes`, `antigravity`, `generic-openai`) are
**configuration convenience only**: they seed a default capability set at client
registration. A future client with a new name and standard behaviour needs no
BAYZ source change — a source-scan test enforces that no product name appears in
the request-handling path.

## 6. 9B — Streaming + Tool Calling

### Streaming

`POST /v1/chat/completions` gains `stream: true`. Server-Sent Events framing:
`data: {json}\n\n` per chunk, terminated by `data: [DONE]\n\n`.

Requirements, each with an owning task in the 9B plan:

- Incremental upstream parsing with a bounded line buffer (64 KiB per line, 2 MiB
  total), so a provider that never emits a newline cannot exhaust memory.
- Client disconnect aborts the upstream request within one event loop turn.
- Upstream disconnect emits a terminal error event, never a silent truncation.
- Cancellation via `AbortSignal` propagates provider-ward.
- Malformed chunks are skipped with a bounded skip count, then the stream fails.
- Idle timeout distinct from total timeout.
- Zero socket, timer, or listener leaks — proven by a soak test.
- **Failover semantics change under streaming**: once the first byte is emitted to
  the client, failover is impossible. The plan states this explicitly rather than
  pretending mid-stream failover works.

### Tool calling

`tools`, `tool_choice`, assistant `tool_calls`, and the `role: "tool"` result
roundtrip. Tool-call arguments are **data, never code**: they are parsed as JSON,
validated against the declared schema, and bounded (32 KiB per argument blob, 64
tools per request, 8 tool calls per response).

Capability detection: a provider that does not support tools receives a request
without them and the client receives `tools_unsupported` rather than a silent drop.

## 7. 9C — Client Identity / Scoped Keys

Migration v6 adds `client_identities`. Each identity has an id, display name, a
scope set, an optional expiry, and a revocation flag. The secret lives at
`client:<id>:key` in the existing scoped secret store — reusing the Phase 3
primitive, not a new mechanism.

Scopes:

```text
chat.completions   models.read   usage.read
providers.read     providers.write
proxies.read       proxies.write
routes.read        routes.write
admin
```

The Phase 6 `api:token` becomes the bootstrap **admin** identity, preserved for
backward compatibility. A client key grants only `chat.completions`,
`models.read`, and optionally `usage.read` by default.

**Blast radius requirement**: a compromised OpenCode key must not reach Hermes,
Antigravity, provider credentials, proxy passwords, or admin authority. Proven by
an adversarial test that authenticates with a chat-scope key and asserts `403` on
every management route and `404` on every hypothetical credential path.

Rotation replaces the secret and keeps the identity. Revocation is immediate and
survives restart. Audit records metadata only — identity id, scope used, outcome —
never the key.

## 8. 9D — Custom Provider Production Completeness

Custom providers are first-class and remain **untrusted**.

New provider kind `custom-openai` plus a safe header allowlist. Headers are the
sharp edge, so the rules are explicit:

- Allowlist by name pattern `^[A-Za-z][A-Za-z0-9-]{0,63}$`, value printable ASCII
  ≤ 1024 chars, ≤ 8 headers.
- **Denylist enforced after allowlist**: `authorization`, `proxy-authorization`,
  `host`, `cookie`, `set-cookie`, `content-length`, `transfer-encoding`,
  `connection`, `upgrade`, and anything starting `sec-` or `proxy-`.
- A denied header is a `400`, never silently dropped.

Egress policy (this is also 9F's SSRF work, owned here for provider URLs):

- Resolve the hostname and reject loopback, link-local (`169.254/16`, `fe80::/10`),
  private (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), CGNAT (`100.64/10`),
  multicast, and cloud metadata (`169.254.169.254`, `metadata.google.internal`).
- **Loopback is allowed only when explicitly opted in per provider**, because local
  model runtimes are a first-class BAYZ use case. Default is deny.
- Re-check after DNS resolution, immediately before connect, to close the
  resolve-then-connect race as far as Node permits.
- `redirect: "error"` is already correct in `packages/providers/src/http.ts:118`;
  the plan adds the same posture to `packages/router/src/transport.ts`.

## 9. 9E — Multi-Provider + Multi-Proxy Easy UX

**Release requirement.** Backend support is not enough.

The architectural change: proxy assignment moves from route-only to a
**provider-level default with route-level override**. Migration v7 adds
`providers.proxy_id`. Resolution order at dial time: route override → provider
default → direct. This is what makes "assign one proxy to forty providers" one
action instead of forty.

API additions:

```text
POST /api/proxies/:id/assign     { providerIds: string[] }   bulk assign
POST /api/proxies/:id/unassign   { providerIds: string[] }   bulk to direct
GET  /api/proxies/:id/usage      safe "used by N" metadata
```

Dashboard flows, each an owning task:

- Create/edit/delete proxy for both SOCKS5 and HTTP CONNECT.
- Write-only password field, cleared on submit (matching the Phase 7 pattern).
- Test connection with a real result and measured latency, or an explicit "not
  measured".
- Multi-select provider list with select-all and select-filtered.
- One-action assign of a proxy to the selection, and one-action revert to Direct.
- Each provider row shows its effective proxy and whether it is inherited or
  overridden.
- Each proxy row shows "used by N providers, M routes".
- Disabled and degraded proxy states render distinctly, monochrome only.
- No config-file editing for any normal operation.

Flux Core is **not** touched by this subprogram beyond receiving proxy identity it
already accepts.

## 10. 9F — Fortress Security Expansion

### Root key and secret custody

- Real OS-backed key providers where the platform genuinely offers one: DPAPI
  (Windows), Keychain (macOS), Secret Service (Linux desktop). **Termux/Android has
  no such facility available to Node**, so on this device the provider stays
  `available = false` and the plan says so rather than faking it.
- Root key rotation already exists (`rotateRootKey`); the plan adds an operator
  surface, a rotation audit record, and a stale-key detection test.
- Per-credential rotation and revocation with cryptographic erasure semantics:
  deleting the DEK makes the ciphertext unrecoverable, which is the honest
  guarantee. The plan does not claim secure overwrite on flash storage.
- Encrypted export/import for backup, with a distinct passphrase and a documented
  threat model.

### Tamper and rollback

- Migration integrity: a hash chain over applied migration versions, detecting a
  database whose `user_version` was edited.
- Config integrity: an HMAC over the provider/proxy/route registry, detecting
  out-of-band edits.
- **Anti-rollback is bounded honestly**: without trusted monotonic storage, an
  attacker with write access can restore an older `bayz.db` wholesale. The plan
  adds detection (a monotonic counter in `runtime_metadata` plus a warning), and
  states plainly that prevention is impossible here.

### Credential access

- `withCredential` scope narrowed so plaintext exists only inside header
  construction.
- Credential-use audit: metadata only — which provider, which operation, outcome.
- **No claim of memory zeroization.** Buffers are filled with zeros where they are
  `Buffer`s; JavaScript strings cannot be wiped, and the plan says so.

### Remote posture ladder

Three postures, selected by bind address, each failing closed:

| Posture | Bind | Mandatory |
|---|---|---|
| `loopback` | `127.0.0.1`, `::1` | token |
| `lan` | private range | token + TLS + tightened limits + no admin scope over the wire |
| `remote` | anything else | token + TLS + mTLS *or* request signing + strict limits + explicit opt-in |

Binding to a less-trusted interface **must never silently keep the loopback
posture**. Absent mandatory protection is a startup failure, not a warning.

### Network and egress

SSRF policy (9D), DNS-rebinding re-check at connect, redirect refusal, proxy pivot
prevention (a proxy target may not itself be a BAYZ instance), header
sanitisation, and an outbound concurrency cap — the last closing gap 8.

## 11. 9G — Agent / Tool Injection Security

**Model output is untrusted data. Prompt injection is not the security boundary.**

The pipeline:

```text
model output → JSON parse → schema validation → capability lookup
             → client scope check → allowed operation
```

There is no capability that reads a secret. A prompt saying "read all provider API
keys" fails because no such capability is registered, not because the model was
asked not to. New package `packages/capability` holds the registry; a source-scan
test asserts no capability handler imports `SecretStorage`.

Adversarial tests cover: a tool call naming a non-existent capability, a tool call
whose arguments contain a path traversal, a model emitting a tool call the client
never declared, a tool result claiming elevated scope, and a nested tool call
attempting recursion beyond a bounded depth.

## 12. 9H — Mandatory Client Compatibility Matrix

Release-blocking for the Core 3 plus generic OpenAI.

**Measured device reality**: `opencode` is present on this machine
(`/usr/local/bin/opencode`). `antigravity`, `hermes`, `cline`, and `aider` are
**absent** and cannot be executed here. A `command -v continue` hit is the **shell
builtin**, not the Continue client — it is not installed, and treating that hit as
a present client would have been a measurement error.

Every matrix cell records exactly one of `PASS`, `FAIL`, `UNVERIFIED`, `N/A`.
`UNVERIFIED` is never collapsed into `PASS`. A cell may only read `PASS` with a
command transcript or a smoke-script check number attached.

Capabilities per client: configure, authenticate, list models, chat, stream, tool
call, tool result roundtrip, large request, cancel, error surface, custom provider,
proxy-bound route, combo, failover, restart/reconnect, key revoke/rotate.

## 13. 9I — Fuzz / Chaos / Load / Soak

Fuzz targets, each with a seeded corpus and a crash-free assertion: API request
schemas, `Authorization` parsing, SSE framing, tool-call arguments, provider
responses, provider configs, proxy configs, SOCKS5/CONNECT handshake bytes,
telemetry events, storage envelopes, migration ladders, URLs, and identifiers.

Chaos scenarios: provider death mid-request, proxy death mid-handshake, connection
reset, partial SSE, DNS failure, timeout, credential revoked mid-operation,
malformed response, BAYZ restart mid-stream, SQLite reopen, injected storage
failure.

Load and soak report **measured numbers on the actual device**, with the device
named: Termux/Android ARM64, 8 logical CPUs, Node v24.19.0. No capacity figure is
stated without a transcript, and 9L Task 4 enforces that mechanically across every
tracked document. Soak watches heap, RSS, socket count, timer count, file
descriptors, database size, and telemetry row count over a documented duration.

## 14. 9J — Cross-Platform / Packaging / Upgrade

Target matrix: Linux x64, Linux ARM64, Termux/Android ARM64, Windows x64, Windows
ARM64, macOS x64, macOS ARM64.

**Only Termux/Android ARM64 can be tested here.** Every other platform is
`UNVERIFIED` until a real machine or CI runner produces a transcript. The plan
provides the CI workflow that would produce those transcripts and forbids marking
a platform `PASS` without one.

Zero native runtime dependencies is already true and was measured, not assumed:
the 86-package runtime closure contains no `.node` binary, no `hasInstallScript`
entry, and no `os`/`cpu` restriction. The 53 platform-restricted packages and the
two install-scripted ones (`esbuild`, `fsevents`) are reachable only through
`vite`, a dev dependency. The plan adds a test pinning the closure size and these
properties, so a future dependency cannot quietly break Termux.

Packaging is not simply `npm pack`. All nine workspace packages are `private: true`
with no `license` field and depend on each other at version `0.1.0`, which resolves
only through workspace links — so a per-package `npm pack` produces a tarball that
cannot install anywhere. A measured dry run of `@bayz/server` also ships all 14 of
its `test/*.ts` files, because no `files` field exists. BAYZ therefore ships as a
**single self-contained artifact** declaring only the five external dependencies,
with the `@bayz/*` code included as compiled output. 9J Task 4 owns this.

Packaging: `npm pack` tarball plus a documented install path, no shell assumption
that breaks Windows (no bare `sh` in any script a user runs), data directory and
permission verification, restart and DB reopen, migration from every prior schema
version v1 to the Phase 9 head read from the migration table, corrupted config
recovery, and uninstall data-ownership semantics.

## 15. 9K — Supply Chain / Release Integrity

Preserve the five-runtime-dependency philosophy. No dependency is added to satisfy
a checklist item where the standard library suffices.

**Measured tool reality**: `openssl` and `gpg` are present on this device; `syft`,
`cyclonedx`, and `cosign` are **absent**. The SBOM is therefore generated by a
repository script from `package-lock.json`, and signing is specified against
`openssl`/`gpg` with an operator-supplied key that is never stored in the tree.

- `npm audit` with a documented acceptance policy.
- Lockfile integrity check in CI.
- License inventory for the full closure.
- Secret scan of the release artifact.
- SBOM in CycloneDX JSON, generated from the lockfile by a script in this repo —
  not a new dependency.
- Provenance and signing: the plan specifies detached signatures over the tarball
  and a documented verification command. It does **not** claim reproducible builds,
  which the vite/rolldown chain does not currently guarantee.
- Native binary inventory asserting runtime closure stays native-free.
- An unexpected-network check: the test suite runs with egress blocked and must
  still pass, proving no test depends on the internet.

## 16. 9L — Final Feature Completeness Gate

A feature reaches `PASS` only with real end-to-end proof. Explicitly insufficient:
backend exists but UI cannot reach it; UI exists but the action is inert; a unit
test mocks the boundary that matters; documentation asserts it; a protocol is
theoretically compatible; it worked in an earlier implementation.

The gate document is a table of every feature in §17 with its evidence citation —
smoke check number, test name, or transcript path — and one of `PASS`, `FAIL`,
`UNVERIFIED`, `N/A`.

## 17. Release feature inventory

Twenty-seven features. This list is the authoritative row set for the 9L gate
document, and `tests/feature-gate-integrity.test.mjs` asserts the gate has exactly
these rows — no fewer, so a feature cannot be quietly dropped, and no more, so a
row cannot be invented to pad the table.

| # | Feature | Owning subprogram |
|---|---|---|
| 1 | Foundation | Phase 1 |
| 2 | Secure storage | Phase 2 / 9F |
| 3 | Provider manager | Phase 3 |
| 4 | Custom providers | 9D |
| 5 | Model discovery | Phase 3 / 9D |
| 6 | Proxy manager | Phase 4 |
| 7 | HTTP CONNECT | Phase 4 |
| 8 | SOCKS5 | Phase 4 |
| 9 | Multi-provider proxy | 9E |
| 10 | Easy proxy UX | 9E |
| 11 | Routing | Phase 5 |
| 12 | Combo | Phase 5 |
| 13 | Failover | Phase 5 / 9B |
| 14 | OpenAI-compatible API | Phase 6 / 9A |
| 15 | Authentication | Phase 6 / 9C |
| 16 | Streaming | 9B |
| 17 | Tool / function calling | 9B / 9G |
| 18 | Usage telemetry | Phase 8 |
| 19 | Flux Core live data | Phase 8 |
| 20 | Provider constellation | Phase 7 |
| 21 | Client integrations | 9H |
| 22 | Per-client security | 9C |
| 23 | Fortress security | 9F |
| 24 | Restart / persistence | Phase 2 / 9J |
| 25 | Packaging | 9J |
| 26 | Upgrade | 9J |
| 27 | Cross-platform qualification | 9J |

Rows 1–3, 5–8, 11–12, 18–20, and 24 carry Phase 1–8 evidence already and enter the
gate at their existing verified status. Every row whose owning subprogram is a 9x
enters the gate as `UNVERIFIED` until that subprogram produces a citation.

## 18. Locks and prohibitions

- **Flux Core V2 is visually LOCKED.** Real bugs, lifecycle faults, and measured
  performance problems may be fixed. Polish redesign may not.
- **No client name in the runtime protocol path.** Enforced by source scan.
- **No credential read path, ever.** The existing getter scan extends to every new
  package.
- **No content persistence.** The Phase 8 sentinel drill extends to streaming
  chunks and tool-call arguments.
- **GitHub push is prohibited.** The private `B-Router` remote is not added, not
  configured, and not pushed during Phase 9. Push requires: implementation
  complete, feature gate complete, security gate complete, clean tree, verified
  release candidate, and an explicit user instruction.

## 19. Status vocabulary

Used consistently across every Phase 9 document:

- **IMPLEMENTED** — code exists and its unit tests pass.
- **VERIFIED** — proven end to end against real components, with cited evidence.
- **UNVERIFIED** — cannot be proven in the available environment. Never upgraded
  without new evidence.
- **N/A** — not applicable to that platform or client.

## 20. Verification commands

Every plan uses these exact commands:

```bash
npm run test --workspace @bayz/<pkg>
npm run build --workspace @bayz/<pkg>
npm run runtime:test
npm run runtime:verify
node --test tests/runtime-structure.test.mjs
node scripts/<name>-smoke.mjs
git diff --check
```

## 21. Gate scripts

Each gate owns exactly one rule set and is composed, never duplicated, by 9L. All
support `--report` (always exit 0) and `--enforce` (exit non-zero on a blocking
row), so a gate can be inspected without being a build break.

```text
scripts/client-gate.mjs        9H  Core 3 client compatibility
scripts/resilience-gate.mjs    9I  fuzz / chaos / load / soak
scripts/platform-gate.mjs      9J  platform matrix, primary platform mandatory
scripts/supply-chain-gate.mjs  9K  audit / lockfile / licence / SBOM / signing
scripts/release-gate.mjs       9L  aggregate of the four above plus feature gate
```

A missing gate script is a `FAIL` in the aggregate, never a skip. An absent gate
must not read as a pass.

## 22. Release documents produced

```text
docs/superpowers/2026-08-27-bayz-client-compatibility-matrix.md   9H
docs/superpowers/2026-08-27-bayz-resilience-report.md             9I
docs/superpowers/2026-08-27-bayz-platform-matrix.md               9J
docs/superpowers/2026-08-27-bayz-ci-notes.md                      9J
docs/superpowers/2026-08-27-bayz-supply-chain-policy.md           9K
docs/superpowers/2026-08-27-bayz-license-inventory.md             9K
docs/superpowers/2026-08-27-bayz-supply-chain-report.md           9K
docs/superpowers/2026-08-27-bayz-feature-completeness-gate.md     9L
docs/superpowers/2026-08-27-bayz-release-readiness.md             9L
docs/clients/{opencode,antigravity,hermes,generic-openai}.md      9H
docs/install.md                                                   9J
docs/release-verification.md                                      9K
```

Every one of these is a *generated or evidence-cited* document. None of them may
assert a status that a gate cannot resolve to a citation.

## 23. Open decisions requiring a user answer

Planning surfaced two questions that cannot be answered by inspecting the
repository. Neither blocks planning; both block the subprogram that needs them, and
each is recorded as `UNVERIFIED` rather than guessed.

1. **Licence identifier.** There is no `LICENSE` file, the root `package.json` has
   no `license` field, and all nine workspace packages declare none. They are all
   `private: true`, so npm has never complained — but 9J produces a distributable
   tarball, and an unlicensed artifact is legally unusable by whoever downloads it.
   9K Task 3 blocks on this rather than picking one.
2. **Signing key custody.** 9K Task 5 specifies detached signatures with an
   operator-supplied key that is never stored in the tree, and refuses to run if the
   key path is inside the repository. Whether a release is signed at all, and with
   whose key, is the user's call. An unsigned local build is normal and is reported
   `UNVERIFIED: unsigned build`, never conflated with a signed release.

## 24. Honest boundaries this program will not cross

Collected in one place so a later phase cannot quietly promise them. Each is
established in the subprogram noted.

| Boundary | Why | Owner |
|---|---|---|
| No mid-stream failover | Once a byte reaches the client, the response is committed | 9B |
| No memory wiping | JavaScript strings cannot be overwritten; `Buffer`s are zeroed where they exist | 9F |
| No secure overwrite on disk | Flash storage cannot be overwritten from Node; erasure is cryptographic | 9F |
| No rollback *prevention* | Requires trusted monotonic storage this device lacks; detection only | 9F |
| No OS keystore on Termux/Android | No `secret-tool`, `security`, or `keyctl` available to Node here | 9F |
| No DNS-rebinding elimination | Re-check before connect narrows the window; Node cannot close it | 9D |
| No reproducible build claim | The `vite`/`rolldown` chain does not guarantee it | 9K |
| No prompt-injection filtering | Injection is not the boundary; the capability registry is | 9G |
| No `PASS` for an untested platform or client | Six of seven platforms and two of three Core clients cannot run here | 9H, 9J |

`tests/no-fabrication.test.mjs` (9L Task 4) enforces that no tracked document
claims any of these, while permitting the documents that *refuse* them — including
this table.
