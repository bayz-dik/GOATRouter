# BAYZ feature completeness gate — Phase 9L

- Device: Termux/Android ARM64 (Ubuntu proot), 8 CPUs, 11.0 GiB RAM
- Node: v24.19.0 (arm64), npm 11.17.0
- Written: 2026-08-30 (Phase 9L Task 2)

Twenty-nine features, from spec §17 plus the two §25.5 additions. One row each — no fewer, so a
feature cannot be quietly dropped, and no more, so a row cannot be invented to pad the table.
`tests/feature-gate-integrity.test.mjs` and `scripts/feature-gate.mjs` both enforce that row set.

**This document does not decide anything.** `scripts/feature-gate.mjs --enforce` reads it, resolves
every `PASS` citation against the repository, and exits non-zero on any `FAIL`, any `UNVERIFIED`, any
`PASS` whose evidence does not resolve, and any row that breaks the rules below. Unlike the
supply-chain gate, this one has **no advisory exemption list**: it is the final gate, so a row that
cannot be proven blocks the release rather than being noted and waved through.

## What the columns mean

| column | meaning |
|---|---|
| backend | the capability exists in the runtime and is proven by real components |
| UI reachability | see the definition below — this column is where "backend exists but nothing can reach it" gets caught |
| end-to-end evidence | one citation, resolved by `scripts/evidence.mjs`, that proves the feature as a whole |
| overall | `PASS` only if backend is `PASS`, UI reachability is not `FAIL`/`UNVERIFIED`, and the evidence resolves |

**UI reachability is `PASS`** when a dashboard panel exposes the action *and* a test drives that
panel's DOM to reach it. **`N/A`** when the feature has no user-facing action by design — either it is
infrastructure with no control surface, or it engages automatically, or it is a client-facing protocol
capability the dashboard deliberately does not offer. Every `N/A` carries its reason below, because
`N/A` used as a way to avoid measuring is exactly the failure this column exists to catch.

## Rules, and why each one exists

Straight from spec §16's list of what is explicitly insufficient for a `PASS`:

1. **Backend `PASS` + UI reachability `FAIL`/`UNVERIFIED` cannot be overall `PASS`.** "A backend
   exists but no UI can reach it" is the first insufficiency named, and it is the one where both
   halves look green in isolation.
2. **A `PASS` on a feature whose subprogram ships a smoke script must cite `smoke:` or
   `transcript:`.** "A unit test mocks the boundary that matters" is the third insufficiency, and the
   only mechanical way to enforce it is to demand the citation form that implies a real run.
   `scripts/feature-gate.mjs` reads which subprograms have scripts from `scripts/*-smoke.mjs` rather
   than a hand-kept list.
3. **No two features may share an evidence reference.** One transcript proving one thing cannot prove
   two, and a shared citation is how a row takes credit for work done elsewhere.
4. **A missing or extra row is a violation, not a silent pass.** Every per-row rule above would pass
   by having nothing to check.

## Verdicts

