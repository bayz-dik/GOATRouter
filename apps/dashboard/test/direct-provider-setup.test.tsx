import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ProvidersPanel,
  deriveProviderId,
  inferProviderKind,
  isLoopbackBaseUrl,
  uniqueProviderId,
} from "../src/panels/ProvidersPanel";
import type { CreateProviderBody, ProviderView } from "../src/api/types";

/**
 * Direct provider setup: the short path from "I have a key" to "it works".
 *
 * **The problem this covers.** The add-provider form opened with `Provider id` — a field
 * whose alphabet is dictated by the secret-name grammar (`^[a-z0-9][a-z0-9-]{0,62}$`, no
 * trailing hyphen), and whose violation returns `invalid_provider_id`, which reads as a
 * product bug rather than a typo. Then `Kind`, a five-way choice about discovery paths and
 * auth shapes. Then, before the submit button, sixteen header inputs and a checkbox
 * authorising GOAT ROUTER to dial the local machine. The three things an operator actually
 * knows — what to call it, where it is, and the key — were third, fourth, and nowhere:
 * there was no key field at all, so adding a provider took a create, then a scroll to the
 * new row, then a second form.
 *
 * **What is pinned here.** The primary flow is display name, base URL, API key. Kind
 * appears only when the endpoint cannot answer the question. Everything else is behind a
 * collapsed `Advanced`. The key goes through the existing encrypted path, not a new one.
 * And a proxy is never required — a provider created through this form routes direct.
 *
 * Queries use `data-testid` for the notes and `getByLabelText` for the fields, matching the
 * split the rest of the provider suite already uses: labels are the contract for inputs,
 * test ids for prose that has no accessible-name role.
 */

const KEY = "sk-primary-flow-key-abcdef123456";

function provider(overrides: Partial<ProviderView> = {}): ProviderView {
  return {
    id: "existing",
    kind: "openai-compatible",
    displayName: "Existing",
    baseUrl: "https://existing.example.com/v1",
    enabled: true,
    config: { timeoutMs: 30000, discoveryPath: "/v1/models", modelLimit: 100 },
    credentialPresent: true,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    ...overrides,
  };
}

function api(overrides: Partial<Parameters<typeof ProvidersPanel>[0]["api"]> = {}) {
  return {
    listProviders: vi.fn(async () => [provider()]),
    createProvider: vi.fn(async (_body: CreateProviderBody) => provider({ id: "created" })),
    updateProvider: vi.fn(async () => provider()),
    deleteProvider: vi.fn(async () => undefined),
    setProviderCredential: vi.fn(async (_id: string, _value: string) => undefined),
    clearProviderCredential: vi.fn(async () => undefined),
    discoverModels: vi.fn(async () => []),
    discoverModelCatalogue: vi.fn(async () => []),
    testProviderConnection: vi.fn(async () => ({ ok: true, latencyMs: 31, modelCount: 12 })),
    listProxies: vi.fn(async () => []),
    assignProxy: vi.fn(async () => ({
      proxyId: "p",
      providerCount: 0,
      proxyEnabled: true,
      notes: [] as string[],
    })),
    unassignProxy: vi.fn(async () => ({ proxyId: "p", providerCount: 0, detachedFromProxy: 0 })),
    ...overrides,
  };
}

async function ready(): Promise<void> {
  await screen.findByText("Existing");
}

/** Fill the primary flow. Nothing else is touched, which is the point. */
function fillPrimary(name: string, url: string, key?: string): void {
  fireEvent.change(screen.getByLabelText(/^display name$/i), { target: { value: name } });
  fireEvent.change(screen.getByLabelText(/^base url$/i), { target: { value: url } });
  if (key !== undefined) {
    fireEvent.change(screen.getByLabelText(/^api key$/i), { target: { value: key } });
  }
}

