import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProvidersPanel } from "../src/panels/ProvidersPanel";
import type { CreateProviderBody, ProviderView } from "../src/api/types";

/**
 * The custom-provider surface.
 *
 * Two things are being pinned: the form is genuinely usable for a relay or a local
 * runtime, and nothing an operator or an upstream supplies can become markup or a
 * remote fetch.
 */

const HEADER_VALUE = "relay-token-value-abc123";

function provider(overrides: Partial<ProviderView> = {}): ProviderView {
  return {
    id: "relay",
    kind: "custom-openai",
    displayName: "Tabitoken Relay",
    baseUrl: "https://relay.example.com/v1",
    enabled: true,
    config: { timeoutMs: 30000, discoveryPath: "/v1/models", modelLimit: 100 },
    credentialPresent: false,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

function api(overrides: Partial<Parameters<typeof ProvidersPanel>[0]["api"]> = {}) {
  return {
    listProviders: vi.fn(async () => [provider()]),
    createProvider: vi.fn(async (_body: CreateProviderBody) => provider({ id: "created" })),
    updateProvider: vi.fn(async () => provider({ enabled: false })),
    deleteProvider: vi.fn(async () => undefined),
    setProviderCredential: vi.fn(async () => undefined),
    clearProviderCredential: vi.fn(async () => undefined),
    discoverModels: vi.fn(async () => ["gpt-4o"]),
    // 9E free-only amendment: the economics-bearing sibling of discoverModels.
    discoverModelCatalogue: async () => [],
    testProviderConnection: vi.fn(async () => ({
      ok: true,
      latencyMs: 42,
      modelCount: 7,
    })),
    // 9E Task 5 added the bulk proxy assign bar to this panel.
    listProxies: vi.fn(async () => []),
    assignProxy: vi.fn(async () => ({
      proxyId: "tor",
      providerCount: 0,
      proxyEnabled: true,
      notes: [] as string[],
    })),
    unassignProxy: vi.fn(async () => ({
      proxyId: "tor",
      providerCount: 0,
      detachedFromProxy: 0,
    })),
    ...overrides,
  };
}

async function ready(): Promise<void> {
  await screen.findByText("Tabitoken Relay");
}

describe("custom provider creation", () => {
  it("offers custom-openai among the kinds", async () => {
    render(<ProvidersPanel api={api()} />);
    await ready();

    const select = screen.getByLabelText(/^kind$/i) as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).toContain("custom-openai");
    expect(values).toContain("openai-compatible");
    expect(values).toContain("openrouter");
    expect(values).toContain("gemini");
    expect(values).toContain("codex-oauth");
  });

  it("sends a configured header with the create body", async () => {
    const client = api();
    render(<ProvidersPanel api={client} />);
    await ready();

    fireEvent.change(screen.getByLabelText(/provider id/i), { target: { value: "r2" } });
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "R2" } });
    fireEvent.change(screen.getByLabelText(/base url/i), {
      target: { value: "https://r2.example.com/v1" },
    });
    fireEvent.change(screen.getByLabelText(/header 1 name/i), {
      target: { value: "x-relay-token" },
    });
    fireEvent.change(screen.getByLabelText(/header 1 value/i), {
      target: { value: HEADER_VALUE },
    });
    fireEvent.click(screen.getByRole("button", { name: /add provider/i }));

    await waitFor(() => expect(client.createProvider).toHaveBeenCalled());
    expect(vi.mocked(client.createProvider).mock.calls[0]![0]).toMatchObject({
      id: "r2",
      config: { headers: { "x-relay-token": HEADER_VALUE } },
    });
  });

  it("omits config entirely when nothing optional was set", async () => {
    const client = api();
    render(<ProvidersPanel api={client} />);
    await ready();

    fireEvent.change(screen.getByLabelText(/provider id/i), { target: { value: "r3" } });
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "R3" } });
    fireEvent.change(screen.getByLabelText(/base url/i), {
      target: { value: "https://r3.example.com/v1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add provider/i }));

    await waitFor(() => expect(client.createProvider).toHaveBeenCalled());
    // Sending `config: {}` would look identical to the operator but is a different
    // request, and the server's defaults are what should apply.
    expect(vi.mocked(client.createProvider).mock.calls[0]![0]).not.toHaveProperty(
      "config",
    );
  });

  it("bounds the headers editor to eight rows", async () => {
    render(<ProvidersPanel api={api()} />);
    await ready();

    // The server refuses a ninth header. Letting the form collect one anyway would
    // produce a 400 the operator could have been spared.
    expect(screen.getByLabelText(/header 8 name/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/header 9 name/i)).toBeNull();
  });

  it("shows an inline error for a hostile header name and does not submit", async () => {
    const client = api();
    render(<ProvidersPanel api={client} />);
    await ready();

    fireEvent.change(screen.getByLabelText(/provider id/i), { target: { value: "r4" } });
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "R4" } });
    fireEvent.change(screen.getByLabelText(/base url/i), {
      target: { value: "https://r4.example.com/v1" },
    });
    fireEvent.change(screen.getByLabelText(/header 1 name/i), {
      target: { value: "authorization" },
    });
    fireEvent.change(screen.getByLabelText(/header 1 value/i), {
      target: { value: "Bearer forged" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add provider/i }));

    expect(await screen.findByTestId("header-error-0")).toHaveTextContent(/authorization/i);
    expect(client.createProvider).not.toHaveBeenCalled();
  });

  it("refuses a header name outside the allowed charset", async () => {
    const client = api();
    render(<ProvidersPanel api={client} />);
    await ready();

    fireEvent.change(screen.getByLabelText(/provider id/i), { target: { value: "r5" } });
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "R5" } });
    fireEvent.change(screen.getByLabelText(/base url/i), {
      target: { value: "https://r5.example.com/v1" },
    });
    fireEvent.change(screen.getByLabelText(/header 1 name/i), {
      target: { value: "x relay token" },
    });
    fireEvent.change(screen.getByLabelText(/header 1 value/i), { target: { value: "v" } });
    fireEvent.click(screen.getByRole("button", { name: /add provider/i }));

    expect(await screen.findByTestId("header-error-0")).toBeInTheDocument();
    expect(client.createProvider).not.toHaveBeenCalled();
  });

  it("cannot even hold a newline in a header value, and refuses non-ASCII", async () => {
    const client = api();
    render(<ProvidersPanel api={client} />);
    await ready();

    fireEvent.change(screen.getByLabelText(/provider id/i), { target: { value: "r6" } });
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "R6" } });
    fireEvent.change(screen.getByLabelText(/base url/i), {
      target: { value: "https://r6.example.com/v1" },
    });
    fireEvent.change(screen.getByLabelText(/header 1 name/i), {
      target: { value: "x-relay-token" },
    });

    // A single-line `<input>` strips CR and LF on assignment, so a CRLF cannot
    // originate from this form at all. Asserted rather than assumed, because the
    // obvious test — "type a newline, expect an error" — would pass for the wrong
    // reason and hide that the client-side check never fired.
    const valueInput = screen.getByLabelText(/header 1 value/i) as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: "a\r\nx-injected: 1" } });
    expect(valueInput.value).not.toContain("\n");
    expect(valueInput.value).not.toContain("\r");

    // Non-ASCII survives the input and is what the client-side guard is for. The
    // server re-validates regardless; this is about telling the operator immediately.
    fireEvent.change(valueInput, { target: { value: "café" } });
    fireEvent.click(screen.getByRole("button", { name: /add provider/i }));

    expect(await screen.findByTestId("header-error-0")).toBeInTheDocument();
    expect(client.createProvider).not.toHaveBeenCalled();
  });

  it("offers an explicit loopback opt-in with a warning", async () => {
    const client = api();
    render(<ProvidersPanel api={client} />);
    await ready();

    const checkbox = screen.getByLabelText(/allow loopback/i);
    expect(checkbox).not.toBeChecked();
    // The warning is the point of an explicit opt-in: the operator is authorizing BAYZ
    // to dial their own machine, and that has to be a decision rather than a default.
    expect(screen.getByTestId("loopback-warning")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/provider id/i), { target: { value: "ollama" } });
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "Ollama" } });
    fireEvent.change(screen.getByLabelText(/base url/i), {
      target: { value: "http://127.0.0.1:11434/v1" },
    });
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: /add provider/i }));

    await waitFor(() => expect(client.createProvider).toHaveBeenCalled());
    expect(vi.mocked(client.createProvider).mock.calls[0]![0]).toMatchObject({
      config: { allowLoopback: true },
    });
  });
});