| feature | owning subprogram | backend | UI reachability | end-to-end evidence | overall |
|---|---|---|---|---|---|
| Foundation | Phase 1 | PASS | N/A | smoke:api#1 | PASS |
| Secure storage | Phase 2 / 9F | PASS | PASS | smoke:storage#7 | PASS |
| Provider manager | Phase 3 | PASS | PASS | smoke:provider#1 | PASS |
| Custom providers | 9D | PASS | PASS | smoke:custom-provider#2 | PASS |
| Model discovery | Phase 3 / 9D | PASS | PASS | smoke:provider#9 | PASS |
| Proxy manager | Phase 4 | PASS | PASS | smoke:proxy#1 | PASS |
| HTTP CONNECT | Phase 4 | PASS | PASS | smoke:proxy#13 | PASS |
| SOCKS5 | Phase 4 | PASS | PASS | smoke:proxy#16 | PASS |
| Multi-provider proxy | 9E | PASS | PASS | smoke:proxy-ux#13 | PASS |
| Easy proxy UX | 9E | PASS | PASS | smoke:proxy-ux#23 | PASS |
| Routing | Phase 5 | PASS | PASS | smoke:router#3 | PASS |
| Combo | Phase 5 | PASS | N/A | smoke:client-conformance#46 | PASS |
| Failover | Phase 5 / 9B | PASS | N/A | smoke:router#18 | PASS |
| OpenAI-compatible API | Phase 6 / 9A | PASS | N/A | smoke:api#25 | PASS |
| Authentication | Phase 6 / 9C | PASS | PASS | smoke:api#5 | PASS |
| Streaming | 9B | PASS | N/A | smoke:stream#5 | PASS |
| Tool / function calling | 9B / 9G | PASS | N/A | smoke:stream#37 | PASS |
| Usage telemetry | Phase 8 | PASS | PASS | smoke:usage#13 | PASS |
| Flux Core live data | Phase 8 | PASS | PASS | smoke:usage#55 | PASS |
| Provider constellation | Phase 7 | PASS | PASS | smoke:dashboard#33 | PASS |
| Client integrations | 9H | PASS | N/A |  | UNVERIFIED |
| Per-client security | 9C | PASS | PASS | smoke:identity#14 | PASS |
| Fortress security | 9F | PASS | N/A | smoke:security#27 | PASS |
| Restart / persistence | Phase 2 / 9J | PASS | N/A | smoke:install#43 | PASS |
| Packaging | 9J | PASS | N/A | smoke:install#3 | PASS |
| Upgrade | 9J | PASS | N/A | smoke:upgrade#3 | PASS |
| Cross-platform qualification | 9J | PASS | N/A |  | UNVERIFIED |
| Free-first model discovery | 9D | PASS | PASS | smoke:custom-provider#12 | PASS |
| Free-only routing | 9E | PASS | PASS | smoke:proxy-ux#83 | PASS |

**27 `PASS`, 0 `FAIL`, 2 `UNVERIFIED`.** `--enforce` therefore exits **non-zero**, and that is the
correct result: two features genuinely are not proven, and adjusting a status to make the gate pass is
the one thing the plan forbids.

## Why each non-`PASS` verdict is what it is

#### Client integrations

`UNVERIFIED` overall, and this is the honest state of a genuinely large body of completed work.
`opencode` is `VERIFIED` on 16 of 17 capabilities (`models.list` `UNVERIFIED` because the client does
not use that surface) and `hermes` on 17 of 17, both driven as **real binaries** against a real BAYZ
listener with transcripts under `docs/transcripts/`. But `antigravity` is a **Core 3** client and is
absent from this host — `command -v antigravity` finds nothing — so every one of its cells is
`UNVERIFIED` and `scripts/client-gate.mjs --enforce` exits 1. The Core 3 are release-blocking by
decision, so the feature cannot be `PASS` while one of them has never been run. UI reachability is
`N/A`: the clients are external processes, and BAYZ's own dashboard is not one of them.

#### Cross-platform qualification

`UNVERIFIED` overall. The Termux/Android ARM64 row is 11/11 `PASS` against the real installed
artifact, and the other six platform rows have never been executed — no runner exists, and
`.github/workflows/platform-matrix.yml` is committed but inert because no remote is configured and
Phase 9 prohibits pushing. The backend is `PASS` because the closure is genuinely native-free (no
install script, no `gypfile`, no `libc` constraint, no `os`/`cpu` restriction anywhere in the runtime
closure), which makes the code *plausibly* portable and proves nothing about any particular machine.
UI reachability is `N/A`: qualification is a property of a platform, not an action in a panel.

#### Foundation

UI reachability `N/A`. The foundation is the runtime skeleton — configuration loading, the listener,
the database open path — and has no control surface of its own; every panel in the dashboard depends
on it, and none of them *is* it.

#### Combo

UI reachability `N/A`, because combo is not something a user switches on. A route with two or more
eligible providers routes in combo mode automatically (`packages/router/src/router.ts`:
`eligible.length >= 2 ? "combo" : "direct"`), so there is no action to reach. What the dashboard does
offer is the *consequence*: the Flux Core renders `routingMode: "combo"` and marks combo members, and
`apps/dashboard/test/flux-dense.test.tsx` drives that at 5 and 12 providers.