describe("provider id derivation", () => {
  it("produces an id the server's own rule accepts", () => {
    // Mirrors `assertProviderId` in @bayz/providers. The server re-validates; this only
    // spares the operator a round trip that returns `invalid_provider_id`.
    const legal = /^[a-z0-9][a-z0-9-]{0,62}$/;
    for (const name of [
      "OpenRouter Main",
      "Tabitoken  Relay",
      "GROQ (eu-west)",
      "provider.with.dots",
      "Ünïcödé Provider",
      "  leading and trailing  ",
      "A".repeat(200),
    ]) {
      const id = deriveProviderId(name);
      expect(id, `${name} produced ${id}`).toMatch(legal);
      expect(id.endsWith("-"), `${name} produced a trailing hyphen`).toBe(false);
      expect(id.length).toBeLessThanOrEqual(63);
    }
  });

  it("returns empty rather than something illegal when nothing can be derived", () => {
    // A name of pure punctuation or of a non-Latin script has no derivable id. Returning
    // `"-"` or `""`-with-a-prefix would send the server a value it refuses; the form asks
    // for an override instead.
    for (const name of ["", "   ", "!!!", "***", "。。。"]) {
      expect(deriveProviderId(name)).toBe("");
    }
  });

  it("does not collide with an id already in use", () => {
    // Two providers called "Relay" is a normal thing to want. A silent 409 on the second is
    // not.
    expect(uniqueProviderId("relay", [])).toBe("relay");
    expect(uniqueProviderId("relay", ["relay"])).toBe("relay-2");
    expect(uniqueProviderId("relay", ["relay", "relay-2"])).toBe("relay-3");
    // The bound is respected even when suffixing a maximum-length id.
    const long = "a".repeat(63);
    const suffixed = uniqueProviderId(long, [long]);
    expect(suffixed.length).toBeLessThanOrEqual(63);
    expect(suffixed).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
  });
});

describe("kind inference", () => {
  it("recognises only hosts whose kind is a fact", () => {
    expect(inferProviderKind("https://openrouter.ai/api")).toBe("openrouter");
    expect(inferProviderKind("https://openrouter.ai/api/v1")).toBe("openrouter");
    expect(inferProviderKind("https://generativelanguage.googleapis.com")).toBe("gemini");
  });

  it("refuses to guess for anything else", () => {
    /*
     * The kind decides the discovery path and the auth shape — `gemini` uses
     * `/v1beta/models` and a query-parameter key, the rest use `/v1/models` and a bearer
     * header. Guessing it from an unknown host would silently misconfigure both, so an
     * unrecognised host returns `undefined` and the form shows the selector.
     */
    for (const url of [
      "https://api.example.com/v1",
      "http://127.0.0.1:11434/v1",
      "https://not-openrouter.ai.evil.example/api",
      "https://openrouter.ai.evil.example/api",
      "not a url",
      "",
    ]) {
      expect(inferProviderKind(url), url).toBeUndefined();
    }
  });

  it("recognises a loopback address in every form the server refuses", () => {
    for (const url of [
      "http://127.0.0.1:11434/v1",
      "http://127.1.2.3/v1",
      "http://localhost:8080/v1",
      "http://[::1]:8080/v1",
      "http://runtime.localhost/v1",
    ]) {
      expect(isLoopbackBaseUrl(url), url).toBe(true);
    }
    for (const url of ["https://api.example.com/v1", "http://10.0.0.5/v1", "nonsense"]) {
      expect(isLoopbackBaseUrl(url), url).toBe(false);
    }
  });
});

