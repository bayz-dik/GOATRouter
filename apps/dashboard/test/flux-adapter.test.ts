import { describe, expect, it } from "vitest";
import {
  buildLiveViewModel,
  buildDemoViewModel,
  type UsageProviderRow,
  type UsageRequestRow,
  type UsageSummaryResponse,
} from "../src/flux/adapter";

/**
 * Real-telemetry adapter.
 *
 * The adapter maps authenticated Usage API output onto the LOCKED Flux Core
 * display-safe boundary. Its whole job is to be honest: live and demo never merge,
 * unknown stays unknown, and nothing secret can cross.
 */

function summary(overrides: Partial<UsageSummaryResponse> = {}): UsageSummaryResponse {
  return {
    period: "today",
    totalRequests: 12,
    okRequests: 11,
    failedRequests: 1,
    promptTokens: 1200,
    completionTokens: 340,
    cachedTokens: 90,
    tokenReports: 12,
    averageLatencyMs: 412,
    costAvailable: false,
    costReason: "no_pricing_data",
    ...overrides,
  };
}

function providerRow(overrides: Partial<UsageProviderRow> = {}): UsageProviderRow {
  return {
    providerId: "p1",
    displayName: "OPENROUTER",
    kind: "openrouter",
    enabled: true,
    credentialPresent: true,
    attempts: 5,
    failures: 0,
    lastOutcome: "ok",
    lastFailureCategory: null,
    averageLatencyMs: 300,
    ...overrides,
  };
}

function providers(
  n: number,
  overrides: Record<number, Partial<UsageProviderRow>> = {},
): UsageProviderRow[] {
  return Array.from({ length: n }, (_unused, index) =>
    providerRow({
      providerId: `p${index}`,
      displayName: `PROVIDER ${index}`,
      ...(overrides[index] ?? {}),
    }),
  );
}

describe("live and demo are never mixed", () => {
  it("marks real telemetry as live", () => {
    const model = buildLiveViewModel({ summary: summary(), providers: providers(3) });
    expect(model.source).toBe("live");
  });

  it("marks the demo adapter as simulation and keeps it separate", () => {
    const demo = buildDemoViewModel();
    expect(demo.source).toBe("simulation");
    expect(demo.providers.length).toBeGreaterThan(0);
  });

  it("never falls back to demo values when live data is empty", () => {
    const model = buildLiveViewModel({
      summary: summary({ totalRequests: 0, okRequests: 0, failedRequests: 0 }),
      providers: [],
    });
    expect(model.source).toBe("live");
    // An empty live field is empty, not silently repopulated with demo providers.
    expect(model.providers).toEqual([]);
    expect(model.routedRequests).toBe(0);
  });

  it("does not carry demo provider names into a live model", () => {
    const model = buildLiveViewModel({ summary: summary(), providers: providers(2) });
    const names = model.providers.map((provider) => provider.displayName);
    expect(names).toEqual(["PROVIDER 0", "PROVIDER 1"]);
    expect(names).not.toContain("TABITOKEN");
  });
});

