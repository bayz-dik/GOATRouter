# Connecting a client to GOAT ROUTER

Four guides, one per client row in the compatibility matrix:

| guide | client on this host | matrix row |
| --- | --- | --- |
| [`generic-openai.md`](generic-openai.md) | any OpenAI-compatible client | 13 VERIFIED, 2 PARTIAL, 2 UNVERIFIED |
| [`opencode.md`](opencode.md) | present, `1.18.23` | **16 VERIFIED, 1 UNVERIFIED** |
| [`hermes.md`](hermes.md) | present, `Hermes Agent v0.20.5` | **17 VERIFIED** |
| [`antigravity.md`](antigravity.md) | **absent** | all 17 cells UNVERIFIED |

## Read this first

These are **configuration** guides. They tell you what to paste where. They are not
compatibility claims.

GOAT ROUTER implements an OpenAI-compatible
gateway with streaming, tool calling, scoped client keys, custom providers, proxy-bound
routes, combos, failover, and free-only routing — proven by 1897 tests and 998 smoke
checks. That is what GOAT ROUTER *does*. Whether a **specific client** works against it is a
separate question, answered only by running that client, and recorded cell by cell in
[`../superpowers/2026-08-27-bayz-client-compatibility-matrix.md`](../superpowers/2026-08-27-bayz-client-compatibility-matrix.md).

**Two of the three mandated clients have now been driven against BAYZ for real** —
`scripts/verify-opencode.mjs` (16 of 17 cells) and `scripts/verify-hermes.mjs` (17 of 17),
each cell citing a transcript under `docs/transcripts/`. Doing so found **four** defects the
55 generic protocol checks could not see, which is the case for real-client verification
stated as a result rather than a principle. `antigravity` is not installed here, so all 17 of
its cells stay `UNVERIFIED` and `scripts/verify-antigravity.mjs` records the absence rather
than inventing a configuration.

Where a guide shows a client-side config file, that file was **read from this machine**.
Where a client is not installed, the guide says its configuration form is undocumented here
rather than guessing at field names.

## What every client needs, regardless of guide

- **Base URL** — `http://127.0.0.1:20128/v1`
- **API key** — a scoped client key: 64 lowercase hex characters, shown exactly once when
  the identity is created
- **Model name** — exactly a `model` value from `GET /v1/models`; BAYZ invents no aliases

Creating a key, in the dashboard (Identities panel → Preset → Create) or over the API:

```bash
curl -sS -X POST http://127.0.0.1:20128/api/identities \
  -H "Authorization: Bearer $BAYZ_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"id":"my-client","displayName":"My Client",
       "scopes":["chat.completions","models.read"],"preset":"opencode"}'
```

The response carries `"keyShownOnce": true` and the only copy of the key. `GET` on the
identity afterwards returns metadata with **no key field** — there is no recovery path, only
`POST /api/identities/<id>/rotate`.

## FREE-ONLY will refuse your first request, by design

A route created without an explicit `freeOnly` field **is free-only** (spec §25 rule 6), and
a model whose economics BAYZ has not classified as free is **not free** — including a model
it has never classified at all. So a fresh route to an unclassified provider answers:

```json
{"error":{"code":"no_free_route","message":"no_free_route: no free model was available and this route may not spend money (stage: chat-free-only)","requestId":"req_…"}}
```

with HTTP **409**. That is BAYZ refusing to spend money you did not authorise, not a
misconfiguration. Publish the provider's catalogue so its models get classified
(`POST /api/providers/<id>/catalogue`), or opt a specific route out deliberately
(`freeOnly: false`). Each guide repeats this, because it is the first thing a new user
hits.

## Presets change nothing about how a request is served

`opencode`, `hermes`, `antigravity`, and `generic-openai` are the four preset names the
identity registry accepts (`packages/identity/src/repository.ts`). A preset **seeds the
default scope set** on the create form and labels the key for the operator. That is all.

There is no client-name branching in any runtime path. BAYZ derives behaviour from the
request path, the `Accept` header, the body shape, and the caller's scopes — never from a
product name. `packages/gateway/src/presets.ts` is the single file where these names may
appear, and `packages/gateway/test/adversarial.test.ts` scans every other gateway source
file to keep it that way. Naming your key `opencode` does not make BAYZ treat the request
differently from a key named `generic-openai`.
