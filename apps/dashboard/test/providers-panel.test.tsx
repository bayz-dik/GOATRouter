import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import { ProvidersPanel } from "../src/panels/ProvidersPanel";
import type { ProviderView } from "../src/api/types";

const CREDENTIAL = "sk-panel-credential-must-never-render";

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

function api(overrides: Partial<Parameters<typeof ProvidersPanel>[0]["api"]> = {}) {
  return {
    listProviders: vi.fn(async () => [provider()]),
    createProvider: vi.fn(async () => provider({ id: "created" })),
    updateProvider: vi.fn(async () => provider({ enabled: false })),
    deleteProvider: vi.fn(async () => undefined),
    setProviderCredential: vi.fn(async () => undefined),
    clearProviderCredential: vi.fn(async () => undefined),
    discoverModels: vi.fn(async () => ["gpt-4o", "gpt-4o-mini"]),
    testProviderConnection: vi.fn(async () => ({
      ok: true,
      latencyMs: 12,
      modelCount: 2,
    })),
    ...overrides,
  };
}

describe("ProvidersPanel", () => {
  it("lists providers with a presence indicator instead of a credential", async () => {
    render(<ProvidersPanel api={api({ listProviders: vi.fn(async () => [provider({ credentialPresent: true })]) })} />);

    expect(await screen.findByText("Local Llama")).toBeInTheDocument();
    expect(screen.getByText("http://127.0.0.1:11434/v1")).toBeInTheDocument();
    expect(screen.getByTestId("credential-local")).toHaveTextContent(/stored/i);
  });

  it("shows that no credential is stored when there is none", async () => {
    render(<ProvidersPanel api={api()} />);
    expect(await screen.findByTestId("credential-local")).toHaveTextContent(/not set/i);
  });

  it("creates a provider from the form", async () => {
    const client = api();
    render(<ProvidersPanel api={client} />);
    await screen.findByText("Local Llama");

    fireEvent.change(screen.getByLabelText(/provider id/i), { target: { value: "new-one" } });
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "New One" } });
    fireEvent.change(screen.getByLabelText(/base url/i), {
      target: { value: "http://127.0.0.1:8080/v1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add provider/i }));

    await waitFor(() => expect(client.createProvider).toHaveBeenCalledTimes(1));
    expect(client.createProvider).toHaveBeenCalledWith({
      id: "new-one",
      kind: "openai-compatible",
      displayName: "New One",
      baseUrl: "http://127.0.0.1:8080/v1",
    });
  });

  it("sends the credential and immediately clears the field", async () => {
    const client = api();
    const { container } = render(<ProvidersPanel api={client} />);
    await screen.findByText("Local Llama");

    const field = screen.getByLabelText(/credential for local/i) as HTMLInputElement;
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "off");

    fireEvent.change(field, { target: { value: CREDENTIAL } });
    fireEvent.click(screen.getByRole("button", { name: /save credential for local/i }));

    await waitFor(() =>
      expect(client.setProviderCredential).toHaveBeenCalledWith("local", CREDENTIAL),
    );
    await waitFor(() => expect(field.value).toBe(""));
    expect(container.innerHTML).not.toContain(CREDENTIAL);
    expect(document.body.innerHTML).not.toContain(CREDENTIAL);
  });

  it("refuses to submit an empty credential", async () => {
    const client = api();
    render(<ProvidersPanel api={client} />);
    await screen.findByText("Local Llama");

    fireEvent.click(screen.getByRole("button", { name: /save credential for local/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(client.setProviderCredential).not.toHaveBeenCalled();
  });

  it("clears a stored credential", async () => {
    const client = api({
      listProviders: vi.fn(async () => [provider({ credentialPresent: true })]),
    });
    render(<ProvidersPanel api={client} />);
    await screen.findByText("Local Llama");

    fireEvent.click(screen.getByRole("button", { name: /clear credential for local/i }));
    await waitFor(() => expect(client.clearProviderCredential).toHaveBeenCalledWith("local"));
  });

  it("toggles enabled state through a patch", async () => {
    const client = api();
    render(<ProvidersPanel api={client} />);
    await screen.findByText("Local Llama");

    fireEvent.click(screen.getByRole("button", { name: /disable local/i }));
    await waitFor(() =>
      expect(client.updateProvider).toHaveBeenCalledWith("local", { enabled: false }),
    );
  });

  it("deletes a provider", async () => {
    const client = api();
    render(<ProvidersPanel api={client} />);
    await screen.findByText("Local Llama");

    fireEvent.click(screen.getByRole("button", { name: /delete local/i }));
    await waitFor(() => expect(client.deleteProvider).toHaveBeenCalledWith("local"));
  });

  it("renders discovered models", async () => {
    const client = api();
    render(<ProvidersPanel api={client} />);
    await screen.findByText("Local Llama");

    fireEvent.click(screen.getByRole("button", { name: /discover models for local/i }));
    expect(await screen.findByText("gpt-4o")).toBeInTheDocument();
    expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument();
  });

  it("renders a hostile model name as text, never as markup", async () => {
    const client = api({
      discoverModels: vi.fn(async () => ['<img src=x onerror="window.__xssModel = true">']),
    });
    const { container } = render(<ProvidersPanel api={client} />);
    await screen.findByText("Local Llama");

    fireEvent.click(screen.getByRole("button", { name: /discover models for local/i }));
    await screen.findByText('<img src=x onerror="window.__xssModel = true">');

    expect(container.querySelector("img")).toBeNull();
    expect((window as unknown as Record<string, unknown>).__xssModel).toBeUndefined();
  });

  it("renders a hostile display name as text", async () => {
    const client = api({
      listProviders: vi.fn(async () => [
        provider({ displayName: '<script>window.__xssName = true</script>' }),
      ]),
    });
    const { container } = render(<ProvidersPanel api={client} />);
    await screen.findByText("<script>window.__xssName = true</script>");

    expect(container.querySelector("script")).toBeNull();
    expect((window as unknown as Record<string, unknown>).__xssName).toBeUndefined();
  });

  it("shows the envelope code and message when a write fails", async () => {
    const client = api({
      setProviderCredential: vi.fn(async () => {
        throw new ApiError(501, "unsupported_operation", "this provider kind does not support that operation");
      }),
    });
    render(<ProvidersPanel api={client} />);
    await screen.findByText("Local Llama");

    fireEvent.change(screen.getByLabelText(/credential for local/i), {
      target: { value: "token-value" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save credential for local/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("unsupported_operation");
    expect(alert).toHaveTextContent("does not support that operation");
  });

  it("shows a load failure using the envelope", async () => {
    render(
      <ProvidersPanel
        api={api({
          listProviders: vi.fn(async () => {
            throw new ApiError(401, "unauthorized", "A valid API token is required");
          }),
        })}
      />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("unauthorized");
  });

  it("never renders a credential field value back into the list", async () => {
    const client = api({
      // A hostile or buggy Core that returned a credential field must not be
      // rendered by the panel, which reads only the fields it knows about.
      listProviders: vi.fn(async () => [
        { ...provider(), credential: CREDENTIAL, apiKey: CREDENTIAL } as unknown as ProviderView,
      ]),
    });
    const { container } = render(<ProvidersPanel api={client} />);
    await screen.findByText("Local Llama");

    expect(container.innerHTML).not.toContain(CREDENTIAL);
  });
});