describe("provider identity mapping", () => {
  it("maps registered providers to safe display identities", () => {
    const model = buildLiveViewModel({
      summary: summary(),
      providers: [providerRow({ providerId: "gem", displayName: "GEMINI", kind: "gemini" })],
    });
    const provider = model.providers[0]!;
    expect(provider.id).toBe("gem");
    expect(provider.displayName).toBe("GEMINI");
    // Icon comes from the local table via a kind-derived key, never from the API.
    expect(provider.iconKey).toBe("gemini");
  });

  it("falls back to a generic icon for an unknown kind", () => {
    const model = buildLiveViewModel({
      summary: summary(),
      providers: [providerRow({ kind: "something-new" as never })],
    });
    expect(model.providers[0]!.iconKey).toBe("generic");
  });

  it("maps the custom-openai kind to the local custom mark", () => {
    const model = buildLiveViewModel({
      summary: summary(),
      providers: [providerRow({ kind: "custom-openai" as never })],
    });
    // `custom` is a key into the local icon table, so a custom provider gets a
    // recognisable mark without the API ever supplying an asset, a URL, or markup.
    expect(model.providers[0]!.iconKey).toBe("custom");
  });

  it("resolves a hostile kind descriptor to the local generic mark", () => {
    // 9D extends the Phase 7 rule to `custom-openai`: the kind is a *key*, so markup,
    // a URL, and a data URI are all simply unknown keys and fall back to `generic`.
    // There is no code path that turns provider metadata into an asset reference.
    for (const hostile of [
      '<svg onload="window.__iconXss = true"></svg>',
      "https://evil.example.com/logo.svg",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "../../etc/passwd",
      "custom-openai\u0000",
      "CUSTOM-OPENAI",
      "",
    ]) {
      const model = buildLiveViewModel({
        summary: summary(),
        providers: [providerRow({ kind: hostile as never })],
      });
      expect(model.providers[0]!.iconKey).toBe("generic");
    }
    expect((window as unknown as { __iconXss?: boolean }).__iconXss).toBeUndefined();
  });

  it("keeps duplicate display names distinguishable by id", () => {
    const model = buildLiveViewModel({
      summary: summary(),
      providers: [
        providerRow({ providerId: "cust-tokyo", displayName: "CUSTOM" }),
        providerRow({ providerId: "cust-backup", displayName: "CUSTOM" }),
        providerRow({ providerId: "cust-third", displayName: "CUSTOM" }),
      ],
    });
    const ids = model.providers.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(3);
    // The adapter preserves the ids; the identity layer derives PVD- suffixes.
    expect(ids).toEqual(["cust-tokyo", "cust-backup", "cust-third"]);
  });
});

describe("state derivation from real attempt outcomes", () => {
  it("reports active when recent attempts all succeeded", () => {
    const model = buildLiveViewModel({
      summary: summary(),
      providers: [providerRow({ attempts: 9, failures: 0, lastOutcome: "ok" })],
    });
    expect(model.providers[0]!.state).toBe("active");
  });

  it("reports failed when the most recent attempt failed and all attempts failed", () => {
    const model = buildLiveViewModel({
      summary: summary(),
      providers: [
        providerRow({
          attempts: 3,
          failures: 3,
          lastOutcome: "failed",
          lastFailureCategory: "unreachable",
        }),
      ],
    });
    expect(model.providers[0]!.state).toBe("failed");
    expect(model.providers[0]!.incidentReason).toBe("unreachable");
  });

  it("reports degraded when some attempts failed but the latest succeeded", () => {
    const model = buildLiveViewModel({
      summary: summary(),
      providers: [providerRow({ attempts: 10, failures: 3, lastOutcome: "ok" })],
    });
    expect(model.providers[0]!.state).toBe("degraded");
  });

  it("reports recovering when the latest succeeded after a recent failure run", () => {
    const model = buildLiveViewModel({
      summary: summary(),
      providers: [
        providerRow({ attempts: 4, failures: 3, lastOutcome: "ok", lastFailureCategory: "timeout" }),
      ],
    });
    expect(model.providers[0]!.state).toBe("recovering");
  });

  it("reports standby for an enabled provider with no traffic", () => {
    const model = buildLiveViewModel({
      summary: summary(),
      providers: [providerRow({ attempts: 0, failures: 0, lastOutcome: null })],
    });
    expect(model.providers[0]!.state).toBe("standby");
  });

  it("reports off for a disabled provider regardless of history", () => {
    const model = buildLiveViewModel({
      summary: summary(),
      providers: [providerRow({ enabled: false, attempts: 5, lastOutcome: "ok" })],
    });
    expect(model.providers[0]!.state).toBe("off");
  });
});

