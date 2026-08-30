# BAYZ supply-chain report — Phase 9K

- Device: Termux/Android ARM64 (Ubuntu proot), 8 CPUs, 11.0 GiB RAM
- Node: v24.19.0 (arm64), npm 11.17.0
- Commit: 029fd3d7702c7fa259273448b69e027d22c3a6d4
- Runtime dependency count: 74 external packages
- Written: 2026-08-30 (Phase 9K Task 8)

Every row below carries exactly one verdict — `PASS`, `FAIL`, `UNVERIFIED`, or `N/A` — and every
`PASS` carries an evidence reference that resolves on disk. The runtime dependency count above is
**checked against `scripts/dependency-closure.mjs`** by `tests/supply-chain-report.test.mjs`, not
copied, so it cannot drift from the lockfile.

`scripts/supply-chain-gate.mjs` reads this document, and **re-measures three of its rows from the
live tree**: runtime licences, vulnerabilities, and the tarball secret scan. A live failure blocks
regardless of what the row below says. That is deliberate — a report is a record of a measurement,
not a substitute for one, and a gate that trusted the prose could be passed by editing the prose.

## Verdicts

| item | status | evidence | notes |
|---|---|---|---|
| audit | PASS | test:tests/audit-policy.test.mjs | `npm audit --json` against the runtime closure: 0 critical, 0 high, 0 moderate, 0 low. Found a real **high** advisory (GHSA-83w8-p2f5-377r, route guard bypass in `@fastify/static@8.3.0`) on its first live run and it was fixed by upgrading to `^10.1.3`, not deferred. Re-measured live by the gate. |
| lockfile integrity | PASS | test:tests/lockfile-integrity.test.mjs | 264 entries, `lockfileVersion` 3. All 239 resolved entries carry `sha512-` integrity and a `registry.npmjs.org` origin at an exact version; 12 workspace links and 12 workspace definitions are exempt by a narrow, separately-tested rule. `node scripts/lockfile-check.mjs` exits 0. |
| licence inventory | PASS | test:tests/license-inventory.test.mjs | Apache-2.0, chosen by the repository owner. 74 runtime packages: 60 MIT, 5 BlueOak-1.0.0, 5 ISC, 4 BSD-3-Clause — no `UNKNOWN`, nothing copyleft. `MPL-2.0` is present on 12 `lightningcss` builds and is dev-only, reached through `vite`. All 12 first-party workspaces declare Apache-2.0. Re-measured live by the gate. |
| SBOM | PASS | test:tests/sbom.test.mjs | CycloneDX 1.5, generated from the lockfile by `scripts/sbom.mjs` with zero new dependencies. 239 components (74 runtime, 165 dev-only), scoped purls percent-encoded, serial `urn:uuid:8fedf7f7-8a24-523e-95a0-1c3e8ee59d3a` derived from content so regeneration is byte-stable. The 12 workspaces appear as first-party subcomponents with **no** purl. |
| digests | PASS | test:tests/release-signing.test.mjs | `SHA256SUMS` over the tarball and the SBOM. `bayz-router-0.1.0.tgz` = `4e10560506c8a8db…`, `bayz-0.1.0.cdx.json` = `70807b7f2d367930…`. `node scripts/verify-release.mjs` recomputes both and exits 0; cross-checked with coreutils `sha256sum -c`. |
| signature | UNVERIFIED | | **Unsigned local build, which is the normal and expected state here.** No long-lived signing key exists in this repository, its history, or on this host; the owner's decision is keyless Sigstore-style provenance through GitHub OIDC, which requires a hosted workflow run. `.github/workflows/release-provenance.yml` exists and is inert — no remote is configured and Phase 9 prohibits pushing. Unsigned is **not** the same outcome as forged: `verify-release.mjs` reports a missing signature and an invalid signature distinctly, and neither is reported as verified. |
| determinism | UNVERIFIED | test:tests/build-determinism.test.mjs | Measured per artifact class, with **no reproducible-build claim**: release tarball `PASS` (two packs byte-identical), SBOM `PASS` (two generations identical at a pinned timestamp), build-machine identity `PASS` (8 shipped files scanned, no absolute path, home directory, username or hostname), `tsc`-emitted output `N/A` (all 11 workspace builds are `tsc --noEmit`, so nothing is emitted). The **dashboard bundle is `UNVERIFIED`**: `vite`/`rolldown` do not guarantee determinism and the rebuild is not run inside the suite on this device, so this row takes the weakest verdict of its classes rather than averaging them. |
| offline | PASS | test:tests/offline.test.mjs | All 12 unit suites — 1,927 tests — pass with off-host egress blocked by a `NODE_OPTIONS` preload that refuses non-loopback `net.connect`, `tls.connect`, `dns.lookup` and `fetch`. The guard is proven effective before any suite is trusted: `scripts/offline-check.mjs` runs a deliberate `fetch("https://example.invalid")` in a child and refuses to report `PASS` if it is not blocked. Two real network dependencies were found and fixed in the code rather than exempted. Nine mutations (K24a–f, K25a–c) all caught. `node scripts/offline-check.mjs` exits 0 in 108.8s. |
| native-free closure | PASS | test:tests/dependency-closure.test.mjs | 5 direct external dependencies, 84 in the runtime closure (10 workspace links + 74 external). No install script, no `gypfile`, no libc constraint, no `os`/`cpu` restriction anywhere in the runtime closure. The 53 platform-restricted and 2 install-scripted packages in the tree are all dev-only, reached through `vite`. `node scripts/dependency-closure.mjs` exits 0. |
| tarball secret scan | PASS | test:tests/pack.test.mjs | All 8 shipped files scanned **by content, not by filename**: no `sk-` credential, Bearer token, 64-hex literal, PEM private key, password fixture, or usage/smoke sentinel. `node scripts/pack.mjs --self-test` proves the scan can fail — a planted credential of each shape is caught, and the real artifact trips none of them. Re-measured live by the gate. |

