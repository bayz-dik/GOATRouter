import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FluxCore } from "../src/flux/FluxCore";
import type { FluxCoreViewModel, FluxProvider, FluxProviderState } from "../src/flux/types";

/**
 * Dense-provider integration tests.
 *
 * These exercise the real integrated component, not helper functions in isolation:
 * the stated requirement is that a 40-provider Combo works in the actual UI.
 */

let rafSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // This file calls `vi.unstubAllGlobals()` between tests, which also clears the
  // shared setup stub, so ResizeObserver is re-installed here explicitly.
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
  rafSpy = vi
    .spyOn(globalThis, "requestAnimationFrame")
    .mockImplementation(() => 1 as never);
});

afterEach(() => {
  rafSpy.mockRestore();
  vi.unstubAllGlobals();
});

function providers(
  n: number,
  overrides: Record<number, Partial<FluxProvider>> = {},
): FluxProvider[] {
  return Array.from({ length: n }, (_unused, index) => ({
    id: `prov-${index}`,
    displayName: `PROVIDER ${index}`,
    state: "active" as FluxProviderState,
    sharePercent: 100 / n,
    ...(overrides[index] ?? {}),
  }));
}

function model(list: FluxProvider[], extra: Partial<FluxCoreViewModel> = {}): FluxCoreViewModel {
  return { source: "live", providers: list, routedRequests: 4210, ...extra };
}

function nodeCount(container: HTMLElement): number {
  return container.querySelectorAll(".provider").length;
}

function labelCount(container: HTMLElement): number {
  return container.querySelectorAll(".provider .provider-label").length;
}

describe("1 provider DIRECT", () => {
  it("renders one node and reports a direct route", () => {
    const { container } = render(<FluxCore model={model(providers(1))} />);
    expect(nodeCount(container)).toBe(1);
    // Sentence case since the copy pass; `DIRECT ROUTE` is banned by the copy contract.
    expect(screen.getByText("Direct")).toBeInTheDocument();
  });
});

describe("5 provider COMBO", () => {
  it("keeps the approved position classes and full chip detail", () => {
    const { container } = render(<FluxCore model={model(providers(5))} />);
    expect(nodeCount(container)).toBe(5);
    for (const cls of ["p1", "p2", "p3", "p4", "p5"]) {
      expect(container.querySelector(`.provider.${cls}`)).not.toBeNull();
    }
    // Every provider labelled at the approved count: no reduction.
    expect(labelCount(container)).toBe(5);
    expect(screen.getByText("Combo")).toBeInTheDocument();
  });
});

describe("12 provider COMBO", () => {
  it("renders every node and reduces labels rather than nodes", () => {
    const { container } = render(<FluxCore model={model(providers(12))} />);
    expect(nodeCount(container)).toBe(12);
    expect(labelCount(container)).toBeLessThan(12);
    expect(labelCount(container)).toBeGreaterThan(0);
    // The approved five-position classes no longer apply past the baseline.
    expect(container.querySelector(".provider.p1")).toBeNull();
  });
});

describe("40 provider COMBO", () => {
  it("renders all forty nodes without truncation", () => {
    const { container } = render(<FluxCore model={model(providers(40))} />);
    expect(nodeCount(container)).toBe(40);
    /*
     * The count is asserted on the core caption now. The old assertion read `/40 NODES/`
     * from the panel meta line, which the copy pass removed — `NODES` was jargon for
     * providers, and the line also carried stale branding and a fake liveness badge. The
     * caption states the same fact as `40 of 40 routing`, so the property survives its
     * wording.
     */
    expect(screen.getByText(/40 of 40 routing/)).toBeInTheDocument();
  });

  it("keeps every provider individually addressable", () => {
    const { container } = render(<FluxCore model={model(providers(40))} />);
    const ids = Array.from(container.querySelectorAll(".provider")).map((el) =>
      el.getAttribute("data-provider-id"),
    );
    expect(new Set(ids).size).toBe(40);
    for (let index = 0; index < 40; index += 1) {
      expect(ids).toContain(`prov-${index}`);
    }
  });

  it("gives every node an accessible name even when its label is hidden", () => {
    const { container } = render(<FluxCore model={model(providers(40))} />);
    for (const el of Array.from(container.querySelectorAll(".provider"))) {
      expect(el.getAttribute("aria-label")).toBeTruthy();
    }
  });

  it("does not draw forty permanent labels", () => {
    const { container } = render(<FluxCore model={model(providers(40))} />);
    expect(labelCount(container)).toBeLessThanOrEqual(10);
  });

  it("still reports combo routing", () => {
    render(<FluxCore model={model(providers(40))} />);
    expect(screen.getByText("Combo")).toBeInTheDocument();
  });
});

