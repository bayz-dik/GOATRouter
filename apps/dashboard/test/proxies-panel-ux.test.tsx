import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import { ProxiesPanel } from "../src/panels/ProxiesPanel";
import type { ProxyUsage, ProxyView } from "../src/api/types";

const PASSWORD = "hunter2-panel-ux-password-must-never-render";

function proxy(overrides: Partial<ProxyView> = {}): ProxyView {
  return {
    id: "tor",
    kind: "socks5",
    host: "127.0.0.1",
    port: 1080,
    username: undefined,
    enabled: true,
    config: {
      connectTimeoutMs: 10000,
      healthCheckHost: "1.1.1.1",
      healthCheckPort: 443,
    },
    passwordPresent: false,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

function usage(overrides: Partial<ProxyUsage> = {}): ProxyUsage {
  return {
    proxyId: "tor",
    providerCount: 0,
    routeCount: 0,
    providerIds: [],
    ...overrides,
  };
}

function api(overrides: Partial<Parameters<typeof ProxiesPanel>[0]["api"]> = {}) {
  return {
    listProxies: vi.fn(async () => [proxy()]),
    createProxy: vi.fn(async () => proxy({ id: "created" })),
    updateProxy: vi.fn(async () => proxy()),
    deleteProxy: vi.fn(async () => undefined),
    setProxyPassword: vi.fn(async () => undefined),
    clearProxyPassword: vi.fn(async () => undefined),
    checkProxy: vi.fn(async () => ({ ok: true, kind: "socks5" as const, latencyMs: 42 })),
    proxyUsage: vi.fn(async (id: string) => usage({ proxyId: id })),
    ...overrides,
  };
}

describe("ProxiesPanel lifecycle UX", () => {
  it("creates an http proxy when the kind selector is changed", async () => {
    const client = api();
    render(<ProxiesPanel api={client} />);
    await screen.findByText("127.0.0.1");

    fireEvent.change(screen.getByLabelText(/proxy id/i), { target: { value: "vps" } });
    fireEvent.change(screen.getByLabelText(/^kind$/i), { target: { value: "http" } });
    fireEvent.change(screen.getByLabelText(/^host$/i), { target: { value: "10.0.0.5" } });
    fireEvent.change(screen.getByLabelText(/^port$/i), { target: { value: "8080" } });
    fireEvent.click(screen.getByRole("button", { name: /add proxy/i }));

    await waitFor(() => expect(client.createProxy).toHaveBeenCalledTimes(1));
    expect(client.createProxy).toHaveBeenCalledWith({
      id: "vps",
      kind: "http",
      host: "10.0.0.5",
      port: 8080,
    });
  });

  it("edits host, port, username, and config in one patch", async () => {
    const client = api();
    render(<ProxiesPanel api={client} />);
    await screen.findByText("127.0.0.1");

    fireEvent.click(screen.getByRole("button", { name: /edit tor/i }));
    fireEvent.change(screen.getByLabelText(/host for tor/i), {
      target: { value: "10.9.9.9" },
    });
    fireEvent.change(screen.getByLabelText(/port for tor/i), { target: { value: "9050" } });
    fireEvent.change(screen.getByLabelText(/username for tor/i), {
      target: { value: "bayz" },
    });
    fireEvent.change(screen.getByLabelText(/connect timeout for tor/i), {
      target: { value: "5000" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save tor/i }));

    await waitFor(() => expect(client.updateProxy).toHaveBeenCalledTimes(1));
    expect(client.updateProxy).toHaveBeenCalledWith("tor", {
      host: "10.9.9.9",
      port: 9050,
      username: "bayz",
      config: { connectTimeoutMs: 5000 },
    });
  });

  it("clears a username with null rather than an empty string", async () => {
    const client = api({
      listProxies: vi.fn(async () => [proxy({ username: "bayz" })]),
    });
    render(<ProxiesPanel api={client} />);
    await screen.findByText("127.0.0.1");

    fireEvent.click(screen.getByRole("button", { name: /edit tor/i }));
    fireEvent.change(screen.getByLabelText(/username for tor/i), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /save tor/i }));

    await waitFor(() => expect(client.updateProxy).toHaveBeenCalledTimes(1));
    // `""` would be a second way to say "no username"; the API models absence as null.
    expect(client.updateProxy).toHaveBeenCalledWith("tor", { username: null });
  });

  it("sends nothing when an edit changed nothing", async () => {
    const client = api();
    render(<ProxiesPanel api={client} />);
    await screen.findByText("127.0.0.1");

    fireEvent.click(screen.getByRole("button", { name: /edit tor/i }));
    fireEvent.click(screen.getByRole("button", { name: /save tor/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(client.updateProxy).not.toHaveBeenCalled();
  });

  it("toggles enabled without opening the editor", async () => {
    const client = api();
    render(<ProxiesPanel api={client} />);
    await screen.findByText("127.0.0.1");

    fireEvent.click(screen.getByRole("button", { name: /disable tor/i }));
    await waitFor(() =>
      expect(client.updateProxy).toHaveBeenCalledWith("tor", { enabled: false }),
    );
  });

  it("requires a confirmation before deleting", async () => {
    const client = api();
    render(<ProxiesPanel api={client} />);
    await screen.findByText("127.0.0.1");

    fireEvent.click(screen.getByRole("button", { name: /^delete tor$/i }));
    expect(client.deleteProxy).not.toHaveBeenCalled();

    // The confirmation names what is at stake: providers fall back to direct.
    expect(screen.getByTestId("confirm-delete-tor")).toHaveTextContent(/direct/i);
    fireEvent.click(screen.getByRole("button", { name: /confirm delete tor/i }));
    await waitFor(() => expect(client.deleteProxy).toHaveBeenCalledWith("tor"));
  });

  it("abandons a delete when the confirmation is cancelled", async () => {
    const client = api();
    render(<ProxiesPanel api={client} />);
    await screen.findByText("127.0.0.1");

    fireEvent.click(screen.getByRole("button", { name: /^delete tor$/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel delete tor/i }));
    expect(client.deleteProxy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("confirm-delete-tor")).toBeNull();
  });

  it("keeps the password write-only and clears the field on submit", async () => {
    const client = api();
    const { container } = render(<ProxiesPanel api={client} />);
    await screen.findByText("127.0.0.1");

    const field = screen.getByLabelText(/password for tor/i) as HTMLInputElement;
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "off");

    fireEvent.change(field, { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: /save password for tor/i }));

    await waitFor(() => expect(client.setProxyPassword).toHaveBeenCalledWith("tor", PASSWORD));
    await waitFor(() => expect(field.value).toBe(""));
    expect(container.innerHTML).not.toContain(PASSWORD);
    expect(document.body.innerHTML).not.toContain(PASSWORD);
  });

  it("says the connection was not measured until it is", async () => {
    const client = api();
    render(<ProxiesPanel api={client} />);
    await screen.findByText("127.0.0.1");

    // No fabricated latency, and no implied success: the check has not run.
    const state = screen.getByTestId("check-tor");
    expect(state).toHaveTextContent(/not measured/i);
    expect(state.textContent).not.toMatch(/\d+\s*ms/);
  });

  it("reports a measured latency after a successful check", async () => {
    const client = api();
    render(<ProxiesPanel api={client} />);
    await screen.findByText("127.0.0.1");

    fireEvent.click(screen.getByRole("button", { name: /check tor/i }));
    await waitFor(() => expect(screen.getByTestId("check-tor")).toHaveTextContent("42"));
    expect(screen.getByTestId("check-tor")).toHaveTextContent(/reachable/i);
  });

  it("shows the envelope code and message when a check is refused", async () => {
    const client = api({
      checkProxy: vi.fn(async () => {
        throw new ApiError(502, "refused", "the connection through the proxy was refused");
      }),
    });
    render(<ProxiesPanel api={client} />);
    await screen.findByText("127.0.0.1");

    fireEvent.click(screen.getByRole("button", { name: /check tor/i }));
    const state = await screen.findByTestId("check-tor");
    await waitFor(() => expect(state).toHaveTextContent("refused"));
    expect(state).toHaveTextContent(/the connection through the proxy was refused/);
    // A failed check must not carry a latency: none was measured.
    expect(state.textContent).not.toMatch(/\d+\s*ms/);
  });

  it("marks a proxy whose last check failed as degraded", async () => {
    const client = api({
      checkProxy: vi.fn(async () => {
        throw new ApiError(502, "refused", "refused");
      }),
    });
    render(<ProxiesPanel api={client} />);
    await screen.findByText("127.0.0.1");

    expect(screen.getByTestId("proxy-row-tor")).toHaveAttribute("data-state", "ok");
    fireEvent.click(screen.getByRole("button", { name: /check tor/i }));
    await waitFor(() =>
      expect(screen.getByTestId("proxy-row-tor")).toHaveAttribute("data-state", "degraded"),
    );
    expect(screen.getByTestId("proxy-row-tor")).toHaveTextContent(/degraded/i);
  });

  it("renders a disabled proxy distinctly", async () => {
    const client = api({ listProxies: vi.fn(async () => [proxy({ enabled: false })]) });
    render(<ProxiesPanel api={client} />);
    await screen.findByText("127.0.0.1");

    expect(screen.getByTestId("proxy-row-tor")).toHaveAttribute("data-state", "disabled");
    expect(screen.getByTestId("proxy-row-tor")).toHaveTextContent(/disabled/i);
  });

  it("shows how many providers and routes use each proxy", async () => {
    const client = api({
      listProxies: vi.fn(async () => [proxy(), proxy({ id: "vps", kind: "http" })]),
      proxyUsage: vi.fn(async (id: string) =>
        id === "tor"
          ? usage({ proxyId: "tor", providerCount: 12, routeCount: 3 })
          : usage({ proxyId: "vps", providerCount: 0, routeCount: 0 }),
      ),
    });
    render(<ProxiesPanel api={client} />);

    await waitFor(() =>
      expect(screen.getByTestId("usage-tor")).toHaveTextContent(
        /used by 12 providers, 3 routes/i,
      ),
    );
    expect(screen.getByTestId("usage-vps")).toHaveTextContent(/used by 0 providers, 0 routes/i);
  });

  it("says usage is unavailable rather than reporting a fabricated zero", async () => {
    const client = api({
      proxyUsage: vi.fn(async () => {
        throw new ApiError(403, "forbidden", "This credential lacks the required scope");
      }),
    });
    render(<ProxiesPanel api={client} />);

    await waitFor(() =>
      expect(screen.getByTestId("usage-tor")).toHaveTextContent(/usage unavailable/i),
    );
    expect(screen.getByTestId("usage-tor").textContent).not.toMatch(/\b0 providers/);
  });

  it("renders no field whose name looks like a secret", async () => {
    const client = api({
      listProxies: vi.fn(async () => [
        {
          ...proxy(),
          password: PASSWORD,
          credential: "sk-hostile-core-credential",
          secret: "hostile-core-secret",
        } as unknown as ProxyView,
      ]),
    });
    const { container } = render(<ProxiesPanel api={client} />);
    await screen.findByText("127.0.0.1");

    expect(container.innerHTML).not.toContain(PASSWORD);
    expect(container.innerHTML).not.toContain("sk-hostile-core-credential");
    expect(container.innerHTML).not.toContain("hostile-core-secret");
  });

  it("renders a hostile host as inert text", async () => {
    const client = api({
      listProxies: vi.fn(async () => [
        proxy({ host: '<img src=x onerror="window.__xssProxyUx = true">' }),
      ]),
    });
    const { container } = render(<ProxiesPanel api={client} />);
    await screen.findByText('<img src=x onerror="window.__xssProxyUx = true">');

    expect(container.querySelector("img")).toBeNull();
    expect((window as unknown as Record<string, unknown>).__xssProxyUx).toBeUndefined();
  });
});
