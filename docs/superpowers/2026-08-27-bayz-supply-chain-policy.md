# BAYZ supply-chain acceptance policy

> Written 2026-08-29 (Phase 9K Task 1). Enforced by `scripts/audit-check.mjs` and
> `scripts/supply-chain-gate.mjs`.

This document says what BAYZ does about a known vulnerability, before one is found, so the decision is
not made under pressure with a release waiting.

## Scope: runtime versus dev

The only distinction that matters is **whether the package ships**.

`scripts/dependency-closure.mjs` computes the runtime closure from `package-lock.json` — the set of
packages reachable through `dependencies` and `optionalDependencies` from the workspace manifests.
That single computation defines "runtime" everywhere in this repository: the audit check, the licence
inventory, the SBOM, and the release gate all call it rather than keeping their own idea of the word.

A package reachable **only** through `devDependencies` never reaches a user. It is triaged separately
and never blocks a release on its own. This is not laxity: `vite` alone pulls in 53
platform-restricted and 2 install-scripted packages, and treating a build-tool advisory as a shipping
defect would train everyone to ignore the gate.

## Severity actions

| severity | in the runtime closure | dev-only |
|---|---|---|
| `critical` | **Blocks the release.** Fix, upgrade, or remove before shipping. No exception without a written entry below. | Recorded here with a review date. Fix at the next convenient change. |
| `high` | **Blocks the release.** Same as critical. | Recorded here with a review date. |
| `moderate` | Recorded here with a rationale and a **review date**. Does not block. | Recorded in the audit output only. |
| `low` | Recorded here with a rationale and a review date. Does not block. | Recorded in the audit output only. |
| `info` | No action. Reported by `npm audit` for completeness. | No action. |

**Maximum tolerated age.** A `moderate` or `low` finding in the runtime closure may be carried for at
most **90 days** from the date it is first recorded. On its review date it is either fixed or
re-justified with a new date and a new rationale. A finding whose review date has passed is treated as
`high` by the gate — an expired deferral is indistinguishable from having forgotten about it.

## Exceptions

The **repository owner** decides exceptions. Nobody else, and not the agent running the release.

An exception is only real when it is **written into this document** in the section below, with:

1. the advisory identifier and the affected package and version range,
2. why the vulnerable code path is not reachable in BAYZ, stated specifically enough to be checked,
3. the review date, and
4. who approved it.

An exception that exists only in someone's memory, a commit message, or a chat log is not an
exception; the gate will block and it should. Living with a finding silently is the failure mode this
section exists to prevent.

## Network unavailability

`npm audit` needs the registry. When it is unreachable, `scripts/audit-check.mjs` prints
`UNVERIFIED: audit requires registry access` and **exits 0**.

This is deliberate. A gate that cannot tell "clean" from "unknown" is worse than no gate, because it
teaches its operator that red means "try again on better wifi". `UNVERIFIED` is reported as its own
state in the supply-chain report and is never counted as a pass.

## Findings

### Resolved

**GHSA-83w8-p2f5-377r — `@fastify/static` route guard bypass via path traversal — high.**
Recorded 2026-08-29, resolved the same day.

Measured on this repository: `@fastify/static@8.3.0` was in the runtime closure and the advisory range
is `<=10.1.0`. Three further advisories affected the same package —
GHSA-8pvw-jcv7-9cmj (authorization bypass via non-canonical URL paths, `<=10.1.1`),
GHSA-pr96-94w5-mx2h (path traversal in directory listing, `>=8.0.0 <=9.1.0`), and
GHSA-x428-ghpx-8j92 (route guard bypass via encoded path separators, `>=8.0.0 <=9.1.0`) — all
moderate.

This was not deferred. BAYZ serves the operator dashboard through this plugin
(`apps/server/src/static-dashboard.ts`), and a route guard bypass on the process that also exposes the
admin API is precisely the class of defect the Fortress work exists to prevent. Deferring a reachable
authorization bypass would have made the whole policy decorative.

**Action taken:** upgraded to `@fastify/static@^10.1.3`. The runtime closure was re-measured rather
than assumed, and the 9J closure pins were updated to the new measured values with the change
recorded — see `WORK-HANDOFF.md`.

### Active deferrals

None. There is no `moderate` or `low` finding in the runtime closure at the time of writing.

`npm audit` reports `{"info":0,"low":0,"moderate":0,"high":0,"critical":0,"total":0}` after the
upgrade above.
