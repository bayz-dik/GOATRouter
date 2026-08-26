import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FluxCore } from "../src/flux/FluxCore";
import type { FluxCoreViewModel, FluxProvider } from "../src/flux/types";

/**
 * Requirement-completeness tests.
 *
 * The display-safe boundary declares `routeParticipation`, `latencyMs`,
 * `incidentReason`, and `period`. Declaring a field without consuming it is a
 * hollow boundary, so these tests pin that each one actually reaches the screen,
 * and that the Direct / Combo / Failover / Standby / Disabled prominence rules the
 * requirement describes are observable in the DOM.
 */

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
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(() => 1 as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function model(providers: FluxProvider[], extra: Partial<FluxCoreViewModel> = {}): FluxCoreViewModel {
  return { source: "live", providers, routedRequests: 512, ...extra };
}

describe("route participation is rendered", () => {
  const providers: FluxProvider[] = [
    {
      id: "primary",
      displayName: "PRIMARY",
      state: "active",
      sharePercent: 60,
      routeParticipation: "primary",
    },
    {
      id: "combo",
      displayName: "COMBO NODE",
      state: "active",
      sharePercent: 30,
      routeParticipation: "combo",
    },
    {
      id: "reserve",
      displayName: "RESERVE NODE",
      state: "standby",
      sharePercent: 10,
      routeParticipation: "reserve",
    },
    {
      id: "idle",
      displayName: "IDLE NODE",
      state: "off",
      sharePercent: 0,
      routeParticipation: "none",
    },
  ];

  it("marks each node with its route participation", () => {
    const { container } = render(<FluxCore model={model(providers)} />);
    expect(
      container.querySelector('[data-provider-id="primary"]')?.getAttribute("data-route"),
    ).toBe("primary");
    expect(
      container.querySelector('[data-provider-id="combo"]')?.getAttribute("data-route"),
    ).toBe("combo");
    expect(
      container.querySelector('[data-provider-id="reserve"]')?.getAttribute("data-route"),
    ).toBe("reserve");
    expect(
      container.querySelector('[data-provider-id="idle"]')?.getAttribute("data-route"),
    ).toBe("none");
  });

  it("gives a primary route strong prominence over a reserve", () => {
    const { container } = render(<FluxCore model={model(providers)} />);
    const primary = container.querySelector('[data-provider-id="primary"]')!;
    const reserve = container.querySelector('[data-provider-id="reserve"]')!;
    // Prominence is expressed as a class the stylesheet acts on, so the DOM shows
    // the intent rather than a computed style jsdom cannot resolve.
    expect(primary.className).toContain("route-primary");
    expect(reserve.className).toContain("route-reserve");
  });

  it("includes participation in the accessible name", () => {
    const { container } = render(<FluxCore model={model(providers)} />);
    expect(
      container.querySelector('[data-provider-id="reserve"]')?.getAttribute("aria-label"),
    ).toMatch(/reserve/i);
  });
});

describe("latency is rendered when available", () => {
  it("shows latency on a labelled node", () => {
    render(
      <FluxCore
        model={model([
          { id: "a", displayName: "ALPHA", state: "active", sharePercent: 100, latencyMs: 143 },
        ])}
      />,
    );
    expect(screen.getByText(/143\s*ms/)).toBeInTheDocument();
  });

  it("omits latency rather than showing a placeholder when absent", () => {
    const { container } = render(
      <FluxCore
        model={model([{ id: "a", displayName: "ALPHA", state: "active", sharePercent: 100 }])}
      />,
    );
    expect(container.textContent).not.toMatch(/\bms\b/);
  });

  it("ignores a hostile latency value rather than rendering it", () => {
    const { container } = render(
      <FluxCore
        model={model([
          {
            id: "a",
            displayName: "ALPHA",
            state: "active",
            sharePercent: 100,
            latencyMs: Number.NaN,
          },
        ])}
      />,
    );
    expect(container.textContent).not.toContain("NaN");
  });
});

describe("incident reason is displayed safely", () => {
  const failing: FluxProvider[] = [
    {
      id: "down",
      displayName: "TOKYO EDGE",
      state: "failed",
      sharePercent: 0,
      incidentReason: "upstream_error: the upstream provider returned an unusable response",
    },
    { id: "up", displayName: "OSAKA", state: "active", sharePercent: 100 },
  ];

  it("shows the reason in the incident detail", () => {
    render(<FluxCore model={model(failing)} />);
    expect(screen.getByText(/upstream_error/)).toBeInTheDocument();
  });

  it("renders a hostile reason as inert text", () => {
    const hostile: FluxProvider[] = [
      {
        id: "down",
        displayName: "TOKYO EDGE",
        state: "failed",
        sharePercent: 0,
        incidentReason: "<img src=x onerror=z>",
      },
      { id: "up", displayName: "OSAKA", state: "active", sharePercent: 100 },
    ];
    const { container } = render(<FluxCore model={model(hostile)} />);
    expect(screen.getByText("<img src=x onerror=z>")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("shows no incident detail when nothing has failed", () => {
    const { container } = render(
      <FluxCore
        model={model([{ id: "up", displayName: "OSAKA", state: "active", sharePercent: 100 }])}
      />,
    );
    expect(container.querySelector(".incident-detail")).toBeNull();
  });
});

describe("selected period is displayed", () => {
  it("shows the period supplied by the model", () => {
    render(
      <FluxCore
        model={model([{ id: "a", displayName: "ALPHA", state: "active", sharePercent: 100 }], {
          period: "7D",
        })}
      />,
    );
    expect(screen.getByText(/7D/)).toBeInTheDocument();
  });

  it("renders a hostile period label as inert text", () => {
    const { container } = render(
      <FluxCore
        model={model([{ id: "a", displayName: "ALPHA", state: "active", sharePercent: 100 }], {
          period: "<script>x</script>",
        })}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
  });
});

describe("routing mode prominence", () => {
  it("promotes the replacement provider during failover", () => {
    const providers: FluxProvider[] = [
      {
        id: "draining",
        displayName: "DRAINING",
        state: "degraded",
        sharePercent: 5,
        routeParticipation: "none",
      },
      {
        id: "promoted",
        displayName: "PROMOTED",
        state: "recovering",
        sharePercent: 95,
        routeParticipation: "primary",
      },
    ];
    const { container } = render(
      <FluxCore model={model(providers, { routingMode: "failover" })} />,
    );
    expect(screen.getByText("FAILOVER SEQUENCE")).toBeInTheDocument();
    expect(container.querySelector('[data-provider-id="promoted"]')?.className).toContain(
      "route-primary",
    );
    expect(container.querySelector('[data-provider-id="draining"]')?.className).toContain(
      "route-none",
    );
  });

  it("keeps a disabled node inspectable with no active traffic", () => {
    const { container } = render(
      <FluxCore
        model={model([
          { id: "off", displayName: "OFFLINE", state: "off", sharePercent: 0 },
          { id: "on", displayName: "ONLINE", state: "active", sharePercent: 100 },
        ])}
      />,
    );
    const disabled = container.querySelector('[data-provider-id="off"]')!;
    // Present, focusable, and clearly not carrying traffic.
    expect(disabled).not.toBeNull();
    expect(disabled.getAttribute("data-state")).toBe("off");
    expect((disabled as HTMLButtonElement).disabled).toBe(false);
    expect(disabled.getAttribute("aria-label")).toContain("OFFLINE");
  });
});
