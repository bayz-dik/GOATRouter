# Bayz Router Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce the first independently runnable Bayz All-in-One skeleton: typed shared contracts, a Node.js/Fastify Core with a real health endpoint, a React Bayz dashboard served by that Core, secure request IDs and log redaction, loopback-safe runtime configuration, and repeatable tests/builds.

**Architecture:** Keep the existing private Sites review surface intact while adding the final runtime as npm workspaces under `apps/` and `packages/`. The Node Core owns APIs and serves the compiled dashboard from one process; shared contracts prevent server/dashboard drift. This phase deliberately does not add provider credentials, routing, proxies, SQLite, or demo implementations of later features.

**Tech Stack:** TypeScript, Node.js 24+, npm workspaces, Fastify 5, React 19, Vite 8, Zod 4, Node test runner through `tsx`, React Testing Library, native `fetch`.

**Spec:** `docs/superpowers/specs/2026-08-25-bayz-router-all-in-one-design.md`

## Global Constraints

- One install, one process, one dashboard, one configurable port.
- Default API and dashboard origin: `http://127.0.0.1:20128`.
- OpenAI-compatible API base: `http://127.0.0.1:20128/v1`.
- Web UI and Node.js Core ship together; they are not separate products.
- Local-first and single-admin by default, with remote access disabled until explicitly configured.
- Node.js 24 or newer is required for the final runtime.
- Direct Termux installation is a first-class compatibility target.
- Keep the dashboard private during development.
- Keep the visual system black, white, and grayscale.
- Do not copy protected third-party brand assets or the 9Router radial usage graph.
- Do not present a later-phase feature as active before it has real behavior.
- Preserve the existing root Sites build and its private review URL throughout this phase.
- Do not push to the user's GitHub during this phase.

## Scope decomposition

The approved specification contains several independent subsystems. It is intentionally split into separately executable plans. This is Plan 1 and must finish before later plans are written against the resulting interfaces.

1. Foundation — this plan.
2. Security and SQLite storage.
3. Provider Manager and model discovery.
4. HTTP/HTTPS/SOCKS Proxy Manager.
5. Unified OpenAI/Anthropic/Gemini API surfaces.
6. Routing Engine and combos.
7. Client integrations and per-tool keys.
8. Usage, logs, Relay Track, and complete dashboard.
9. Packaging, compatibility, security, load, and soak stabilization.

## File structure locked by this phase

```text
apps/
  dashboard/
    index.html                 Vite entry document
    package.json               dashboard scripts and dependencies
    tsconfig.json              dashboard TypeScript boundary
    vite.config.ts             deterministic dashboard build
    src/api/health.ts          typed health client
    src/App.tsx                real foundation dashboard screen
    src/main.tsx               React mount
    src/styles.css             Bayz grayscale tokens and responsive shell
    test/App.test.tsx          UI health-state behavior
    test/setup.ts              DOM test setup
  server/
    package.json               Core scripts and dependencies
    tsconfig.json              Node TypeScript boundary
    src/app.ts                 Fastify composition root
    src/config.ts              environment/runtime configuration
    src/errors.ts              stable API error handling
    src/index.ts               process entrypoint and shutdown
    src/static-dashboard.ts    dashboard static serving
    test/app.test.ts           health and request-ID tests
    test/config.test.ts        loopback-safe config tests
    test/static-dashboard.test.ts static asset integration test
packages/
  contracts/
    package.json
    tsconfig.json
    src/index.ts               shared Zod schemas and inferred types
    test/contracts.test.ts     schema contract tests
  security/
    package.json
    tsconfig.json
    src/redact.ts              recursive secret redaction
    src/index.ts               public package exports
    test/redact.test.ts        redaction tests
tests/runtime-structure.test.mjs root workspace/smoke contract
```

---

