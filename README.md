# BAYZ Router

Private development repository for the BAYZ All-in-One runtime.

## Bayz All-in-One Runtime

The private foundation runtime lives in `apps/server`, `apps/dashboard`, and
`packages/*`. It currently provides only the verified Core health surface and
dashboard status shell. Providers, proxies, combos, routes, integrations, and
usage remain visibly marked as planned until their real implementations pass
their dedicated phases.

- Node.js: 24 or newer
- Default URL: `http://127.0.0.1:20128`
- Verify: `npm run runtime:verify`
- Start after building the dashboard: `npm run start --workspace @bayz/server`

Do not expose the runtime on a non-loopback interface unless authentication and
the explicit remote-access setting are configured.

## Deferred verification

The existing private BAYZ Sites/UI review surface is not present in this
workspace. `BAYZ-responsive-master.html`, the Sites build, and its root
`package.json` scripts have not been merged here yet.

Therefore the following Foundation Plan checks are **DEFERRED**, not passing:

- Root Sites build (`npm run build`) — no Sites source exists to build.
- "The existing root Sites build still passes" phase-completion item.

`apps/dashboard` is the runtime foundation shell only. It is not a replacement
for the locked BAYZ visual direction, and it does not supersede
`BAYZ-responsive-master.html` as the visual source of truth. These deferred
checks must be run after the original UI/Sites source is added to this
workspace.
