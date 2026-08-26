# Phase 9B — Streaming + Tool / Function Calling

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Spec:** `docs/superpowers/specs/2026-08-27-bayz-phase9-goat-release-design.md` §6

**Depends on:** 9A (streaming and tools are capabilities the gateway negotiates)

**Goal:** Production SSE streaming and tool/function calling, closing the capability deliberately deferred in Phase 5.

**Locks:** No prompt, completion, or tool-argument content persisted or logged. Once the first stream byte reaches the client, failover is impossible — stated, not faked. No fabricated upstream capability.

---

### Task 1 — SSE framing primitives

**Create:** `packages/router/src/sse.ts`
**Test:** `packages/router/test/sse.test.ts`

**Interface produced:**
```ts
export function encodeSseEvent(data: unknown): string;
export function encodeSseDone(): string;
export class SseLineReader {           // bounded incremental parser
  push(chunk: Uint8Array): string[];   // complete data payloads
  done(): void;
}
```

- [ ] RED `sse.test.ts`: `encodeSseEvent({a:1})` is exactly `data: {"a":1}\n\n`; `encodeSseDone()` is `data: [DONE]\n\n`; a payload containing a newline is JSON-escaped, never emitted raw (frame-injection guard); `SseLineReader` reassembles a payload split across three chunks; a line exceeding 64 KiB throws `response_too_large`; total buffered bytes exceeding 2 MiB throws; a `data:` line with no space is accepted; a comment line (`:heartbeat`) is ignored; `[DONE]` terminates; malformed JSON is skipped up to 8 times then throws.
- [ ] Verify RED: `node --import tsx --test packages/router/test/sse.test.ts` fails with `ERR_MODULE_NOT_FOUND`.
- [ ] GREEN `sse.ts` with zero-allocation-per-chunk buffering.
- [ ] Verify: `npm run test --workspace @bayz/router` exits 0.
- [ ] Commit — `feat: add bounded SSE framing for the Bayz router`

### Task 2 — Streaming transport

**Modify:** `packages/router/src/transport.ts`
**Test:** `packages/router/test/transport-stream.test.ts`

**Interface produced:** `sendChatRequestStreaming(options): AsyncIterable<ChatChunk>`

- [ ] RED `transport-stream.test.ts` against a real `node:http` origin emitting SSE: chunks arrive incrementally (assert the first chunk is observed before the origin finishes); an idle gap beyond `idleTimeoutMs` aborts with `unreachable`; total duration beyond `requestTimeoutMs` aborts; an upstream socket destroyed mid-stream yields a terminal error, never a silent end; a truncated stream (no `[DONE]`) yields a terminal error; `AbortSignal` cancellation propagates and destroys the upstream socket within one turn; a 401 before the first chunk maps to `auth_failed`; response bytes beyond the cap abort mid-stream.
- [ ] RED same file: **resource proof** — after 50 sequential streams, `process._getActiveHandles()` count returns to its baseline ±2, and no timer remains.
- [ ] Verify RED.
- [ ] GREEN `sendChatRequestStreaming` reusing the existing `node:http` agent path so a proxy-bound route streams through its proxy.
- [ ] Verify: `npm run test --workspace @bayz/router` exits 0; `node scripts/router-smoke.mjs` still 46/46.
- [ ] Commit — `feat: add streaming transport to the Bayz router`

### Task 3 — Router streaming with honest failover semantics

**Modify:** `packages/router/src/router.ts`
**Test:** `packages/router/test/router-stream.test.ts`

**Interface produced:** `chatStream(request, options): AsyncIterable<ChatChunk>`

- [ ] RED `router-stream.test.ts`: a failing first candidate fails over **before** any byte is emitted, and the client sees only the successful stream; once the first chunk is emitted, a mid-stream upstream failure surfaces as a terminal error and **no failover is attempted** (assert the second origin received zero requests); telemetry emits `provider.attempted` and `request.completed` with `attempts` correct; the prompt sentinel appears in no emitted telemetry event; a stream that ends without `[DONE]` records `request.failed` with `invalid_response`.
- [ ] RED same file: token counts from a terminal `usage` chunk are recorded; absent usage stays `undefined`, never `0`.
- [ ] Verify RED.
- [ ] GREEN `chatStream`.
- [ ] Verify: `npm run test --workspace @bayz/router` exits 0; `npm run build --workspace @bayz/router` exits 0.
- [ ] Commit — `feat: add Bayz router streaming with pre-first-byte failover`

### Task 4 — Server SSE endpoint

**Modify:** `apps/server/src/routes/chat.ts`
**Test:** `apps/server/test/chat-stream.test.ts`

