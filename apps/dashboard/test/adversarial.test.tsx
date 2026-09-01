import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
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

  it("renders the approved Flux Core through its slot without inventing motion", () => {
    const slot = sourceFiles().find((source) => source.name.endsWith("FluxCoreSlot.tsx"));
    expect(slot).toBeDefined();
    // The slot delegates to the approved component and defines no animation of its
    // own; the engine is the single place motion lives.
    expect(slot!.text).toMatch(/FluxCore/);
    expect(codeOnly(slot!.text)).not.toMatch(/requestAnimationFrame|WebGL|@keyframes/i);

    // Exactly one module may drive frames, so a second animation loop cannot be
    // introduced alongside the approved one.
    const drivers = sourceFiles().filter((source) =>
      /requestAnimationFrame/.test(codeOnly(source.text)),
    );
    expect(drivers.map((source) => source.name).sort()).toEqual([
      "flux/FluxCore.tsx",
      "flux/engine.ts",
    ]);
  });

  it("uses no remote font, script, or stylesheet anywhere in the dashboard", () => {
    for (const source of sourceFiles()) {
      const text = source.text;
      expect(text, `${source.name} must not import Google Fonts`).not.toMatch(
        /fonts\.googleapis\.com|fonts\.gstatic\.com/,
      );
      expect(text, `${source.name} must not reference a CDN`).not.toMatch(
        /cdn\.jsdelivr|unpkg\.com|cdnjs\.cloudflare/i,
      );
      // Only a loadable URL is a dependency; a URL inside a comment is prose.
      expect(
        codeOnly(text),
        `${source.name} must not load a remote origin`,
      ).not.toMatch(/(?:src|href|url\(|from\s*['"`])\s*['"`(]?\s*https?:\/\//i);
    }
  });

  it("keeps the Flux Core css free of remote imports", () => {
    // Comments are stripped for the same reason as in the source scan: the file
    // documents that the Google Fonts @import was removed, and that explanation
    // must not trip the rule that enforces its removal.
    const css = readFileSync(join(SRC_ROOT, "flux", "flux.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      " ",
    );
    expect(css).not.toMatch(/@import/);
    expect(css).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    expect(css).not.toMatch(/url\(\s*['"]?https?:/i);
  });
});

/** A key-shaped value the identity panel must never render from a list response. */
const CLIENT_KEY = "c".repeat(64);

describe("dashboard runtime guarantees", () => {
  function stubClient(overrides: Partial<ApiClient> = {}): ApiClient {
    return {
      getStatus: vi.fn(async () => ({
        schemaVersion: 4,
        journalMode: "wal",
        driver: "node:sqlite",
        keyProvider: "environment",
        keyId: "kek_deadbeefdeadbeefdeadbeefdeadbeef",
        counts: { providers: 1, proxies: 1, routes: 1, identities: 1 },
      })),
      listIdentities: vi.fn(async () => [
        {
          id: "opencode",
          displayName: "OpenCode",
          scopes: ["chat.completions", "models.read"],
          preset: "opencode",
          revoked: false,
          expiresAt: undefined,
          createdAt: "2026-08-27T00:00:00.000Z",
          updatedAt: "2026-08-27T00:00:00.000Z",
          lastUsedAt: undefined,
          // A hostile or buggy Core returning a key must not be rendered. There is
          // no field on the view that carries one, so this must be dropped.
          key: CLIENT_KEY,
        } as never,
      ]),
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
      getUsageSummary: vi.fn(async () => ({
        period: "today",
        totalRequests: 3,
        okRequests: 2,
        failedRequests: 1,
        promptTokens: 1200,
        completionTokens: 340,
        cachedTokens: 90,
        tokenReports: 3,
        averageLatencyMs: 410,
        costAvailable: false,
        costReason: "no_pricing_data",
        retention: { requests: 5000, attempts: 20000 },
      })),
      listUsageProviders: vi.fn(async () => [
        {
          providerId: "p1",
          displayName: "P1",
          kind: "openai-compatible",
          enabled: true,
          credentialPresent: true,
          attempts: 3,
          failures: 1,
          lastOutcome: "ok" as const,
          lastFailureCategory: "timeout",
          averageLatencyMs: 410,
          // A hostile or buggy Core returning secrets on a usage row must not render.
          credential: CREDENTIAL,
          apiKey: CREDENTIAL,
        } as never,
      ]),
      listUsageRequests: vi.fn(async () => [
        {
          requestId: "req_1",
          occurredAt: new Date().toISOString(),
          routeId: "r1",
          providerId: "p1",
          proxyId: null,
          model: "gpt-4o",
          routingMode: "direct",
          outcome: "ok",
          failureCategory: null,
          latencyMs: 410,
          attempts: 1,
          promptTokens: 1200,
          completionTokens: 340,
          cachedTokens: 90,
          // Content the router never stores. If it ever appeared, it must not render.
          prompt: CREDENTIAL,
          completion: PASSWORD,
        } as never,
      ]),
      ...overrides,
    } as unknown as ApiClient;
  }

  /** Visit one screen through the real navigation, exactly as an operator would. */
  function goTo(label: string): void {
    fireEvent.click(screen.getByRole("button", { name: label }));
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

    /*
     * Every screen is visited, because the panels no longer share one page: a scan of
     * the home screen alone would report clean for the same reason a working one does.
     */
    for (const [label, marker] of [
      ["Providers", "P1"],
      ["Identities", "OpenCode"],
      ["Proxies", "x1"],
      ["Routes", "r1"],
      ["Usage", "gpt-4o"],
    ] as const) {
      goTo(label);
      await screen.findAllByText(new RegExp(marker, "i"));
      const html = container.innerHTML;
      expect(html, `${label} rendered a credential`).not.toContain(CREDENTIAL);
      expect(html, `${label} rendered a password`).not.toContain(PASSWORD);
      expect(html, `${label} rendered the API token`).not.toContain(TOKEN);
      // A client key smuggled into a list response must not reach the DOM either.
      expect(html, `${label} rendered a client key`).not.toContain(CLIENT_KEY);
      expect(html, `${label} rendered a key-shaped literal`).not.toMatch(/[0-9a-f]{64}/);
    }
    // Six screens rendered in one test, each awaiting its own fetch: the default
    // five-second budget is for a single render, not a whole tour.
  }, 30_000);

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

    goTo("Providers");
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

    goTo("Providers");
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
    expect(screen.queryByRole("heading", { name: "Runtime" })).toBeNull();

    /*
     * Navigation cannot be a way around the gate, because while locked there IS no
     * navigation: `App` returns the login surface without mounting the shell. This used
     * to walk each screen and assert the token field was still shown — a weaker property,
     * since it accepted a rail rendering around the gate. Asserting the absence of every
     * nav control is the stronger form, and it fails if the shell ever comes back.
     */
    for (const label of [
      "Home",
      "Providers",
      "Proxies",
      "Routes",
      "Identities",
      "Chat",
      "Usage",
    ] as const) {
      expect(
        screen.queryByRole("button", { name: label }),
        `${label} navigation is reachable while locked`,
      ).toBeNull();
    }

    // And none of the panel headings those screens would render.
    for (const heading of [
      "Providers",
      "Proxies",
      "Routes",
      "Client identities",
      "Test chat",
      "Recent requests",
    ] as const) {
      expect(
        screen.queryByRole("heading", { name: heading, level: 2 }),
        `${heading} rendered while locked`,
      ).toBeNull();
    }
  });

  it("reports Core liveness once unlocked, and not before", async () => {
    /*
     * Liveness is a real reading from `/api/health`, which needs no token — but it is
     * still not shown on the login surface. Pre-authentication the only question is
     * "what do I type here", and a status line answers a question nobody asked yet.
     */
    const locked = createTokenStore();
    const { unmount } = render(
      <App
        healthClient={async () => ({ status: "ok", version: "0.1.0", uptimeSeconds: 1 })}
        tokenStore={locked}
        apiClient={stubClient()}
      />,
    );
    await screen.findByLabelText(/api token/i);
    expect(screen.queryByText("Core online")).toBeNull();
    unmount();

    const unlocked = createTokenStore();
    unlocked.set(TOKEN);
    render(
      <App
        healthClient={async () => ({ status: "ok", version: "0.1.0", uptimeSeconds: 1 })}
        tokenStore={unlocked}
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
          listUsageRequests: vi.fn(async () => [
            {
              requestId: "req_hostile",
              occurredAt: new Date().toISOString(),
              routeId: payload,
              providerId: payload,
              proxyId: null,
              // Model, route, and failure category all reach the Usage table as text.
              model: payload,
              routingMode: payload,
              outcome: "failed",
              failureCategory: payload,
              latencyMs: 12,
              attempts: 2,
              promptTokens: null,
              completionTokens: null,
              cachedTokens: null,
            },
          ]) as never,
        })}
      />,
    );

    // Status on home, provider name on Providers, request metadata on Usage.
    await screen.findAllByText(payload);
    for (const label of ["Providers", "Usage"] as const) {
      goTo(label);
      await screen.findAllByText(new RegExp("<img", "i"));
    }

    /*
     * The payload is `<img src=x onerror=…>`, so "no element was created from it" used
     * to be assertable as "there is no `img` in the tree at all". The shell now renders
     * the approved GOAT ROUTER brand artwork, so that shortcut would fail on a legitimate
     * image — and deleting the assertion would drop the XSS guarantee with it.
     *
     * Stated as the property it was always standing in for instead: every `img` in the
     * document is one of the two approved brand files loaded from our own origin. An
     * injected one carries `src="x"` and fails this, and so would any *new* image
     * sourced from API data — which the old form could not have caught either.
     */
    const images = Array.from(container.querySelectorAll("img"));
    // Not vacuous: the shell mounts brand artwork, so there is something to check.
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image.getAttribute("src")).toMatch(
        /^\/brand\/goat-router-(lockup\.png|character\.webp)$/,
      );
      // An onerror/onload handler is how the payload would execute even with a safe src.
      expect(image.getAttribute("onerror")).toBeNull();
      expect(image.getAttribute("onload")).toBeNull();
    }
    expect((window as unknown as Record<string, unknown>).__xssApp).toBeUndefined();
  });

  it("mounts the approved Flux Core inside its slot", async () => {
    const store = createTokenStore();
    store.set(TOKEN);
    const { container } = render(
      <App
        healthClient={async () => ({ status: "ok", version: "0.1.0", uptimeSeconds: 1 })}
        tokenStore={store}
        apiClient={stubClient()}
      />,
    );

    // The relay stage lives on the Usage screen, which is where the approved reference
    // puts it.
    goTo("Usage");
    await screen.findByText("Recent requests");
    const slot = container.querySelector("[data-bayz-flux-core-slot]");
    expect(slot).not.toBeNull();
    // This assertion previously required an EMPTY slot, which was the correct pin
    // while the approved Flux Core V2 source was unavailable. That pin expired on
    // integration: the slot must now contain the approved canvas visualization.
    expect(slot!.childElementCount).toBeGreaterThan(0);
    expect(slot!.querySelector("canvas")).not.toBeNull();
    expect(slot!.querySelector(".relay-wrap")).not.toBeNull();
  });
});