### Task 1: Create the workspace and shared contracts

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/test/contracts.test.ts`
- Create: `packages/contracts/src/index.ts`

**Interfaces:**
- Consumes: none.
- Produces: `HealthSchema`, `HealthResponse`, `ApiErrorSchema`, `ApiErrorResponse`, `ClientProtocolSchema`, and `ClientProtocol` from `@bayz/contracts`.

- [ ] **Step 1: Add workspace metadata and write the failing contract test**

Add these root `package.json` fields without removing any existing Sites scripts or dependencies:

```json
{
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "runtime:test": "npm run test --workspaces --if-present",
    "runtime:build": "npm run build --workspace @bayz/contracts --if-present && npm run build --workspace @bayz/security --if-present && npm run build --workspace @bayz/dashboard && npm run build --workspace @bayz/server"
  }
}
```

Update the root `tsconfig.json` exclusion so the private Sites review build does
not typecheck the independent Node runtime workspaces with Next.js compiler
settings:

```json
{
  "exclude": ["node_modules", "apps", "packages"]
}
```

Create `packages/contracts/package.json`:

```json
{
  "name": "@bayz/contracts",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "scripts": {
    "test": "node --import tsx --test test/*.test.ts",
    "build": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "zod": "^4.0.0"
  }
}
```

Create `packages/contracts/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `packages/contracts/test/contracts.test.ts` before the implementation exists:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  ApiErrorSchema,
  ClientProtocolSchema,
  HealthSchema,
} from "../src/index.js";

test("accepts the stable health response", () => {
  const result = HealthSchema.parse({
    status: "ok",
    version: "0.1.0",
    uptimeSeconds: 12,
  });
  assert.equal(result.status, "ok");
});

test("rejects a health response with negative uptime", () => {
  assert.throws(() =>
    HealthSchema.parse({ status: "ok", version: "0.1.0", uptimeSeconds: -1 }),
  );
});

test("keeps API errors and client protocols stable", () => {
  const error = ApiErrorSchema.parse({
    error: {
      code: "internal_error",
      message: "Request failed",
      requestId: "req_123",
    },
  });
  assert.equal(error.error.requestId, "req_123");
  assert.equal(ClientProtocolSchema.parse("openai"), "openai");
  assert.equal(ClientProtocolSchema.parse("anthropic"), "anthropic");
});
```

- [ ] **Step 2: Install only the dependencies required by the contract test**

Run:

```bash
npm install --save-dev tsx@latest
npm install zod@^4.0.0 --workspace @bayz/contracts
```

Expected: root `package-lock.json` records the workspace and packages.

- [ ] **Step 3: Run the contract test and verify RED**

Run:

```bash
npm run test --workspace @bayz/contracts
```

Expected: FAIL because `packages/contracts/src/index.ts` does not exist or does not export the schemas.

- [ ] **Step 4: Implement the minimal shared contracts**

Create `packages/contracts/src/index.ts`:

```ts
import { z } from "zod";

export const HealthSchema = z.object({
  status: z.literal("ok"),
  version: z.string().min(1),
  uptimeSeconds: z.number().finite().nonnegative(),
});
export type HealthResponse = z.infer<typeof HealthSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().min(1),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorResponse = z.infer<typeof ApiErrorSchema>;

export const ClientProtocolSchema = z.enum(["openai", "anthropic"]);
export type ClientProtocol = z.infer<typeof ClientProtocolSchema>;
```

- [ ] **Step 5: Run contracts test and typecheck**

Run:

```bash
npm run test --workspace @bayz/contracts
npm run build --workspace @bayz/contracts
```

Expected: all contract tests PASS and TypeScript exits 0.

- [ ] **Step 6: Commit the contract boundary**

```bash
git add package.json package-lock.json tsconfig.json packages/contracts
git commit -m "feat: add Bayz shared API contracts"
```

---

### Task 2: Add recursive secret redaction

**Files:**
- Create: `packages/security/package.json`
- Create: `packages/security/tsconfig.json`
- Create: `packages/security/test/redact.test.ts`
- Create: `packages/security/src/redact.ts`
- Create: `packages/security/src/index.ts`

**Interfaces:**
- Consumes: plain JavaScript values.
- Produces: `redactSecrets<T>(value: T): T` from `@bayz/security`.

- [ ] **Step 1: Scaffold the package and write the failing redaction tests**

Create `packages/security/package.json`:

```json
{
  "name": "@bayz/security",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "scripts": {
    "test": "node --import tsx --test test/*.test.ts",
    "build": "tsc -p tsconfig.json --noEmit"
  }
}
```

Create `packages/security/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `packages/security/test/redact.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { redactSecrets } from "../src/index.js";

test("redacts secret fields recursively without mutating input", () => {
  const input = {
    authorization: "Bearer secret",
    nested: {
      apiKey: "sk-provider",
      proxyPassword: "proxy-secret",
      safe: "visible",
    },
    rows: [{ cookie: "session=secret", model: "gpt-test" }],
  };

  const output = redactSecrets(input);

  assert.deepEqual(output, {
    authorization: "[REDACTED]",
    nested: {
      apiKey: "[REDACTED]",
      proxyPassword: "[REDACTED]",
      safe: "visible",
    },
    rows: [{ cookie: "[REDACTED]", model: "gpt-test" }],
  });
  assert.equal(input.nested.apiKey, "sk-provider");
});

test("preserves null, primitives, and dates", () => {
  const when = new Date("2026-08-25T00:00:00Z");
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets("safe"), "safe");
  assert.equal(redactSecrets(when), when);
});
```

