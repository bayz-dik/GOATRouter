# Bayz Router — Operator Dashboard Design (Phase 7)

Status: Accepted · Date: 2026-08-26 · Predecessors: Phases 1–6

## 1. Goal

Let an operator manage providers, proxies, and routes from the existing dashboard
shell instead of `curl`, and send a test chat. The API already exists and is
authenticated; Phase 7 is a client for it.

## 2. Non-goals

- **The Flux Core motion system stays LOCKED.** No Flux file is tracked in this
  workspace, and none is created. If the real Sites/UI source arrives later, its
  visual direction is authoritative over anything built here.
- No redesign of `BAYZ-responsive-master.html`. `apps/dashboard` remains the
  runtime foundation shell; Phase 7 adds panels inside it, not a new visual
  language.
- No new runtime dependency. React and Vite are already present; no state library,
  no component kit, no HTTP client package.
- No credential display, ever. Not masked, not partially revealed, not on request.
- No chat history persistence. The test-chat panel keeps a transcript in component
  state and loses it on reload, because persisting prompts is exactly what Phase 5
  refuses to do.
- No streaming UI. The API returns `400` for `stream`, so the panel does not offer
  it.

## 3. Token handling in a browser

The dashboard is served from the same origin as the API, so a request needs the
bearer token. Where that token lives is the central decision.

- The token is held in **module-scope memory only**, entered through a form on
  first use. It is not written to `localStorage`, `sessionStorage`, a cookie, or
  the URL. A reload requires re-entry.
- Rationale: `localStorage` is readable by any script that achieves XSS on the
  origin, and a persisted operator token turns a transient script injection into
  permanent API access. Re-entry on reload is a real inconvenience, accepted
  deliberately, and the README says so.
- The input uses `type="password"` and `autocomplete="off"`.
- On `401` the client clears the in-memory token and returns to the entry form, so
  a rotated token cannot leave the UI in a silently broken state.

## 4. Client layer

`apps/dashboard/src/api/client.ts`:

- One `request()` helper: injects `Authorization`, sets
  `content-type: application/json` for bodies, and parses the Bayz error envelope
  into a typed `ApiError { status, code, message, requestId }`.
- `credentials: "omit"` on every call. The API is cookie-free by design and
  ambient credentials would only add CSRF surface.
- Typed wrappers per endpoint. No dynamic path building from unvalidated input:
  ids are encoded with `encodeURIComponent`.
- A hard client-side timeout via `AbortSignal.timeout`, so a hung request cannot
  leave a panel spinning forever.
- **No function returns a credential or password**, because no such endpoint
  exists. A source-scan test asserts the client has no `getCredential`-shaped
  method.

## 5. Panels

Four panels plus a status header, all inside the existing shell:

1. **Status** — `/api/status`: schema version, driver, journal mode, key provider,
   counts. Read-only.
2. **Providers** — list, create, enable/disable, delete; set/clear credential
   (write-only field that clears itself on submit); discover models.
3. **Proxies** — list, create, enable/disable, delete; set/clear password
   (write-only); run a reachability check and show `ok` plus latency.
4. **Routes** — list, create, enable/disable, delete, set priority, bind/unbind a
   proxy.
5. **Test chat** — pick a model from `/v1/models`, send one message, show the
   reply plus the `x-bayz-route` / `x-bayz-provider` / `x-bayz-proxy` headers so an
   operator can see *where* the answer came from.

Every panel shows `code` and `message` from the error envelope verbatim on
failure. The envelope already refuses to carry secrets, so surfacing it is safe
and far more useful than "something went wrong".

## 6. Threat-model notes

- Token in memory only: XSS becomes a session-length problem, not a permanent
  credential theft.
- No secret is ever rendered. Credential and password inputs are write-only and
  zeroed from component state on submit.
- The API's `Origin` check already refuses cross-site requests; the dashboard being
  same-origin means it passes without any CORS relaxation.
- No prompt or completion is persisted anywhere — not in storage, not in
  `localStorage`.

## 7. Verification

Vitest with Testing Library (already present) for panel behaviour against a stubbed
`fetch`; a source-scan test for the no-credential-accessor rule; and
`scripts/dashboard-smoke.mjs` building the dashboard and asserting the bundle
contains no `localStorage`/`sessionStorage`/`document.cookie` write and no token
literal. The existing five smoke scripts and the full regression gate must stay
green, and `git log -- apps/dashboard` must show Phase 7 as the only change since
Phase 1.