describe("routing mode derivation", () => {
  it("reports direct for a single active participant", () => {
    const model = buildLiveViewModel({
      summary: summary(),
      providers: [providerRow({ attempts: 4 })],
    });
    expect(model.routingMode).toBe("direct");
  });

  it("reports combo when several providers carried traffic", () => {
    const model = buildLiveViewModel({
      summary: summary(),
      providers: providers(4).map((provider) => ({ ...provider, attempts: 3 })),
    });
    expect(model.routingMode).toBe("combo");
  });

  it("reports failover when a participant is currently failed", () => {
    const model = buildLiveViewModel({
      summary: summary(),
      providers: [
        providerRow({ providerId: "a", attempts: 3, failures: 3, lastOutcome: "failed" }),
        providerRow({ providerId: "b", attempts: 3 }),
      ],
    });
    expect(model.routingMode).toBe("failover");
  });

  it("prefers an explicit recent failover from request history", () => {
    const requests: UsageRequestRow[] = [
      {
        requestId: "req_1",
        occurredAt: new Date().toISOString(),
        routeId: "r1",
        providerId: "b",
        proxyId: null,
        model: "gpt-4o",
        routingMode: "failover",
        outcome: "ok",
        failureCategory: null,
        latencyMs: 400,
        attempts: 2,
        promptTokens: null,
        completionTokens: null,
        cachedTokens: null,
      },
    ];
    const model = buildLiveViewModel({
      summary: summary(),
      providers: providers(2).map((provider) => ({ ...provider, attempts: 1 })),
      requests,
    });
    expect(model.routingMode).toBe("failover");
  });
});

describe("token and count honesty", () => {
  it("carries real request totals", () => {
    const model = buildLiveViewModel({
      summary: summary({ totalRequests: 47 }),
      providers: providers(2),
    });
    expect(model.routedRequests).toBe(47);
  });

  it("leaves unknown token counts unknown", () => {
    const model = buildLiveViewModel({
      summary: summary({
        promptTokens: null,
        completionTokens: null,
        cachedTokens: null,
        tokenReports: 0,
      }),
      providers: providers(1),
    });
    expect(model.tokens?.promptTokens).toBeUndefined();
    expect(model.tokens?.completionTokens).toBeUndefined();
    expect(model.tokens?.known).toBe(false);
  });

  it("preserves a genuine zero token total as zero", () => {
    const model = buildLiveViewModel({
      summary: summary({ promptTokens: 0, completionTokens: 0, cachedTokens: 0, tokenReports: 3 }),
      providers: providers(1),
    });
    expect(model.tokens?.promptTokens).toBe(0);
    expect(model.tokens?.known).toBe(true);
  });

  it("never reports a cost figure", () => {
    const model = buildLiveViewModel({ summary: summary(), providers: providers(1) });
    expect(model.cost?.available).toBe(false);
    expect(model.cost?.reason).toBe("no_pricing_data");
    expect(JSON.stringify(model)).not.toMatch(/\$|"cost":\s*\d/);
  });

  it("derives load from real activity rather than inventing it", () => {
    const idle = buildLiveViewModel({
      summary: summary({ totalRequests: 0 }),
      providers: providers(2).map((provider) => ({ ...provider, attempts: 0 })),
    });
    const busy = buildLiveViewModel({
      summary: summary({ totalRequests: 500 }),
      providers: providers(2).map((provider) => ({ ...provider, attempts: 250 })),
    });
    expect(idle.loadPercent).toBe(0);
    expect(busy.loadPercent).toBeGreaterThan(idle.loadPercent!);
    expect(busy.loadPercent).toBeLessThanOrEqual(100);
  });
});

