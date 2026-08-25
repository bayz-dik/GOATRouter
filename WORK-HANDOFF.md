# BAYZ Router — Chat → Work handoff

## Current execution state

- Approved plan: `docs/superpowers/plans/2026-08-26-bayz-router-foundation.md`
- Execution method: Subagent-Driven in Work; this chat sandbox cannot dispatch Codex subagents.
- Task 1 scaffold created through the RED boundary only.
- RED observed with Node's type stripping: contract test fails because `packages/contracts/src/index.ts` does not exist.
- Production implementation intentionally not written yet because GREEN cannot be verified in this sandbox.

## Sandbox blockers

- Node available here: `v22.16.0`; approved final runtime requires Node 24+.
- `registry.npmjs.org` is unreachable from this sandbox (`EAI_AGAIN`).
- Therefore `tsx`, `zod`, `fastify`, React, Vite, and Vitest cannot be installed here.

## Resume in Work

Merge the scaffold into the existing BAYZ filesystem without replacing the existing private Sites/UI surface.

1. Confirm Node 24+.
2. Preserve the existing root `package.json` scripts/dependencies and merge only the approved workspace fields/scripts.
3. Run:
   - `npm install --save-dev tsx@latest`
   - `npm install zod@^4.0.0 --workspace @bayz/contracts`
4. Re-run `npm run test --workspace @bayz/contracts` and confirm RED for the missing contracts implementation.
5. Continue Task 1 Step 4 from the approved plan, then verify GREEN and typecheck.
6. Do not rebuild or replace the BAYZ private review UI; `BAYZ-responsive-master.html` remains the visual source of truth until the React runtime integration phase.

## Important

This handoff is a portable execution aid, not a replacement repository. The Work filesystem remains authoritative for existing root files and UI assets.