#### Failover

UI reachability `N/A` for the same reason — failover is automatic on a failing primary, not a button.
Its *configuration* is reachable: `RoutesPanel` edits per-route priority, which is the order failover
walks. Marking this column `PASS` on the strength of a priority field would be claiming the failover
action itself is reachable, which it is not and should not be.

#### OpenAI-compatible API

UI reachability `N/A`. The `/v1` surface exists for external clients; the dashboard talks to the
management API at `/api` instead, deliberately, because the dashboard is not a chat client and
routing it through the OpenAI-compatible path would mean giving it a client identity. The dashboard's
own test chat is a separate, smaller thing — see Streaming below.

#### Streaming

UI reachability `N/A`, and this one is a deliberate refusal rather than an omission.
`apps/dashboard/src/panels/ChatPanel.tsx` offers **no** streaming control, and its comment says why:
the management chat endpoint rejects `stream`, so a toggle there would advertise a capability that
surface does not have. Streaming is a gateway capability for real clients, and it is verified as one
— 63/63 in `scripts/stream-smoke.mjs`, plus `stream` `VERIFIED` for both `opencode` and `hermes` from
their own transcripts.

#### Tool / function calling

UI reachability `N/A`. Tool calling is a protocol capability between a client and a model; the
dashboard is neither, and there is no tool UI to reach. It is verified where it lives: a three-turn
tool roundtrip over real SSE in `stream-smoke`, and `tool result roundtrip` `VERIFIED` for both real
clients. 9G's capability boundary is verified separately at 179/179.

#### Fortress security

UI reachability `N/A`. TLS, mTLS, request signing, and the outbound concurrency cap are deployment
configuration read at start-up — a bind that requires TLS and does not have it refuses to start,
which is not a thing a panel can do. Root-key rotation and credential revocation are API operations
with no dashboard control today; `IdentitiesPanel` reaches the *client-key* half of that surface,
which is the Per-client security row.

#### Restart / persistence

UI reachability `N/A`. Persistence across a restart is a property of the process and its database,
observable but not actionable from a panel. It is proven twice over: every Phase 2–5 smoke reopens the
database **in a separate process** and reads its secrets back, and `install-smoke` restarts the real
installed service.

#### Packaging

UI reachability `N/A`. Installing the tarball is an operator action at a shell, and a dashboard that
could repackage itself would be a considerably worse idea than one that cannot. Proven where it
happens: `install-smoke` installs the real artifact under a prefix and drives first boot from it.

#### Upgrade

UI reachability `N/A`, for the same reason and with a sharper edge: a self-upgrading dashboard would
be a migration running with a browser tab as its transaction boundary. The upgrade ladder is proven
across every schema rung v1…v11 by `upgrade-smoke` against the real installed artifact.

## What this gate does not claim

- **`PASS` means the cited evidence resolves and the run behind it happened.** It does not mean the
  feature is bug-free, and it does not mean it was exercised on any platform other than this one.
- **The two `UNVERIFIED` rows are not soft failures.** Nothing is known about BAYZ under
  `antigravity`, or on Windows, macOS, or non-Termux Linux. That is a statement about what has been
  looked at, not a prediction.
- **UI reachability `PASS` covers the panel-to-API-client hop**, driven through the real DOM by
  `apps/dashboard/test/*.test.tsx`. The browser-to-server hop over a real socket is covered
  separately, by `dashboard-smoke` against the built bundle and by `usage-smoke`'s live Flux Core view
  model read from the real API — not by this column.
- **No row cites `.github/workflows/*`.** A workflow that has never executed is not evidence, and
  `tests/release-workflow.test.mjs` and `tests/ci-workflow.test.mjs` both enforce that.

## Reproduce

```
node scripts/feature-gate.mjs --report     # every row, and the not-verified list
node scripts/feature-gate.mjs --enforce    # exits non-zero today, correctly
node --test tests/feature-gate-integrity.test.mjs
```