- [ ] **Step 2: Run the security test and verify RED**

Run:

```bash
npm run test --workspace @bayz/security
```

Expected: FAIL because `redactSecrets` does not exist.

- [ ] **Step 3: Implement recursive redaction**

Create `packages/security/src/redact.ts`:

```ts
const SECRET_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "apikey",
  "api_key",
  "password",
  "proxypassword",
  "proxy_password",
  "access_token",
  "refresh_token",
]);

export function redactSecrets<T>(value: T): T {
  if (value === null || typeof value !== "object" || value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry)) as T;
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SECRET_KEYS.has(key.toLowerCase())
      ? "[REDACTED]"
      : redactSecrets(entry);
  }
  return output as T;
}
```

Create `packages/security/src/index.ts`:

```ts
export { redactSecrets } from "./redact.js";
```

- [ ] **Step 4: Run security test and typecheck**

Run:

```bash
npm run test --workspace @bayz/security
npm run build --workspace @bayz/security
```

Expected: all security tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit the redaction primitive**

```bash
git add packages/security
git commit -m "feat: add recursive secret redaction"
```

---

### Task 3: Build the Core health endpoint

**Files:**
- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/test/app.test.ts`
- Create: `apps/server/src/app.ts`

**Interfaces:**
- Consumes: `HealthResponse` from `@bayz/contracts`.
- Produces: `buildApp(options?: { version?: string; logger?: boolean }): FastifyInstance` and `GET /api/health`.

- [ ] **Step 1: Scaffold the Core package and write the failing health test**

Create `apps/server/package.json`:

```json
{
  "name": "@bayz/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.0.0" },
  "scripts": {
    "test": "node --import tsx --test test/*.test.ts",
    "build": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@bayz/contracts": "0.1.0",
    "@bayz/security": "0.1.0",
    "fastify": "^5.0.0"
  }
}
```

Create `apps/server/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `apps/server/test/app.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { HealthSchema } from "@bayz/contracts";
import { buildApp } from "../src/app.js";

test("GET /api/health returns the typed Core health response", async (t) => {
  const app = buildApp({ version: "0.1.0", logger: false });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.statusCode, 200);
  const body = HealthSchema.parse(response.json());
  assert.equal(body.status, "ok");
  assert.equal(body.version, "0.1.0");
  assert.ok(body.uptimeSeconds >= 0);
});
```

- [ ] **Step 2: Install Core dependencies**

Run:

```bash
npm install fastify@^5.0.0 --workspace @bayz/server
```

Expected: dependencies resolve and the lockfile records `@bayz/server`.

- [ ] **Step 3: Run the Core test and verify RED**

Run:

```bash
npm run test --workspace @bayz/server
```

Expected: FAIL because `apps/server/src/app.ts` does not exist.

- [ ] **Step 4: Implement the Fastify composition root and health route**

Create `apps/server/src/app.ts`:

```ts
import Fastify, { type FastifyInstance } from "fastify";
import type { HealthResponse } from "@bayz/contracts";

export type BuildAppOptions = {
  version?: string;
  logger?: boolean;
};

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });
  const version = options.version ?? "0.1.0";

  app.get("/api/health", async (): Promise<HealthResponse> => ({
    status: "ok",
    version,
    uptimeSeconds: process.uptime(),
  }));

  return app;
}
```

