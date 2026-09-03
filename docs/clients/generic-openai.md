# Generic OpenAI-compatible client → GOAT ROUTER

For any client that speaks the OpenAI chat-completions API: an SDK, `curl`, a custom
script, or a tool not covered by the other three guides.

## Verification status

This is the **only** row in the compatibility matrix with evidence behind it. Every claim
below cites a numbered check in `scripts/client-conformance.mjs`, which drives GOAT ROUTER over
real HTTP with real `fetch` against a real listener, a real SQLite database, and real
scripted upstream origins — no in-process shortcuts. Run it yourself:

```bash
node scripts/client-conformance.mjs   # 55/55 checks
```

| capability | status | evidence |
| --- | --- | --- |
| configure | VERIFIED | `smoke:client-conformance#1` |
| authenticate | VERIFIED | `smoke:client-conformance#3` |
| models.list | VERIFIED | `smoke:client-conformance#5` |
| chat | VERIFIED | `smoke:client-conformance#9` |
| stream | VERIFIED | `smoke:client-conformance#14` |
| tool call | VERIFIED | `smoke:client-conformance#22` |
| tool result roundtrip | VERIFIED | `smoke:client-conformance#27` |
| large request | **PARTIAL** | `smoke:client-conformance#31` — see [Request size](#request-size) |
| cancel | VERIFIED | `smoke:client-conformance#35` |
| error surface | **PARTIAL** | `smoke:client-conformance#37` — see [Errors](#errors) |
| custom provider | VERIFIED | `smoke:client-conformance#42` |
| proxy-bound route | **UNVERIFIED** | not exercised by the harness; needs a real CONNECT proxy fixture (9H Task 4) |
| combo | VERIFIED | `smoke:client-conformance#46` |
| failover | VERIFIED | `smoke:client-conformance#44` |
| restart/reconnect | **UNVERIFIED** | not exercised; needs a client surviving a listener restart (9H Task 4/5) |
| key revoke/rotate | VERIFIED | `smoke:client-conformance#49` |
| free-only routing | VERIFIED | `smoke:client-conformance#52` |

`VERIFIED` here means *the protocol contract was observed to hold over real HTTP*. It does
not mean any particular third-party client has been run — that is what the `opencode`,
`hermes`, and `antigravity` rows are for, and all of those are still `UNVERIFIED`.

## Configuration

| setting | value |
| --- | --- |
| base URL | `http://127.0.0.1:20128/v1` |
| auth | `Authorization: Bearer <client key>` |
| key format | 64 lowercase hex characters |
| model | exactly an `id` from `GET /v1/models` |

Most SDKs take the base URL and key as constructor arguments or environment variables. The
OpenAI Python and Node SDKs read `OPENAI_BASE_URL` and `OPENAI_API_KEY`; GOAT ROUTER requires no
SDK-specific setting beyond those two, because it does not inspect client identity.

`20128` is the default port (`BAYZ_PORT` in `apps/server/src/config.ts`). Use whatever port
your deployment binds.

### Create a key

```bash
curl -sS -X POST http://127.0.0.1:20128/api/identities \
  -H "Authorization: Bearer $BAYZ_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"id":"my-script","displayName":"My Script",
       "scopes":["chat.completions","models.read"],"preset":"generic-openai"}'
```

Response, with `keyShownOnce: true` and the only copy of the key:

```json
{
  "identity": {
    "id": "my-script",
    "displayName": "My Script",
    "scopes": ["chat.completions", "models.read"],
    "preset": "generic-openai",
    "revoked": false,
    "createdAt": "…",
    "updatedAt": "…"
  },
  "key": "<64 hex chars>",
  "keyShownOnce": true
}
```

`chat.completions` and `models.read` are the two scopes a client needs. Granting more widens
the blast radius of a leaked key for no benefit — a client cannot use `providers.write`.

## Endpoints

Two, and only these two, are for clients.

### `GET /v1/models`

```json
{"object":"list","data":[{"id":"probe-model","object":"model","owned_by":"bayz"}]}
```

Every `id` is a model you have a route for. Wildcard route patterns (`gpt-4*`) are **not**
listed, because they are configuration rather than usable model ids. `owned_by` is always
`"bayz"`.

### `POST /v1/chat/completions`

```bash
curl -sS http://127.0.0.1:20128/v1/chat/completions \
  -H "Authorization: Bearer $CLIENT_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"probe-model","messages":[{"role":"user","content":"hello"}]}'
```

Response shape, asserted field-for-field by check #9:

```json
{
  "id": "chatcmpl-<uuid>",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "probe-model",
  "choices": [
    {"index": 0, "message": {"role": "assistant", "content": "…"}, "finish_reason": "stop"}
  ],
  "usage": {"prompt_tokens": 5, "completion_tokens": 6, "total_tokens": 11}
}
```

Absent token counts are `null`, never `0` — reporting zero where the provider reported
nothing would be an invented measurement. If the upstream omits `usage` **entirely**, the
`usage` key is **absent** from the response rather than present-and-null; if it reports some
counts but not others, the missing ones are `null`. Both behaviours were measured against a
live listener.

Three response **headers** carry routing facts, so the body stays exactly the OpenAI shape:
`x-bayz-route`, `x-bayz-provider`, and `x-bayz-proxy` when the route is proxy-bound. Every
response also carries `x-request-id`, which is the value to quote in a bug report.

### Accepted request fields

Exactly these, and **an unknown field is a 400 rather than a silent no-op**
(`packages/gateway/src/normalize.ts`):

`model`, `messages`, `temperature`, `max_tokens`, `top_p`, `stop`, `tools`, `tool_choice`,
`stream`, `parallel_tool_calls`.

If your client sends something else — `provider`, `user`, `seed`, `n`,
`frequency_penalty`, `response_format` — the request is refused. That is deliberate: a
client that sent `response_format` and got a silent no-op would believe a constraint was
being enforced. Two conveniences are accepted: `stop` may be a bare string, and `max_tokens`
may be a decimal string.

## Streaming

Send `"stream": true`. Verified by checks #14–#21.

```text
data: {"id":"chatcmpl-…","object":"chat.completion.chunk","created":…,"model":"probe-model","choices":[{"index":0,"delta":{"content":"par"},"finish_reason":null}]}

data: {"id":"chatcmpl-…","object":"chat.completion.chunk",…,"choices":[{"index":0,"delta":{"content":"tial"},"finish_reason":null}]}

data: {"id":"chatcmpl-…",…,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

- `content-type: text/event-stream; charset=utf-8`
- `cache-control: no-cache, no-transform` and `x-accel-buffering: no`, so a reverse proxy
  cannot buffer the stream into one response
- every chunk shares one `id`
- the stream ends with the literal `data: [DONE]`

**A stream that fails mid-flight does not send `[DONE]`.** It emits a final chunk carrying
an `error` object and then closes. Treat a missing `[DONE]` as a broken stream — that is the
only way to distinguish it from a complete one, since the 200 was committed with the first
byte.

## Tools

Send `tools` as the OpenAI contract defines. Verified by checks #22–#30.

A tool call comes back with `content: null` (not `""`), `finish_reason: "tool_calls"`, and
snake_case `tool_calls` where `arguments` is an **opaque JSON string**:

```json
{"choices":[{"index":0,"message":{"role":"assistant","content":null,
  "tool_calls":[{"id":"call_1","type":"function",
    "function":{"name":"get_weather","arguments":"{\"city\":\"Jakarta\"}"}}]},
  "finish_reason":"tool_calls"}]}
```

Execute the tool and send the result back as a `role: "tool"` message whose `tool_call_id`
matches:

```json
{"model":"probe-model","messages":[
  {"role":"user","content":"weather?"},
  {"role":"assistant","content":null,"tool_calls":[…]},
  {"role":"tool","tool_call_id":"call_1","content":"22C and clear"}
]}
```

A `tool_call_id` that matches no prior call in the same conversation is refused **400**
(check #30). Untrusted output must not be able to fabricate a result for a call that never
happened.

Tool names must match `^[A-Za-z_][A-Za-z0-9_-]{0,63}$` and may not start with `__`. The
underscore prefix is refused because BAYZ hands these names to clients it does not control,
and a client building `handlers[toolName]` would resolve `__proto__` through the prototype
chain. A tool named `__proto__` is refused **400 `invalid_request`**, measured.

Per response: at most **8** tool calls, **32 KiB** per argument blob.

### Server-side tool dispatch is off by default

BAYZ can execute a tool itself if an operator registered a capability for it (Phase 9G).
**The shipped registry is empty**, so every tool call is handed to you exactly as Phase 9B
did. If a capability is registered and the model calls it, BAYZ runs it and continues the
conversation without your involvement — bounded at 4 turns. A response mixing
registered and client-side calls is refused `tool_dispatch_split` rather than half-run.

## Request size

**PARTIAL**, and here is the exact boundary.

- A 120 KiB message is served in full with nothing truncated (check #31).
- 200 KiB in one message exceeds `MAX_CONTENT_CHARS` (**128,000 characters**, see
  `packages/router/src/request.ts`) and is refused **400 `invalid_request`** — cleanly, with
  the standard envelope, never truncated and never 5xx. Nothing is sent upstream.

Other bounds you may hit, each measured against a live listener and each answering
**400 `invalid_request`**: 1 MiB total request body, **256** messages, **64** tool
definitions, **4** stop sequences.

The cell is `PARTIAL` rather than `VERIFIED` because "large request" is satisfied within a
bound and refused beyond it. Both halves are proven; neither is hidden.

## Cancel

Abort the HTTP request. BAYZ tears the upstream request down rather than leaving the
provider generating tokens nobody reads (check #35). The listener continues serving
normally afterwards, which is asserted separately — an abort must not poison the server.

## Errors

Every error is this envelope, at every status code:

```json
{"error":{"code":"invalid_request","message":"…","requestId":"req_…"}}
```

Branch on `code`; it is fixed vocabulary. `message` is fixed per code and never
interpolates your input or an upstream body.

| status | when |
| --- | --- |
| 400 | malformed request, unknown model, unknown field, oversized message |
| 401 | missing, unknown, revoked, or rotated-away key |
| 403 | valid key without the required scope — e.g. `GET /v1/models` without `models.read` |
| 409 | `no_free_route` — see below |
| 413 | tool arguments beyond 32 KiB |
| 429 | rate limited |
| 501 | the routed provider cannot do tools (`tools_unsupported`) |
| 502 | upstream failed, unreachable, or returned an unparseable response |
| 504 | upstream timed out |

**The `PARTIAL`, stated plainly:** a request body that is valid JSON but **not an object**
(a bare string, number, or array) is refused 400 — correct — but the code is
`capability_unsupported`, whose message reads "the client is not granted that capability".
The real cause is the body shape: `deriveProfile` cannot derive the `chat` intent from a
non-object, so the refusal arrives from the capability gate. The status and envelope are
conformant so no client breaks, but the message misdirects a developer debugging it. Fixing
it means changing `intentOf` in `@bayz/gateway`, which is out of scope for the task that
found it; it is asserted by check #37 so the wording is pinned rather than drifting.

## FREE-ONLY

A route created without an explicit `freeOnly` field **is free-only**. A model BAYZ has not
classified as free is not free — including one it has never classified. So your first chat
against a fresh route very likely returns:

```json
{"error":{"code":"no_free_route","message":"no_free_route: no free model was available and this route may not spend money (stage: chat-free-only)","requestId":"req_…"}}
```

HTTP **409** — an operator decision, not an outage, which is why it is not 503. Verified by
check #52, and check #51 proves the paid provider was **never contacted**: a 409 alone would
not prove nothing was spent.

Two ways forward:

1. Classify the models — `POST /api/providers/<id>/catalogue` publishes the upstream
   catalogue, after which genuinely free models route normally.
2. Opt one route out deliberately — `PATCH /api/routes/<id>` with `{"freeOnly": false}`.
   Verified by check #53: the guard is a bound, not a wall.

The classification is deliberately strict. `FREE_VERIFIED`, `FREE_TIER`, `FREE_PREVIEW`, and
`LOCAL` are free; `PAID` and `UNKNOWN` are not. Treating "we never checked" as free is what
produces a bill.

## Key rotation and revocation

Verified by check #49.

- `POST /api/identities/<id>/rotate` returns a new key; the old one 401s immediately.
- `DELETE /api/identities/<id>` revokes; that key 401s immediately.
- Neither affects any other client's key.
- The identity stays visible for audit after revocation.

## Not verified

- **`proxy-bound route`** — BAYZ supports routes pinned to a SOCKS5 or HTTP CONNECT proxy,
  and `proxy-smoke.mjs` (39/39) plus `proxy-ux-smoke.mjs` (127/127) prove the tunnelling
  works. What is not verified is a *generic client* driving one end to end, because the
  conformance harness has no CONNECT fixture. 9H Task 4 owns it.
- **`restart/reconnect`** — not exercised. Needs a client surviving a real listener restart.

Both cells stay `UNVERIFIED`. Claiming them from a harness that does not exercise them would
be exactly the fake compatibility claim Phase 9H exists to prevent.