## Why two rows are `UNVERIFIED`, and why neither blocks

**`signature`.** A local release candidate is legitimately unsigned. Blocking on it would make the
gate unpassable on the only device that has this repository, and an unpassable gate is routed around
within a week — which is strictly worse than one that reports honestly. It would also destroy the
distinction Task 5 exists to preserve: `verify-release.mjs` deliberately reports *unsigned* and
*invalid signature* as different outcomes, because conflating them means a forged artifact and an
ordinary local build produce the same message. The gate prints this row under `--enforce` with an
explicit note that it is **not** a pass.

**`determinism`.** The blocking half of this row is already green — the tarball and the SBOM are
byte-stable and the shipped bytes carry no build-machine identity. What is `UNVERIFIED` is bundler
determinism, which the `vite`/`rolldown` chain does not promise.
No reproducible build is claimed, here or anywhere, because the phase Locks refuse it and because
asserting one would be asserting something untrue. The honest verdict is that bundler output has not
been measured across a rebuild on this device.

Both are printed by `--enforce`, never hidden. Everything else `UNVERIFIED` **does** block.

## What this report does not claim

- **No reproducible build.** The phrase appears here only as a refusal. `vite`/`rolldown` do not
  guarantee identical output across environments, and borrowing the term's authority would mislead
  precisely the security-conscious reader who looks for it.
- **A signature would not prove reproducibility, and would not prove the build machine was
  uncompromised.** See `docs/release-verification.md` for what each release mode does and does not
  establish.
- **The offline row proves no *unit test* needs the internet.** It says nothing about the install and
  upgrade smokes, which install a real tarball from the npm registry — requiring those to run offline
  would be requiring them to stop testing installation.
- **`.github/workflows/release-provenance.yml` has never executed.** No row here cites it as
  evidence, and `tests/release-workflow.test.mjs` enforces that mechanically: the workflow may not
  appear in any evidence cell, no row mentioning it may carry a `PASS`, and every mention in prose
  must be a disclaimer. A workflow that has never run is not evidence — but saying so plainly is
  required, which is why the rule is negation-aware rather than a blanket ban on the filename.

## Gate policy

`scripts/supply-chain-gate.mjs` reads this report and re-measures three rows live.

- `--report` always exits 0 and prints every documented row, the live re-measurement, every integrity
  violation, and the tally — including a state that would fail.
- `--enforce` exits non-zero on: any `FAIL` row; any `UNVERIFIED` row outside the documented
  exemptions (`signature`, `audit`, `determinism`); an `UNKNOWN` or disallowed runtime licence; a
  `critical`/`high` runtime advisory; a tarball secret-scan hit; an `UNVERIFIED` row with no stated
  reason; a `PASS` with no evidence reference; a stated runtime count that disagrees with the closure
  walk; or a missing, empty, or malformed report.
- `--no-audit` skips the live `npm audit` hop and records it `UNVERIFIED`. It never records it `PASS`.
- No flag, both flags, or an unknown flag exits **2**. "Report and enforce" has two plausible meanings
  — print then fail, or print instead of failing — and guessing one would let a release script believe
  it enforced when it only reported. Same contract as `scripts/resilience-gate.mjs`.

A live measurement always outranks the document. If a row here claims `PASS` and the live check fails,
that disagreement is reported as an integrity violation in its own right, not merely as a failure.

Current state on this device: `--report` exits 0; `--enforce` exits **0**, with `signature`,
`determinism` and — when run with `--no-audit` — `audit` listed as non-blocking `UNVERIFIED`.

Reproduce with:

```
node scripts/audit-check.mjs                 # vulnerability policy
node scripts/lockfile-check.mjs              # integrity and provenance
node scripts/license-inventory.mjs           # regenerates the inventory
node scripts/sbom.mjs --out sbom/bayz-0.1.0.cdx.json
node scripts/pack.mjs --self-test            # artifact + secret scan, with its own negative controls
node scripts/sign-release.mjs                # digests; unsigned locally by design
node scripts/verify-release.mjs              # recomputes every digest
node scripts/build-determinism.mjs           # per-class verdicts, no reproducibility claim
node scripts/offline-check.mjs               # 12 suites with off-host egress blocked
node scripts/dependency-closure.mjs          # native-free closure
node scripts/supply-chain-gate.mjs --enforce # this report, gated
```