- [ ] **Step 5: Run the Core test and typecheck**

Run:

```bash
npm run test --workspace @bayz/server
npm run build --workspace @bayz/server
```

Expected: health test PASS and TypeScript exits 0.

- [ ] **Step 6: Commit the runnable Core boundary**

```bash
git add apps/server package-lock.json
git commit -m "feat: add Bayz Core health endpoint"
```

---

### Task 4: Add request IDs and stable error envelopes

**Files:**
- Modify: `apps/server/test/app.test.ts`
- Create: `apps/server/src/errors.ts`
- Modify: `apps/server/src/app.ts`

**Interfaces:**
- Consumes: `ApiErrorResponse` from `@bayz/contracts` and `redactSecrets` from `@bayz/security`.
- Produces: `installErrorHandling(app: FastifyInstance): void`; every response has `x-request-id`; uncaught errors return the stable API error envelope.

- [ ] **Step 1: Write failing request-ID and error-envelope tests**

Append to `apps/server/test/app.test.ts`:

```ts
test("preserves a valid client request ID", async (t) => {
  const app = buildApp({ logger: false });
  t.after(() => app.close());
  const response = await app.inject({
    method: "GET",
    url: "/api/health",
    headers: { "x-request-id": "req_client_123" },
  });
  assert.equal(response.headers["x-request-id"], "req_client_123");
});

test("returns a redacted stable error envelope", async (t) => {
  const app = buildApp({ logger: false, registerTestRoutes: true });
  t.after(() => app.close());
  const response = await app.inject({
    method: "GET",
    url: "/__test/error",
    headers: { "x-request-id": "req_error_123" },
  });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), {
    error: {
      code: "internal_error",
      message: "Request failed",
      requestId: "req_error_123",
    },
  });
  assert.doesNotMatch(response.body, /sk-secret/);
});
```

- [ ] **Step 2: Run the targeted tests and verify RED**

Run:

```bash
npm run test --workspace @bayz/server
```

Expected: FAIL because request IDs, the test-only route option, and stable error handling are absent.

- [ ] **Step 3: Implement request IDs and the error handler**

Create `apps/server/src/errors.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type { ApiErrorResponse } from "@bayz/contracts";
import { redactSecrets } from "@bayz/security";

export function installErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    request.log.error(redactSecrets({
      error: { name: error.name, message: error.message },
      headers: request.headers,
    }));
    const body: ApiErrorResponse = {
      error: {
        code: "internal_error",
        message: "Request failed",
        requestId: request.id,
      },
    };
    void reply.code(500).send(body);
  });
}
```

Replace `apps/server/src/app.ts` with the complete request-aware composition
root:

```ts
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { HealthResponse } from "@bayz/contracts";
import { installErrorHandling } from "./errors.js";

export type BuildAppOptions = {
  version?: string;
  logger?: boolean;
  registerTestRoutes?: boolean;
};

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? true,
    genReqId(request) {
      const supplied = request.headers["x-request-id"];
      return typeof supplied === "string" && SAFE_REQUEST_ID.test(supplied)
        ? supplied
        : `req_${randomUUID()}`;
    },
  });

  app.addHook("onSend", async (request, reply, payload) => {
    void reply.header("x-request-id", request.id);
    return payload;
  });

  app.get("/api/health", async (): Promise<HealthResponse> => ({
    status: "ok",
    version: options.version ?? "0.1.0",
    uptimeSeconds: process.uptime(),
  }));

  if (options.registerTestRoutes) {
    app.get("/__test/error", async () => {
      throw new Error("sk-secret");
    });
  }

  installErrorHandling(app);
  return app;
}
```

- [ ] **Step 4: Run Core tests and typecheck**

Run:

```bash
npm run test --workspace @bayz/server
npm run build --workspace @bayz/server
```

Expected: health, request-ID, and stable-error tests PASS; no secret appears in response output.

- [ ] **Step 5: Commit observable error handling**

```bash
git add apps/server
git commit -m "feat: add Core request tracing and safe errors"
```

---

### Task 5: Build the real React dashboard foundation

