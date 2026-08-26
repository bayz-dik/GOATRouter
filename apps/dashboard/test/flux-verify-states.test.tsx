import { render, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FluxCore } from "../src/flux/FluxCore";
import { buildConstellation, ingressGroups } from "../src/flux/constellation";
import { resolveLabels } from "../src/flux/lod";
import type { FluxCoreViewModel, FluxProvider, FluxProviderState } from "../src/flux/types";

/**
 * Dense-state verification report.
 *
 * This is the automated half of the required manual sweep. It renders every listed
 * state in the integrated component and prints a table of what was actually
 * measured, so the claims in the handoff are reproducible rather than asserted.
 *
 * jsdom performs no layout, so real pixel overlap cannot be measured here. What
 * *is* measured is label density against the collision budget, which is the
 * mechanism that prevents overlap. The remaining visual confirmation needs a
 * browser and is recorded as a residual limitation.
 */

const rows: string[] = [];

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
  cleanup();
  vi.restoreAllMocks();
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

function model(list: FluxProvider[]): FluxCoreViewModel {
  return { source: "live", providers: list, routedRequests: 4210 };
}

function measure(label: string, list: FluxProvider[]): void {
  const { container } = render(<FluxCore model={model(list)} />);
  const nodes = container.querySelectorAll(".provider").length;
  const labels = container.querySelectorAll(".provider .provider-label").length;
  const incidents = container.querySelectorAll(".incident-row").length;
  const failed = container.querySelectorAll('.provider[data-state="failed"]').length;
  const marks = container.querySelectorAll(".provider .provider-mark").length;

  // Every provider is a node, every node carries a mark, and labels stay within
  // the collision budget for the current detail band.
  expect(nodes).toBe(list.length);
  expect(marks).toBe(list.length);
  const resolved = resolveLabels(buildConstellation(list), {
    zoom: 1,
    selectedId: undefined,
  });
  expect(labels).toBeLessThanOrEqual(resolved.labelBudget);
  // Failures are always accounted for: labelled in place or listed as incidents.
  const labelledText = Array.from(container.querySelectorAll(".provider-label"))
    .map((el) => el.textContent ?? "")
    .join(" ");
  const incidentText = Array.from(container.querySelectorAll(".incident-row"))
    .map((el) => el.textContent ?? "")
    .join(" ");
  for (const provider of list.filter((candidate) => candidate.state === "failed")) {
    expect(`${labelledText} ${incidentText}`).toContain(provider.displayName);
  }

  const trunks = ingressGroups(buildConstellation(list)).length;
  rows.push(
    `${label.padEnd(34)} nodes=${String(nodes).padStart(3)} labels=${String(labels).padStart(3)}` +
      ` budget=${String(resolved.labelBudget).padStart(3)} trunks=${String(trunks).padStart(3)}` +
      ` failed=${String(failed).padStart(3)} incidents=${String(incidents).padStart(3)}`,
  );
  cleanup();
}

describe("dense-state verification sweep", () => {
  it("measures every required provider state", () => {
    measure("1 provider DIRECT", providers(1));
    measure("5 provider COMBO", providers(5));
    measure("12 provider COMBO", providers(12));
    measure("40 provider COMBO", providers(40));
    measure(
      "40 COMBO / 1 FAILED",
      providers(40, { 17: { state: "failed", displayName: "TOKYO EDGE" } }),
    );

    const multi: Record<number, Partial<FluxProvider>> = {};
    for (let index = 0; index < 14; index += 1) {
      multi[index] = { state: "failed", displayName: `FAILED SITE ${index}` };
    }
    measure("40 COMBO / 14 FAILED", providers(40, multi));

    measure("120 provider COMBO", providers(120));

    measure("duplicate custom names", [
      { id: "c1", displayName: "CUSTOM", state: "active", sharePercent: 25 },
      { id: "c2", displayName: "CUSTOM", state: "active", sharePercent: 25 },
      { id: "c3", displayName: "CUSTOM", state: "failed", sharePercent: 25 },
      { id: "g1", displayName: "GEMINI", state: "active", sharePercent: 25 },
    ]);

    measure(
      "mixed states",
      providers(20, {
        0: { state: "failed" },
        1: { state: "degraded" },
        2: { state: "recovering" },
        3: { state: "standby" },
        4: { state: "off" },
      }),
    );

    // Printed so the numbers in the handoff are reproducible on demand.
    console.info(`\nDense-state verification\n${rows.join("\n")}\n`);
    expect(rows).toHaveLength(9);
  });

  it("keeps label count within budget at every zoom band for 40 providers", () => {
    const nodes = buildConstellation(providers(40));
    for (const zoom of [0.45, 0.8, 1, 1.5, 2.5, 4]) {
      const resolved = resolveLabels(nodes, { zoom, selectedId: undefined });
      expect(resolved.labelled.length).toBeLessThanOrEqual(resolved.labelBudget);
      expect(resolved.nodes).toHaveLength(40);
    }
  });

  it("scales trunk count sublinearly with provider count", () => {
    const counts = [5, 12, 40, 120].map(
      (n) => ingressGroups(buildConstellation(providers(n))).length,
    );
    // Bundling is what keeps forty providers from becoming forty cables.
    expect(counts[0]).toBe(5);
    expect(counts[2]).toBeLessThan(40);
    expect(counts[3]).toBeLessThanOrEqual(counts[2]! + 1);
  });

  it("renders a 120-provider field without exceeding a sane node budget", () => {
    const { container } = render(<FluxCore model={model(providers(120))} />);
    // Every provider is one button; no full-detail card is created for hidden ones.
    expect(container.querySelectorAll(".provider")).toHaveLength(120);
    expect(container.querySelectorAll(".provider .provider-label").length).toBeLessThanOrEqual(
      10,
    );
  });
});