describe("the primary add-provider flow", () => {
  it("asks for a display name, a base URL and a key — and nothing else", async () => {
    render(<ProvidersPanel api={api()} />);
    await ready();

    const form = screen.getByTestId("add-provider-form");
    // Every labelled control the operator meets before opening Advanced.
    const visible = Array.from(form.querySelectorAll<HTMLElement>("label"))
      .filter((label) => label.closest("details") === null)
      .map((label) => (label.textContent ?? "").trim());
    expect(visible).toEqual(["Display name", "Base URL", "API key"]);
  });

  it("creates the provider and stores the key through the existing encrypted path", async () => {
    const client = api();
    render(<ProvidersPanel api={client} />);
    await ready();

    fillPrimary("OpenRouter Main", "https://openrouter.ai/api", KEY);
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));

    await waitFor(() => expect(client.createProvider).toHaveBeenCalledTimes(1));
    expect(client.createProvider).toHaveBeenCalledWith({
      id: "openrouter-main",
      // Inferred from the host, so the operator was never asked.
      kind: "openrouter",
      displayName: "OpenRouter Main",
      baseUrl: "https://openrouter.ai/api",
    });

    /*
     * The key travels by `setProviderCredential`, which is `PUT …/credential` with a body of
     * exactly `{ value }`, answered 204 with no echo and no read accessor anywhere. This
     * flow added no new credential path — asserted, because a second path is exactly how a
     * secret ends up somewhere it was never meant to be.
     */
    await waitFor(() => expect(client.setProviderCredential).toHaveBeenCalledTimes(1));
    expect(client.setProviderCredential).toHaveBeenCalledWith("openrouter-main", KEY);
    // And it is never part of the create body, which is logged and echoed back as a view.
    expect(vi.mocked(client.createProvider).mock.calls[0]![0]).not.toHaveProperty("config.headers.authorization");
    expect(JSON.stringify(vi.mocked(client.createProvider).mock.calls[0]![0])).not.toContain(KEY);
  });

  it("clears the key field the moment it is sent and never re-renders it", async () => {
    const client = api();
    const { container } = render(<ProvidersPanel api={client} />);
    await ready();

    fillPrimary("Relay", "https://relay.example.com/v1", KEY);
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));

    await waitFor(() => expect(client.setProviderCredential).toHaveBeenCalled());
    const field = screen.getByLabelText(/^api key$/i) as HTMLInputElement;
    expect(field.value).toBe("");
    expect(container.innerHTML).not.toContain(KEY);
    expect(document.body.innerHTML).not.toContain(KEY);
  });

  it("drops the key from state even when the create fails", async () => {
    const client = api({
      createProvider: vi.fn(async () => {
        throw new Error("conflict");
      }),
    });
    render(<ProvidersPanel api={client} />);
    await ready();

    fillPrimary("Relay", "https://relay.example.com/v1", KEY);
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));

    await screen.findByRole("alert");
    // A half-created provider must not leave a secret sitting in component state waiting
    // for a second submit.
    expect((screen.getByLabelText(/^api key$/i) as HTMLInputElement).value).toBe("");
    expect(document.body.innerHTML).not.toContain(KEY);
    expect(client.setProviderCredential).not.toHaveBeenCalled();
  });

  it("stores no credential when the key is left blank", async () => {
    const client = api();
    render(<ProvidersPanel api={client} />);
    await ready();

    // `codex-oauth` has no key to paste and a local runtime often needs none, so the field
    // is optional rather than merely lenient.
    fillPrimary("Local Runtime", "https://runtime.example.com/v1");
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));

    await waitFor(() => expect(client.createProvider).toHaveBeenCalled());
    expect(client.setProviderCredential).not.toHaveBeenCalled();
    expect(await screen.findByTestId("create-result")).toHaveTextContent(/no api key stored/i);
  });

  it("shows the derived id before submitting, so it is never a surprise", async () => {
    render(<ProvidersPanel api={api()} />);
    await ready();

    fillPrimary("GROQ (eu-west)", "https://api.groq.com/openai/v1");
    // The id appears in every log line and in the stored secret's name. Deriving it silently
    // and never showing it would make those unexplainable.
    expect(await screen.findByTestId("derived-provider-id")).toHaveTextContent("groq-eu-west");
  });

  it("suffixes rather than colliding with an existing id", async () => {
    const client = api({
      listProviders: vi.fn(async () => [provider({ id: "relay", displayName: "Existing" })]),
    });
    render(<ProvidersPanel api={client} />);
    await ready();

    fillPrimary("Relay", "https://relay.example.com/v1");
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));

    await waitFor(() => expect(client.createProvider).toHaveBeenCalled());
    expect(vi.mocked(client.createProvider).mock.calls[0]![0]!.id).toBe("relay-2");
  });

  it("refuses to submit with a missing field, naming the field", async () => {
    const client = api();
    render(<ProvidersPanel api={client} />);
    await ready();

    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/display name/i);
    expect(client.createProvider).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/^display name$/i), { target: { value: "R" } });
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/base url/i);
    expect(client.createProvider).not.toHaveBeenCalled();
  });
});