**Files:**
- Create: `apps/dashboard/package.json`
- Create: `apps/dashboard/tsconfig.json`
- Create: `apps/dashboard/vite.config.ts`
- Create: `apps/dashboard/index.html`
- Create: `apps/dashboard/test/setup.ts`
- Create: `apps/dashboard/test/App.test.tsx`
- Create: `apps/dashboard/src/api/health.ts`
- Create: `apps/dashboard/src/App.tsx`
- Create: `apps/dashboard/src/main.tsx`
- Create: `apps/dashboard/src/styles.css`

**Interfaces:**
- Consumes: `HealthSchema` and `HealthResponse` from `@bayz/contracts`; `GET /api/health` from Task 3.
- Produces: `fetchHealth(fetcher?: typeof fetch): Promise<HealthResponse>` and `App({ healthClient? })`.

- [ ] **Step 1: Scaffold the dashboard and write the failing UI tests**

Create `apps/dashboard/package.json`:

```json
{
  "name": "@bayz/dashboard",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "build": "tsc -p tsconfig.json --noEmit && vite build"
  },
  "dependencies": {
    "@bayz/contracts": "0.1.0",
    "react": "19.2.6",
    "react-dom": "19.2.6"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.0.0",
    "@testing-library/react": "^16.0.0",
    "@vitejs/plugin-react": "^6.0.0",
    "jsdom": "^26.0.0",
    "vite": "^8.0.0",
    "vitest": "^4.0.0"
  }
}
```

Create `apps/dashboard/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["DOM", "ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "test/**/*.ts", "test/**/*.tsx", "vite.config.ts"]
}
```

Create `apps/dashboard/vite.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  test: {
    environment: "jsdom",
    setupFiles: "./test/setup.ts",
  },
});
```

Create `apps/dashboard/test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

Create `apps/dashboard/test/App.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";

describe("Bayz dashboard foundation", () => {
  it("shows a verified Core status", async () => {
    render(
      <App
        healthClient={async () => ({
          status: "ok",
          version: "0.1.0",
          uptimeSeconds: 42,
        })}
      />,
    );
    expect(screen.getByRole("heading", { name: "Bayz" })).toBeInTheDocument();
    expect(await screen.findByText("Core online")).toBeInTheDocument();
    expect(screen.getByText("v0.1.0")).toBeInTheDocument();
  });

  it("shows an actionable offline state", async () => {
    render(<App healthClient={async () => { throw new Error("offline"); }} />);
    expect(await screen.findByText("Core offline")).toBeInTheDocument();
    expect(screen.getByText("Check the Bayz process and try again.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Install dashboard dependencies**

Run:

```bash
npm install --workspace @bayz/dashboard
```

Expected: dashboard dependencies are added without replacing existing root dependency versions.

- [ ] **Step 3: Run dashboard tests and verify RED**

Run:

```bash
npm run test --workspace @bayz/dashboard
```

Expected: FAIL because `App` does not exist.

- [ ] **Step 4: Implement the typed health client**

Create `apps/dashboard/src/api/health.ts`:

```ts
import { HealthSchema, type HealthResponse } from "@bayz/contracts";

export async function fetchHealth(
  fetcher: typeof fetch = fetch,
): Promise<HealthResponse> {
  const response = await fetcher("/api/health", {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Health request failed: ${response.status}`);
  return HealthSchema.parse(await response.json());
}
```

- [ ] **Step 5: Implement the Bayz foundation screen**

Create `apps/dashboard/src/App.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { HealthResponse } from "@bayz/contracts";
import { fetchHealth } from "./api/health";
import "./styles.css";

type AppProps = {
  healthClient?: () => Promise<HealthResponse>;
};

export function App({ healthClient = fetchHealth }: AppProps) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let active = true;
    void healthClient().then(
      (value) => active && setHealth(value),
      () => active && setOffline(true),
    );
    return () => { active = false; };
  }, [healthClient]);

  return (
    <main className="bayz-shell">
      <header className="bayz-header">
        <h1>Bayz</h1>
        <span>Foundation / Private</span>
      </header>
      <section className="status-panel" aria-live="polite">
        {!health && !offline && <p>Checking Core…</p>}
        {health && <><strong>Core online</strong><span>v{health.version}</span></>}
        {offline && <><strong>Core offline</strong><span>Check the Bayz process and try again.</span></>}
      </section>
      <nav aria-label="Planned Bayz modules">
        {[
          "Providers", "Proxies", "Combos", "Routes", "CLI Tools", "Usage",
        ].map((label) => <span className="planned-module" key={label}>{label} / Planned</span>)}
      </nav>
    </main>
  );
}
```

Create `apps/dashboard/src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>,
);
```

Create `apps/dashboard/index.html`:

```html
<!doctype html>
<html lang="id">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#050505" />
    <title>Bayz Router</title>
  </head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

