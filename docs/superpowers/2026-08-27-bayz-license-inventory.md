# BAYZ licence inventory

> **Generated file — do not edit.** Produced by `scripts/license-inventory.mjs` from
> `package-lock.json` and the workspace manifests. Regenerate with
> `node scripts/license-inventory.mjs`; `tests/license-inventory.test.mjs` asserts that a fresh
> generation reproduces this file byte for byte, so it cannot drift from the tree.

Project licence: **Apache-2.0**, chosen by the repository owner (Phase 9K Task 3).

Third-party identifiers are read from the lockfile and reported as recorded. Nothing here
rewrites a dependency's licence, and no compatibility is asserted on a dependency's behalf.

## BAYZ's own packages

| package | version | licence | declared in |
|---|---|---|---|
| `@bayz/capability` | 0.1.0 | Apache-2.0 | `packages/capability/package.json` |
| `@bayz/contracts` | 0.1.0 | Apache-2.0 | `packages/contracts/package.json` |
| `@bayz/dashboard` | 0.1.0 | Apache-2.0 | `apps/dashboard/package.json` |
| `@bayz/gateway` | 0.1.0 | Apache-2.0 | `packages/gateway/package.json` |
| `@bayz/identity` | 0.1.0 | Apache-2.0 | `packages/identity/package.json` |
| `@bayz/providers` | 0.1.0 | Apache-2.0 | `packages/providers/package.json` |
| `@bayz/proxy` | 0.1.0 | Apache-2.0 | `packages/proxy/package.json` |
| `@bayz/router` | 0.1.0 | Apache-2.0 | `packages/router/package.json` |
| `@bayz/security` | 0.1.0 | Apache-2.0 | `packages/security/package.json` |
| `@bayz/server` | 0.1.0 | Apache-2.0 | `apps/server/package.json` |
| `@bayz/storage` | 0.1.0 | Apache-2.0 | `packages/storage/package.json` |
| `@bayz/telemetry` | 0.1.0 | Apache-2.0 | `packages/telemetry/package.json` |

All twelve are `private: true` and are not published to npm; the identifier is stated so the
release artifact's own claim is verifiable, and so no package silently disagrees with the root.

## Runtime closure

74 packages actually ship. These are the ones whose terms bind a user.

| licence | packages |
|---|---|
| MIT | 60 |
| BlueOak-1.0.0 | 5 |
| ISC | 5 |
| BSD-3-Clause | 4 |

Allowed identifiers in the runtime closure:

`0BSD`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `BlueOak-1.0.0`, `CC0-1.0`, `ISC`, `MIT`, `Unlicense`

`BlueOak-1.0.0` was **added to that list in 9K Task 3** and is worth stating plainly. Five
runtime packages carry it — `glob`, `minimatch`, `minipass`, `path-scurry`, and `lru-cache` —
all reached through the `@fastify/static@10` upgrade that 9K Task 1 made to close a
high-severity advisory. It is a **permissive**, non-reciprocal, SPDX-registered licence on the
Blue Oak Council's permissive list, with no copyleft and no source-disclosure obligation, so
allowing it is truthful rather than convenient. It was not on the plan's original list because
the plan predates that upgrade, and adding it silently would have hidden a real change.

## Development-only closure

165 packages are reachable only from `devDependencies` and never ship.

| licence | packages |
|---|---|
| MIT | 139 |
| MPL-2.0 | 12 |
| Apache-2.0 | 5 |
| ISC | 4 |
| BSD-2-Clause | 2 |
| BSD-3-Clause | 2 |
| MIT-0 | 1 |

`MPL-2.0` appears here on twelve `lightningcss` builds, reached through `vite`. MPL-2.0 is
weak copyleft and is **not** allowed in the runtime closure; it is unproblematic here because
these packages are build-time only and no part of them is distributed. The distinction is the
reason this inventory labels scope at all.

## Verdict

No `UNKNOWN` and no disallowed licence in the runtime closure.

## Full runtime package list

