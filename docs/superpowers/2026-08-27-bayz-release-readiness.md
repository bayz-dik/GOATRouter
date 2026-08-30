# BAYZ release readiness statement — Phase 9L Task 6

> **Generated, not written.** Every table below is produced by `scripts/readiness.mjs` from each
> subprogram's own parser and policy. Do not hand-edit this file: `tests/readiness.test.mjs`
> asserts that regenerating reproduces it byte for byte, so an edit here fails the suite rather
> than quietly disagreeing with the gate it summarises. To change a verdict, change the evidence.

- Device: Termux/Android ARM64 (Ubuntu proot), 8 CPUs, 11.0 GiB RAM
- Node: v24.19.0 (arm64)
- Generator: `node scripts/readiness.mjs --write`

## What this document is, and what it is not

This is a summary of **what the matrices and reports say**, and of whether each gate's own policy
accepts them. It runs no smoke script, no suite, and no `npm audit`.

That distinction is the point rather than a caveat. A document verdict answers "is the recorded
evidence sufficient and internally consistent?" A live run answers "does it still pass today?"
Collapsing the two would let a stale document read as a fresh measurement, which is precisely the
insufficiency spec §16 names. **Phase 9L Task 7 performs the live execution**, and its results are
recorded in `## Task 7 — live execution` below; until that section exists, no line in this file is
a claim about a run that happened today.

## Gate verdicts

Each row cites the policy test that mechanically enforces its gate's reading of its own document,
so a verdict here is something a reader can open rather than something they must take on trust.
9F cites a numbered check in `scripts/security-smoke.mjs` instead, because 9F has no gate script:
`scripts/release-gate.mjs` derives that row the same way, from the same smoke.

| gate | subprogram | verdict | evidence | blocking reasons |
|---|---|---|---|---|
| client compatibility | 9H | BLOCKED | test:tests/client-gate.test.mjs | 18: opencode/models.list: UNVERIFIED; antigravity/configure: UNVERIFIED |
| resilience | 9I | BLOCKED | test:tests/resilience-report.test.mjs | 2: chaos/read-only database injection: UNVERIFIED in a blocking section (chaos); chaos/disk exhaustion: UNVERIFIED in a blocking section (chaos) |
| platform qualification | 9J | PASS | test:tests/platform-gate.test.mjs | — |
| supply chain (document only) | 9K | PASS | test:tests/supply-chain-report.test.mjs | — |
| feature completeness | 9L | BLOCKED | test:tests/feature-gate-integrity.test.mjs | 2: Client integrations: UNVERIFIED; Cross-platform qualification: UNVERIFIED |
| security posture (derived) | 9F | PASS | smoke:security#6 | — |

**3 of 6 gates block:** client compatibility, resilience, feature completeness.

The aggregate runner `scripts/release-gate.mjs --enforce` therefore exits non-zero while any row
above is `BLOCKED`. That is the gate working. A status is never adjusted to make it pass.

## Feature inventory

27 `PASS`, 0 `FAIL`, 2 `UNVERIFIED` across 29 features.
Authoritative record: `docs/superpowers/2026-08-27-bayz-feature-completeness-gate.md`.

## Everything currently `UNVERIFIED`

Read through each subprogram's own parser by `scripts/release-gate.mjs`'s `collectUnverified()`,
so this list cannot disagree with what the aggregate gate prints. **This is the honest
release-notes content**: each entry is a thing nobody has looked at, not a thing known to be broken.
`UNVERIFIED` is never rolled up into a pass, a percentage, or a readiness score.

67 entries.