Create `apps/dashboard/src/styles.css` with these exact foundation rules:

```css
:root {
  color: #050505;
  background: #fff;
  font-family: Arial, sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; min-height: 100dvh; }
.bayz-shell { min-height: 100dvh; padding: 16px; background: #fff; }
.bayz-header { display: flex; align-items: end; justify-content: space-between; border-bottom: 4px solid #050505; }
.bayz-header h1 { margin: 0; font-size: clamp(48px, 12vw, 112px); line-height: .88; text-transform: uppercase; }
.bayz-header span { padding-bottom: 8px; font: 700 11px monospace; text-transform: uppercase; }
.status-panel { margin-top: 16px; min-height: 120px; padding: 18px; color: #fff; background: #050505; display: grid; align-content: space-between; }
.status-panel strong { font-size: clamp(28px, 7vw, 56px); text-transform: uppercase; }
.status-panel span { font-family: monospace; }
nav { display: grid; grid-template-columns: 1fr; margin-top: 16px; border-top: 2px solid #050505; }
.planned-module { min-height: 54px; display: flex; align-items: center; border-bottom: 1px solid #050505; font: 700 12px monospace; text-transform: uppercase; }
@media (min-width: 640px) { .bayz-shell { padding: 24px; } nav { grid-template-columns: 1fr 1fr; } .planned-module:nth-child(odd) { border-right: 1px solid #050505; } }
@media (min-width: 1024px) { .bayz-shell { padding: 32px; } nav { grid-template-columns: repeat(3, 1fr); } .planned-module { border-right: 1px solid #050505; padding: 0 14px; } }
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
```

- [ ] **Step 6: Run dashboard tests and build**

Run:

```bash
npm run test --workspace @bayz/dashboard
npm run build --workspace @bayz/dashboard
```

Expected: both UI-state tests PASS and `apps/dashboard/dist/index.html` exists.

- [ ] **Step 7: Commit the real dashboard foundation**

```bash
git add apps/dashboard package-lock.json
git commit -m "feat: add Bayz runtime dashboard foundation"
```

---

### Task 6: Serve the compiled dashboard from the Core

**Files:**
- Modify: `apps/server/package.json`
- Create: `apps/server/test/static-dashboard.test.ts`
- Create: `apps/server/src/static-dashboard.ts`
- Modify: `apps/server/src/app.ts`

**Interfaces:**
- Consumes: a compiled dashboard directory.
- Produces: `registerStaticDashboard(app, { root }): Promise<void>` and `buildApp({ dashboardRoot })`.

- [ ] **Step 1: Write the failing static-dashboard integration test**

Create `apps/server/test/static-dashboard.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../src/app.js";

test("serves the dashboard and keeps API 404 responses as JSON", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bayz-dashboard-"));
  await writeFile(join(root, "index.html"), "<h1>Bayz Runtime</h1>");
  const app = buildApp({ logger: false, dashboardRoot: root });
  t.after(() => app.close());

  const page = await app.inject({ method: "GET", url: "/" });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Bayz Runtime/);

  const api = await app.inject({ method: "GET", url: "/api/missing" });
  assert.equal(api.statusCode, 404);
  assert.match(api.headers["content-type"] ?? "", /^application\/json/);
});
```

- [ ] **Step 2: Install the static-serving dependency**

Run:

```bash
npm install @fastify/static@^8.0.0 --workspace @bayz/server
```

Expected: the server workspace records `@fastify/static`.

- [ ] **Step 3: Run the targeted test and verify RED**

Run:

```bash
node --import tsx --test apps/server/test/static-dashboard.test.ts
```

Expected: FAIL because `dashboardRoot` and static registration are absent.

- [ ] **Step 4: Implement safe dashboard serving**

Create `apps/server/src/static-dashboard.ts`:

