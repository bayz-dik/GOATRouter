# Phase 9L — Final Feature Completeness Gate

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Spec:** `docs/superpowers/specs/2026-08-27-bayz-phase9-goat-release-design.md` §16, §17

**Depends on:** 9A, 9B, 9C, 9D, 9E, 9F, 9G, 9H, 9I, 9J, 9K — **all of them.** This is the gate, not a feature.

**Goal:** One document and one command that answer "is BAYZ actually done?" with evidence, where every `PASS` is defended by a citation and nothing can be talked into passing.

**Locks:** `UNVERIFIED` is never collapsed into `PASS`. Flux Core V2 remains visually LOCKED. GitHub push remains prohibited until this gate is green *and* the user explicitly instructs it.

**What is explicitly insufficient for a `PASS`** — restated from the spec because this is the whole point of the subprogram: a backend that exists but no UI can reach; a UI that exists but whose action is inert; a unit test that mocks the boundary that matters; documentation asserting it; theoretical protocol compatibility; and "it worked in an earlier implementation."

---

### Task 1 — Evidence vocabulary and citation checker

**Create:** `scripts/evidence.mjs`
**Test:** `tests/evidence.test.mjs`

**Interface produced:**
```js
export function parseEvidence(ref);   // -> { kind, target, number? } | undefined
export async function resolveEvidence(ref);  // -> { ok, reason }
```

- [x] RED `tests/evidence.test.mjs`: an evidence reference is exactly one of `smoke:<script>#<n>`, `test:<path>`, `test:<path>::<name>`, or `transcript:<path>`, and anything else is rejected; `resolveEvidence` **actually checks the referenced thing exists** — the smoke script file exists and emits at least `n` numbered checks, the test file exists and (for `::name`) contains that test name, the transcript file exists and is non-empty; a reference to a file outside the repository is rejected; a reference with `..` is rejected. — *20 tests. A fifth shape is in the union deliberately: `smoke:<script>#<n>-<m>`, a contiguous range, because a chaos scenario really does span numbered checks and the resilience report already cites eight of them. A **comma list** stays rejected — `smoke:load#4,9,14,19,24` makes a citation unfalsifiable, since no single check can be looked up to confirm or refute it. Traversal is rejected by `parseEvidence`, **not** by the regex: `[\w./-]+` matches `..`, and a test asserts the regex alone is insufficient so nobody later mistakes it for the boundary.*
- [x] RED same file: a citation that resolves to a file which exists but contains **zero** assertions is rejected — pointing at an empty test file must not launder a `PASS`. — *Exercised against a fixture written **inside** the repository, because a path outside it is refused earlier for a different reason and would never reach this rule. The same file with one real assertion is then accepted, so the rule is not simply refusing everything in a temp directory.*
- [x] Verify RED: `node --test tests/evidence.test.mjs` fails with `ERR_MODULE_NOT_FOUND`.
- [x] GREEN.
- [x] **Consolidation:** 9H Task 1, 9I Task 7, 9J Task 1, and 9K Task 8 each specify the same evidence-reference regex inline, because each was written to stand alone. Once `scripts/evidence.mjs` exists, refactor all four matrix-integrity tests to import `parseEvidence`/`resolveEvidence` from it and delete their local copies. Four copies of one regex will drift, and the copy that drifts will be the one guarding the claim that matters. Verify each of the four tests still exits 0 after the refactor. — *Done, and **the drift had already happened**: 9H's copy rejected the contiguous range 9I's report uses, and only 9K's accepted `::name`. `resilience-gate-lib.mjs` and `supply-chain-gate.mjs` re-export from the shared module rather than being edited at every call site, because their tests assert against `lib.EVIDENCE_RE`/`gate.EVIDENCE_RE`.*
- [x] Verify: `node --test tests/evidence.test.mjs` exits 0; `node --test tests/matrix-integrity.test.mjs`, `tests/resilience-report.test.mjs`, `tests/platform-matrix.test.mjs`, and `tests/supply-chain-report.test.mjs` all still exit 0. — *All five: 85/85. Root suite **363/363**. All four subordinate gates still `--report` exit 0.*
- [x] Commit — `test: add the Bayz evidence citation checker`

**Three real defects the consolidation found, none of which a regex could have found.**