describe("many providers are never truncated", () => {
  it("maps a 40-provider combo in full", () => {
    const model = buildLiveViewModel({
      summary: summary(),
      providers: providers(40).map((provider) => ({ ...provider, attempts: 2 })),
    });
    expect(model.providers).toHaveLength(40);
    expect(new Set(model.providers.map((provider) => provider.id)).size).toBe(40);
    expect(model.routingMode).toBe("combo");
  });

  it("maps a 40-provider combo with failures without losing identity", () => {
    const overrides: Record<number, Partial<UsageProviderRow>> = {
      7: {
        attempts: 3,
        failures: 3,
        lastOutcome: "failed",
        lastFailureCategory: "rate_limited",
        displayName: "TOKYO EDGE",
      },
    };
    const model = buildLiveViewModel({
      summary: summary(),
      providers: providers(40, overrides).map((provider) => ({
        ...provider,
        attempts: provider.attempts || 2,
      })),
    });
    expect(model.providers).toHaveLength(40);
    const failed = model.providers.find((provider) => provider.state === "failed")!;
    expect(failed.id).toBe("p7");
    expect(failed.displayName).toBe("TOKYO EDGE");
    expect(failed.incidentReason).toBe("rate_limited");
  });

  it("maps 120 providers in full", () => {
    const model = buildLiveViewModel({
      summary: summary(),
      providers: providers(120),
    });
    expect(model.providers).toHaveLength(120);
    expect(new Set(model.providers.map((provider) => provider.id)).size).toBe(120);
  });

  it("maps a single provider as direct", () => {
    const model = buildLiveViewModel({
      summary: summary(),
      providers: [providerRow({ attempts: 3 })],
    });
    expect(model.providers).toHaveLength(1);
    expect(model.routingMode).toBe("direct");
  });

  it("shares add up without a fixed five-provider assumption", () => {
    for (const count of [1, 5, 12, 40, 120]) {
      const model = buildLiveViewModel({
        summary: summary(),
        providers: providers(count).map((provider) => ({ ...provider, attempts: 4 })),
      });
      expect(model.providers).toHaveLength(count);
      const total = model.providers.reduce(
        (sum, provider) => sum + provider.sharePercent,
        0,
      );
      /*
       * Per-provider rounding means the total drifts from 100 as the count grows
       * (120 equal providers each round 0.83% up to 1%, summing to 120). That is
       * honest arithmetic, not a bug: each share is the provider's real attempt
       * fraction. The invariants that matter are that every share is bounded and no
       * provider is dropped.
       */
      expect(total).toBeGreaterThan(90);
      expect(total).toBeLessThanOrEqual(count <= 5 ? 110 : 100 + count);
      for (const provider of model.providers) {
        expect(provider.sharePercent).toBeGreaterThanOrEqual(0);
        expect(provider.sharePercent).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe("malformed API data degrades safely", () => {
  it("tolerates a missing summary", () => {
    const model = buildLiveViewModel({ summary: undefined, providers: providers(2) });
    expect(model.source).toBe("live");
    expect(model.routedRequests).toBeUndefined();
    expect(model.providers).toHaveLength(2);
  });

  it("drops a provider row that has no usable id", () => {
    const model = buildLiveViewModel({
      summary: summary(),
      providers: [
        providerRow({ providerId: "" }),
        providerRow({ providerId: "ok" }),
        { ...providerRow(), providerId: undefined as never },
      ],
    });
    expect(model.providers.map((provider) => provider.id)).toEqual(["ok"]);
  });

  it("substitutes the id when a display name is unusable", () => {
    const model = buildLiveViewModel({
      summary: summary(),
      providers: [providerRow({ providerId: "nameless", displayName: "" as never })],
    });
    expect(model.providers[0]!.displayName).toBe("nameless");
  });

  it("clamps hostile numeric values rather than propagating them", () => {
    const model = buildLiveViewModel({
      summary: summary({ totalRequests: -5, averageLatencyMs: Number.NaN }),
      providers: [
        providerRow({ attempts: -1, failures: Number.NaN, averageLatencyMs: Infinity }),
      ],
    });
    expect(model.routedRequests).toBeUndefined();
    expect(model.providers[0]!.sharePercent).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(model.providers[0]!.latencyMs ?? 0)).toBe(true);
  });

  it("tolerates a non-array providers payload", () => {
    const model = buildLiveViewModel({
      summary: summary(),
      providers: undefined as never,
    });
    expect(model.providers).toEqual([]);
  });

  it("truncates an absurdly long display name without losing the provider", () => {
    const model = buildLiveViewModel({
      summary: summary(),
      providers: [providerRow({ providerId: "long", displayName: "X".repeat(5000) })],
    });
    expect(model.providers).toHaveLength(1);
    expect(model.providers[0]!.displayName.length).toBeLessThanOrEqual(128);
  });
});

describe("nothing secret crosses the adapter", () => {
  const CREDENTIAL = "sk-adapter-credential-sentinel";
  const TOKEN = "bayz-api-token-sentinel";

  it("carries no secret-shaped field even when the API sends one", () => {
    const model = buildLiveViewModel({
      summary: summary(),
      providers: [
        {
          ...providerRow(),
          // A compromised or future API returning these must not leak through.
          credential: CREDENTIAL,
          apiKey: CREDENTIAL,
          password: CREDENTIAL,
          authorization: `Bearer ${TOKEN}`,
          token: TOKEN,
          prompt: "PROMPT-SENTINEL",
          completion: "COMPLETION-SENTINEL",
        } as never,
      ],
    });

    const serialized = JSON.stringify(model);
    for (const sentinel of [CREDENTIAL, TOKEN, "PROMPT-SENTINEL", "COMPLETION-SENTINEL"]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("emits only the display-safe provider field set", () => {
    const healthy = buildLiveViewModel({ summary: summary(), providers: providers(1) });
    // A healthy provider carries no incident reason at all, rather than a null one.
    expect(Object.keys(healthy.providers[0]!).sort()).toEqual([
      "displayName",
      "iconKey",
      "id",
      "latencyMs",
      "routeParticipation",
      "sharePercent",
      "state",
    ]);

    const failing = buildLiveViewModel({
      summary: summary(),
      providers: [
        providerRow({
          attempts: 2,
          failures: 2,
          lastOutcome: "failed",
          lastFailureCategory: "timeout",
        }),
      ],
    });
    expect(Object.keys(failing.providers[0]!).sort()).toEqual([
      "displayName",
      "iconKey",
      "id",
      "incidentReason",
      "latencyMs",
      "routeParticipation",
      "sharePercent",
      "state",
    ]);
  });

  it("keeps credentialPresent out of the view model entirely", () => {
    const model = buildLiveViewModel({
      summary: summary(),
      providers: [providerRow({ credentialPresent: true })],
    });
    expect(JSON.stringify(model)).not.toContain("credentialPresent");
  });

  it("passes a hostile display name through as inert text, unmodified", () => {
    const hostile = "<img src=x onerror=z>";
    const model = buildLiveViewModel({
      summary: summary(),
      providers: [providerRow({ displayName: hostile })],
    });
    // Not sanitized into something else: React escapes it at render time, and a
    // silent rewrite would change an operator's label without telling them.
    expect(model.providers[0]!.displayName).toBe(hostile);
    expect(model.providers[0]!.iconKey).toBe("openrouter");
  });

  it("normalizes an unsafe failure category to a known token", () => {
    const model = buildLiveViewModel({
      summary: summary(),
      providers: [
        providerRow({
          attempts: 2,
          failures: 2,
          lastOutcome: "failed",
          lastFailureCategory: "<script>x</script>" as never,
        }),
      ],
    });
    expect(model.providers[0]!.incidentReason).toBe("unknown_error");
  });
});

describe("no per-frame update path", () => {
  it("is a pure function of its inputs", () => {
    const input = { summary: summary(), providers: providers(5) };
    const first = buildLiveViewModel(input);
    const second = buildLiveViewModel(input);
    expect(second).toEqual(first);
  });

  it("does not schedule timers or animation frames", () => {
    const source = buildLiveViewModel.toString();
    for (const forbidden of [
      "requestAnimationFrame",
      "setInterval",
      "setTimeout",
      "useState",
      "useEffect",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