describe("test connection", () => {
  it("shows latency and the model count on success", async () => {
    render(<ProvidersPanel api={api()} />);
    await ready();

    fireEvent.click(screen.getByRole("button", { name: /test connection for relay/i }));
    const result = await screen.findByTestId("test-result-relay");
    expect(result).toHaveTextContent(/42/);
    expect(result).toHaveTextContent(/7/);
  });

  it("shows an explicit failure code on failure", async () => {
    render(
      <ProvidersPanel
        api={api({
          testProviderConnection: vi.fn(async () => ({
            ok: false,
            latencyMs: 5,
            failureCode: "auth_failed" as const,
          })),
        })}
      />,
    );
    await ready();

    fireEvent.click(screen.getByRole("button", { name: /test connection for relay/i }));
    // A bare "failed" would leave the operator guessing between a bad key, a dead
    // endpoint, and a blocked address.
    expect(await screen.findByTestId("test-result-relay")).toHaveTextContent(/auth_failed/);
  });

  it("renders a failure code as inert text", async () => {
    render(
      <ProvidersPanel
        api={api({
          testProviderConnection: vi.fn(async () => ({
            ok: false,
            latencyMs: 5,
            // Not a code the server can produce. The panel must still not parse it.
            failureCode: '<img src=x onerror="window.__xss = true">' as never,
          })),
        })}
      />,
    );
    await ready();

    fireEvent.click(screen.getByRole("button", { name: /test connection for relay/i }));
    await screen.findByTestId("test-result-relay");
    expect((window as unknown as { __xss?: boolean }).__xss).toBeUndefined();
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("header display", () => {
  it("lists configured header names and never a value", async () => {
    render(
      <ProvidersPanel
        api={api({
          listProviders: vi.fn(async () => [
            provider({
              config: {
                timeoutMs: 30000,
                discoveryPath: "/v1/models",
                modelLimit: 100,
                headerNames: ["x-relay-token", "x-tenant"],
              },
            }),
          ]),
        })}
      />,
    );
    await ready();

    const headers = await screen.findByTestId("headers-relay");
    expect(headers).toHaveTextContent("x-relay-token");
    expect(headers).toHaveTextContent("x-tenant");
    expect(headers).not.toHaveTextContent(HEADER_VALUE);
  });

  it("renders a hostile header name as inert text", async () => {
    render(
      <ProvidersPanel
        api={api({
          listProviders: vi.fn(async () => [
            provider({
              config: {
                timeoutMs: 30000,
                discoveryPath: "/v1/models",
                modelLimit: 100,
                headerNames: ['<img src=x onerror="window.__hdrXss = true">'],
              },
            }),
          ]),
        })}
      />,
    );
    await ready();

    await screen.findByTestId("headers-relay");
    expect((window as unknown as { __hdrXss?: boolean }).__hdrXss).toBeUndefined();
    expect(document.querySelector("img")).toBeNull();
  });

  it("shows nothing header-related when none are configured", async () => {
    render(<ProvidersPanel api={api()} />);
    await ready();
    expect(screen.queryByTestId("headers-relay")).toBeNull();
  });

  it("marks a loopback provider so the opt-in is visible after creation", async () => {
    render(
      <ProvidersPanel
        api={api({
          listProviders: vi.fn(async () => [
            provider({
              baseUrl: "http://127.0.0.1:11434/v1",
              config: {
                timeoutMs: 30000,
                discoveryPath: "/v1/models",
                modelLimit: 100,
                allowLoopback: true,
              },
            }),
          ]),
        })}
      />,
    );
    await ready();
    // An operator auditing their setup has to be able to see which providers may dial
    // the local machine without reading the database.
    expect(await screen.findByTestId("loopback-relay")).toBeInTheDocument();
  });
});
