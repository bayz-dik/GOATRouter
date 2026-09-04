# Verify a GOAT ROUTER artifact

The local pack command creates an unsigned artifact. It does not publish, sign, or upload anything.

```sh
npm run runtime:build
npm run release:pack
node --test tests/pack.test.mjs
```

The artifact path is `packaging/out/bayz-router-<version>.tgz`. `tests/pack.test.mjs` verifies the exact file set, external dependency closure, secret scan, size limit, executable behavior, license consistency, and deterministic tar metadata.

## Inspect an artifact

```sh
tar -xOf packaging/out/bayz-router-0.1.1.tgz package/package.json
npm install -g packaging/out/bayz-router-0.1.1.tgz
bayz --version
```

The resulting package is `bayz-router`; its executable is `bayz`; its product description is GOAT ROUTER. Those compatibility identifiers are intentional.

## Signing status

Local artifacts are unsigned. This repository contains release-signing tooling and a hosted-workflow path, but hosted signing has not executed in the recorded environment. Do not describe a local tarball as signed or as a hosted release.

A matching digest or signature establishes the identity of the checked bytes. It does not prove that the build machine, dependencies, or source code are free of compromise or vulnerabilities.
