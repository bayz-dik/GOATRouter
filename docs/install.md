# Install GOAT ROUTER

GOAT ROUTER retains the `bayz` executable, `bayz-router` artifact name, and `BAYZ_*` variables for compatibility.

## Requirements

- Node.js 24 or newer
- npm

Termux/Android ARM64 is the only platform qualified in this repository. Other platforms are not claimed as supported.

## Build and install the local artifact

From the repository root:

```sh
npm ci
npm run runtime:build
npm run release:pack
npm install -g packaging/out/bayz-router-0.1.0.tgz
bayz --version
```

The tarball bundles the internal `@bayz/*` workspaces. Its only external runtime dependencies are `fastify` and `@fastify/static`; no internal package registry is required.

## Start

```sh
BAYZ_API_TOKEN=<your-token> bayz
```

With no `BAYZ_HOST` or `BAYZ_PORT`, GOAT ROUTER listens on `http://127.0.0.1:20128` and serves the dashboard there. `BAYZ_API_TOKEN` is required for a non-loopback bind. On a loopback first start without one, GOAT ROUTER generates a token, stores it encrypted, and prints it once.

Set `BAYZ_HOST`, `BAYZ_PORT`, and `BAYZ_DATA_DIR` only when needed. Non-loopback `BAYZ_HOST` requires `BAYZ_ALLOW_REMOTE=true`; review the server security posture before exposing the service.

## Data

The runtime stores its database and key material in `BAYZ_DATA_DIR` when set. Otherwise it reuses an existing `~/.bayz`, then chooses a platform data location. The startup log records the chosen directory and reason. Back up the entire selected directory: `bayz.db` without `master.key` cannot restore encrypted provider credentials.

Uninstalling the CLI does not remove data:

```sh
npm uninstall -g bayz-router
```

Delete the selected data directory only when you intend to permanently remove all providers, routes, identities, telemetry, and encrypted credentials.

See `packaging/README.md` for artifact contents and `README.md` for first provider setup.