- **Fifteen unresolvable citations in a shipped report.** Every `smoke:fuzz#…` row in the resilience report cites the script name `fuzz`, and the script is `scripts/fuzz-run.mjs`. Each previous copy of the rule was a pattern that never opened a file, so fifteen citations pointing at nothing had been sitting in the document. Fixed by teaching the resolver the `-run.mjs` convention, not by editing the rows — the citations name the right script, and it was the resolver that could not find it.
- **A citation to a file that does not exist, in the 9H matrix legend.** `transcript:docs/transcripts/opencode/chat.log` was the legend's illustrative example; the real transcript is `chat-stream.md`. Harmless as prose and a genuine problem as documentation, since it is the example a future author copies.
- **A `PASS`-shaped example in prose is not a claim.** The corpus scan initially read the 9H matrix's own sentence recording that `smoke:client-conformance#99` once passed for an unexercised capability — the sentence documenting the hole. Requiring *that* to resolve would force deleting the record of the defect to satisfy the test guarding against it. The scan now reads **table cells only**: a citation in a cell is a claim, the same string in prose is documentation.

**Two bounds `resolveEvidence` reports rather than hides.** A `smoke:` citation into a script publishing `docs/evidence/<script>.json` returns `bound: "manifest"` — the number is checked against the checks that really ran, and a per-capability citation against the check that really covers it. A script that numbers its checks but publishes no manifest returns `bound: "numbering-only"`, because the *upper* bound genuinely cannot be verified from disk. Refusing those would refuse eleven honest citations; silently accepting them would imply a guarantee nobody checked. A script emitting **no** numbered output is refused outright — `#n` cannot mean anything there.

**A consequence for the amendment below, and it did not survive contact with Task 2:** at Task 1's close `scripts/proxy-ux-smoke.mjs` printed `ok <label>` with no number, so `smoke:proxy-ux#N` could not resolve and the free-only routing row could not reach `PASS` by citation. A test pinned that state so it would become stale loudly. **It did.** Task 2 numbered `proxy-ux` and twelve sibling scripts, and the pinning test — whose subject the next task was expected to fix — was moved onto fixtures rather than deleted, so the rule survives without depending on any one script staying unnumbered. The free-only routing row now cites `smoke:proxy-ux#83`.


### Task 2 — Feature inventory document

**Create:** `docs/superpowers/2026-08-27-bayz-feature-completeness-gate.md`
**Test:** `tests/feature-gate-integrity.test.mjs`

**Rows — the full §17 inventory, one row each:** foundation · secure storage · provider manager · custom providers · model discovery · proxy manager · HTTP CONNECT · SOCKS5 · multi-provider proxy · easy proxy UX · routing · combo · failover · OpenAI-compatible API · authentication · streaming · tool/function calling · usage telemetry · Flux Core live data · provider constellation · client integrations · per-client security · fortress security · restart/persistence · packaging · upgrade · cross-platform qualification.

**Columns:** feature · owning subprogram · backend status · UI reachability · end-to-end evidence · overall status.

