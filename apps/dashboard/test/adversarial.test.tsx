import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { createTokenStore } from "../src/api/token";
import type { ApiClient } from "../src/api/client";

/**
 * Adversarial suite for the dashboard.
 *
 * The source scans are the load-bearing part: they make "the token is never
 * persisted" and "no credential is ever rendered" properties of the codebase
 * rather than of the tests that happen to exist today.
 */

const TOKEN = "adversarial-dashboard-token-0123";
const CREDENTIAL = "sk-adversarial-dashboard-credential";
const PASSWORD = "hunter2-adversarial-dashboard";

/**
 * Locate `apps/dashboard/src` on disk.
 *
 * jsdom rewrites `import.meta.url` to an http scheme, so a module-relative URL
 * cannot be used. The cwd differs depending on whether Vitest was started from the
 * workspace or the repo root, so both are tried and a miss is a hard failure rather
 * than a silently empty scan.
 */
function resolveSrcRoot(): string {
  for (const candidate of [
    join(process.cwd(), "src"),
    join(process.cwd(), "apps", "dashboard", "src"),
  ]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("Unable to locate apps/dashboard/src for the source scan");
}

const SRC_ROOT = resolveSrcRoot();

/**
 * Strip comments and string literals before scanning.
 *
 * The rules below must catch *code* that persists a token, not prose explaining
 * why we refuse to. Without this, documenting the decision in a comment would fail
 * the very test that enforces it, which would push the reasoning out of the source.
 */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

function sourceFiles(): Array<{ name: string; text: string }> {
  const files: Array<{ name: string; text: string }> = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(SRC_ROOT, relative), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(relative, entry.name));
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        files.push({
          name: join(relative, entry.name),
          text: readFileSync(join(SRC_ROOT, relative, entry.name), "utf8"),
        });
      }
    }
  };
  walk(".");
  return files;
}

