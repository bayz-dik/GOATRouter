# Bayz Router — Usage Telemetry Design (Phase 8)

Status: Accepted · Date: 2026-08-26 · Predecessors: Phases 1–7, Flux Core V2 (LOCKED)

## 1. Goal

Wire real routing telemetry into the Usage page, the Relay Usage Track, and the
recent-request list — as **metadata only**, behind one authoritative event
boundary, with retention bounds and a strict Content-Security-Policy.

The approved Flux Core V2 visual and motion system is LOCKED. Phase 8 supplies it
with real state through the existing `FluxCoreViewModel`; it changes no geometry,
no motion, and no constellation behaviour.

## 2. Non-goals

- No prompt, completion, message, system prompt, tool argument, request body, or
  response body is recorded anywhere. Not truncated, not hashed, not "just the
  first 100 characters".
- No cost model. Bayz has no pricing table and no billing API, so estimated cost is
  reported as **unavailable**, never as a number.
- No speculative events. The event list below is what the router can actually
  observe today.
- No new dependency. No `node:sqlite` import outside the established driver.
- No per-frame React updates. The canvas engine keeps owning animation.

## 3. The privacy boundary

One rule, enforced three ways: **telemetry is a closed set of scalar metadata
fields, and the recorder cannot accept anything else.**

Recorded fields:

```text
requestId        opaque id, already generated per request
occurredAt       ISO-8601 timestamp, clamped to a sane window
routeId          slug
providerId       slug
proxyId          slug or absent
model            validated model id
routingMode      direct | combo | failover
outcome          ok | failed
failureCategory  normalized code (auth_failed, rate_limited, unreachable, …)
latencyMs        bounded integer
attempts         bounded integer
promptTokens     bounded integer or unknown
completionTokens bounded integer or unknown
cachedTokens     bounded integer or unknown
```

Enforcement:

1. **The recorder builds its own row.** It accepts a typed event, copies only the
   fields above onto a fresh object, and validates each. An extra key on the input
   is dropped by construction rather than filtered by a denylist — a denylist would
   need updating every time a field is added upstream.
2. **`failureCategory` is a fixed enum.** An unrecognized code becomes
   `unknown_error`. Arbitrary upstream error text can therefore never be stored,
   because there is no column it could occupy.
3. **Executable proof.** An adversarial suite seeds a prompt sentinel, a completion
   sentinel, and a credential sentinel through a real request, then scans
   `bayz.db`, `-wal`, `-shm`, every API response, and captured logs for those bytes.
   A source scan additionally asserts no `INSERT`/`UPDATE` in the telemetry package
   names a content-like column.

## 4. Event boundary

`packages/telemetry` exposes one recorder. The router emits events to it; nothing
else in the codebase writes usage rows.

```ts
type UsageEvent =
  | { kind: "request.completed"; … }
  | { kind: "request.failed"; … }
  | { kind: "provider.attempted"; … }
  | { kind: "provider.failed"; … }
  | { kind: "failover.started"; … };
```

`provider.attempted` / `provider.failed` are what make Combo membership and
failover observable per provider: a 40-provider Combo emits 40 attempt events for
one request, each carrying its own provider id and outcome.

The recorder is synchronous and writes through the existing `SqlDatabase`
interface. There is no queue, because there is nothing to buffer: a row is a dozen
integers and slugs, and an async queue would introduce loss on shutdown for no
measurable gain. Bounded-queue protection is therefore satisfied by having no
queue at all.

## 5. Storage

Migration v5 adds two tables:

```sql
CREATE TABLE usage_requests (
  request_id        TEXT PRIMARY KEY,
  occurred_at       TEXT    NOT NULL,
  route_id          TEXT,
  provider_id       TEXT,
  proxy_id          TEXT,
  model             TEXT    NOT NULL,
  routing_mode      TEXT    NOT NULL CHECK (routing_mode IN ('direct','combo','failover')),
  outcome           TEXT    NOT NULL CHECK (outcome IN ('ok','failed')),
  failure_category  TEXT,
  latency_ms        INTEGER NOT NULL CHECK (latency_ms >= 0),
  attempts          INTEGER NOT NULL CHECK (attempts >= 0),
  prompt_tokens     INTEGER CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  completion_tokens INTEGER CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  cached_tokens     INTEGER CHECK (cached_tokens IS NULL OR cached_tokens >= 0)
);

CREATE TABLE usage_attempts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id       TEXT    NOT NULL,
  occurred_at      TEXT    NOT NULL,
  route_id         TEXT,
  provider_id      TEXT    NOT NULL,
  outcome          TEXT    NOT NULL CHECK (outcome IN ('ok','failed')),
  failure_category TEXT,
  latency_ms       INTEGER NOT NULL CHECK (latency_ms >= 0)
);
```

No foreign key to `requests`: an attempt is worth keeping even if its parent row
was pruned, and a cascade would make retention order-dependent.

Deliberately absent: any TEXT column that could hold content. `failure_category`
is enum-constrained at the schema level as a second line of defence behind the
recorder.

**Retention** is count-based, default 5,000 requests and 20,000 attempts,
configurable via `BAYZ_USAGE_RETENTION`. Pruning runs on write, deleting only rows
outside the newest N **within the usage tables** — nothing else is ever touched.
Count rather than age because a count bounds disk deterministically while an age
window does not.

## 6. Usage API

```text
GET /api/usage/summary?period=today|24h|7d|30d
GET /api/usage/requests?limit=50
GET /api/usage/providers
```

All three require the API token, like every route except `/api/health`. Responses
carry metadata only. `summary` reports request counts, outcome split, token totals
where known, and `costAvailable: false` with `costReason: "no_pricing_data"` —
stated rather than invented.

Token totals distinguish **zero** from **unknown**: a field is `null` when no
provider reported it, and the summary reports how many requests contributed.

## 7. Flux Core real data

`apps/dashboard/src/flux/adapter.ts` maps `/api/usage/providers` plus
`/api/providers` onto the existing `FluxCoreViewModel` with `source: "live"`.
Provider state derives from recent attempt outcomes: all-ok → `active`, recent
failures → `degraded`, all-recent-failed → `failed`, no traffic but enabled →
`standby`, disabled → `off`.

The dashboard polls at 5 s. The canvas engine is untouched: it continues to own
every frame, and the adapter only replaces the view model, exactly as the LOCKED
integration already supports. Nothing new runs per frame.

## 8. Content-Security-Policy

Served on the dashboard document:

```text
default-src 'none';
script-src 'self';
style-src 'self';
img-src 'self' data:;
font-src 'self';
connect-src 'self';
base-uri 'none';
form-action 'none';
frame-ancestors 'none';
object-src 'none'
```

No `unsafe-inline` and no `unsafe-eval`. Vite emits external script and style
files, and Flux Core is already free of remote fonts, `eval`, and inline handlers,
so no exception is required. The one detail to verify is that Flux Core sets
element styles via the React `style` prop — which is a DOM property assignment, not
an inline `style` attribute in the CSP sense — so `style-src 'self'` holds.

If any of that turns out to be false, the implementation gets fixed; the policy
does not get relaxed.

## 9. Bounds

- String fields: length-capped and slug-validated; over-long values rejected, not
  truncated into something misleading.
- Integers: `Number.isInteger`, non-negative, capped (latency ≤ 24 h, tokens ≤ 100
  M, attempts ≤ 100). Out-of-range is rejected.
- Timestamps: must parse and fall within ±24 h of now, else replaced with now.
- Cardinality: bounded by retention plus id validation.
- Flooding: bounded by retention pruning on every write.
- A malformed event is dropped with a redacted counter increment, never partially
  written.

## 10. Verification

Per-task RED→GREEN. Gate adds `scripts/usage-smoke.mjs`: a real listener, a real
origin, a real failing origin, a real `CONNECT` proxy, a real chat through the real
router, then a byte scan of `bayz.db`/`-wal`/`-shm`, every usage API response, and
captured logs for prompt, completion, and credential sentinels.