describe("kind is asked only when it cannot be known", () => {
  it("stays hidden for a host whose kind is a fact", async () => {
    render(<ProvidersPanel api={api()} />);
    await ready();

    fillPrimary("OpenRouter Main", "https://openrouter.ai/api");
    await waitFor(() =>
      expect(screen.getByTestId("inferred-kind")).toHaveTextContent(/openrouter/),
    );
    // No selector in the primary flow: the endpoint already answered.
    expect(screen.queryByTestId("provider-kind")).toBeNull();
  });

  it("appears for an unrecognised host, preselected and not blocking", async () => {
    const client = api();
    render(<ProvidersPanel api={client} />);
    await ready();

    fillPrimary("My Relay", "https://api.example.com/v1");
    // Visible, because a silent guess about discovery and auth is not acceptable.
    expect(await screen.findByTestId("provider-kind")).toBeInTheDocument();
    expect(screen.getByTestId("kind-note")).toBeInTheDocument();

    /*
     * But it does not stop the operator: `openai-compatible` is the right answer for an
     * arbitrary `/v1` endpoint and is preselected. An earlier version of this made an
     * explicit choice mandatory, which added a required step to every self-hosted relay —
     * the exact friction this whole pass exists to remove.
     */
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    await waitFor(() => expect(client.createProvider).toHaveBeenCalled());
    expect(vi.mocked(client.createProvider).mock.calls[0]![0]!.kind).toBe("openai-compatible");
  });

  it("sends an explicit choice over the inferred one", async () => {
    const client = api();
    render(<ProvidersPanel api={client} />);
    await ready();

    fillPrimary("Self-hosted Gemini", "https://api.example.com/v1beta");
    fireEvent.change(await screen.findByTestId("provider-kind"), {
      target: { value: "gemini" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));

    await waitFor(() => expect(client.createProvider).toHaveBeenCalled());
    expect(vi.mocked(client.createProvider).mock.calls[0]![0]!.kind).toBe("gemini");
  });

  it("lets an operator override a recognised host from Advanced", async () => {
    const client = api();
    render(<ProvidersPanel api={client} />);
    await ready();

    // A self-hosted OpenRouter-compatible relay behind the real hostname is legitimate, so
    // inference must be overridable rather than final.
    fillPrimary("Relay", "https://openrouter.ai/api");
    fireEvent.change(screen.getByLabelText(/^kind override$/i), {
      target: { value: "custom-openai" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));

    await waitFor(() => expect(client.createProvider).toHaveBeenCalled());
    expect(vi.mocked(client.createProvider).mock.calls[0]![0]!.kind).toBe("custom-openai");
  });
});

describe("Advanced holds everything that is an override", () => {
  it("is collapsed on arrival", async () => {
    render(<ProvidersPanel api={api()} />);
    await ready();
    const advanced = screen.getByTestId("provider-advanced") as HTMLDetailsElement;
    expect(advanced.open).toBe(false);
  });

  it("contains the id override, all eight header rows, loopback and compatibility", async () => {
    render(<ProvidersPanel api={api()} />);
    await ready();
    const advanced = screen.getByTestId("provider-advanced");

    /*
     * Asserted by containment rather than by presence: every one of these was in the primary
     * flow before, and a test that only checked "it exists" would pass just as happily with
     * them all still in front of the operator.
     */
    for (const label of [
      /^provider id override$/i,
      /^kind override$/i,
      /header 1 name/i,
      /header 8 value/i,
      /^allow loopback/i,
      /^discovery path$/i,
      /^request timeout/i,
      /^model limit$/i,
      /^tool calling$/i,
    ]) {
      const control = screen.getByLabelText(label);
      expect(advanced.contains(control), `${label} is not under Advanced`).toBe(true);
    }
    // Still bounded at eight: the server refuses a ninth.
    expect(screen.queryByLabelText(/header 9 name/i)).toBeNull();
  });

  it("sends an id override in place of the derived one", async () => {
    const client = api();
    render(<ProvidersPanel api={client} />);
    await ready();

    fillPrimary("Relay With A Long Name", "https://relay.example.com/v1");
    fireEvent.change(screen.getByLabelText(/^provider id override$/i), {
      target: { value: "relay-eu" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));

    await waitFor(() => expect(client.createProvider).toHaveBeenCalled());
    expect(vi.mocked(client.createProvider).mock.calls[0]![0]!.id).toBe("relay-eu");
  });

  it("sends the compatibility overrides only when they were set", async () => {
    const client = api();
    render(<ProvidersPanel api={client} />);
    await ready();

    fillPrimary("Relay", "https://relay.example.com/v1");
    fireEvent.change(screen.getByLabelText(/^discovery path$/i), {
      target: { value: "/models" },
    });
    fireEvent.change(screen.getByLabelText(/^request timeout/i), { target: { value: "9000" } });
    fireEvent.change(screen.getByLabelText(/^model limit$/i), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText(/^tool calling$/i), { target: { value: "no" } });
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));

    await waitFor(() => expect(client.createProvider).toHaveBeenCalled());
    expect(vi.mocked(client.createProvider).mock.calls[0]![0]).toMatchObject({
      config: {
        discoveryPath: "/models",
        timeoutMs: 9000,
        modelLimit: 25,
        supportsTools: false,
      },
    });
  });

  it("omits an untouched numeric override rather than sending zero", async () => {
    const client = api();
    render(<ProvidersPanel api={client} />);
    await ready();

    /*
     * `Number("")` is `0`, which the server refuses as out of range for both `timeoutMs`
     * (min 1000) and `modelLimit` (min 1). An empty box has to mean "server default", not
     * "zero", or leaving the section alone would produce a 400.
     */
    fillPrimary("Relay", "https://relay.example.com/v1");
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));

    await waitFor(() => expect(client.createProvider).toHaveBeenCalled());
    expect(vi.mocked(client.createProvider).mock.calls[0]![0]).not.toHaveProperty("config");
  });

  it("keeps tool support undetermined by default", async () => {
    const client = api();
    render(<ProvidersPanel api={client} />);
    await ready();

    // `unknown` is a real answer the capability report prints as `undetermined`. A checkbox
    // would force the operator to assert something they may not know.
    fillPrimary("Relay", "https://relay.example.com/v1");
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));

    await waitFor(() => expect(client.createProvider).toHaveBeenCalled());
    const body = vi.mocked(client.createProvider).mock.calls[0]![0]!;
    expect(body.config?.supportsTools).toBeUndefined();
  });

  it("warns about a loopback address without refusing to store it", async () => {
    const client = api();
    render(<ProvidersPanel api={client} />);
    await ready();

    fillPrimary("Ollama", "http://127.0.0.1:11434/v1");
    /*
     * A warning, not a blocker. `allowLoopback` is consulted by the egress classifier at
     * request time, not by `createProvider` — so refusing here would invent a rule the API
     * does not have and break "enter it now, authorise it later".
     */
    expect(await screen.findByTestId("loopback-hint")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    await waitFor(() => expect(client.createProvider).toHaveBeenCalled());

    // And with the opt-in the hint is gone and the flag is sent.
    fillPrimary("Ollama Two", "http://127.0.0.1:11435/v1");
    fireEvent.click(screen.getByLabelText(/^allow loopback/i));
    expect(screen.queryByTestId("loopback-hint")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    await waitFor(() => expect(client.createProvider).toHaveBeenCalledTimes(2));
    expect(vi.mocked(client.createProvider).mock.calls[1]![0]).toMatchObject({
      config: { allowLoopback: true },
    });
  });
});

