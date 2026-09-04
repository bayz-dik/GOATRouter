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

For a one-command install that checks prerequisites, builds, packs, verifies, and installs globally, use the lifecycle CLI:

```sh
npm run goat:install
```

## Start, stop, restart, status

The lifecycle CLI manages the server as a background process without systemd:

```sh
node scripts/goat.mjs start
node scripts/goat.mjs stop
node scripts/goat.mjs restart
node scripts/goat.mjs status
```

Or as npm scripts: `npm run goat:start`, `goat:stop`, `goat:restart`, `goat:status`. See `docs/operations.md` for the full lifecycle, update, backup, and rollback guide.

## Start

```sh
BAYZ_API_TOKEN=<your-token> bayz
```

With no `BAYZ_HOST` or `BAYZ_PORT`, GOAT ROUTER listens on `http://127.0.0.1:20128` and serves the dashboard there. `BAYZ_API_TOKEN` is required for a non-loopback bind. On a loopback first start without one, GOAT ROUTER generates a token, stores it encrypted, and prints it once.

Set `BAYZ_HOST`, `BAYZ_PORT`, and `BAYZ_DATA_DIR` only when needed. Non-loopback `BAYZ_HOST` requires `BAYZ_ALLOW_REMOTE=true`; review the server security posture before exposing the service.

## Data

The runtime stores its database and key material in a data directory read in order:

1. `BAYZ_DATA_DIR`, when set.
2. An existing `~/.bayz` (backward compatibility).
3. The platform default: `$XDG_DATA_HOME/bayz` or `~/.local/share/bayz` on Linux/Termux; `%LOCALAPPDATA%\bayz` on Windows; `~/Library/Application Support/bayz` on macOS.
4. `~/.bayz` when no platform path is available.

The startup log records the chosen directory and reason. Back up the entire selected directory: `bayz.db` without `master.key` cannot restore encrypted provider credentials, because the DEKs needed to decrypt them live in that same directory.

Uninstalling the CLI does not remove data:

```sh
npm uninstall -g bayz-router
```

## Removing BAYZ

Deleting the selected data directory is **irreversible**. It permanently removes all providers, routes, identities, telemetry, and encrypted credentials, and the encryption keys that could have decrypted them go with it. There is no recovery from a deleted `bayz.db` or `master.key`. Back up the directory before deleting it, and only delete it when you intend to remove all data permanently.

See `packaging/README.md` for artifact contents and `README.md` for first provider setup.
