import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import { ProxiesPanel } from "../src/panels/ProxiesPanel";
import type { ProxyView } from "../src/api/types";

const PASSWORD = "hunter2-panel-password-must-never-render";

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

function api(overrides: Partial<Parameters<typeof ProxiesPanel>[0]["api"]> = {}) {
  return {
    listProxies: vi.fn(async () => [proxy()]),
    createProxy: vi.fn(async () => proxy({ id: "created" })),
    updateProxy: vi.fn(async () => proxy({ enabled: false })),
    deleteProxy: vi.fn(async () => undefined),
    setProxyPassword: vi.fn(async () => undefined),
    clearProxyPassword: vi.fn(async () => undefined),
    checkProxy: vi.fn(async () => ({ ok: true, kind: "socks5" as const, latencyMs: 42 })),
    // 9E Task 4: every row reports what uses the proxy, so the stub answers it.
    proxyUsage: vi.fn(async (id: string) => ({
      proxyId: id,
      providerCount: 0,
      routeCount: 0,
      providerIds: [],
    })),
    ...overrides,
  };
}

describe("ProxiesPanel", () => {
  it("lists proxies with a presence indicator instead of a password", async () => {
    render(
      <ProxiesPanel
        api={api({
          listProxies: vi.fn(async () => [
            proxy({ passwordPresent: true, username: "bayz" }),
          ]),
        })}
      />,
    );

    expect(await screen.findByText("127.0.0.1")).toBeInTheDocument();
    expect(screen.getByText("1080")).toBeInTheDocument();
    expect(screen.getByText("bayz")).toBeInTheDocument();
    expect(screen.getByTestId("password-tor")).toHaveTextContent(/stored/i);
  });

  it("shows that no password is stored when there is none", async () => {
    render(<ProxiesPanel api={api()} />);
    expect(await screen.findByTestId("password-tor")).toHaveTextContent(/not set/i);
  });

  it("creates a proxy from the form", async () => {
    const client = api();
    render(<ProxiesPanel api={client} />);
    await screen.findByText("127.0.0.1");

    fireEvent.change(screen.getByLabelText(/proxy id/i), { target: { value: "vps" } });
    fireEvent.change(screen.getByLabelText(/^host$/i), { target: { value: "10.0.0.5" } });
    fireEvent.change(screen.getByLabelText(/^port$/i), { target: { value: "1080" } });
    fireEvent.click(screen.getByRole("button", { name: /add proxy/i }));

    await waitFor(() => expect(client.createProxy).toHaveBeenCalledTimes(1));
    expect(client.createProxy).toHaveBeenCalledWith({
      id: "vps",
      kind: "socks5",
      host: "10.0.0.5",
      port: 1080,
    });
  });

  it("includes a username only when one was entered", async () => {
    const client = api();
    render(<ProxiesPanel api={client} />);
    await screen.findByText("127.0.0.1");

    fireEvent.change(screen.getByLabelText(/proxy id/i), { target: { value: "vps" } });
    fireEvent.change(screen.getByLabelText(/^host$/i), { target: { value: "10.0.0.5" } });
    fireEvent.change(screen.getByLabelText(/^port$/i), { target: { value: "8080" } });
    fireEvent.change(screen.getByLabelText(/^username$/i), { target: { value: "bayz" } });
    fireEvent.click(screen.getByRole("button", { name: /add proxy/i }));

    await waitFor(() => expect(client.createProxy).toHaveBeenCalledTimes(1));
    expect(client.createProxy).toHaveBeenCalledWith({
      id: "vps",
      kind: "socks5",
      host: "10.0.0.5",
      port: 8080,
      username: "bayz",
    });
  });

  it("sends the password and immediately clears the field", async () => {
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

  it("refuses to submit an empty password", async () => {
    const client = api();
    render(<ProxiesPanel api={client} />);
    await screen.findByText("127.0.0.1");

    fireEvent.click(screen.getByRole("button", { name: /save password for tor/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(client.setProxyPassword).not.toHaveBeenCalled();
  });

  it("clears a stored password", async () => {
    const client = api({
      listProxies: vi.fn(async () => [proxy({ passwordPresent: true, username: "bayz" })]),
    });
    render(<ProxiesPanel api={client} />);
    await screen.findByText("127.0.0.1");

    fireEvent.click(screen.getByRole("button", { name: /clear password for tor/i }));
    await waitFor(() => expect(client.clearProxyPassword).toHaveBeenCalledWith("tor"));
  });

  it("reports a successful check with its latency", async () => {
    const client = api();
    render(<ProxiesPanel api={client} />);
    await screen.findByText("127.0.0.1");

    fireEvent.click(screen.getByRole("button", { name: /check tor/i }));
    expect(await screen.findByTestId("check-tor")).toHaveTextContent("42");
    expect(screen.getByTestId("check-tor")).toHaveTextContent(/reachable/i);
  });

  it("shows the envelope code when a check is refused", async () => {
    const client = api({
      checkProxy: vi.fn(async () => {
        throw new ApiError(502, "refused", "the connection through the proxy was refused");
      }),
    });
    render(<ProxiesPanel api={client} />);
    await screen.findByText("127.0.0.1");

    fireEvent.click(screen.getByRole("button", { name: /check tor/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("refused");
  });

  it("toggles enabled state and deletes after confirming", async () => {
    const client = api();
    render(<ProxiesPanel api={client} />);
    await screen.findByText("127.0.0.1");

    fireEvent.click(screen.getByRole("button", { name: /disable tor/i }));
    await waitFor(() =>
      expect(client.updateProxy).toHaveBeenCalledWith("tor", { enabled: false }),
    );

    // 9E Task 4 made delete a two-step action: it silently detaches every provider
    // using the proxy, so it asks first.
    fireEvent.click(screen.getByRole("button", { name: /^delete tor$/i }));
    expect(client.deleteProxy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /confirm delete tor/i }));
    await waitFor(() => expect(client.deleteProxy).toHaveBeenCalledWith("tor"));
  });

  it("renders a hostile host value as text, never as markup", async () => {
    const client = api({
      listProxies: vi.fn(async () => [
        proxy({ host: '<img src=x onerror="window.__xssHost = true">' }),
      ]),
    });
    const { container } = render(<ProxiesPanel api={client} />);
    await screen.findByText('<img src=x onerror="window.__xssHost = true">');

    expect(container.querySelector("img")).toBeNull();
    expect((window as unknown as Record<string, unknown>).__xssHost).toBeUndefined();
  });

  it("never renders a password field returned by a hostile Core", async () => {
    const client = api({
      listProxies: vi.fn(async () => [
        { ...proxy(), password: PASSWORD } as unknown as ProxyView,
      ]),
    });
    const { container } = render(<ProxiesPanel api={client} />);
    await screen.findByText("127.0.0.1");
    expect(container.innerHTML).not.toContain(PASSWORD);
  });

  it("shows a load failure using the envelope", async () => {
    render(
      <ProxiesPanel
        api={api({
          listProxies: vi.fn(async () => {
            throw new ApiError(401, "unauthorized", "A valid API token is required");
          }),
        })}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("unauthorized");
  });
});