describe("test connection from the create flow", () => {
  it("creates, stores the key, then tests — in that order", async () => {
    const order: string[] = [];
    const client = api({
      createProvider: vi.fn(async () => {
        order.push("create");
        return provider({ id: "relay" });
      }),
      setProviderCredential: vi.fn(async () => {
        order.push("credential");
      }),
      testProviderConnection: vi.fn(async () => {
        order.push("test");
        return { ok: true, latencyMs: 31, modelCount: 12 };
      }),
    });
    render(<ProvidersPanel api={client} />);
    await ready();

    fillPrimary("Relay", "https://relay.example.com/v1", KEY);
    fireEvent.click(screen.getByTestId("create-and-test"));

    await waitFor(() => expect(client.testProviderConnection).toHaveBeenCalled());
    /*
     * The order is the whole design. `POST /api/providers/:id/test` dials a *stored*
     * provider using its *stored* credential — there is nothing to dial before both exist.
     * Testing an unsaved form would need a second endpoint that accepts a raw key in a
     * request body, which is a secret-bearing surface this product does not have and should
     * not grow for a convenience.
     */
    expect(order).toEqual(["create", "credential", "test"]);
    expect(client.testProviderConnection).toHaveBeenCalledWith("relay");
  });

  it("reports latency and the model count on success", async () => {
    render(<ProvidersPanel api={api()} />);
    await ready();

    fillPrimary("Relay", "https://relay.example.com/v1", KEY);
    fireEvent.click(screen.getByTestId("create-and-test"));

    const result = await screen.findByTestId("create-test-result");
    expect(result).toHaveTextContent(/31/);
    expect(result).toHaveTextContent(/12/);
  });

  it("names the failure code rather than saying only that it failed", async () => {
    const client = api({
      testProviderConnection: vi.fn(async () => ({
        ok: false,
        latencyMs: 8,
        failureCode: "auth_failed" as const,
      })),
    });
    render(<ProvidersPanel api={client} />);
    await ready();

    fillPrimary("Relay", "https://relay.example.com/v1", KEY);
    fireEvent.click(screen.getByTestId("create-and-test"));

    // The point of testing at setup time: "the key is wrong" and "the endpoint is dead" are
    // different problems with different fixes, and a bare "failed" tells the operator to
    // guess.
    expect(await screen.findByTestId("create-test-result")).toHaveTextContent(/auth_failed/);
  });

  it("renders a hostile failure code as inert text", async () => {
    const client = api({
      testProviderConnection: vi.fn(async () => ({
        ok: false,
        latencyMs: 8,
        failureCode: '<img src=x onerror="window.__createXss = true">' as never,
      })),
    });
    render(<ProvidersPanel api={client} />);
    await ready();

    fillPrimary("Relay", "https://relay.example.com/v1", KEY);
    fireEvent.click(screen.getByTestId("create-and-test"));

    await screen.findByTestId("create-test-result");
    expect((window as unknown as { __createXss?: boolean }).__createXss).toBeUndefined();
    // Every `img` in the document is an approved brand file; the payload created none.
    for (const image of Array.from(document.querySelectorAll("img"))) {
      expect(image.getAttribute("src")).toMatch(/^\/brand\//);
    }
  });

  it("says which field is missing instead of dialling nothing", async () => {
    const client = api();
    render(<ProvidersPanel api={client} />);
    await ready();

    fireEvent.click(screen.getByTestId("create-and-test"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/display name/i);
    expect(client.createProvider).not.toHaveBeenCalled();
    expect(client.testProviderConnection).not.toHaveBeenCalled();
  });

  it("refuses an invalid header before creating anything", async () => {
    const client = api();
    render(<ProvidersPanel api={client} />);
    await ready();

    fillPrimary("Relay", "https://relay.example.com/v1", KEY);
    fireEvent.change(screen.getByLabelText(/header 1 name/i), {
      target: { value: "authorization" },
    });
    fireEvent.change(screen.getByLabelText(/header 1 value/i), {
      target: { value: "Bearer forged" },
    });
    fireEvent.click(screen.getByTestId("create-and-test"));

    // Header validation is shared by both buttons: a forged `authorization` must not reach
    // the server through the newer path just because the older one refused it.
    expect(await screen.findByTestId("header-error-0")).toHaveTextContent(/authorization/i);
    expect(client.createProvider).not.toHaveBeenCalled();
    expect(client.testProviderConnection).not.toHaveBeenCalled();
  });
});

describe("a proxy is optional, never required", () => {
  it("creates a direct provider with no proxy selected and says so", async () => {
    const client = api();
    render(<ProvidersPanel api={client} />);
    await ready();

    fillPrimary("Relay", "https://relay.example.com/v1", KEY);
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));

    await waitFor(() => expect(client.createProvider).toHaveBeenCalled());
    // No proxy field in the create flow at all, and no proxy call made.
    expect(vi.mocked(client.createProvider).mock.calls[0]![0]).not.toHaveProperty("proxyId");
    expect(client.assignProxy).not.toHaveBeenCalled();
    expect(screen.getByTestId("proxy-optional-note")).toHaveTextContent(/optional/i);
    expect(await screen.findByTestId("create-result")).toHaveTextContent(/direct/i);
  });

  it("works identically with no proxies configured at all", async () => {
    const client = api({ listProxies: vi.fn(async () => []) });
    render(<ProvidersPanel api={client} />);
    await ready();

    /*
     * The load-bearing case: a fresh install has no proxies, and setting up a provider must
     * not depend on one existing. An external router is an option this product offers, not a
     * prerequisite it imposes.
     */
    fillPrimary("Relay", "https://relay.example.com/v1", KEY);
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));

    await waitFor(() => expect(client.createProvider).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("proxy-assign-bar")).toBeNull();
  });
});
