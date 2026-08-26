import { describe, expect, it } from "vitest";
import { buildConstellation } from "../src/flux/constellation";
import {
  DETAIL_FAR,
  DETAIL_MEDIUM,
  DETAIL_NEAR,
  detailLevel,
  labelPriority,
  resolveLabels,
} from "../src/flux/lod";
import { clampViewport, createViewport, panBy, resetViewport, zoomAt } from "../src/flux/viewport";
import type { FluxProvider } from "../src/flux/types";

function providers(n: number, overrides: Partial<FluxProvider>[] = []): FluxProvider[] {
  return Array.from({ length: n }, (_unused, index) => ({
    id: `p${index}`,
    displayName: `PROVIDER ${index}`,
    state: "active" as const,
    sharePercent: 100 / n,
    ...(overrides[index] ?? {}),
  }));
}

describe("semantic zoom levels", () => {
  it("maps zoom to the three approved detail bands", () => {
    expect(detailLevel(0.5)).toBe(DETAIL_FAR);
    expect(detailLevel(0.9)).toBe(DETAIL_FAR);
    expect(detailLevel(1.4)).toBe(DETAIL_MEDIUM);
    expect(detailLevel(2.6)).toBe(DETAIL_NEAR);
  });

  it("hides most labels when far out but keeps every node", () => {
    const nodes = buildConstellation(providers(40));
    const far = resolveLabels(nodes, { zoom: 0.6, selectedId: undefined });
    const near = resolveLabels(nodes, { zoom: 3, selectedId: undefined });

    // Labels reduce; nodes never disappear.
    expect(far.nodes).toHaveLength(40);
    expect(near.nodes).toHaveLength(40);
    expect(far.labelled.length).toBeLessThan(near.labelled.length);
    expect(far.labelled.length).toBeLessThan(40);
  });

  it("shows compact identity far out and full identity near in", () => {
    const nodes = buildConstellation(providers(6));
    expect(resolveLabels(nodes, { zoom: 0.6, selectedId: undefined }).detail).toBe(DETAIL_FAR);
    const nearDetail = resolveLabels(nodes, { zoom: 3, selectedId: undefined });
    expect(nearDetail.detail).toBe(DETAIL_NEAR);
    expect(nearDetail.showState).toBe(true);
    expect(nearDetail.showShare).toBe(true);
  });

  it("never deletes a node merely because its label is hidden", () => {
    const nodes = buildConstellation(providers(40));
    const far = resolveLabels(nodes, { zoom: 0.4, selectedId: undefined });
    expect(new Set(far.nodes.map((node) => node.id)).size).toBe(40);
    for (const node of far.nodes) {
      expect(node.markVisible).toBe(true);
    }
  });
});

describe("label priority", () => {
  it("ranks selected above failed above degraded above active", () => {
    const selected = labelPriority({ state: "active", selected: true, share: 1 });
    const failed = labelPriority({ state: "failed", selected: false, share: 1 });
    const degraded = labelPriority({ state: "degraded", selected: false, share: 1 });
    const active = labelPriority({ state: "active", selected: false, share: 1 });
    const off = labelPriority({ state: "off", selected: false, share: 1 });

    expect(selected).toBeGreaterThan(failed);
    expect(failed).toBeGreaterThan(degraded);
    expect(degraded).toBeGreaterThan(active);
    expect(active).toBeGreaterThan(off);
  });

  it("breaks ties by traffic share", () => {
    const busy = labelPriority({ state: "active", selected: false, share: 40 });
    const quiet = labelPriority({ state: "active", selected: false, share: 1 });
    expect(busy).toBeGreaterThan(quiet);
  });

  it("keeps the selected provider labelled even in a dense field", () => {
    const nodes = buildConstellation(providers(40));
    const resolved = resolveLabels(nodes, { zoom: 0.4, selectedId: "p37" });
    expect(resolved.labelled).toContain("p37");
  });

  it("gives a failed provider label priority over healthy neighbours", () => {
    const list = providers(40);
    list[23] = { ...list[23]!, state: "failed" };
    const nodes = buildConstellation(list);
    const resolved = resolveLabels(nodes, { zoom: 0.4, selectedId: undefined });
    expect(resolved.labelled).toContain("p23");
  });

  it("labels every failure it can and reports the overflow rather than overlapping", () => {
    const list = providers(40).map((provider, index) =>
      index < 18 ? { ...provider, state: "failed" as const } : provider,
    );
    const nodes = buildConstellation(list);
    const resolved = resolveLabels(nodes, { zoom: 0.4, selectedId: undefined });

    expect(resolved.labelled.length).toBeLessThanOrEqual(resolved.labelBudget);
    // Unlabelled exceptions surface through an incident list, never a "+N" blob.
    expect(resolved.overflowIncidents.length).toBeGreaterThan(0);
    const covered = new Set([...resolved.labelled, ...resolved.overflowIncidents]);
    for (let index = 0; index < 18; index += 1) {
      expect(covered.has(`p${index}`)).toBe(true);
    }
  });

  it("does not report an overflow when everything fits", () => {
    const nodes = buildConstellation(providers(3));
    const resolved = resolveLabels(nodes, { zoom: 3, selectedId: undefined });
    expect(resolved.overflowIncidents).toEqual([]);
  });
});