| source | item | reason |
|---|---|---|
| 9H opencode | models.list | The client never calls `GET /v1/models`: it offers the models listed in its own config `models` map, so BAYZ's discovery endpoint is not exercised by this client at all. A full `opencode models bayz` run recorded zero such requests. Not a B |
| 9H antigravity | configure | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, an |
| 9H antigravity | authenticate | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, an |
| 9H antigravity | models.list | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, an |
| 9H antigravity | chat | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, an |
| 9H antigravity | stream | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, an |
| 9H antigravity | tool call | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, an |
| 9H antigravity | tool result roundtrip | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, an |
| 9H antigravity | large request | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, an |
| 9H antigravity | cancel | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, an |
| 9H antigravity | error surface | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, an |
| 9H antigravity | custom provider | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, an |
| 9H antigravity | proxy-bound route | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, an |
| 9H antigravity | combo | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, an |
| 9H antigravity | failover | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, an |
| 9H antigravity | restart/reconnect | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, an |
| 9H antigravity | key revoke/rotate | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, an |
| 9H antigravity | free-only routing | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, an |
| 9H generic-openai | proxy-bound route | Not exercised by the conformance harness; needs a real CONNECT proxy fixture, which 9H Task 4 owns. |
| 9H generic-openai | restart/reconnect | Not exercised by the conformance harness; needs a client surviving a real listener restart — 9H Task 4/5. |
| 9H continue | configure | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| 9H continue | authenticate | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| 9H continue | models.list | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| 9H continue | chat | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| 9H continue | stream | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| 9H continue | tool call | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| 9H continue | tool result roundtrip | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| 9H continue | large request | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| 9H continue | cancel | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| 9H continue | error surface | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| 9H continue | custom provider | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| 9H continue | proxy-bound route | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| 9H continue | combo | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| 9H continue | failover | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| 9H continue | restart/reconnect | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| 9H continue | key revoke/rotate | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| 9H continue | free-only routing | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| 9H cline | configure | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| 9H cline | authenticate | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| 9H cline | models.list | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| 9H cline | chat | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| 9H cline | stream | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| 9H cline | tool call | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| 9H cline | tool result roundtrip | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| 9H cline | large request | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| 9H cline | cancel | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| 9H cline | error surface | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| 9H cline | custom provider | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| 9H cline | proxy-bound route | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| 9H cline | combo | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| 9H cline | failover | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| 9H cline | restart/reconnect | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| 9H cline | key revoke/rotate | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| 9H cline | free-only routing | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| 9I chaos | read-only database injection | `chmod 0444` does not prevent writes for this process — root under Termux/proot, and `paths.ts:56` documents that Android and FAT-derived mounts may not honour POSIX modes. The `storage_unavailable` path is covered by `@bayz/storage` unit t |
| 9I chaos | disk exhaustion | No bounded filesystem is available: `mount -t tmpfs` exits **0** under proot while mounting nothing, leaving the mount point inaccessible. An earlier version of this scenario passed on a `storage_unavailable` raised by a vanished directory; |
| 9I soak | 2-hour long mode | `--long` is implemented and documented but has not been run on this device. A two-hour foreground run cannot be supervised here, and the host is documented to stall for up to 184 s at load average 0.12 (`scripts/fuzz/host-baseline.mjs`), wh |
| 9J | Linux x64 | 11 cell(s) UNVERIFIED: install, first boot, schema create, chat, stream, proxy, dashboard serve, restart, upgrade from v1, data dir permissions, uninstall |
| 9J | Linux ARM64 | 11 cell(s) UNVERIFIED: install, first boot, schema create, chat, stream, proxy, dashboard serve, restart, upgrade from v1, data dir permissions, uninstall |
| 9J | Windows x64 | 11 cell(s) UNVERIFIED: install, first boot, schema create, chat, stream, proxy, dashboard serve, restart, upgrade from v1, data dir permissions, uninstall |
| 9J | Windows ARM64 | 11 cell(s) UNVERIFIED: install, first boot, schema create, chat, stream, proxy, dashboard serve, restart, upgrade from v1, data dir permissions, uninstall |
| 9J | macOS x64 | 11 cell(s) UNVERIFIED: install, first boot, schema create, chat, stream, proxy, dashboard serve, restart, upgrade from v1, data dir permissions, uninstall |
| 9J | macOS ARM64 | 11 cell(s) UNVERIFIED: install, first boot, schema create, chat, stream, proxy, dashboard serve, restart, upgrade from v1, data dir permissions, uninstall |
| 9K | signature | **Unsigned local build, which is the normal and expected state here.** No long-lived signing key exists in this repository, its history, or on this host; the owner's decision is keyless Sigstore-style provenance through GitHub OIDC, which r |
| 9K | determinism | Measured per artifact class, with **no reproducible-build claim**: release tarball `PASS` (two packs byte-identical), SBOM `PASS` (two generations identical at a pinned timestamp), build-machine identity `PASS` (8 shipped files scanned, no  |
| 9L feature | Client integrations | `UNVERIFIED` overall, and this is the honest state of a genuinely large body of completed work. |
| 9L feature | Cross-platform qualification | `UNVERIFIED` overall. The Termux/Android ARM64 row is 11/11 `PASS` against the real installed |

## Must not be described as supported

### Platforms

Qualifying device: **Termux/Android ARM64** — the only platform with evidence.

- **Linux x64** — do not describe as supported.
- **Linux ARM64** — do not describe as supported.
- **Windows x64** — do not describe as supported.
- **Windows ARM64** — do not describe as supported.
- **macOS x64** — do not describe as supported.
- **macOS ARM64** — do not describe as supported.

Nothing has been executed on any of these. That is a statement about what has been *observed*,
not a claim that BAYZ is broken there: the runtime closure is native-free, which makes the code
plausibly portable and proves nothing about any particular machine.

### Clients

- **opencode** — do not describe as working: 1 of 17 capabilities are `BLOCKED` or `UNVERIFIED`.
- **antigravity** — do not describe as working: 17 of 17 capabilities are `BLOCKED` or `UNVERIFIED`.
- **generic-openai** — do not describe as working: 2 of 17 capabilities are `BLOCKED` or `UNVERIFIED`.
- **continue** — do not describe as working: 17 of 17 capabilities are `BLOCKED` or `UNVERIFIED`.
- **cline** — do not describe as working: 17 of 17 capabilities are `BLOCKED` or `UNVERIFIED`.

Acceptable at release **with a stated limit**, which is not the same as unsupported — each
`PARTIAL` cell carries evidence *and* a named limitation, enforced by `tests/matrix-integrity.test.mjs`:

- **generic-openai** — 2 of 17 capabilities `PARTIAL`. Read the limit before quoting support.

Release-blocking clients (the Core 3): opencode, antigravity, hermes. Per-client tallies below cover
the Core 3 only, because that is the set 9H's gate blocks on — `scripts/client-gate-lib.mjs`'s own
`assess()` produces them. The withheld list above covers **every** client in the matrix, including
the ones no gate blocks on, since an unmentioned client is the one somebody assumes is fine.

| client | VERIFIED | PARTIAL | BLOCKED | UNVERIFIED | N/A | missing |
|---|---|---|---|---|---|---|
| opencode | 16 | 0 | 0 | 1 | 0 | 0 |
| antigravity | 0 | 0 | 0 | 17 | 0 | 0 |
| hermes | 17 | 0 | 0 | 0 | 0 | 0 |

## Residual risk

Parsed from spec §24's own table rather than retyped, so this list cannot drift from the
normative one. Each is a boundary BAYZ **will not cross and does not claim to have crossed**;
`tests/no-fabrication.test.mjs` mechanically forbids any document claiming otherwise.

| boundary | why | owner |
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
| No guarantee you will never be charged | BAYZ classifies from provider metadata; a provider that misreports its own pricing is misclassified and BAYZ cannot detect it | 9D (§25) |

## When a GitHub push becomes permissible

All six conditions, simultaneously. A push is prohibited while any row reads `**NOT met**`.

| condition | state | detail |
|---|---|---|
| Implementation complete | met | 27 of 29 features PASS, 0 FAIL, 2 UNVERIFIED |
| This gate green | **NOT met** | blocked: client compatibility, resilience, feature completeness |
| Security gate green | met | derived from scripts/security-smoke.mjs; Task 7 executes it live |
| Clean tree | n/a | checked at Task 7, not recorded here — it is true only at an instant |
| Verified release candidate | **NOT met** | the release signature row is UNVERIFIED: no signing key exists here, and provenance needs a hosted workflow run |
| Explicit user instruction | **NOT met** | not given; absent it, Phase 9 ends at the local commit |

**3 conditions are not met**, so a push is prohibited: This gate green, Verified release candidate, Explicit user instruction.

No remote is configured, and `tests/phase9-locks.test.mjs` asserts that mechanically — including
that no remote is named `B-Router` and none points at a GitHub URL. Phase 9 ends at the local commit.

