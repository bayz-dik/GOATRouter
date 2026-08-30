import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageScreen, type UsageApi } from "../src/usage/UsageScreen";
import { ApiError } from "../src/api/client";
import type {
  UsagePeriod,
  UsageProviderView,
  UsageRequestView,
  UsageSummaryView,
} from "../src/api/types";

/**
 * Usage screen, on real telemetry.
 *
 * The approved `reference/Web-Ui.html` drives this screen from four hardcoded demo
 * tables and labels each figure `DEMO DATA`. Production has neither, so the assertions
 * here are about honesty as much as layout:
 *
 *  - no demo constant from the reference reaches the DOM,
 *  - an unreported token count renders as unknown rather than zero,
 *  - cost is stated unavailable with the server's reason, never as a dollar figure,
 *  - an empty period says so instead of drawing a chart of nothing.
 */

let rafSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  }));
  rafSpy = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(() => 1 as never);
});

afterEach(() => {
  rafSpy.mockRestore();
  vi.unstubAllGlobals();
});

function summary(overrides: Partial<UsageSummaryView> = {}): UsageSummaryView {
  return {
    period: "today",
    totalRequests: 47,
    okRequests: 45,
    failedRequests: 2,
    promptTokens: 18_400,
    completionTokens: 3260,
    cachedTokens: 910,
    tokenReports: 47,
    averageLatencyMs: 412,
    costAvailable: false,
    costReason: "no_pricing_data",
    retention: { requests: 5000, attempts: 20_000 },
    ...overrides,
  };
}

function providerRow(overrides: Partial<UsageProviderView> = {}): UsageProviderView {
  return {
    providerId: "openrouter-main",
    displayName: "OPENROUTER MAIN",
    kind: "openrouter",
    enabled: true,
    credentialPresent: true,
    attempts: 30,
    failures: 0,
    lastOutcome: "ok",
    lastFailureCategory: null,
    averageLatencyMs: 380,
    ...overrides,
  };
}

function requestRow(overrides: Partial<UsageRequestView> = {}): UsageRequestView {
  return {
    requestId: "req_alpha",
    occurredAt: new Date(Date.now() - 18_000).toISOString(),
    routeId: "route-primary",
    providerId: "openrouter-main",
    proxyId: null,
    model: "claude-opus",
    routingMode: "combo",
    outcome: "ok",
    failureCategory: null,
    latencyMs: 380,
    attempts: 1,
    promptTokens: 12_900,
    completionTokens: 241,
    cachedTokens: 400,
    ...overrides,
  };
}

function stubApi(overrides: Partial<UsageApi> = {}): UsageApi {
  return {
    getUsageSummary: vi.fn(async (_period: UsagePeriod) => summary()),
    listUsageProviders: vi.fn(async (_period: UsagePeriod) => [providerRow()]),
    listUsageRequests: vi.fn(async (_limit: number) => [requestRow()]),
    ...overrides,
  };
}

describe("Usage screen renders measured telemetry", () => {
  it("shows real summary figures from the API", async () => {
    render(<UsageScreen api={stubApi()} />);

    expect(await screen.findByTestId("score-requests")).toHaveTextContent("47");
    expect(screen.getByTestId("score-input")).toHaveTextContent("18.4K");
    expect(screen.getByTestId("score-output")).toHaveTextContent("3.3K");
    expect(screen.getByTestId("score-cached")).toHaveTextContent("910");
    expect(screen.getByTestId("score-latency")).toHaveTextContent("412 ms");
  });

  it("labels itself live rather than demo", async () => {
    render(<UsageScreen api={stubApi()} />);
    expect(await screen.findByTestId("usage-source")).toHaveTextContent(/live/i);
    expect(screen.queryByText(/demo data/i)).toBeNull();
    expect(screen.queryByText(/not actual billing/i)).toBeNull();
  });

  it("carries no demo constant from the approved preview", async () => {
    const { container } = render(<UsageScreen api={stubApi()} />);
    await screen.findByTestId("score-requests");

    /*
     * The exact strings the reference preview hardcodes. If any appears here it means a
     * demo table was carried across, which is the failure this integration exists to
     * prevent.
     */
    const text = container.textContent ?? "";
    for (const demo of ["184K", "36K", "71K", "$0.00", "gpt-5.6-sol", "TABITOKEN", "openai-codex"]) {
      expect(text, `demo value ${demo} reached the Usage screen`).not.toContain(demo);
    }
  });

  it("renders the request table from real rows", async () => {
    render(
      <UsageScreen
        api={stubApi({
          listUsageRequests: vi.fn(async () => [
            requestRow(),
            requestRow({
              requestId: "req_beta",
              model: "gemini-2.5",
              attempts: 3,
              promptTokens: 9700,
              completionTokens: 154,
            }),
          ]),
        })}
      />,
    );

    expect(await screen.findByTestId("request-req_alpha")).toBeInTheDocument();
    expect(screen.getByTestId("request-req_beta")).toBeInTheDocument();
    expect(screen.getByText("claude-opus")).toBeInTheDocument();
    expect(screen.getByText("12.9K / 241")).toBeInTheDocument();
    expect(screen.getByText("9.7K / 154")).toBeInTheDocument();
    // A retried success keeps its retry marker.
    expect(within(screen.getByTestId("request-req_beta")).getByText(/RETRY/)).toBeInTheDocument();
  });

  it("names the failure category on a failed request", async () => {
    render(
      <UsageScreen
        api={stubApi({
          listUsageRequests: vi.fn(async () => [
            requestRow({ outcome: "failed", failureCategory: "rate_limited", attempts: 2 }),
          ]),
        })}
      />,
    );
    // The category surfaces in more than one place — the table cell and the Flux Core
    // incident list both name it — so this asserts presence rather than uniqueness.
    expect((await screen.findAllByText(/rate_limited/)).length).toBeGreaterThan(0);
    expect(
      within(screen.getByTestId("request-req_alpha")).getByText(/FAILED/),
    ).toBeInTheDocument();
  });
});