- [x] RED `tests/feature-gate-integrity.test.mjs`: every §17 feature appears exactly once and no extra row exists (a feature quietly dropped from the inventory is the failure mode this catches); each status cell is exactly one of `PASS`, `FAIL`, `UNVERIFIED`, `N/A`; a row whose overall status is `PASS` must carry an end-to-end evidence reference that `resolveEvidence` accepts; a row whose backend is `PASS` but whose UI reachability is `FAIL`/`UNVERIFIED` **cannot** have an overall `PASS`; a row citing only a unit test for a feature whose owning subprogram declares a smoke script may not be `PASS` — the citation must be `smoke:` or `transcript:`. — *29 tests. `N/A` in UI reachability is **not** treated as a UI failure: a fifth of the inventory is headless by design (combo resolution, failover, the OpenAI-compatible API surface, streaming, tool calling, packaging, upgrade), and collapsing `N/A` into `UNVERIFIED` would have blocked seven honestly-proven rows while proving nothing. `FAIL`/`UNVERIFIED` block; `N/A` requires the row to say **why** it has no UI, which a test asserts.*
- [x] RED same file: no row's evidence reference is duplicated across two different features, since one transcript proving one thing cannot prove two. — *Caught two real collisions on first run: model discovery and provider manager both cited `smoke:provider#1`, and free-first model discovery reused custom providers' `smoke:custom-provider#2`. Both were repointed at the check that actually covers the distinct feature (`#9` and `#12`), not exempted.*
- [x] Verify RED: the integrity test fails against an absent document, and each rule fails against a deliberately-broken fixture row before the document exists.
- [x] GREEN: write the document with every cell honestly set from the current repository state. — *The planning-time expectation was wrong in the release's favour and is recorded rather than quietly enjoyed: by the time 9L Task 2 ran, 9A–9K were implemented, so 27 of 29 rows carry resolving `smoke:` citations. **Two do not and stay `UNVERIFIED`:** client integrations (9H) and cross-platform qualification (9J). Both represent large bodies of finished work whose end-to-end proof is a transcript captured on hardware this session does not have, and neither was talked into `PASS`.*
- [x] **Thirteen smoke scripts renumbered, because Task 1's resolver refuses unnumbered output.** `api`, `custom-provider`, `dashboard`, `identity`, `injection`, `provider`, `proxy`, `proxy-ux`, `router`, `security`, `storage`, `stream`, and `usage` printed `ok <label>` with no number, so every citation this inventory needs was unresolvable — not because the check was missing but because it could not be looked up. Each `check()` now prints `String(checks).padStart(2)`, and failures carry `#n` too. All thirteen were **rerun live and pass with zero failures**. *Numbers are contractual: append checks, never insert one, or every citation past the insertion point silently shifts.*
- [x] Verify: `node --test tests/feature-gate-integrity.test.mjs` exits 0. — *29/29. `node --test tests/evidence.test.mjs` 18/18 after `emitsNumberedChecks` was exported and taught the `checks` counter shape; its unnumbered-script test moved off `proxy-ux-smoke.mjs` — the very script this task numbers — onto fixtures written outside `scripts/`, since 9J's portability scanner reads that directory concurrently and a vanishing file there produced `ENOENT` once already. Contained root run GREEN. `node scripts/feature-gate.mjs --report` exits 0; `--enforce` exits 1 on the two `UNVERIFIED` rows, which is the correct state.*
- [x] Commit — `docs: add the Bayz feature completeness gate document`

### Task 3 — Aggregate gate runner

**Create:** `scripts/release-gate.mjs`

The runner composes the subordinate gates rather than reimplementing them, so a rule lives in exactly one place.

