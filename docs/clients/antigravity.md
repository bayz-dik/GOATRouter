# Antigravity → BAYZ Router

## Verification status: UNVERIFIED, all 17 capabilities — and the client is absent

**Antigravity is not installed on this host.** `command -v antigravity` finds nothing, and
there is no `~/.antigravity`. Nothing can be configured, run, or observed here.

Every cell in the `antigravity` row of
[the compatibility matrix](../superpowers/2026-08-27-bayz-client-compatibility-matrix.md)
reads `UNVERIFIED` with that reason recorded. Absence of the client is **not** a failure of
BAYZ — but it is not success either, and it is not recorded as one.

## Why this guide is deliberately short

The other three guides document field names, config-file structure, and CLI syntax read from
files or binaries **present on this machine**. For Antigravity there is nothing to read.

Writing a plausible configuration block here would mean inventing:

- a config file path,
- a field name for the base URL (`baseURL`? `base_url`? `endpoint`?),
- a field name for the API key,
- an environment variable,
- a model-naming form (bare id? prefixed by a provider label, as OpenCode does?).

Each of those is a coin flip, and the two clients this repo *can* inspect disagree on nearly
every one — OpenCode uses camelCase `baseURL`/`apiKey` in JSON with a `provider/model`
prefix, Hermes uses snake_case `base_url` in YAML with a derived env-var for the key and bare
model ids. There is no safe default to generalise from. A guide that guessed would be
indistinguishable from a correct one until someone tried it, which is exactly the kind of
fake documentation Phase 9H exists to prevent.

So: no invented fields, and no invented capabilities.

## What is known, and is enough to configure it once it exists

BAYZ exposes a standard OpenAI-compatible surface. Any client that speaks it needs three
things, and BAYZ requires nothing beyond them:

| setting | value |
| --- | --- |
| base URL | `http://127.0.0.1:20128/v1` |
| auth | `Authorization: Bearer <client key>` |
| model | exactly an `id` from `GET /v1/models` |

Whatever Antigravity calls those fields, those are the values. The full protocol contract —
endpoints, request fields, response shapes, streaming frames, tool-call format, error
envelope, and bounds — is in [`generic-openai.md`](generic-openai.md), which is the only
guide here with evidence behind it (`scripts/client-conformance.mjs`, 55/55 over real HTTP).

### Create the key

```bash
curl -sS -X POST http://127.0.0.1:20128/api/identities \
  -H "Authorization: Bearer $BAYZ_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"id":"antigravity","displayName":"Antigravity",
       "scopes":["chat.completions","models.read"],"preset":"antigravity"}'
```

`preset: "antigravity"` is accepted by the identity registry
(`packages/identity/src/repository.ts`) and seeds the default scope set. It changes **nothing**
about how a request is served — there is no client-name branching in any runtime path, and
`packages/gateway/test/adversarial.test.ts` enforces that by scanning every gateway source
file for product names.

### Expect FREE-ONLY to refuse the first request

A route created without an explicit `freeOnly` field is free-only, and a model BAYZ has not
classified as free is not free. Expect HTTP 409:

```json
{"error":{"code":"no_free_route","message":"no_free_route: no free model was available and this route may not spend money (stage: chat-free-only)","requestId":"req_…"}}
```

Publish the provider's catalogue (`POST /api/providers/<id>/catalogue`), or opt one route out
with `PATCH /api/routes/<id>` `{"freeOnly": false}`.

## What happens when Antigravity is available

9H Task 5 ships `scripts/verify-antigravity.mjs`. Its contract is already fixed by the plan:

- If the binary is **absent**, print `UNVERIFIED: antigravity not installed on this host` and
  exit **0**. Absence is not a BAYZ failure, and must not be recorded as success.
- If **present**, run the same seventeen-capability matrix as the OpenCode harness and write
  transcripts.

The matrix row can then move cell by cell, each with a `transcript:` citation that
`tests/matrix-integrity.test.mjs` resolves on disk. Until then every cell stays
`UNVERIFIED`, and 9H Task 6's release gate is expected to **block** on that — which is the
correct behaviour, not a defect.

## Not claimed here

- No configuration snippet. The field names are unknown on this host, so none is offered.
- No screenshot, no transcript, no capability claim.
- No `antigravity`-specific behaviour in BAYZ. There is none, by design.