| package | version | licence |
|---|---|---|
| `@fastify/accept-negotiator` | 2.1.0 | MIT |
| `@fastify/ajv-compiler` | 4.0.6 | MIT |
| `@fastify/error` | 4.2.0 | MIT |
| `@fastify/fast-json-stringify-compiler` | 5.1.0 | MIT |
| `@fastify/forwarded` | 3.0.2 | MIT |
| `@fastify/merge-json-schemas` | 0.2.1 | MIT |
| `@fastify/proxy-addr` | 5.1.0 | MIT |
| `@fastify/send` | 4.1.1 | MIT |
| `@fastify/static` | 10.1.3 | MIT |
| `@lukeed/ms` | 2.0.2 | MIT |
| `@pinojs/redact` | 0.4.0 | MIT |
| `abstract-logging` | 2.0.1 | MIT |
| `ajv` | 8.20.0 | MIT |
| `ajv-formats` | 3.0.1 | MIT |
| `atomic-sleep` | 1.0.0 | MIT |
| `avvio` | 9.3.0 | MIT |
| `balanced-match` | 4.0.4 | MIT |
| `brace-expansion` | 5.0.9 | MIT |
| `content-disposition` | 2.0.1 | MIT |
| `cookie` | 1.1.1 | MIT |
| `depd` | 2.0.0 | MIT |
| `dequal` | 2.0.3 | MIT |
| `escape-html` | 1.0.3 | MIT |
| `fast-decode-uri-component` | 1.0.1 | MIT |
| `fast-deep-equal` | 3.1.3 | MIT |
| `fast-json-stringify` | 7.0.1 | MIT |
| `fast-querystring` | 1.1.2 | MIT |
| `fast-uri` | 3.1.6 | BSD-3-Clause |
| `fast-uri` | 4.1.3 | BSD-3-Clause |
| `fastify` | 5.12.1 | MIT |
| `fastify-plugin` | 6.0.0 | MIT |
| `fastq` | 1.20.1 | ISC |
| `find-my-way` | 9.9.0 | MIT |
| `glob` | 13.0.6 | BlueOak-1.0.0 |
| `http-errors` | 2.0.1 | MIT |
| `inherits` | 2.0.4 | ISC |
| `ipaddr.js` | 2.5.0 | MIT |
| `json-schema-ref-resolver` | 3.0.0 | MIT |
| `json-schema-traverse` | 1.0.0 | MIT |
| `light-my-request` | 6.6.0 | BSD-3-Clause |
| `lru-cache` | 11.5.2 | BlueOak-1.0.0 |
| `mime` | 3.0.0 | MIT |
| `minimatch` | 10.2.6 | BlueOak-1.0.0 |
| `minipass` | 7.1.3 | BlueOak-1.0.0 |
| `on-exit-leak-free` | 2.1.2 | MIT |
| `path-scurry` | 2.0.2 | BlueOak-1.0.0 |
| `pino` | 10.3.1 | MIT |
| `pino-abstract-transport` | 3.0.0 | MIT |
| `pino-std-serializers` | 7.1.0 | MIT |
| `process-warning` | 4.0.1 | MIT |
| `process-warning` | 5.1.0 | MIT |
| `quick-format-unescaped` | 4.0.4 | MIT |
| `react` | 19.2.6 | MIT |
| `react-dom` | 19.2.6 | MIT |
| `real-require` | 0.2.0 | MIT |
| `real-require` | 1.0.0 | MIT |
| `require-from-string` | 2.0.2 | MIT |
| `ret` | 0.5.0 | MIT |
| `reusify` | 1.1.0 | MIT |
| `rfdc` | 1.4.1 | MIT |
| `safe-regex2` | 5.1.1 | MIT |
| `safe-stable-stringify` | 2.5.0 | MIT |
| `scheduler` | 0.27.0 | MIT |
| `secure-json-parse` | 4.1.0 | BSD-3-Clause |
| `semver` | 7.8.5 | ISC |
| `set-cookie-parser` | 2.7.2 | MIT |
| `setprototypeof` | 1.2.0 | ISC |
| `sonic-boom` | 4.2.1 | MIT |
| `split2` | 4.2.0 | ISC |
| `statuses` | 2.0.2 | MIT |
| `thread-stream` | 4.2.0 | MIT |
| `toad-cache` | 3.7.4 | MIT |
| `toidentifier` | 1.0.1 | MIT |
| `zod` | 4.4.3 | MIT |