- [x] Compose: `scripts/client-gate.mjs` (9H), `scripts/resilience-gate.mjs` (9I), `scripts/platform-gate.mjs` (9J), `scripts/supply-chain-gate.mjs` (9K), plus the feature gate from Task 2 and the security posture check from 9F. — *Six rows in `COMPOSED_GATES`. The 9F row is **derived** rather than re-run: 9F's posture ladder is proven by `scripts/security-smoke.mjs`, which is already in the fast class, so the row reads that step's outcome instead of spending another 13 s re-measuring the same listener. The file must still exist or the row is a `FAIL`.*
- [x] Run the full verification set and record each outcome: `npm run runtime:verify`; every smoke script present in `scripts/*-smoke.mjs` discovered dynamically (so a new smoke script is included automatically rather than forgotten); `node --test tests/*.test.mjs`; `node scripts/fuzz-run.mjs`; `node scripts/dependency-closure.mjs`; `node scripts/lockfile-check.mjs`; `node scripts/offline-check.mjs`; `git diff --check`; and a clean-tree check. — *30 steps, discovery finding 18 smoke scripts.*
- [x] **Duration classes, decided explicitly.** Dynamic discovery of `scripts/*-smoke.mjs` will pick up `load-smoke.mjs` and `soak-smoke.mjs`, whose default soak duration is 10 minutes and whose long mode is 2 hours. A gate that takes hours will be skipped by whoever is in a hurry, which makes it worthless. So the runner classifies each script: `fast` (every Phase 2–8 smoke, plus stream, identity, injection, custom-provider, proxy-ux, security, install, upgrade, chaos), and `long` (load, soak). `--report` and `--enforce` run the fast set. `--enforce --full` additionally runs the long set. A `--enforce` run without `--full` prints, prominently, that the long set was **not** executed and that any load or soak row therefore rests on a previous transcript — the run does not silently inherit an old measurement as if it were fresh. — *16 fast, 2 long.*
- [x] A script that is neither classified is a `FAIL`, not a default. A new smoke script must be placed in a class deliberately, since an unclassified script is one nobody decided about. — *And the converse is equally a `FAIL`: a name in the map with no file on disk means the map is stale, and a stale map is how a class silently stops covering anything.*
- [x] `--report` prints a single table of every gate with its verdict and exits 0. `--enforce` exits non-zero unless every composed gate passes with its own `--enforce` semantics. — *Plus `--plan`, which runs nothing; no mode, two modes, or an unknown flag exits 2, because "report and enforce" has two plausible meanings and guessing one would let a release script believe it enforced when it only reported.*
- [x] The runner prints, separately and prominently, the **list of everything currently `UNVERIFIED`** with the reason, because that list is the honest release-notes content. — *Read through each subprogram's own parser rather than a hand-kept list.*
- [x] A gate script that is missing is a `FAIL`, never a skip — an absent gate must not read as a pass. — *An absent gate reading as a pass would be the cheapest possible way to ship an unverified release: delete the file that says no.*
- [x] **A refusal the plan did not ask for, added because this device has already paid for it.** The runner runs `offline-check.mjs`, which runs the root suite, which contains `tests/*.test.mjs` — so a test that spawned the runner would re-enter the whole tree two children per level. 9K Task 7 lost three verification sessions to exactly that shape, and the tree dies by signal rather than failing politely. `BAYZ_RELEASE_GATE_DEPTH` is set on **every** child and checked before any work, mirroring `scripts/offline-nesting.mjs`; `tests/release-gate.test.mjs` therefore asserts the policy in-process against the exported pure functions and **spawns nothing at all**, which one of its own tests asserts.
- [ ] Verify: `node scripts/release-gate.mjs --report` exits 0 and lists the current state; `--enforce` exits **non-zero** today, which is correct while Phase 9 is unimplemented. — *`tests/release-gate.test.mjs` **19/19**, and `--plan` exits 0 against the real repository. The full `--report` execution is **deliberately deferred to Task 7**, which the plan already requires to run it: a fast-class `--report` costs roughly six minutes of `tsc`, sixteen smoke scripts, and the root suite, and running it twice would buy reassurance rather than evidence. A first attempt was killed by the host at the sixteenth step with fifteen consecutive `PASS` rows and no failure — that partial log is kept at `/tmp/9l-diag/release-gate-partial-preSIGKILL.txt` as a **partial** run and is not treated as a verdict.*
- [x] Commit — `test: add the aggregate Bayz release gate`

### Task 4 — Anti-fabrication enforcement

**Create:** `tests/no-fabrication.test.mjs`

This is the subprogram's teeth: it scans the documentation for claims that are not backed.

**A distinction the rule must get right.** The Phase 9 specs and plans deliberately *name* the guarantees BAYZ refuses to make — §10 says "No claim of memory zeroization", §15 says "does not claim reproducible builds", and the Phase 2 spec says "JavaScript cannot guarantee zeroization". A naive substring ban would fail against the very documents that establish the honesty policy, which would be the rule defeating its own purpose. So the scan matches a **claim**, not a mention: a forbidden term trips only when its line carries no negation marker, the markers being the case-insensitive stems `no`, `not`, `never`, `cannot`, `forbid`, `refuse`, `impossible`, `without`, `unverified`, and `honest limit`. The test asserts both directions — a bare `memory is zeroized` fails, while every one of the twelve existing mentions in this repository passes — so the negation carve-out is validated against the real corpus rather than against an invented example, and cannot itself be abused to smuggle a claim through.

**Measured corpus at planning time:** the forbidden terms already appear on twelve lines across `README.md`, both Phase 9 plan documents that establish the locks, and the Phase 2 and Phase 9 specs. Every one of those twelve is a refusal, and the test must pass against all twelve on first GREEN. If it does not, the rule is wrong — not the documents.

