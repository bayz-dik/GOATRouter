import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProvidersPanel } from "../src/panels/ProvidersPanel";
import { RoutesPanel } from "../src/panels/RoutesPanel";
import type {
  ModelCatalogueEntry,
  ProviderView,
  RouteView,
} from "../src/api/types";

/*
 * Task 6c: free-first model selection.
 *
 * The load-bearing assertion in this file is that a PAID model is *absent from the DOM*
 * until the operator asks for it. "De-emphasised but present" is not the requirement: a
 * paid model that is merely styled differently can still be clicked by accident, and the
 * point of FREE-FIRST is that spending money takes a deliberate act.
 *
 * Queries use `data-testid` rather than label text. `getByLabelText` is superlinear under
 * jsdom — ~26s per call at 120 rows versus ~7ms for `getByTestId`. Real `<label htmlFor>`
 * elements are still present and are exercised by the accessibility test at the bottom.
 *
 * `fireEvent`, not `user-event`: the latter is not a dependency of this repository and
 * 9E adds none.
 */

function provider(overrides: Partial<ProviderView> = {}): ProviderView {
  return {
    id: "p1",
    kind: "openai-compatible",
    displayName: "Provider One",
    baseUrl: "https://example.invalid/v1",
    enabled: true,
    credentialPresent: true,
    config: { timeoutMs: 30_000, discoveryPath: "/v1/models", modelLimit: 100 },
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

function route(overrides: Partial<RouteView> = {}): RouteView {
  return {
    id: "r1",
    model: "free-model",
    providerId: "p1",
    proxyId: undefined,
    forceDirect: false,
    // Matches the server default. A fixture defaulting to paid would quietly invert the
    // policy this task exists to enforce.
    freeOnly: true,
    priority: 100,
    enabled: true,
    config: { maxAttempts: 2, requestTimeoutMs: 30_000 },
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

function providersApi(overrides: Record<string, unknown> = {}) {
  return {
    listProviders: vi.fn(async () => [provider()]),
    createProvider: vi.fn(async () => provider()),
    updateProvider: vi.fn(async () => provider()),
    deleteProvider: vi.fn(async () => undefined),
    setProviderCredential: vi.fn(async () => undefined),
    clearProviderCredential: vi.fn(async () => undefined),
    discoverModels: vi.fn(async () => ["free-verified"]),
    discoverModelCatalogue: vi.fn(async (): Promise<ModelCatalogueEntry[]> => []),
    testProviderConnection: vi.fn(async () => ({
      ok: true,
      latencyMs: 10,
      modelCount: 1,
    })),
    listProxies: vi.fn(async () => []),
    assignProxy: vi.fn(async () => ({
      proxyId: "x",
      providerCount: 0,
      proxyEnabled: true,
      notes: [] as string[],
    })),
    unassignProxy: vi.fn(async () => ({
      proxyId: "x",
      providerCount: 0,
      detachedFromProxy: 0,
    })),
    ...overrides,
  };
}

function routesApi(overrides: Record<string, unknown> = {}) {
  return {
    listRoutes: vi.fn(async () => [route()]),
    listProviders: vi.fn(async () => [provider()]),
    listProxies: vi.fn(async () => []),
    createRoute: vi.fn(async (_body: unknown) => route()),
    updateRoute: vi.fn(async () => route({ freeOnly: false })),
    deleteRoute: vi.fn(async () => undefined),
    ...overrides,
  };
}

const MIXED: ModelCatalogueEntry[] = [
  { id: "paid-big", economics: "PAID" },
  { id: "free-verified", economics: "FREE_VERIFIED" },
  { id: "mystery", economics: "UNKNOWN" },
  { id: "free-tier", economics: "FREE_TIER" },
  { id: "free-preview", economics: "FREE_PREVIEW" },
  { id: "local-llama", economics: "LOCAL" },
];

describe("free-first catalogue display", () => {
  it("lists free models and keeps paid models out of the DOM until asked", async () => {
    const api = providersApi({ discoverModelCatalogue: vi.fn(async () => MIXED) });
    render(<ProvidersPanel api={api as never} />);

    fireEvent.click(await screen.findByTestId("catalogue-p1"));

    await waitFor(() => {
      expect(screen.getByTestId("model-free-verified")).toBeTruthy();
    });
    expect(screen.getByTestId("model-free-tier")).toBeTruthy();
    expect(screen.getByTestId("model-free-preview")).toBeTruthy();
    expect(screen.getByTestId("model-local-llama")).toBeTruthy();

    // Paid and unknown are genuinely not rendered, not merely styled down.
    expect(screen.queryByTestId("model-paid-big")).toBeNull();
    expect(screen.queryByTestId("model-mystery")).toBeNull();
    expect(screen.queryByText(/paid-big/)).toBeNull();

    // Disclosed, so nothing is hidden silently.
    expect(screen.getByTestId("paid-hidden-count-p1").textContent).toContain("2");

    fireEvent.click(screen.getByTestId("show-paid-p1"));

    expect(screen.getByTestId("model-paid-big")).toBeTruthy();
    expect(screen.getByTestId("model-mystery")).toBeTruthy();
  });

  it("orders free models before paid ones once both are shown", async () => {
    const api = providersApi({ discoverModelCatalogue: vi.fn(async () => MIXED) });
    render(<ProvidersPanel api={api as never} />);

    fireEvent.click(await screen.findByTestId("catalogue-p1"));
    await waitFor(() => {
      expect(screen.getByTestId("model-free-verified")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("show-paid-p1"));

    const order = Array.from(
      screen.getByTestId("catalogue-list-p1").querySelectorAll("[data-economics]"),
      (node) => node.getAttribute("data-economics"),
    );
    const firstNonFree = order.findIndex(
      (value) => value === "PAID" || value === "UNKNOWN",
    );
    const lastFree = order.reduce(
      (last, value, index) =>
        value === "PAID" || value === "UNKNOWN" ? last : index,
      -1,
    );
    expect(firstNonFree).toBeGreaterThan(-1);
    expect(lastFree).toBeLessThan(firstNonFree);
  });

  it("qualifies FREE_TIER and FREE_PREVIEW so neither reads as permanently free", async () => {
    const api = providersApi({ discoverModelCatalogue: vi.fn(async () => MIXED) });
    render(<ProvidersPanel api={api as never} />);

    fireEvent.click(await screen.findByTestId("catalogue-p1"));

    await waitFor(() => {
      expect(screen.getByTestId("model-free-tier").textContent).toContain(
        "limited quota",
      );
    });
    expect(screen.getByTestId("model-free-preview").textContent).toContain("temporary");
    expect(screen.getByTestId("model-free-verified").textContent).toContain("Free");
    expect(screen.getByTestId("model-local-llama").textContent).toContain("Local");
  });

  it("groups UNKNOWN with paid rather than with free", async () => {
    const api = providersApi({
      discoverModelCatalogue: vi.fn(async () => [
        { id: "mystery", economics: "UNKNOWN" as const },
      ]),
    });
    render(<ProvidersPanel api={api as never} />);

    fireEvent.click(await screen.findByTestId("catalogue-p1"));

    // Absence of a price is not evidence of zero.
    await waitFor(() => {
      expect(screen.getByTestId("paid-hidden-count-p1").textContent).toContain("1");
    });
    expect(screen.queryByTestId("model-mystery")).toBeNull();

    fireEvent.click(screen.getByTestId("show-paid-p1"));
    expect(screen.getByTestId("model-mystery").textContent).toContain("Unknown");
  });

  it("renders a hostile economics value as Unknown rather than trusting it", async () => {
    const api = providersApi({
      discoverModelCatalogue: vi.fn(async () => [
        // A tampered response: must not be offered as free, must not render markup.
        { id: "evil", economics: "<img src=x onerror=alert(1)>" as never },
      ]),
    });
    render(<ProvidersPanel api={api as never} />);

    fireEvent.click(await screen.findByTestId("catalogue-p1"));

    await waitFor(() => {
      expect(screen.getByTestId("paid-hidden-count-p1").textContent).toContain("1");
    });
    fireEvent.click(screen.getByTestId("show-paid-p1"));

    const row = screen.getByTestId("model-evil");
    expect(row.textContent).toContain("Unknown");
    expect(row.querySelector("img")).toBeNull();
  });

  it("renders a hostile model id as text, not markup", async () => {
    const api = providersApi({
      discoverModelCatalogue: vi.fn(async () => [
        { id: "<script>bad</script>", economics: "FREE_VERIFIED" as const },
      ]),
    });
    render(<ProvidersPanel api={api as never} />);

    fireEvent.click(await screen.findByTestId("catalogue-p1"));

    const list = await screen.findByTestId("catalogue-list-p1");
    expect(list.querySelector("script")).toBeNull();
    expect(list.textContent).toContain("<script>bad</script>");
  });
});

describe("free-only route controls", () => {
  it("defaults the new-route toggle to free-only and sends true", async () => {
    const api = routesApi();
    render(<RoutesPanel api={api as never} />);

    const toggle = (await screen.findByTestId("route-free-only")) as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    fireEvent.change(screen.getByTestId("route-id-input"), {
      target: { value: "r2" },
    });
    fireEvent.change(screen.getByTestId("route-model-input"), {
      target: { value: "free-model" },
    });
    fireEvent.change(screen.getByTestId("route-provider-input"), {
      target: { value: "p1" },
    });
    fireEvent.click(screen.getByTestId("route-submit"));

    await waitFor(() => {
      expect(api.createRoute).toHaveBeenCalled();
    });
    expect(api.createRoute.mock.calls[0]?.[0]).toMatchObject({ freeOnly: true });
  });

  it("warns in plain language when free-only is turned off on the form", async () => {
    render(<RoutesPanel api={routesApi() as never} />);

    fireEvent.click(await screen.findByTestId("route-free-only"));

    // Plain language, and it names the consequence: money.
    expect(screen.getByTestId("paid-warning").textContent).toMatch(/charge|cost|paid/i);
  });

  it("marks a free-only route on its row and does not mark a paid one", async () => {
    const api = routesApi({
      listRoutes: vi.fn(async () => [
        route({ id: "free-route", freeOnly: true }),
        route({ id: "paid-route", freeOnly: false }),
      ]),
    });
    render(<RoutesPanel api={api as never} />);

    await waitFor(() => {
      expect(screen.getByTestId("route-economics-free-route").textContent).toContain(
        "Free only",
      );
    });
    expect(screen.getByTestId("route-economics-paid-route").textContent).toContain(
      "Paid allowed",
    );
  });

  it("round-trips the toggle through the API on an existing route", async () => {
    const api = routesApi({
      listRoutes: vi.fn(async () => [route({ id: "r1", freeOnly: true })]),
    });
    render(<RoutesPanel api={api as never} />);

    fireEvent.click(await screen.findByTestId("toggle-free-only-r1"));

    await waitFor(() => {
      expect(api.updateRoute).toHaveBeenCalledWith("r1", { freeOnly: false });
    });
  });
});

describe("no_free_route surfacing", () => {
  it("explains that nothing was charged", async () => {
    const failure = Object.assign(
      new Error("no free model is available for this request"),
      { name: "ApiError", status: 409, code: "no_free_route" },
    );
    const api = routesApi({
      listRoutes: vi.fn(async () => [route({ id: "r1" })]),
      updateRoute: vi.fn(async () => {
        throw failure;
      }),
    });
    render(<RoutesPanel api={api as never} />);

    fireEvent.click(await screen.findByTestId("toggle-free-only-r1"));

    // The code, so it can be searched; and the reassurance, because an operator seeing
    // only an error assumes a bug rather than a deliberate refusal.
    const shown = await screen.findByTestId("no-free-route-help");
    expect(shown.textContent).toContain("no_free_route");
    expect(shown.textContent).toMatch(/nothing was charged/i);
  });
});

describe("accessibility and isolation", () => {
  it("keeps real labels on the free-only controls", async () => {
    render(<RoutesPanel api={routesApi() as never} />);

    // One small-fixture label query, deliberately: the test-id queries elsewhere are a
    // jsdom performance measure, not a licence to ship unlabelled inputs.
    expect(await screen.findByLabelText(/free.only/i)).toBeTruthy();
  });

  it("imports nothing from Flux Core", () => {
    // Flux Core is locked. The 9L SHA pin is the real guard; this asserts the two panels
    // changed here did not grow a dependency on it.
    //
    // Resolved from cwd rather than `import.meta.url`: under the jsdom environment that
    // URL is an http:// document URL, and `readFileSync` rejects a non-file scheme.
    for (const path of [
      resolve("src/panels/RoutesPanel.tsx"),
      resolve("src/panels/ProvidersPanel.tsx"),
    ]) {
      expect(readFileSync(path, "utf8")).not.toMatch(/from\s+["'][^"']*flux/i);
    }
  });
});
