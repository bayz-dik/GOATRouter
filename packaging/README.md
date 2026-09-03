# GOAT ROUTER release packaging

`npm run release:pack` creates one installable tarball:

```text
packaging/out/bayz-router-<version>.tgz
```

The product is GOAT ROUTER. The artifact name and `bayz` executable remain unchanged for compatibility.

## Build and pack

The dashboard bundle is an explicit prerequisite:

```sh
npm run runtime:build
npm run release:pack
node scripts/pack.mjs --self-test
```

`release:pack` does not publish to npm or contact a registry.

## What ships

The artifact contains:

```text
package/package.json
package/README.md
package/LICENSE
package/dist/bayz.mjs
package/dist/server.mjs
package/dist/dashboard/index.html
package/dist/dashboard/assets/*
package/dist/dashboard/brand/*
```

The package bundles internal `@bayz/*` workspaces into `dist/server.mjs`. It retains only the external runtime dependencies that the produced bundles import: `fastify` and `@fastify/static`.

## Install and run

```sh
npm install -g packaging/out/bayz-router-0.1.0.tgz
bayz --version
BAYZ_API_TOKEN=<your-token> bayz
```

`bayz --version` and `bayz --help` do not open the database. Starting `bayz` serves the packaged dashboard and uses the same `BAYZ_*` configuration variables as a source checkout.

## Packaging checks

The packer fails when the artifact contains source, tests, databases, environment files, key material, workspace dependencies, undeclared runtime imports, or credential-shaped content. It also enforces a 2 MiB size bound and deterministic tar metadata.

The package is Apache-2.0, matching the root `LICENSE` and package metadata. Local artifacts are unsigned. See `docs/release-verification.md` for the verification model.