describe("dashboard source guarantees", () => {
  it("finds the sources it is meant to scan", () => {
    expect(sourceFiles().length).toBeGreaterThanOrEqual(10);
  });

  it("never writes to localStorage, sessionStorage, or a cookie", () => {
    for (const source of sourceFiles()) {
      const code = codeOnly(source.text);
      expect(code, `${source.name} must not use localStorage`).not.toMatch(
        /localStorage/,
      );
      expect(code, `${source.name} must not use sessionStorage`).not.toMatch(
        /sessionStorage/,
      );
      expect(code, `${source.name} must not write a cookie`).not.toMatch(
        /document\s*\.\s*cookie/,
      );
      expect(code, `${source.name} must not use IndexedDB`).not.toMatch(/indexedDB/);
    }
  });

  it("never logs to the console, where a token could surface", () => {
    for (const source of sourceFiles()) {
      expect(codeOnly(source.text), `${source.name} must not call console`).not.toMatch(
        /console\s*\.\s*(log|info|warn|error|debug|table|dir)/,
      );
    }
  });

  it("uses no unsafe DOM escape hatch", () => {
    for (const source of sourceFiles()) {
      const source_code = codeOnly(source.text);
      expect(source_code, `${source.name} must not use dangerouslySetInnerHTML`).not.toMatch(
        /dangerouslySetInnerHTML/,
      );
      expect(source_code, `${source.name} must not assign innerHTML`).not.toMatch(
        /innerHTML\s*=/,
      );
      expect(source_code, `${source.name} must not use outerHTML`).not.toMatch(
        /outerHTML/,
      );
      expect(source_code, `${source.name} must not use insertAdjacentHTML`).not.toMatch(
        /insertAdjacentHTML/,
      );
      expect(source_code, `${source.name} must not eval`).not.toMatch(
        /\beval\s*\(|new\s+Function\s*\(/,
      );
      expect(source_code, `${source.name} must not use document.write`).not.toMatch(
        /document\s*\.\s*write/,
      );
    }
  });

  it("exposes no credential or password accessor", () => {
    for (const source of sourceFiles()) {
      expect(
        codeOnly(source.text),
        `${source.name} must not contain a secret accessor`,
      ).not.toMatch(/getCredential|getPassword|revealCredential|revealPassword/);
    }
  });

  it("puts no secret value into a URL", () => {
    for (const source of sourceFiles()) {
      // Credential and password writes must use a request body, never a query.
      expect(source.text, `${source.name} must not query-encode a secret`).not.toMatch(
        /[?&](token|credential|password|api_key|apiKey)=/,
      );
    }
  });

  it("does not add a runtime dependency", () => {
    const pkg = JSON.parse(
      readFileSync(join(SRC_ROOT, "..", "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      "@bayz/contracts",
      "react",
      "react-dom",
    ]);
  });

  it("leaves the Flux Core slot empty rather than approximating it", () => {
    const slot = sourceFiles().find((source) => source.name.endsWith("FluxCoreSlot.tsx"));
    expect(slot).toBeDefined();
    // No animation primitives may appear: the approved source is supplied later.
    expect(slot!.text).not.toMatch(/requestAnimationFrame|canvas|WebGL|@keyframes/i);
  });
});

describe("dashboard runtime guarantees", () => {
  function stubClient(overrides: Partial<ApiClient> = {}): ApiClient {
    return {
      getStatus: vi.fn(async () => ({
        schemaVersion: 4,
        journalMode: "wal",
        driver: "node:sqlite",
        keyProvider: "environment",
        keyId: "kek_deadbeefdeadbeefdeadbeefdeadbeef",
        counts: { providers: 1, proxies: 1, routes: 1 },
      })),
      listProviders: vi.fn(async () => [
        {
          id: "p1",
          kind: "openai-compatible" as const,
          displayName: "P1",
          baseUrl: "http://127.0.0.1:1/v1",
          enabled: true,
          config: { timeoutMs: 30000, discoveryPath: "/v1/models", modelLimit: 100 },
          credentialPresent: true,
          createdAt: "2026-08-26T00:00:00.000Z",
          updatedAt: "2026-08-26T00:00:00.000Z",
          // A hostile or buggy Core returning secrets must not be rendered.
          credential: CREDENTIAL,
          apiKey: CREDENTIAL,
        } as never,
      ]),
      listProxies: vi.fn(async () => [
        {
          id: "x1",
          kind: "socks5" as const,
          host: "127.0.0.1",
          port: 1080,
          username: "bayz",
          enabled: true,
          config: {
            connectTimeoutMs: 10000,
            healthCheckHost: "1.1.1.1",
            healthCheckPort: 443,
          },
          passwordPresent: true,
          createdAt: "2026-08-26T00:00:00.000Z",
          updatedAt: "2026-08-26T00:00:00.000Z",
          password: PASSWORD,
        } as never,
      ]),
      listRoutes: vi.fn(async () => [
        {
          id: "r1",
          model: "gpt-4o",
          providerId: "p1",
          proxyId: undefined,
          priority: 100,
          enabled: true,
          config: { maxAttempts: 2, requestTimeoutMs: 60000 },
          createdAt: "2026-08-26T00:00:00.000Z",
          updatedAt: "2026-08-26T00:00:00.000Z",
        },
      ]),
      listModels: vi.fn(async () => ["gpt-4o"]),
      ...overrides,
    } as unknown as ApiClient;
  }

  it("renders no secret from any panel, even when the API returns one", async () => {
    const store = createTokenStore();
    store.set(TOKEN);
    const { container } = render(
      <App
        healthClient={async () => ({ status: "ok", version: "0.1.0", uptimeSeconds: 1 })}
        tokenStore={store}
        apiClient={stubClient()}
      />,
    );

    await screen.findByText("P1");
    const html = container.innerHTML;
    expect(html).not.toContain(CREDENTIAL);
    expect(html).not.toContain(PASSWORD);
    expect(html).not.toContain(TOKEN);
  });

  it("keeps the token out of the DOM while unlocked", async () => {
    const store = createTokenStore();
    store.set(TOKEN);
    render(
      <App
        healthClient={async () => ({ status: "ok", version: "0.1.0", uptimeSeconds: 1 })}
        tokenStore={store}
        apiClient={stubClient()}
      />,
    );

    await screen.findByText("P1");
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it("stores nothing in the browser during a full render", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const store = createTokenStore();
    store.set(TOKEN);
    render(
      <App
        healthClient={async () => ({ status: "ok", version: "0.1.0", uptimeSeconds: 1 })}
        tokenStore={store}
        apiClient={stubClient()}
      />,
    );

    await screen.findByText("P1");
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
    setItem.mockRestore();
  });

  it("hides every operator panel until the session is unlocked", async () => {
    const store = createTokenStore();
    render(
      <App
        healthClient={async () => ({ status: "ok", version: "0.1.0", uptimeSeconds: 1 })}
        tokenStore={store}
        apiClient={stubClient()}
      />,
    );

    expect(await screen.findByLabelText(/api token/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Providers" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Proxies" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Routes" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Test chat" })).toBeNull();
  });

  it("still reports Core liveness before unlocking", async () => {
    const store = createTokenStore();
    render(
      <App
        healthClient={async () => ({ status: "ok", version: "0.1.0", uptimeSeconds: 1 })}
        tokenStore={store}
        apiClient={stubClient()}
      />,
    );
    expect(await screen.findByText("Core online")).toBeInTheDocument();
  });

  it("renders a hostile value from every panel as text, not markup", async () => {
    const store = createTokenStore();
    store.set(TOKEN);
    const payload = '<img src=x onerror="window.__xssApp = true">';
    const { container } = render(
      <App
        healthClient={async () => ({ status: "ok", version: "0.1.0", uptimeSeconds: 1 })}
        tokenStore={store}
        apiClient={stubClient({
          getStatus: vi.fn(async () => ({
            schemaVersion: 4,
            journalMode: payload,
            driver: payload,
            keyProvider: payload,
            keyId: payload,
            counts: { providers: 0, proxies: 0, routes: 0 },
          })) as never,
          listProviders: vi.fn(async () => [
            {
              id: "p1",
              kind: "openai-compatible" as const,
              displayName: payload,
              baseUrl: payload,
              enabled: true,
              config: { timeoutMs: 30000, discoveryPath: "/v1/models", modelLimit: 100 },
              credentialPresent: false,
              createdAt: "x",
              updatedAt: "x",
            },
          ]) as never,
        })}
      />,
    );

    await screen.findAllByText(payload);
    expect(container.querySelector("img")).toBeNull();
    expect((window as unknown as Record<string, unknown>).__xssApp).toBeUndefined();
  });

  it("provides the Flux Core mount point without any animation of its own", async () => {
    const store = createTokenStore();
    store.set(TOKEN);
    const { container } = render(
      <App
        healthClient={async () => ({ status: "ok", version: "0.1.0", uptimeSeconds: 1 })}
        tokenStore={store}
        apiClient={stubClient()}
      />,
    );

    await screen.findByText("P1");
    const slot = container.querySelector("[data-bayz-flux-core-slot]");
    expect(slot).not.toBeNull();
    expect(slot!.childElementCount).toBe(0);
    expect(container.querySelector("canvas")).toBeNull();
  });
});