```ts
import staticPlugin from "@fastify/static";
import type { FastifyInstance } from "fastify";

export async function registerStaticDashboard(
  app: FastifyInstance,
  options: { root: string },
): Promise<void> {
  await app.register(staticPlugin, {
    root: options.root,
    wildcard: false,
  });
  app.get("/", async (_request, reply) => reply.sendFile("index.html"));
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/") || request.url.startsWith("/v1/")) {
      return reply.code(404).send({
        error: {
          code: "not_found",
          message: "Route not found",
          requestId: request.id,
        },
      });
    }
    return reply.sendFile("index.html");
  });
}
```

Update `BuildAppOptions` with `dashboardRoot?: string`. Before returning the app, conditionally call the async registration through a Fastify plugin:

```ts
if (options.dashboardRoot) {
  app.register(async (instance) => {
    await registerStaticDashboard(instance, { root: options.dashboardRoot! });
  });
}
```

- [ ] **Step 5: Run all server tests and typecheck**

Run:

```bash
npm run test --workspace @bayz/server
npm run build --workspace @bayz/server
```

Expected: all Core tests PASS, including dashboard serving and JSON API 404 behavior.

- [ ] **Step 6: Commit the one-process runtime boundary**

```bash
git add apps/server package-lock.json
git commit -m "feat: serve the dashboard from Bayz Core"
```

---

### Task 7: Add loopback-safe runtime configuration and process startup

**Files:**
- Create: `apps/server/test/config.test.ts`
- Create: `apps/server/src/config.ts`
- Create: `apps/server/src/index.ts`
- Modify: `apps/server/package.json`

**Interfaces:**
- Consumes: `process.env`-shaped records.
- Produces: `loadRuntimeConfig(env): RuntimeConfig`; process startup at `apps/server/src/index.ts`.

- [ ] **Step 1: Write failing runtime configuration tests**

Create `apps/server/test/config.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { loadRuntimeConfig } from "../src/config.js";

test("uses private local defaults", () => {
  const config = loadRuntimeConfig({});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 20128);
  assert.match(config.dataDir, /\.bayz$/);
});

test("rejects invalid ports and public binding without explicit opt-in", () => {
  assert.throws(() => loadRuntimeConfig({ BAYZ_PORT: "0" }), /BAYZ_PORT/);
  assert.throws(
    () => loadRuntimeConfig({ BAYZ_HOST: "0.0.0.0" }),
    /BAYZ_ALLOW_REMOTE=true/,
  );
});

test("allows an explicit remote binding", () => {
  const config = loadRuntimeConfig({
    BAYZ_HOST: "0.0.0.0",
    BAYZ_ALLOW_REMOTE: "true",
    BAYZ_PORT: "32128",
    BAYZ_DATA_DIR: "/tmp/bayz-data",
  });
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 32128);
  assert.equal(config.dataDir, "/tmp/bayz-data");
});
```

- [ ] **Step 2: Run the config test and verify RED**

Run:

```bash
node --import tsx --test apps/server/test/config.test.ts
```

Expected: FAIL because `loadRuntimeConfig` does not exist.

- [ ] **Step 3: Implement runtime configuration**

Create `apps/server/src/config.ts`:

```ts
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type RuntimeConfig = {
  host: string;
  port: number;
  dataDir: string;
  dashboardRoot: string;
};

export function loadRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): RuntimeConfig {
  const host = env.BAYZ_HOST ?? "127.0.0.1";
  const port = Number(env.BAYZ_PORT ?? "20128");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("BAYZ_PORT must be an integer from 1 to 65535");
  }
  const localHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (!localHosts.has(host) && env.BAYZ_ALLOW_REMOTE !== "true") {
    throw new Error("Non-loopback BAYZ_HOST requires BAYZ_ALLOW_REMOTE=true");
  }
  return {
    host,
    port,
    dataDir: resolve(env.BAYZ_DATA_DIR ?? `${homedir()}/.bayz`),
    dashboardRoot: resolve(
      env.BAYZ_DASHBOARD_ROOT ??
        fileURLToPath(new URL("../../dashboard/dist/", import.meta.url)),
    ),
  };
}
```

- [ ] **Step 4: Implement process startup and graceful shutdown**

Create `apps/server/src/index.ts`:

