# BAYZ Router — Chat → Work handoff

## Current execution state

- Approved plan: `docs/superpowers/plans/2026-08-26-bayz-router-foundation.md`
- Foundation Plan Task 1 through Task 8: **COMPLETE** in this workspace.
- Every task followed RED → verify RED → GREEN → verify GREEN.
- `npm run runtime:verify` exits 0: 13 tests pass across four workspaces, all four builds exit 0.
- Runtime smoke-checked live on `127.0.0.1:20991` (port 20128 was occupied by an
  unrelated process in this environment): `/api/health` returned the schema
  shape with an `x-request-id` header, `/` served the compiled dashboard, and
  `/api/missing` returned the JSON `not_found` envelope. SIGTERM shut down
  cleanly.

## Environment facts (supersede the earlier sandbox blockers)

- Node: `v24.19.0` — meets the Node 24+ requirement.
- `registry.npmjs.org` reachable; tsx, zod, fastify, React, Vite, Vitest all installed.

## Deviations from the plan text

1. Added root devDependencies `typescript` and `@types/node`; the plan's
   `build` scripts (`tsc -p tsconfig.json --noEmit`) cannot run without them.
2. Pinned `typescript@5` (5.9.3). `typescript@latest` resolves to 7.0.2, which
   rejects `node:*` builtin imports in tests with TS2591 even with `@types/node`
   installed.
3. Added `@types/react` and `@types/react-dom` to `@bayz/dashboard`; the plan's
   dashboard `tsc --noEmit` gate fails without them.
4. Added `index: false` to the `@fastify/static` registration. Without it the
   plugin's own index handling collides with the plan's explicit `GET /`,
   producing `FST_ERR_DUPLICATED_ROUTE`.
5. Added `.gitignore` (`node_modules/`, `dist/`); the repo had none.
6. Created `README.md`. The plan says to append to an existing README, but no
   README existed in this workspace.

## DEFERRED — blocked until the original UI/Sites source is added here

The existing private BAYZ Sites/UI review surface is **not present** in this
workspace. `BAYZ-responsive-master.html`, the Sites build, and the Next.js root
`package.json` scripts have not been merged in.

Consequently these Foundation Plan checks are DEFERRED and have **not** been
verified. They are not passing and must not be reported as passing:

- Root Sites build. `npm run build` at the root fails with
  `Missing script: "build"` because no Sites source exists.
- Phase-completion item "The existing root Sites build still passes."
- Merging the approved workspace fields into the real Next.js root
  `package.json` without discarding its existing scripts/dependencies.

`apps/dashboard` is the runtime foundation shell only. It is **not** a
redesign, and it does **not** replace `BAYZ-responsive-master.html` as the
locked visual source of truth.

## Resume steps once the real BAYZ repo/UI is available

1. Copy the Sites/UI source and the real root `package.json` into this workspace.
2. Merge the workspace fields (`workspaces`, `runtime:*` scripts) into the real
   root `package.json` instead of overwriting it.
3. Move the README "Bayz All-in-One Runtime" section into the real README.
4. Run the root Sites build and confirm it still exits 0.
5. Re-run `npm run runtime:verify` to confirm no regression.

## Important

No push to GitHub has occurred. All work is local commits on `master`.