- [ ] RED `tests/no-fabrication.test.mjs`: across every tracked `docs/**/*.md` and `README.md`, a **capacity or performance figure** — a number immediately followed by `req/s`, `requests/s`, `rps`, `MB/s`, `concurrent requests`, or a latency figure presented as a *result* (`p50`, `p95`, `p99`, `throughput`, `measured`) — must be on a line or in a table row that also carries a `transcript:` reference. An unsourced benchmark number is the easiest thing in this repository to fabricate, so it is mechanically forbidden.
- [ ] RED same file: the figure rule must **not** trip on a configured bound, which is a design decision rather than a measurement. Timeouts, buffer caps, retention limits, and sampling intervals (`64 KiB`, `250 ms`, `±60s`, `every 15 s`, `32 KiB`) are exempt, and the test pins several real examples from the 9B, 9F, and 9I plans as must-pass cases. A rule that cried wolf on every plan document would be turned off within a week, which is worse than not having it.
- [ ] RED same file: no tracked document **claims** `zeroize`/`zeroise`/`zeroization`, `memory wiped`, `securely erased`, `reproducible build`, `tamper-proof`, `unhackable`, `military-grade`, `bank-grade`, or `100% secure`, under the negation-aware rule above. The test names the offending file, line, and matched term.
- [ ] RED same file: no document claims support for a platform whose 9J matrix row is not `PASS`, and no document claims a client works whose 9H matrix row is not `PASS` — asserted by cross-reading both matrices, so the README cannot drift ahead of the evidence.
- [ ] RED same file: no `PASS` anywhere in any tracked matrix or report lacks an evidence reference (a repo-wide sweep, catching a matrix a future phase adds without wiring it into a gate).
- [ ] Verify RED.
- [ ] GREEN: correct any document the scan catches. If a claim cannot be evidenced, the claim is removed or downgraded — never the test loosened.
- [ ] Verify: `node --test tests/no-fabrication.test.mjs` exits 0 against **every** existing document, including the Phase 9 specs and plans themselves.
- [ ] Commit — `test: forbid unevidenced Bayz claims in documentation`

### Task 5 — Lock verification

**Create:** `tests/phase9-locks.test.mjs`

Every lock named in the Phase 9 spec §18 becomes a mechanical check.

- [ ] RED `tests/phase9-locks.test.mjs`:
  - **Flux Core V2 visual lock** — the tracked files under `apps/dashboard/src/flux/` and `apps/dashboard/src/FluxCoreSlot.tsx` are pinned by SHA-256 in a manifest; a change to any of them fails the test with instructions to re-pin *only* alongside a documented bug fix, never for polish.
  - **No client name in the runtime path** — source scan over `packages/*/src` and `apps/*/src`, comments stripped, finds `opencode`/`hermes`/`antigravity`/`cline`/`continue` only in `packages/gateway/src/presets.ts`.
  - **No credential read path** — the Phase 3 getter scan (`getCredential`, `getPassword`, `reveal*`, `export*`) extended across every package including the new `gateway`, `identity`, and `capability`.
  - **No content persistence** — the six-sentinel drill extended to streaming chunks and tool-call arguments, asserted to be exercised by at least one smoke script.
  - **`node:sqlite` in exactly one file** — the existing constraint, re-asserted after the new packages exist.
  - **GitHub remote absent** — `git remote -v` lists no remote named `B-Router` and no remote pointing at a GitHub URL. This is asserted in the test suite because it is the prohibition most easily broken by muscle memory.
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `node --test tests/phase9-locks.test.mjs` exits 0.
- [ ] Commit — `test: enforce every Phase 9 Bayz lock mechanically`

### Task 6 — Release readiness statement

**Create:** `docs/superpowers/2026-08-27-bayz-release-readiness.md`
**Modify:** `README.md` (support and limitations sections), `WORK-HANDOFF.md` (Phase 9 state)

