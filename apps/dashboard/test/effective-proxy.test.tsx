import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProvidersPanel } from "../src/panels/ProvidersPanel";
import { RoutesPanel } from "../src/panels/RoutesPanel";
import type { ProviderView, ProxyView, RouteView } from "../src/api/types";

function provider(overrides: Partial<ProviderView> = {}): ProviderView {
  return {
    id: "p1",
    kind: "openai-compatible",
    displayName: "P1",
    baseUrl: "http://127.0.0.1:11434/v1",
    enabled: true,
    config: { timeoutMs: 30000, discoveryPath: "/v1/models", modelLimit: 100 },
    credentialPresent: false,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

function route(overrides: Partial<RouteView> = {}): RouteView {
  return {
    id: "r1",
    model: "gpt-4o",
    providerId: "p1",
    proxyId: undefined,
    forceDirect: false,
    priority: 100,
    enabled: true,
    config: { maxAttempts: 2, requestTimeoutMs: 60000 },
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

function proxy(id: string): ProxyView {
  return {
    id,
    kind: "socks5",
    host: "127.0.0.1",
    port: 1080,
    username: undefined,
    enabled: true,
    config: { connectTimeoutMs: 10000, healthCheckHost: "1.1.1.1", healthCheckPort: 443 },
    passwordPresent: false,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
}

function routesApi(overrides: Partial<Parameters<typeof RoutesPanel>[0]["api"]> = {}) {
  return {
    listRoutes: vi.fn(async () => [route()]),
    listProviders: vi.fn(async () => [provider()]),
    listProxies: vi.fn(async () => [proxy("tor")]),
    createRoute: vi.fn(async () => route({ id: "created" })),
    updateRoute: vi.fn(async () => route({ enabled: false })),
    deleteRoute: vi.fn(async () => undefined),
    ...overrides,
  };
}

function providersApi(list: ProviderView[]) {
  return {
    listProviders: vi.fn(async () => list),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    setProviderCredential: vi.fn(),
    clearProviderCredential: vi.fn(),
    discoverModels: vi.fn(),
    testProviderConnection: vi.fn(),
    listProxies: vi.fn(async () => [proxy("tor")]),
    assignProxy: vi.fn(),
    unassignProxy: vi.fn(),
  } as unknown as Parameters<typeof ProvidersPanel>[0]["api"];
}

describe("effective proxy visibility on providers", () => {
  it("shows the provider's proxy id when it has one", async () => {
    render(<ProvidersPanel api={providersApi([provider({ proxyId: "tor" })])} />);
    expect(await screen.findByTestId("provider-proxy-p1")).toHaveTextContent("Proxy tor");
  });

  it("shows Direct when the provider has no proxy", async () => {
    render(<ProvidersPanel api={providersApi([provider()])} />);
    expect(await screen.findByTestId("provider-proxy-p1")).toHaveTextContent("Direct");
  });

  it("shows Direct with no dangling id after the proxy was deleted", async () => {
    // ON DELETE SET NULL (migration v8) means a deleted proxy leaves proxy_id NULL, so
    // the row must read Direct rather than naming a proxy that no longer exists.
    render(<ProvidersPanel api={providersApi([provider({ proxyId: undefined })])} />);
    const cell = await screen.findByTestId("provider-proxy-p1");
    expect(cell).toHaveTextContent("Direct");
    expect(cell.textContent).not.toMatch(/tor/);
  });
});

describe("effective proxy visibility on routes", () => {
  it("reports an inherited provider proxy as the effective proxy", async () => {
    render(
      <RoutesPanel
        api={routesApi({
          listRoutes: vi.fn(async () => [route()]),
          listProviders: vi.fn(async () => [provider({ proxyId: "tor" })]),
        })}
      />,
    );

    const cell = await screen.findByTestId("route-proxy-r1");
    expect(cell).toHaveTextContent("tor");
    expect(cell).toHaveTextContent(/inherited/i);
  });

  it("reports a route override as overridden", async () => {
    render(
      <RoutesPanel
        api={routesApi({
          listRoutes: vi.fn(async () => [route({ proxyId: "vps" })]),
          listProviders: vi.fn(async () => [provider({ proxyId: "tor" })]),
          listProxies: vi.fn(async () => [proxy("tor"), proxy("vps")]),
        })}
      />,
    );

    const cell = await screen.findByTestId("route-proxy-r1");
    expect(cell).toHaveTextContent("vps");
    expect(cell).toHaveTextContent(/overridden/i);
    // The provider's default must not be presented as what traffic uses.
    expect(cell.textContent).not.toMatch(/inherited/i);
  });

  it("reports Direct (override) when the route forces direct against a proxied provider", async () => {
    render(
      <RoutesPanel
        api={routesApi({
          listRoutes: vi.fn(async () => [route({ forceDirect: true })]),
          listProviders: vi.fn(async () => [provider({ proxyId: "tor" })]),
        })}
      />,
    );

    const cell = await screen.findByTestId("route-proxy-r1");
    expect(cell).toHaveTextContent(/direct/i);
    expect(cell).toHaveTextContent(/override/i);
    // Naming the provider's proxy here would suggest traffic tunnels when it does not.
    expect(cell.textContent).not.toMatch(/tor/);
  });

  it("reports a plain direct route as Direct without calling it an override", async () => {
    render(
      <RoutesPanel
        api={routesApi({
          listRoutes: vi.fn(async () => [route()]),
          listProviders: vi.fn(async () => [provider()]),
        })}
      />,
    );

    const cell = await screen.findByTestId("route-proxy-r1");
    expect(cell).toHaveTextContent(/direct/i);
    expect(cell.textContent).not.toMatch(/override/i);
  });

  it("forceDirect wins over a route proxyId, matching the router", async () => {
    // `effectiveProxyId` in packages/router checks forceDirect first. The panel must not
    // disagree with what the router will actually do.
    render(
      <RoutesPanel
        api={routesApi({
          listRoutes: vi.fn(async () => [route({ proxyId: "vps", forceDirect: true })]),
          listProviders: vi.fn(async () => [provider({ proxyId: "tor" })]),
          listProxies: vi.fn(async () => [proxy("tor"), proxy("vps")]),
        })}
      />,
    );

    const cell = await screen.findByTestId("route-proxy-r1");
    expect(cell).toHaveTextContent(/direct/i);
    expect(cell.textContent).not.toMatch(/vps/);
  });

  it("says the provider is unknown rather than inventing Direct", async () => {
    // A route whose provider is missing from the list has an unknowable effective proxy.
    // Rendering `Direct` would be a fabricated claim about where traffic goes.
    render(
      <RoutesPanel
        api={routesApi({
          listRoutes: vi.fn(async () => [route({ providerId: "gone" })]),
          listProviders: vi.fn(async () => [provider()]),
        })}
      />,
    );

    const cell = await screen.findByTestId("route-proxy-r1");
    expect(cell).toHaveTextContent(/unknown/i);
  });

  it("renders a hostile proxy id as inert text", async () => {
    const hostile = "<script>alert(1)</script>";
    const { container } = render(
      <RoutesPanel
        api={routesApi({
          listRoutes: vi.fn(async () => [route({ proxyId: hostile })]),
          listProviders: vi.fn(async () => [provider()]),
          listProxies: vi.fn(async () => [proxy(hostile)]),
        })}
      />,
    );

    const cell = await screen.findByTestId("route-proxy-r1");
    expect(cell).toHaveTextContent(hostile);
    expect(container.querySelector("script")).toBeNull();
  });
});
