import { describe, expect, it } from "vitest";
import {
  buildConstellation,
  ingressGroups,
  trunkFor,
} from "../src/flux/constellation";
import { APPROVED_POSITIONS } from "../src/flux/constellation";
import type { FluxProvider } from "../src/flux/types";

function providers(n: number, prefix = "p"): FluxProvider[] {
  return Array.from({ length: n }, (_unused, index) => ({
    id: `${prefix}${index}`,
    displayName: `PROVIDER ${index}`,
    state: "active" as const,
    sharePercent: 100 / n,
  }));
}

describe("constellation layout", () => {
  it("reproduces the approved five positions exactly for 1..5 providers", () => {
    for (let n = 1; n <= 5; n += 1) {
      const nodes = buildConstellation(providers(n));
      expect(nodes).toHaveLength(n);
      nodes.forEach((node, index) => {
        // The approved geometry is the visual source of truth and must not drift.
        expect(node.xPct).toBeCloseTo(APPROVED_POSITIONS[index]!.xPct, 6);
        expect(node.yPct).toBeCloseTo(APPROVED_POSITIONS[index]!.yPct, 6);
      });
    }
  });

  it("scales beyond five without dropping or truncating any provider", () => {
    for (const n of [6, 12, 40, 97]) {
      const nodes = buildConstellation(providers(n));
      expect(nodes).toHaveLength(n);
      expect(new Set(nodes.map((node) => node.id)).size).toBe(n);
    }
  });

  it("keeps every node outside the core and inside the world bounds", () => {
    const nodes = buildConstellation(providers(40));
    for (const node of nodes) {
      const dx = node.xPct - 50;
      const dy = node.yPct - 50;
      const distance = Math.hypot(dx, dy);
      // Never inside the core disc, never beyond the reachable world.
      expect(distance).toBeGreaterThan(18);
      expect(distance).toBeLessThan(300);
    }
  });

  it("separates dense nodes enough that marks do not collide", () => {
    const nodes = buildConstellation(providers(40));
    let minimum = Infinity;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        minimum = Math.min(
          minimum,
          Math.hypot(nodes[i]!.xPct - nodes[j]!.xPct, nodes[i]!.yPct - nodes[j]!.yPct),
        );
      }
    }
    expect(minimum).toBeGreaterThan(4);
  });

  it("is deterministic across calls", () => {
    const first = buildConstellation(providers(40));
    const second = buildConstellation(providers(40));
    expect(second).toEqual(first);
  });

  it("assigns a ring index that grows with provider count", () => {
    expect(buildConstellation(providers(5)).every((node) => node.ring === 0)).toBe(true);
    const large = buildConstellation(providers(40));
    expect(Math.max(...large.map((node) => node.ring))).toBeGreaterThan(0);
  });

  it("tolerates an empty provider list", () => {
    expect(buildConstellation([])).toEqual([]);
  });
});

describe("ingress grouping and trunk bundling", () => {
  it("keeps one stream per provider while bundling by sector", () => {
    const nodes = buildConstellation(providers(40));
    const groups = ingressGroups(nodes);

    // Bundling is a rendering optimization: no provider may be merged away.
    const total = groups.reduce((sum, group) => sum + group.members.length, 0);
    expect(total).toBe(40);
    const ids = groups.flatMap((group) => group.members.map((member) => member.id));
    expect(new Set(ids).size).toBe(40);
  });

  it("uses no trunk bundling at the approved small counts", () => {
    const groups = ingressGroups(buildConstellation(providers(5)));
    // Five providers keep five independent filaments, exactly as approved.
    expect(groups).toHaveLength(5);
    expect(groups.every((group) => group.members.length === 1)).toBe(true);
  });

  it("bundles as density rises rather than drawing forty independent cables", () => {
    const groups = ingressGroups(buildConstellation(providers(40)));
    expect(groups.length).toBeLessThan(40);
    expect(groups.length).toBeGreaterThan(1);
    expect(Math.max(...groups.map((group) => group.members.length))).toBeGreaterThan(1);
  });

  it("maps every provider back to exactly one trunk", () => {
    const nodes = buildConstellation(providers(40));
    const groups = ingressGroups(nodes);
    for (const node of nodes) {
      const trunk = trunkFor(groups, node.id);
      expect(trunk).toBeDefined();
      expect(trunk!.members.some((member) => member.id === node.id)).toBe(true);
    }
  });

  it("gives each trunk a distinct ingress angle", () => {
    const groups = ingressGroups(buildConstellation(providers(40)));
    const angles = groups.map((group) => Math.round(group.angle * 1000));
    expect(new Set(angles).size).toBe(groups.length);
  });
});
