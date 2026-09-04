<p align="center">
  <img src="apps/dashboard/public/brand/goat-router-lockup.png" alt="GOAT ROUTER" width="800">
</p>

# GOAT ROUTER

GOAT ROUTER is a local-first LLM router with an OpenAI-compatible gateway, a browser dashboard, direct provider connections, optional proxy routing, and encrypted local credential storage.

Internal workspace names (`@bayz/*`) and configuration variables (`BAYZ_*`) are compatibility identifiers. They are not the product name.

## What works

- OpenAI-compatible `GET /v1/models` and `POST /v1/chat/completions`
- Streaming and tool-call forwarding
- Direct connections to OpenAI-compatible providers, OpenRouter, Gemini, and custom OpenAI-compatible endpoints
- Provider connection tests and model discovery
- Encrypted-at-rest provider credentials and proxy passwords
- Optional SOCKS5 and HTTP CONNECT proxies
- Provider routes, deterministic failover, and free-only routing by default
- Scoped client identities, a local dashboard, and usage telemetry that excludes prompts and completions

## Requirements

- Node.js 24 or newer
- npm

Termux/Android ARM64 is the only platform qualified by this repository's recorded verification. Do not infer support for other platforms from that result.

## Install from source

```sh
npm ci
npm run runtime:build
```

Start the server from the repository root:

```sh
npm run start --workspace @bayz/server
```

The default listener is `http://127.0.0.1:20128`. The dashboard is served at that address. Open it in a browser on the same device.

Set an API token explicitly when starting a long-lived installation:

```sh
BAYZ_API_TOKEN=<your-token> npm run start --workspace @bayz/server
```

If `BAYZ_API_TOKEN` is unset on a loopback install, GOAT ROUTER generates one on first start, stores it encrypted, and prints it once. Save it before opening the dashboard. Every API endpoint except `GET /api/health` requires `Authorization: Bearer <token>`.

`BAYZ_HOST` defaults to `127.0.0.1`; `BAYZ_PORT` defaults to `20128`. A non-loopback bind requires `BAYZ_ALLOW_REMOTE=true` and additional posture protections. See `docs/install.md` before exposing the service beyond loopback.

## Dashboard and provider setup

1. Open `http://127.0.0.1:20128` and enter the API token. The dashboard keeps it in memory only.
2. Open **Providers** and enter a display name, base URL, and API key or credential.
3. Select a provider kind only when the URL cannot be recognized. Advanced fields hold the provider ID, headers, loopback permission, and compatibility settings.
4. Use **Add and test connection**. GOAT ROUTER creates the provider, stores the credential through its write-only encrypted path, then tests the stored provider.
5. Create a route in **Routes** for the model you want clients to use.

Providers connect directly by default. A proxy is optional and can be assigned later. API keys are never stored in browser storage and are never returned by the API.

### Local runtimes

A provider pointing at `127.0.0.1`, `localhost`, or another loopback address must enable **Allow loopback** under Advanced before GOAT ROUTER can call it. This is intentional SSRF protection.

### Optional 9Router use

9Router is not required by GOAT ROUTER. If you have a 9Router-compatible endpoint, add it as an ordinary provider using its endpoint and credential. GOAT ROUTER has no runtime dependency on 9Router.

## Connect a client

Create a scoped client identity in **Identities**, then configure an OpenAI-compatible client with:

- Base URL: `http://127.0.0.1:20128/v1`
- API key: the client key shown once when the identity is created
- Model: a model returned by `GET /v1/models`

Client-specific guidance is in `docs/clients/`.

Routes are free-only by default. A model without verified free economics can return `no_free_route` until you publish the provider catalogue or deliberately set that route's `freeOnly` option to `false`.

## Development commands

```sh
npm run test --workspace @bayz/dashboard
npm run test --workspace @bayz/server
npm run runtime:build
npm run runtime:verify
```

On constrained devices, run workspace tests and builds one at a time. `runtime:verify` fans out workspaces and can exceed the process limit on this device.

## Package a release artifact

Build first, then create the installable tarball:

```sh
npm run runtime:build
npm run release:pack
```

The artifact is written to `packaging/out/bayz-router-0.1.0.tgz`. The public product is GOAT ROUTER; the existing artifact and CLI identifiers remain `bayz-router` and `bayz` for compatibility.

Install that local artifact with:

```sh
npm install -g packaging/out/bayz-router-0.1.0.tgz
bayz --version
BAYZ_API_TOKEN=<your-token> bayz
```

Run `node scripts/pack.mjs --self-test` to exercise the packaging safeguards. `packaging/README.md` documents the artifact contents and boundaries. Local artifacts are unsigned; see `docs/release-verification.md` for verification rules.

## Published releases

The first release is `v0.1.0`:

- Release: https://github.com/bayz-dik/GOATRouter/releases/tag/v0.1.0
- Artifact: `bayz-router-0.1.0.tgz` (SHA256 in `SHA256SUMS.txt` on the release)

Install the published artifact with:

```sh
npm install -g bayz-router-0.1.0.tgz
bayz --version
BAYZ_API_TOKEN=<your-token> bayz
```

## Limits worth knowing

- Credentials are encrypted at rest, but a compromised host or running process can still access active secrets.
- No provider OAuth flow is implemented for `codex-oauth`.
- No cross-platform support claim is made beyond the qualified Termux/Android ARM64 environment.
- Client compatibility is recorded per client in `docs/clients/`; unavailable clients are not claimed as supported.