describe("viewport", () => {
  it("starts centred at unit zoom", () => {
    const viewport = createViewport();
    expect(viewport).toEqual({ zoom: 1, x: 0, y: 0 });
  });

  it("clamps zoom to the configured bounds", () => {
    expect(zoomAt(createViewport(), 0.01, 0, 0).zoom).toBeGreaterThanOrEqual(0.45);
    expect(zoomAt(createViewport(), 100, 0, 0).zoom).toBeLessThanOrEqual(4);
    for (const factor of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const next = zoomAt(createViewport(), factor, 0, 0);
      expect(Number.isFinite(next.zoom)).toBe(true);
      expect(next.zoom).toBeGreaterThanOrEqual(0.45);
    }
  });

  it("zooms toward a focal point rather than the origin", () => {
    const zoomed = zoomAt(createViewport(), 2, 120, -80);
    expect(zoomed.zoom).toBeCloseTo(2, 6);
    // The focal point stays put, so panning is not required after a wheel zoom.
    expect(zoomed.x).not.toBe(0);
    expect(zoomed.y).not.toBe(0);
  });

  it("clamps panning so the core can never be lost off-screen", () => {
    let viewport = createViewport();
    for (let step = 0; step < 200; step += 1) {
      viewport = panBy(viewport, 500, 500);
    }
    const clamped = clampViewport(viewport);
    expect(Math.abs(clamped.x)).toBeLessThanOrEqual(2000);
    expect(Math.abs(clamped.y)).toBeLessThanOrEqual(2000);
    expect(Number.isFinite(clamped.x)).toBe(true);
    expect(Number.isFinite(clamped.y)).toBe(true);
  });

  it("recovers from a non-finite or absurd state", () => {
    const broken = clampViewport({ zoom: Number.NaN, x: Number.POSITIVE_INFINITY, y: -Infinity });
    expect(Number.isFinite(broken.zoom)).toBe(true);
    expect(Number.isFinite(broken.x)).toBe(true);
    expect(Number.isFinite(broken.y)).toBe(true);
    expect(broken.zoom).toBeGreaterThanOrEqual(0.45);
  });

  it("reset restores a valid useful viewport", () => {
    const wandered = panBy(zoomAt(createViewport(), 3.5, 200, 200), -900, 640);
    const reset = resetViewport();
    expect(reset).toEqual({ zoom: 1, x: 0, y: 0 });
    expect(reset).not.toEqual(wandered);
  });

  it("never produces a zoom of zero, which would collapse the scene", () => {
    let viewport = createViewport();
    for (let step = 0; step < 60; step += 1) {
      viewport = zoomAt(viewport, 0.5, 0, 0);
    }
    expect(viewport.zoom).toBeGreaterThan(0);
    expect(viewport.zoom).toBeGreaterThanOrEqual(0.45);
  });
});