- [ ] RED `chat-stream.test.ts`: `stream: true` returns `content-type: text/event-stream`, `cache-control: no-cache`, `connection: keep-alive`; the strict CSP header is still present; chunks are framed correctly and terminated by `[DONE]`; `stream: false` and an absent `stream` both behave exactly as Phase 6 (regression guard); a client that aborts mid-stream causes the upstream request to be destroyed (assert via origin observation); an identity lacking `chat.stream` capability receives `400 streaming_unsupported`; routing headers appear before the first chunk.
- [ ] RED same file: no prompt or completion sentinel appears in structured logs after a completed stream.
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/server` exits 0; `node scripts/api-smoke.mjs` still 62/62.
- [ ] Commit — `feat: serve Bayz streaming chat completions`

### Task 5 — Tool / function calling request contract

**Modify:** `packages/router/src/request.ts`
**Create:** `packages/router/src/tools.ts`
**Test:** `packages/router/test/tools.test.ts`

**Interface produced:** `parseToolDefinitions`, `parseToolChoice`, `parseToolMessages`

- [ ] RED `tools.test.ts`: a valid `tools` array of `{type:"function",function:{name,description,parameters}}` parses; a tool name outside `^[A-Za-z_][A-Za-z0-9_-]{0,63}$` is refused; more than 64 tools is refused; a `parameters` blob beyond 32 KiB is refused; `tool_choice` accepts `"auto"`, `"none"`, and `{type:"function",function:{name}}` and refuses anything else; a `role:"tool"` message requires `tool_call_id` matching a prior assistant call; more than 8 tool calls in one assistant message is refused; arguments are parsed as JSON **data** and a non-object argument blob is refused; a tool result body beyond 32 KiB is refused.
- [ ] RED same file: **arguments are never evaluated** — a source scan asserts `tools.ts` contains no `eval`, `new Function`, or `require`.
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/router` exits 0.
- [ ] Commit — `feat: add Bayz tool-calling request contract`

### Task 6 — Tool-call response normalization and capability detection

**Modify:** `packages/router/src/response.ts`, `packages/router/src/transport.ts`
**Test:** `packages/router/test/tools-response.test.ts`

- [ ] RED `tools-response.test.ts`: an upstream `tool_calls` array normalizes to a fresh object carrying only `id`, `type`, `function.name`, `function.arguments`; an injected extra field is discarded; `finish_reason: "tool_calls"` is preserved; a provider whose declared capabilities exclude tools receives a request **without** `tools` and the caller gets `tools_unsupported` rather than a silent drop; a streamed tool call reassembles across chunks with bounded buffering; arguments arriving as invalid JSON yield `invalid_response`, not a partial object.
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/router` exits 0; `npm run runtime:verify` exits 0.
- [ ] Commit — `feat: normalize Bayz tool-call responses with capability detection`

### Task 7 — Multi-turn roundtrip through the API

**Modify:** `apps/server/src/routes/chat.ts`
**Test:** `apps/server/test/tools-api.test.ts`

- [ ] RED `tools-api.test.ts` against a real origin scripted to return a tool call then a final answer: turn 1 sends `tools` and receives `tool_calls`; turn 2 sends the assistant message plus a `role:"tool"` result and receives the final content; three turns work; a `tool_call_id` that matches no prior call is `400`; an identity lacking the `tools` capability is `400`; no tool argument or result appears in telemetry, logs, or the database.
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/server` exits 0.
- [ ] Commit — `feat: support Bayz multi-turn tool-result roundtrip`

### Task 8 — Streaming and tool smoke

**Create:** `scripts/stream-smoke.mjs`
**Modify:** `docs` status table

- [ ] Non-mocked: real listener, real SSE origin, real proxy-bound SSE route, real tool-call origin. Assert: incremental delivery, `[DONE]`, client-abort cleanup, upstream-abort error, truncated-stream error, pre-first-byte failover, no mid-stream failover, tool roundtrip over three turns, and a six-sentinel scan (prompt, completion, tool argument, tool result, credential, Authorization) across `bayz.db`/`-wal`/`-shm`/stdout/stderr/logs/usage responses. Non-zero exit on any failure.
- [ ] Verify: `node scripts/stream-smoke.mjs` exits 0.
- [ ] Verify full gate: `npm run runtime:verify`; every `scripts/*-smoke.mjs` present at that point (seven from Phases 2–8 plus `stream-smoke.mjs`, more if a parallel subprogram landed first — discover them rather than hardcoding a count); `git diff --check`.
- [ ] Commit — `test: add Bayz streaming and tool-calling smoke`

## Completion checklist

- [ ] `stream: true` works; `stream: false` and absent `stream` are byte-identical to Phase 6.
- [ ] Bounded buffers; no socket, timer, or listener leak after 50 streams.
- [ ] Client abort and upstream abort both handled; truncated stream is an error.
- [ ] Failover only before the first byte, documented and tested.
- [ ] Tool arguments are data; no `eval`/`Function` anywhere in the path.
- [ ] Provider tool capability detected, never faked.
- [ ] Zero content sentinel leakage including tool arguments and results.