- [ ] The statement records, generated from the gates rather than written by hand: every gate verdict; the complete `UNVERIFIED` list with reasons; the complete residual-risk list; the platforms and clients that must **not** be described as supported; and the exact conditions under which a GitHub push becomes permissible.
- [ ] `README.md` gains a support section listing only `PASS` platforms and clients, and a limitations section carrying the honest boundaries Phase 9 established: no rollback prevention without trusted monotonic storage, no memory wiping in JavaScript, no OS keystore on Termux/Android, no mid-stream failover, no reproducible-build guarantee.
- [ ] `WORK-HANDOFF.md` gains a Phase 9 section in the established format — architecture as built, deviations from the plan text, measured results, residual risks — so the next session resumes from evidence rather than from memory.
- [ ] Verify: `node --test tests/no-fabrication.test.mjs` exits 0 against the new documents (the README's new claims are the most likely thing to trip it, which is the intended pressure).
- [ ] Commit — `docs: record the Bayz release readiness statement`

### Task 7 — Final gate execution

- [ ] Run, and record every result in the readiness statement: `npm run runtime:verify`; every `scripts/*-smoke.mjs` in the fast class; `node --test tests/*.test.mjs`; `node scripts/fuzz-run.mjs`; `node scripts/chaos-smoke.mjs`; `node scripts/offline-check.mjs`; then the long class — `node scripts/load-smoke.mjs` and `node scripts/soak-smoke.mjs`; then `node scripts/release-gate.mjs --report`; then `node scripts/release-gate.mjs --enforce --full`.
- [ ] If `--enforce` fails, the failing rows are the remaining work. **Do not adjust a status to make the gate pass.** Fix the feature, or record the honest `UNVERIFIED` and accept that the release is not GOAT-complete yet.
- [ ] Confirm `git status` is clean and `git remote -v` is empty.
- [ ] **STOP. Do not push.** A push requires: implementation complete, this gate green, the security gate green, a clean tree, a verified release candidate, and an explicit user instruction. Absent any one of those, Phase 9 ends at the local commit.
- [ ] Commit — `docs: record the Bayz Phase 9 final gate results`

## Completion checklist

- [ ] Every evidence citation is machine-resolvable and points at something with real assertions.
- [ ] All four subordinate matrix tests import the single evidence checker; no duplicate regex remains.
- [ ] All 27 §17 features have a row; none missing, none extra, none duplicated evidence.
- [ ] Backend-only or inert-UI features cannot reach overall `PASS`.
- [ ] Aggregate gate composes all five subordinate gates; a missing gate is a `FAIL`; every smoke script is classified `fast` or `long` deliberately.
- [ ] `--enforce` without `--full` states plainly that load and soak were not re-measured.
- [ ] `--enforce` is non-zero while anything mandatory is `UNVERIFIED`.
- [ ] No unsourced performance number and no forbidden security claim in any tracked document.
- [ ] Flux Core V2 files SHA-pinned; no visual drift possible without a deliberate re-pin.
- [ ] No product name in the runtime path; no credential read path; no content persistence.
- [ ] `git remote -v` empty, asserted by a test.
- [ ] README describes only evidenced support and states every honest limitation.

---

## AMENDMENT — Free-first gate rows (spec §25)

§17's inventory grows from 27 to 29 features. Task 2's integrity test must be
written against 29 rows, and the two new rows are release-blocking.

| # | Feature | Owning subprogram | Mandatory evidence |
|---|---|---|---|
| 28 | Free-first model discovery | 9D | `smoke:custom-provider#N` proving classification from real catalogue metadata |
| 29 | Free-only routing | 9E | `smoke:proxy-ux#N` proving zero requests at a paid origin |

- [x] Amend Task 2: the row count is 29; both new rows are present; row 29 may only reach `PASS` with a `smoke:` or `transcript:` citation, never a unit test alone, because the property being proven is "no money was spent" and only a real origin's connection count can prove it. — *29 rows, asserted as an exact count. Row 28 cites `smoke:custom-provider#12` and row 29 `smoke:proxy-ux#83`; both are `smoke:`, and the integrity test refuses a `test:` citation on either. Row 29's citation existed only after Task 2 numbered `proxy-ux-smoke.mjs`.*
- [ ] Amend Task 4: the anti-fabrication scan forbids any document claiming BAYZ guarantees the operator will never be charged. The honest claim, per spec §25.6, is that BAYZ never selected a paid model without metadata saying it was free. The test asserts the strong form is absent and the honest form is present in the README.
- [ ] Amend Task 5: the lock list gains "no paid fallback" — a source scan asserting the selection path has no branch that widens a free-only candidate set on failure.
- [ ] Amend Task 6: the README's limitations section states the §25.6 boundary.