describe("40 provider COMBO with 1 FAILED", () => {
  const list = providers(40, { 17: { state: "failed", displayName: "TOKYO EDGE" } });

  it("keeps the failed provider as its own identifiable node", () => {
    const { container } = render(<FluxCore model={model(list)} />);
    expect(nodeCount(container)).toBe(40);
    const failed = container.querySelector('.provider[data-state="failed"]');
    expect(failed).not.toBeNull();
    expect(failed!.getAttribute("data-provider-id")).toBe("prov-17");
  });

  it("gives the failed provider label priority", () => {
    render(<FluxCore model={model(list)} />);
    // Its label wins a slot despite thirty-nine healthy competitors.
    expect(screen.getByText("TOKYO EDGE")).toBeInTheDocument();
  });

  it("reports 39 active and shows failover state", () => {
    render(<FluxCore model={model(list)} />);
    // Same two facts as before, in the caption's post-cleanup wording.
    expect(screen.getByText(/39 of 40 routing \/ 4210 requests/)).toBeInTheDocument();
    expect(screen.getByText("Failover")).toBeInTheDocument();
  });

  it("keeps the failed provider clickable for focus", () => {
    const { container } = render(<FluxCore model={model(list)} />);
    const failed = container.querySelector('.provider[data-state="failed"]');
    expect(() => fireEvent.click(failed!)).not.toThrow();
  });
});

describe("40 provider COMBO with multiple failures", () => {
  const overrides: Record<number, Partial<FluxProvider>> = {};
  for (let index = 0; index < 14; index += 1) {
    overrides[index] = { state: "failed", displayName: `FAILED SITE ${index}` };
  }
  const list = providers(40, overrides);

  it("keeps every failed node represented", () => {
    const { container } = render(<FluxCore model={model(list)} />);
    expect(nodeCount(container)).toBe(40);
    expect(container.querySelectorAll('.provider[data-state="failed"]')).toHaveLength(14);
  });

  it("surfaces unlabelled failures as named incidents, not a +N blob", () => {
    const { container } = render(<FluxCore model={model(list)} />);
    const incidents = container.querySelectorAll(".incident-row");
    expect(incidents.length).toBeGreaterThan(0);
    // No aggregate abstraction anywhere in the panel.
    expect(container.textContent).not.toMatch(/\+\d+\s*providers?/i);
    for (const row of Array.from(incidents)) {
      expect(row.textContent).toMatch(/FAILED SITE \d+/);
    }
  });

  it("focuses a provider when its incident row is selected", () => {
    const { container } = render(<FluxCore model={model(list)} />);
    const row = container.querySelector(".incident-row");
    expect(row).not.toBeNull();
    fireEvent.click(row!);
    // Focusing selects the node, which is how identity is recovered.
    return waitFor(() =>
      expect(container.querySelector(".provider.selected")).not.toBeNull(),
    );
  });

  it("labels plus incidents together account for every failure", () => {
    const { container } = render(<FluxCore model={model(list)} />);
    const labelledText = Array.from(container.querySelectorAll(".provider-label"))
      .map((el) => el.textContent ?? "")
      .join(" ");
    const incidentText = Array.from(container.querySelectorAll(".incident-row"))
      .map((el) => el.textContent ?? "")
      .join(" ");
    const combined = `${labelledText} ${incidentText}`;
    for (let index = 0; index < 14; index += 1) {
      expect(combined).toContain(`FAILED SITE ${index}`);
    }
  });
});

describe("custom providers with duplicate names", () => {
  const list: FluxProvider[] = [
    { id: "cust-tokyo", displayName: "CUSTOM", state: "active", sharePercent: 25 },
    { id: "cust-backup", displayName: "CUSTOM", state: "active", sharePercent: 25 },
    { id: "cust-third", displayName: "CUSTOM", state: "failed", sharePercent: 25 },
    { id: "gem", displayName: "GEMINI", state: "active", sharePercent: 25 },
  ];

  it("distinguishes them with a safe short identifier", () => {
    const { container } = render(<FluxCore model={model(list)} />);
    const names = Array.from(container.querySelectorAll(".provider")).map((el) =>
      el.getAttribute("aria-label"),
    );
    const customs = names.filter((name) => name?.startsWith("CUSTOM"));
    expect(customs).toHaveLength(3);
    expect(new Set(customs).size).toBe(3);
    for (const name of customs) {
      // The accessible name is identity first, then state and participation.
      expect(name).toMatch(/^CUSTOM — PVD-[0-9A-F]{4} — /);
    }
  });

  it("leaves an unambiguous name unsuffixed", () => {
    const { container } = render(<FluxCore model={model(list)} />);
    const names = Array.from(container.querySelectorAll(".provider")).map((el) =>
      el.getAttribute("aria-label"),
    );
    expect(names.some((name) => name?.startsWith("GEMINI — "))).toBe(true);
    // Unambiguous names carry no PVD suffix.
    expect(names.some((name) => name?.startsWith("GEMINI — PVD-"))).toBe(false);
  });
});