```ts
import { buildApp } from "./app.js";
import { loadRuntimeConfig } from "./config.js";

const config = loadRuntimeConfig();
const app = buildApp({ dashboardRoot: config.dashboardRoot });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "Bayz Core stopping");
  await app.close();
  process.exitCode = 0;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
app.log.info(
  { url: `http://${config.host}:${config.port}`, dataDir: config.dataDir },
  "Bayz Core ready",
);
```

Update `apps/server/package.json` scripts:

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "test": "node --import tsx --test test/*.test.ts",
    "build": "tsc -p tsconfig.json --noEmit"
  }
}
```

- [ ] **Step 5: Run config tests and all Core checks**

Run:

```bash
npm run test --workspace @bayz/server
npm run build --workspace @bayz/server
```

Expected: loopback defaults and remote opt-in tests PASS; all prior Core tests remain green.

- [ ] **Step 6: Commit safe runtime startup**

```bash
git add apps/server
git commit -m "feat: add safe Bayz runtime startup"
```

---

### Task 8: Add root smoke contracts and phase verification

**Files:**
- Create: `tests/runtime-structure.test.mjs`
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: all foundation workspace outputs.
- Produces: root `runtime:test`, `runtime:build`, and `runtime:verify` gates plus documented private startup.

- [ ] **Step 1: Write the failing root structure test**

Create `tests/runtime-structure.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("root package exposes the complete private runtime gates", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  assert.deepEqual(pkg.workspaces, ["apps/*", "packages/*"]);
  assert.equal(typeof pkg.scripts["runtime:test"], "string");
  assert.equal(typeof pkg.scripts["runtime:build"], "string");
  assert.equal(
    pkg.scripts["runtime:verify"],
    "npm run runtime:test && npm run runtime:build",
  );
});
```

- [ ] **Step 2: Run the structure test and verify RED**

Run:

```bash
node --test tests/runtime-structure.test.mjs
```

Expected: FAIL because `runtime:verify` is absent.

- [ ] **Step 3: Add the root verification script**

Add to root `package.json`:

```json
{
  "scripts": {
    "runtime:verify": "npm run runtime:test && npm run runtime:build"
  }
}
```

- [ ] **Step 4: Document the foundation without advertising unfinished features**

Append this section to `README.md`:

```markdown
## Bayz All-in-One Runtime

The private foundation runtime lives in `apps/server`, `apps/dashboard`, and
`packages/*`. It currently provides only the verified Core health surface and
dashboard status shell. Providers, proxies, combos, routes, integrations, and
usage remain visibly marked as planned until their real implementations pass
their dedicated phases.

- Node.js: 24 or newer
- Default URL: `http://127.0.0.1:20128`
- Verify: `npm run runtime:verify`
- Start after building the dashboard: `npm run start --workspace @bayz/server`

Do not expose the runtime on a non-loopback interface unless authentication and
the explicit remote-access setting are configured.
```

- [ ] **Step 5: Run the complete foundation verification gate**

Run:

```bash
node --test tests/runtime-structure.test.mjs
npm run runtime:verify
npm run build
```

Expected:

- root structure test PASS;
- every workspace test PASS;
- contracts, security, dashboard, and server builds exit 0;
- the existing private Sites build still exits 0.

- [ ] **Step 6: Inspect the diff and commit the verified phase**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and only intended foundation files are present.

Commit:

```bash
git add README.md package.json package-lock.json tests/runtime-structure.test.mjs apps packages
git commit -m "test: verify Bayz foundation runtime"
```

## Phase completion checklist

- [ ] `npm run runtime:verify` passes with zero failing tests.
- [ ] The existing root Sites build still passes.
- [ ] `GET /api/health` returns a schema-validated response.
- [ ] Every response has a safe request ID.
- [ ] Uncaught errors return the stable envelope and do not expose secrets.
- [ ] The React dashboard shows real Core online/offline state.
- [ ] The Node Core serves the compiled dashboard from the same process.
- [ ] Loopback is the default; remote binding requires explicit opt-in.
- [ ] Later modules are labeled planned and cannot be mistaken for working controls.
- [ ] No provider key, proxy credential, fake usage, router, combo, or client integration is introduced in this phase.
- [ ] Work remains private and no push to the user's GitHub occurs.
