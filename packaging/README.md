# BAYZ release packaging

Phase 9J Task 4. `node scripts/pack.mjs` produces one tarball at
`packaging/out/bayz-router-<version>.tgz`.

```sh
npm run build --workspace @bayz/dashboard   # required first: the dashboard bundle is not built here
npm run release:pack
node scripts/pack.mjs --self-test           # also prove the packaging checks reject violations
```

## What ships

Seven files, pinned exactly by `tests/pack.test.mjs`:

```text
package/package.json
package/README.md
package/dist/bayz.mjs                          the bin entry
package/dist/server.mjs                        the bundled server, @bayz/* inlined
package/dist/dashboard/index.html              the built dashboard
package/dist/dashboard/assets/*.js
package/dist/dashboard/assets/*.css
```

188 KB packed, against a documented 2 MiB bound.

## Why a single artifact instead of nine packages

`npm pack --workspace @bayz/server` on the pre-9J tree produced **57 files including all 29
`test/*.ts` files**, because there was no `files` field. That is the visible defect. The invisible one
matters more: `@bayz/server` declares ten `@bayz/*` dependencies at version `0.1.0`, and those
versions exist only as workspace symlinks in this checkout. **The tarball could not install
anywhere** — `npm install` would look for `@bayz/storage@0.1.0` on a registry and find nothing.

Publishing nine interdependent packages would fix that, and would require a registry, version
coordination across ten manifests, and dropping `private: true` from all of them. Phase 9 wants none
of that, and publishing is out of scope while the GitHub prohibition stands.

So the `@bayz/*` code is compiled into `dist/server.mjs` with its internal imports resolved, and the
artifact declares only what it genuinely still imports at runtime.

`apps/server/package.json` also gained `files: ["src"]`, which takes a per-workspace pack from 57
files / 120.1 kB to 27 files / 44.4 kB with no test files. That tarball still cannot install — the
`@bayz/*` dependencies are still unresolvable — but a developer who runs the command by hand should
not get a tarball full of tests.

## Why two declared dependencies, not five

The workspaces declare five external runtime dependencies: `fastify`, `@fastify/static`, `react`,
`react-dom`, `zod`. The artifact declares **`fastify` and `@fastify/static`**, because that is what
the built bundles actually import — measured on the output, not read off a manifest:

- `react` and `react-dom` are compiled into the dashboard asset by vite.
- `zod` is only reachable through `@bayz/contracts`, and `apps/server` imports it exclusively with
  `import type`, which erases at compile time. The dashboard's one runtime use of `HealthSchema` is
  inlined into its bundle.

Declaring the other three would install `react`, `react-dom`, `scheduler` and `zod` — 86 packages in
the install closure instead of 82 — that nothing in the artifact can ever load. Every installed
package is supply-chain surface, and a dependency nothing imports is one nobody will notice going
bad.

`tests/pack.test.mjs` asserts the declared set **equals** the imported set, in both directions, so a
sixth genuinely-needed dependency being missed fails just as loudly as an unused one being declared.
Version ranges are copied from `apps/server/package.json` rather than written here, so they cannot
drift.

Fastify stays external deliberately: it resolves plugins by identity and reads their `package.json`
metadata at runtime. Inlining it is possible and would turn plugin registration into a debugging
problem to save a few hundred kilobytes.

## Why `dist/bayz.mjs` is separate from `dist/server.mjs`

Importing the server *starts* it. `apps/server/src/index.ts` builds the runtime and opens SQLite at
module scope — before `listen`, so a broken credential store refuses startup rather than serving
traffic. Correct for a daemon, wrong for `bayz --version`, which must print without touching the
filesystem or opening a database. The bin answers `--version` and `--help` first and imports the
server only when there is a server to run. `tests/pack.test.mjs` proves it by pointing
`BAYZ_DATA_DIR` at a nonexistent path and asserting the path still does not exist afterwards.

The bin also defaults `BAYZ_DASHBOARD_ROOT` to the packaged dashboard, because `config.ts` resolves
that default relative to its own module URL (`../../dashboard/dist/`) — right in the workspace, wrong
in the artifact's flat layout. An operator-supplied value is never overridden.

## Secrets are scanned on the extracted bytes

Not on the file list. A release artifact leaking a test fixture credential is the worst outcome this
phase can produce, and the 29-shipped-test-files baseline is exactly how it happens. The scan covers
`sk-` credentials, Bearer tokens, 64-hex literals (the API token and root key shape), PEM private
keys, the Phase 2 password fixture, the six Phase 8 usage sentinels, the smoke fixture sentinels, and
Google API keys — across every entry including the compiled bundles, where a constant that survived
tree-shaking would be invisible to any filename rule.

## The tarball is byte-reproducible

Two packs of identical inputs are byte-identical, asserted. The archive is a hand-written ustar
member with `mtime`, `uid`, `gid`, `uname` and `gname` zeroed, gzipped with `mtime: 0` so the gzip
header carries no timestamp either. Without that, every digest computed over the artifact in 9K would
measure the clock instead of the contents.

The tar writer is hand-rolled rather than `execFile("tar", …)` because `tar` is on the non-portable
binary list `tests/portability.test.mjs` enforces for user-run scripts: GNU tar, bsdtar, and the tar
bundled with Windows disagree about flags and about which metadata they record.

## Licence: `UNLICENSED`, and that is the honest value

There is no `LICENSE` file in this repository and no `license` field in any of the nine workspace
manifests. **9K Task 3 owns the licence and blocks on a decision the user has not made.**

The artifact therefore declares `UNLICENSED`, the SPDX-recognised marker for "no licence granted",
which is true right now. Writing `MIT` to satisfy a checklist would be a false statement about a legal
fact, and a false licence claim is worse than an honest absence.

`tests/pack.test.mjs` asserts a **consistency rule** rather than a specific identifier: if a root
`LICENSE` exists then the artifact must carry a matching identifier and ship the file; if not, it must
say `UNLICENSED` and ship no licence file. That test does not need to change when 9K lands.

## `esbuild` is a dev dependency

The bundler is `esbuild`, already present in the tree — both `tsx` and `vite` depend on it, and it is
the same compiler that already builds the dashboard. Phase 9J Task 4 promoted it to an explicit root
**`devDependencies`** entry so the release path does not rely on a transitive hoist.

It has an install script and platform-restricted optional binaries, which is why it must stay
dev-only: `node scripts/dependency-closure.mjs` still reports the runtime closure as
**96 = 10 workspace links + 86 external, native-free**, and `tests/dependency-closure.test.mjs`
(12/12) still asserts `esbuild` is absent from it.

## What packing does not do

- It does not build the dashboard. `npm run build --workspace @bayz/dashboard` owns that, and
  `runtime:build` already runs it. Building it here would make every pack slow and would hide a stale
  dashboard behind an implicit rebuild. `apps/dashboard/dist` is gitignored, so a fresh clone must
  build before packing — stated as an error rather than papered over.
- It does not publish. Nothing here contacts a registry.
- It does not sign or produce digests. That is 9K.