describe("zoom and pan in the integrated component", () => {
  it("changes label detail as zoom changes", () => {
    const { container } = render(<FluxCore model={model(providers(40))} />);
    const far = labelCount(container);

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));

    expect(labelCount(container)).toBeGreaterThan(far);
    // Nodes are untouched by zoom.
    expect(nodeCount(container)).toBe(40);
  });

  it("clamps zoom so the controls disable at the bounds", () => {
    render(<FluxCore model={model(providers(12))} />);
    for (let step = 0; step < 12; step += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    }
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeDisabled();

    for (let step = 0; step < 20; step += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    }
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeDisabled();
  });

  it("reset restores the default viewport", () => {
    const { container } = render(<FluxCore model={model(providers(12))} />);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: /reset view/i }));
    const field = container.querySelector(".flux-field") as HTMLElement;
    expect(field.style.transform).toContain("scale(1)");
    expect(field.style.transform).toContain("translate(0px, 0px)");
  });

  it("keeps the field transform finite after aggressive interaction", () => {
    const { container } = render(<FluxCore model={model(providers(12))} />);
    for (let step = 0; step < 30; step += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    }
    const field = container.querySelector(".flux-field") as HTMLElement;
    expect(field.style.transform).not.toContain("NaN");
    expect(field.style.transform).not.toContain("Infinity");
  });

  it("removes its pointer and wheel listeners on unmount", () => {
    const { container, unmount } = render(<FluxCore model={model(providers(6))} />);
    const wrap = container.querySelector(".relay-wrap") as HTMLElement;
    const remove = vi.spyOn(wrap, "removeEventListener");
    unmount();
    const types = remove.mock.calls.map(([type]) => type);
    for (const type of ["wheel", "pointerdown", "pointermove", "pointerup", "pointercancel"]) {
      expect(types).toContain(type);
    }
    remove.mockRestore();
  });
});

describe("selection", () => {
  it("keeps the selected provider labelled in a dense field", () => {
    const { container } = render(<FluxCore model={model(providers(40))} />);
    const target = container.querySelector('[data-provider-id="prov-33"]') as HTMLElement;
    expect(target.querySelector(".provider-label")).toBeNull();

    fireEvent.click(target);
    return waitFor(() => {
      const again = container.querySelector('[data-provider-id="prov-33"]') as HTMLElement;
      expect(again.classList.contains("selected")).toBe(true);
      expect(again.querySelector(".provider-label")).not.toBeNull();
    });
  });
});

describe("hostile labels in a dense field", () => {
  it("renders forty hostile names as inert text", () => {
    const list = providers(40).map((provider, index) => ({
      ...provider,
      displayName: `<img src=x onerror=z> ${index}`,
    }));
    const { container } = render(<FluxCore model={model(list)} />);
    expect(nodeCount(container)).toBe(40);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect((window as unknown as Record<string, unknown>).__denseXss).toBeUndefined();
  });

  it("never renders a provider-supplied icon as markup", () => {
    const list = providers(3).map((provider) => ({
      ...provider,
      iconKey: '<svg onload="window.__iconXss = true"></svg>',
    }));
    const { container } = render(<FluxCore model={model(list)} />);
    // Only local marks are drawn; each is a single inline svg from our own table.
    expect(container.querySelectorAll(".provider svg")).toHaveLength(3);
    expect((window as unknown as Record<string, unknown>).__iconXss).toBeUndefined();
  });
});

describe("live model boundary", () => {
  it("disables the simulation-only controls when live data drives the view", () => {
    render(<FluxCore model={model(providers(8))} />);
    expect(screen.getByRole("button", { name: /failover drill/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: "1" })).toBeDisabled();
    // Zoom and reset stay usable: they are view controls, not routing controls.
    expect(screen.getByRole("button", { name: /reset view/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Calm" })).toBeEnabled();
  });

  it("labels a live source as live and a simulated one as simulated", () => {
    /*
     * Sentence case, and spelled out. `LIVE` / `SIM` were the shouted forms the copy pass
     * removed; what matters — and what this asserts — is that the two states are still
     * distinguishable on screen and never blended.
     *
     * Read from the panel head's own meta line: the activity subhead says
     * `Router events` / `Simulated events` as well, so a document-wide text query matches
     * twice and cannot say which element is the source badge.
     */
    const source = (root: HTMLElement): string | undefined =>
      root.querySelector(".panel-head .panel-meta")?.textContent ?? undefined;

    const live = render(<FluxCore model={model(providers(4))} />);
    expect(source(live.container)).toBe("Live");
    live.unmount();

    const simulated = render(<FluxCore />);
    expect(source(simulated.container)).toBe("Simulated");
  });
});
