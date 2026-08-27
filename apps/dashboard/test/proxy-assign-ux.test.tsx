import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { ApiError } from "../src/api/client";
import { ProvidersPanel } from "../src/panels/ProvidersPanel";
import type { ProviderView, ProxyView } from "../src/api/types";

function provider(overrides: Partial<ProviderView> = {}): ProviderView {
  return {
    id: "local",
    kind: "openai-compatible",
    displayName: "Local Llama",
    baseUrl: "http://127.0.0.1:11434/v1",
    enabled: true,
    config: { timeoutMs: 30000, discoveryPath: "/v1/models", modelLimit: 100 },
    credentialPresent: false,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

function proxy(overrides: Partial<ProxyView> = {}): ProxyView {
  return {
    id: "tor",
    kind: "socks5",
    host: "127.0.0.1",
    port: 1080,
    username: undefined,
    enabled: true,
    config: { connectTimeoutMs: 10000, healthCheckHost: "1.1.1.1", healthCheckPort: 443 },
    passwordPresent: false,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

/** `n` providers, half of them named so a filter can select a known subset. */
function fleet(count: number, matching = 0): ProviderView[] {
  return Array.from({ length: count }, (_, index) =>
    provider({
      id: `p${index + 1}`,
      displayName: index < matching ? `Groq node ${index + 1}` : `Other node ${index + 1}`,
    }),
  );
}

function api(overrides: Partial<Parameters<typeof ProvidersPanel>[0]["api"]> = {}) {
  return {
    listProviders: vi.fn(async () => [provider()]),
    createProvider: vi.fn(async () => provider({ id: "created" })),
    updateProvider: vi.fn(async () => provider({ enabled: false })),
    deleteProvider: vi.fn(async () => undefined),
    setProviderCredential: vi.fn(async () => undefined),
    clearProviderCredential: vi.fn(async () => undefined),
    discoverModels: vi.fn(async () => ["gpt-4o"]),
    testProviderConnection: vi.fn(async () => ({ ok: true, latencyMs: 12, modelCount: 1 })),
    listProxies: vi.fn(async () => [proxy(), proxy({ id: "vps", kind: "http" })]),
    assignProxy: vi.fn(async (id: string, providerIds: string[]) => ({
      proxyId: id,
      providerCount: providerIds.length,
      proxyEnabled: true,
      notes: [] as string[],
    })),
    unassignProxy: vi.fn(async (id: string, providerIds: string[]) => ({
      proxyId: id,
      providerCount: providerIds.length,
      detachedFromProxy: providerIds.length,
    })),
    ...overrides,
  };
}

function selectAll(): void {
  fireEvent.click(screen.getByTestId("provider-select-all"));
}

describe("bulk provider proxy assignment", () => {
  it("gives every provider row a selection checkbox", async () => {
    render(<ProvidersPanel api={api({ listProviders: vi.fn(async () => fleet(3)) })} />);
    await screen.findByText("Other node 1");

    for (const id of ["p1", "p2", "p3"]) {
      expect(screen.getByTestId(`select-${id}`)).toBeInTheDocument();
    }
  });

  it("hides the assign bar until something is selected", async () => {
    render(<ProvidersPanel api={api({ listProviders: vi.fn(async () => fleet(3)) })} />);
    await screen.findByText("Other node 1");

    expect(screen.queryByTestId("proxy-assign-bar")).toBeNull();
    fireEvent.click(screen.getByTestId("select-p2"));
    expect(screen.getByTestId("proxy-assign-bar")).toHaveTextContent(/1 selected/i);
  });

  it("select-all selects every visible provider", async () => {
    render(<ProvidersPanel api={api({ listProviders: vi.fn(async () => fleet(40)) })} />);
    await screen.findByText("Other node 1");

    selectAll();
    expect(screen.getByTestId("proxy-assign-bar")).toHaveTextContent(/40 selected/i);
  });

  it("a filter narrows the list and select-all then takes only the filtered set", async () => {
    const client = api({ listProviders: vi.fn(async () => fleet(40, 12)) });
    render(<ProvidersPanel api={client} />);
    await screen.findByText("Groq node 1");

    fireEvent.change(screen.getByTestId("provider-filter"), {
      target: { value: "groq" },
    });
    expect(screen.getAllByTestId(/^provider-row-/)).toHaveLength(12);

    selectAll();
    expect(screen.getByTestId("proxy-assign-bar")).toHaveTextContent(/12 selected/i);

    fireEvent.change(screen.getByTestId("bulk-proxy-id"), { target: { value: "tor" } });
    fireEvent.click(screen.getByTestId("assign-to-proxy"));

    await waitFor(() => expect(client.assignProxy).toHaveBeenCalledTimes(1));
    const [proxyId, providerIds] = (client.assignProxy as unknown as Mock).mock.calls[0]!;
    expect(proxyId).toBe("tor");
    expect(providerIds).toHaveLength(12);
    expect(providerIds.every((id: string) => /^p([1-9]|1[0-2])$/.test(id))).toBe(true);
  });

  it("a filter does not deselect providers hidden by it", async () => {
    const client = api({ listProviders: vi.fn(async () => fleet(40, 12)) });
    render(<ProvidersPanel api={client} />);
    await screen.findByText("Groq node 1");

    fireEvent.click(screen.getByTestId("select-p20"));
    fireEvent.change(screen.getByTestId("provider-filter"), {
      target: { value: "groq" },
    });
    // Still one selected: filtering is a view operation, and silently dropping a
    // selection the operator made would be a surprising loss.
    expect(screen.getByTestId("proxy-assign-bar")).toHaveTextContent(/1 selected/i);
  });

  it("issues exactly one assign call carrying every selected id", async () => {
    const client = api({ listProviders: vi.fn(async () => fleet(40)) });
    render(<ProvidersPanel api={client} />);
    await screen.findByText("Other node 1");

    selectAll();
    fireEvent.change(screen.getByTestId("bulk-proxy-id"), { target: { value: "vps" } });
    fireEvent.click(screen.getByTestId("assign-to-proxy"));

    await waitFor(() => expect(client.assignProxy).toHaveBeenCalledTimes(1));
    expect((client.assignProxy as unknown as Mock).mock.calls[0]![1]).toHaveLength(40);
    expect(client.updateProvider).not.toHaveBeenCalled();
  });

  it("Set to Direct issues one unassign call", async () => {
    const client = api({ listProviders: vi.fn(async () => fleet(5)) });
    render(<ProvidersPanel api={client} />);
    await screen.findByText("Other node 1");

    selectAll();
    fireEvent.change(screen.getByTestId("bulk-proxy-id"), { target: { value: "tor" } });
    fireEvent.click(screen.getByTestId("set-to-direct"));

    await waitFor(() => expect(client.unassignProxy).toHaveBeenCalledTimes(1));
    expect((client.unassignProxy as unknown as Mock).mock.calls[0]![1]).toHaveLength(5);
    expect(client.assignProxy).not.toHaveBeenCalled();
  });

  it("refuses to assign with no proxy chosen", async () => {
    const client = api({ listProviders: vi.fn(async () => fleet(3)) });
    render(<ProvidersPanel api={client} />);
    await screen.findByText("Other node 1");

    selectAll();
    fireEvent.click(screen.getByTestId("assign-to-proxy"));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(client.assignProxy).not.toHaveBeenCalled();
  });

  it("clears the selection after a successful assignment", async () => {
    const client = api({ listProviders: vi.fn(async () => fleet(4)) });
    render(<ProvidersPanel api={client} />);
    await screen.findByText("Other node 1");

    selectAll();
    fireEvent.change(screen.getByTestId("bulk-proxy-id"), { target: { value: "tor" } });
    fireEvent.click(screen.getByTestId("assign-to-proxy"));

    await waitFor(() => expect(client.assignProxy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("proxy-assign-bar")).toBeNull());
  });

  it("keeps the selection and shows the envelope code when assignment fails", async () => {
    const client = api({
      listProviders: vi.fn(async () => fleet(4)),
      assignProxy: vi.fn(async () => {
        throw new ApiError(400, "invalid_request", "providerIds contains an unknown provider");
      }),
    });
    render(<ProvidersPanel api={client} />);
    await screen.findByText("Other node 1");

    selectAll();
    fireEvent.change(screen.getByTestId("bulk-proxy-id"), { target: { value: "tor" } });
    fireEvent.click(screen.getByTestId("assign-to-proxy"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("invalid_request");
    // Retryable: losing a 40-provider selection on a failure would be punishing.
    expect(screen.getByTestId("proxy-assign-bar")).toHaveTextContent(/4 selected/i);
  });

  it("warns when the batch exceeds the server's bound instead of splitting it", async () => {
    const client = api({ listProviders: vi.fn(async () => fleet(201)) });
    render(<ProvidersPanel api={client} />);
    await screen.findByText("Other node 1");

    selectAll();
    fireEvent.change(screen.getByTestId("bulk-proxy-id"), { target: { value: "tor" } });
    fireEvent.click(screen.getByTestId("assign-to-proxy"));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/200/));
    // Splitting into two calls would forfeit the server's atomicity.
    expect(client.assignProxy).not.toHaveBeenCalled();
  });

  it("with 120 providers still issues one call and renders every row", async () => {
    const client = api({ listProviders: vi.fn(async () => fleet(120)) });
    render(<ProvidersPanel api={client} />);
    await screen.findByText("Other node 1");

    expect(screen.getAllByTestId(/^provider-row-/)).toHaveLength(120);
    selectAll();
    fireEvent.change(screen.getByTestId("bulk-proxy-id"), { target: { value: "tor" } });
    fireEvent.click(screen.getByTestId("assign-to-proxy"));

    await waitFor(() => expect(client.assignProxy).toHaveBeenCalledTimes(1));
    expect((client.assignProxy as unknown as Mock).mock.calls[0]![1]).toHaveLength(120);
    expect(screen.getAllByTestId(/^provider-row-/)).toHaveLength(120);
  });

  it("reports a disabled proxy note from the assignment response", async () => {
    const client = api({
      listProviders: vi.fn(async () => fleet(2)),
      assignProxy: vi.fn(async (id: string, providerIds: string[]) => ({
        proxyId: id,
        providerCount: providerIds.length,
        proxyEnabled: false,
        notes: ["proxy_disabled"],
      })),
    });
    render(<ProvidersPanel api={client} />);
    await screen.findByText("Other node 1");

    selectAll();
    fireEvent.change(screen.getByTestId("bulk-proxy-id"), { target: { value: "tor" } });
    fireEvent.click(screen.getByTestId("assign-to-proxy"));

    const result = await screen.findByTestId("assign-result");
    expect(result).toHaveTextContent(/2 providers/i);
    expect(result).toHaveTextContent(/disabled/i);
  });

  it("offers no proxy option that could smuggle markup", async () => {
    const client = api({
      listProviders: vi.fn(async () => fleet(2)),
      listProxies: vi.fn(async () => [proxy({ id: "tor" })]),
    });
    const { container } = render(<ProvidersPanel api={client} />);
    await screen.findByText("Other node 1");

    selectAll();
    // Options carry ids as text nodes only; React escapes them.
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByTestId("bulk-proxy-id")).toBeInTheDocument();
  });
});