describe("Usage screen stays honest about what it does not know", () => {
  it("shows unknown, not zero, when no provider reported token counts", async () => {
    render(
      <UsageScreen
        api={stubApi({
          getUsageSummary: vi.fn(async () =>
            summary({
              promptTokens: null,
              completionTokens: null,
              cachedTokens: null,
              tokenReports: 0,
            }),
          ),
        })}
      />,
    );

    await screen.findByTestId("score-requests");
    expect(screen.getByTestId("score-input")).toHaveTextContent("—");
    expect(screen.getByTestId("score-output")).toHaveTextContent("—");
    expect(screen.getByTestId("score-cached")).toHaveTextContent("—");
    expect(screen.getAllByText("NOT REPORTED").length).toBeGreaterThan(0);
  });

  it("preserves a genuine zero as zero", async () => {
    render(
      <UsageScreen
        api={stubApi({
          getUsageSummary: vi.fn(async () =>
            summary({ promptTokens: 0, completionTokens: 0, cachedTokens: 0, tokenReports: 4 }),
          ),
        })}
      />,
    );
    // Four requests reported counts and they summed to zero, which is a measurement.
    expect(await screen.findByTestId("score-input")).toHaveTextContent("0");
    expect(screen.queryByText("NOT REPORTED")).toBeNull();
  });

  it("states cost unavailable with the server's reason and never a figure", async () => {
    render(<UsageScreen api={stubApi()} />);
    const cost = await screen.findByTestId("score-cost");
    expect(cost).toHaveTextContent(/unavailable/i);
    expect(cost).toHaveTextContent("no_pricing_data");
    expect(cost.textContent).not.toMatch(/\$|\d+\.\d{2}/);
  });

  it("says the period is empty instead of drawing a chart of nothing", async () => {
    render(
      <UsageScreen
        api={stubApi({
          getUsageSummary: vi.fn(async () =>
            summary({ totalRequests: 0, okRequests: 0, failedRequests: 0, tokenReports: 0 }),
          ),
          listUsageRequests: vi.fn(async () => []),
        })}
      />,
    );

    expect(await screen.findByTestId("recent-empty")).toHaveTextContent(/no requests recorded/i);
    expect(screen.getByTestId("pace-empty")).toHaveTextContent(/no pace to plot/i);
  });

  it("drops the stale view when a reload fails rather than presenting it as current", async () => {
    const failing = stubApi({
      getUsageSummary: vi.fn(async () => {
        throw new ApiError(503, "storage_unavailable", "local storage could not be initialized");
      }),
    });
    render(<UsageScreen api={failing} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("storage_unavailable");
    expect(screen.getByTestId("score-requests")).toHaveTextContent("—");
  });
});

describe("Usage screen period switch", () => {
  it("refetches with the selected period", async () => {
    const api = stubApi();
    render(<UsageScreen api={api} />);
    await screen.findByTestId("score-requests");

    fireEvent.click(screen.getByRole("tab", { name: "7D" }));

    await waitFor(() => expect(api.getUsageSummary).toHaveBeenCalledWith("7d"));
    expect(api.listUsageProviders).toHaveBeenCalledWith("7d");
    expect(screen.getByRole("tab", { name: "7D" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Today" })).toHaveAttribute("aria-selected", "false");
  });

  it("offers exactly the four periods the API accepts", async () => {
    render(<UsageScreen api={stubApi()} />);
    await screen.findByTestId("score-requests");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Today",
      "24H",
      "7D",
      "30D",
    ]);
  });
});

describe("Usage screen drives Flux Core from live data", () => {
  it("mounts the locked relay stage with a live model", async () => {
    const { container } = render(
      <UsageScreen
        api={stubApi({
          listUsageProviders: vi.fn(async () => [
            providerRow(),
            providerRow({ providerId: "gemini-eu", displayName: "GEMINI EU", attempts: 12 }),
          ]),
        })}
      />,
    );

    await screen.findByTestId("score-requests");
    const slot = container.querySelector("[data-bayz-flux-core-slot]");
    expect(slot).not.toBeNull();
    expect(slot!.querySelector("canvas")).not.toBeNull();
    // `LIVE`, not `SIM`: the panel meta says which it is, and the two never blend.
    await waitFor(() => expect(screen.getByText(/LIVE/)).toBeInTheDocument());
    expect(screen.queryByText(/\bSIM\b/)).toBeNull();
  });

  it("shows real provider names on the stage, not the approved demo names", async () => {
    render(<UsageScreen api={stubApi()} />);
    await screen.findByTestId("score-requests");
    expect(screen.getByText(/OPENROUTER MAIN/)).toBeInTheDocument();
    expect(screen.queryByText("TABITOKEN")).toBeNull();
  });

  it("feeds the activity list from real request rows", async () => {
    render(<UsageScreen api={stubApi()} />);
    await screen.findByTestId("score-requests");
    // Provider id and routing mode of an actual request, not an ambient simulation line.
    expect(screen.getByText(/openrouter-main \/ combo/)).toBeInTheDocument();
    expect(screen.queryByText(/checkpoint synced/)).toBeNull();
  });
});
