import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import { RoutesPanel } from "../src/panels/RoutesPanel";
import type { ProviderView, ProxyView, RouteView } from "../src/api/types";

function route(overrides: Partial<RouteView> = {}): RouteView {
  return {
    id: "r1",
    model: "gpt-4o",
    providerId: "p1",
    proxyId: undefined,
    // 9E Task 1 added force-direct; 9E Task 6 made the panel read it.
    forceDirect: false,
    priority: 100,
    enabled: true,
    config: { maxAttempts: 2, requestTimeoutMs: 60000 },
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

const PROVIDER = {
  id: "p1",
  displayName: "P1",
} as unknown as ProviderView;

const PROXY = { id: "x1" } as unknown as ProxyView;

function api(overrides: Partial<Parameters<typeof RoutesPanel>[0]["api"]> = {}) {
  return {
    listRoutes: vi.fn(async () => [route()]),
    listProviders: vi.fn(async () => [PROVIDER]),
    listProxies: vi.fn(async () => [PROXY]),
    createRoute: vi.fn(async () => route({ id: "created" })),
    updateRoute: vi.fn(async () => route({ enabled: false })),
    deleteRoute: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("RoutesPanel", () => {
  it("lists routes with their bindings", async () => {
    render(<RoutesPanel api={api({ listRoutes: vi.fn(async () => [route({ proxyId: "x1" })]) })} />);

    expect(await screen.findByText("gpt-4o")).toBeInTheDocument();
    expect(screen.getByTestId("route-r1")).toHaveTextContent("p1");
    expect(screen.getByTestId("route-r1")).toHaveTextContent("x1");
    expect(screen.getByTestId("route-r1")).toHaveTextContent("100");
  });

  it("creates a route from the form", async () => {
    const client = api();
    render(<RoutesPanel api={client} />);
    await screen.findByText("gpt-4o");

    fireEvent.change(screen.getByLabelText(/route id/i), { target: { value: "r2" } });
    fireEvent.change(screen.getByLabelText(/^model$/i), { target: { value: "claude-3.5" } });
    fireEvent.change(screen.getByLabelText(/^provider$/i), { target: { value: "p1" } });
    fireEvent.change(screen.getByLabelText(/^priority$/i), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: /add route/i }));

    await waitFor(() => expect(client.createRoute).toHaveBeenCalledTimes(1));
    expect(client.createRoute).toHaveBeenCalledWith({
      id: "r2",
      model: "claude-3.5",
      providerId: "p1",
      priority: 500,
    });
  });

  it("binds a proxy when one is selected", async () => {
    const client = api();
    render(<RoutesPanel api={client} />);
    await screen.findByText("gpt-4o");

    fireEvent.change(screen.getByLabelText(/route id/i), { target: { value: "r2" } });
    fireEvent.change(screen.getByLabelText(/^model$/i), { target: { value: "m" } });
    fireEvent.change(screen.getByLabelText(/^provider$/i), { target: { value: "p1" } });
    fireEvent.change(screen.getByLabelText(/^proxy$/i), { target: { value: "x1" } });
    fireEvent.click(screen.getByRole("button", { name: /add route/i }));

    await waitFor(() => expect(client.createRoute).toHaveBeenCalledTimes(1));
    expect(client.createRoute).toHaveBeenCalledWith({
      id: "r2",
      model: "m",
      providerId: "p1",
      proxyId: "x1",
    });
  });

  it("toggles, repriorities, and unbinds a proxy", async () => {
    const client = api({ listRoutes: vi.fn(async () => [route({ proxyId: "x1" })]) });
    render(<RoutesPanel api={client} />);
    await screen.findByText("gpt-4o");

    fireEvent.click(screen.getByRole("button", { name: /disable r1/i }));
    await waitFor(() =>
      expect(client.updateRoute).toHaveBeenCalledWith("r1", { enabled: false }),
    );

    fireEvent.change(screen.getByLabelText(/priority for r1/i), { target: { value: "900" } });
    fireEvent.click(screen.getByRole("button", { name: /save priority for r1/i }));
    await waitFor(() => expect(client.updateRoute).toHaveBeenCalledWith("r1", { priority: 900 }));

    fireEvent.click(screen.getByRole("button", { name: /unbind proxy from r1/i }));
    await waitFor(() => expect(client.updateRoute).toHaveBeenCalledWith("r1", { proxyId: null }));
  });

  it("deletes a route", async () => {
    const client = api();
    render(<RoutesPanel api={client} />);
    await screen.findByText("gpt-4o");

    fireEvent.click(screen.getByRole("button", { name: /delete r1/i }));
    await waitFor(() => expect(client.deleteRoute).toHaveBeenCalledWith("r1"));
  });

  it("surfaces an invalid_route_config failure verbatim", async () => {
    const client = api({
      createRoute: vi.fn(async () => {
        throw new ApiError(400, "invalid_route_config", "the route configuration was rejected");
      }),
    });
    render(<RoutesPanel api={client} />);
    await screen.findByText("gpt-4o");

    fireEvent.change(screen.getByLabelText(/route id/i), { target: { value: "r2" } });
    fireEvent.change(screen.getByLabelText(/^model$/i), { target: { value: "m" } });
    fireEvent.change(screen.getByLabelText(/^provider$/i), { target: { value: "ghost" } });
    fireEvent.click(screen.getByRole("button", { name: /add route/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("invalid_route_config");
  });

  it("renders a hostile model name as text", async () => {
    const client = api({
      listRoutes: vi.fn(async () => [
        route({ model: '<img src=x onerror="window.__xssRoute = true">' }),
      ]),
    });
    const { container } = render(<RoutesPanel api={client} />);
    await screen.findByText('<img src=x onerror="window.__xssRoute = true">');

    expect(container.querySelector("img")).toBeNull();
    expect((window as unknown as Record<string, unknown>).__xssRoute).toBeUndefined();
  });

  it("shows a load failure using the envelope", async () => {
    render(
      <RoutesPanel
        api={api({
          listRoutes: vi.fn(async () => {
            throw new ApiError(503, "storage_unavailable", "local storage could not be initialized");
          }),
        })}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("storage_unavailable");
  });
});
