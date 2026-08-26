import {
  FLUX_APPROVED_PROVIDERS,
  type FluxProvider,
  type FluxProviderState,
  type FluxRouteParticipation,
} from "./types";

/**
 * Provider constellation layout.
 *
 * The approved five positions are reproduced exactly for 1..5 providers, so the
 * visual baseline is untouched at the counts the approved source demonstrates.
 * Beyond five, the field expands into concentric rings around the core — the space
 * *around* the Flux Core grows, the core itself is unchanged.
 *
 * Layout is pure and deterministic: same providers in, same coordinates out, on
 * every machine and every reload.
 */

/** Verbatim from the approved source: `.p1`–`.p5` left/top percentages. */
export const APPROVED_POSITIONS = [
  { xPct: 17, yPct: 18 },
  { xPct: 83, yPct: 18 },
  { xPct: 11, yPct: 52 },
  { xPct: 89, yPct: 52 },
  { xPct: 50, yPct: 87 },
] as const;

/** Ring radii in world-percent units, measured from the core at (50, 50). */
const RING_RADII = [42, 62, 82, 102, 122, 142];
/** Capacity per ring; circumference grows, so each ring holds more. */
const RING_CAPACITY = [8, 14, 20, 26, 32, 38];

export type ConstellationNode = {
  id: string;
  displayName: string;
  state: FluxProviderState;
  sharePercent: number;
  /** Route participation, carried through so prominence can be styled. */
  routeParticipation: FluxRouteParticipation;
  /** Measured latency in ms, when the model supplied a usable number. */
  latencyMs: number | undefined;
  /** Operator-facing failure reason, when supplied. Untrusted text. */
  incidentReason: string | undefined;
  /** World coordinates in percent, where the core sits at (50, 50). */
  xPct: number;
  yPct: number;
  /** 0 for the approved inner positions, then outward. */
  ring: number;
  /** Angle from the core in radians, used for ingress grouping. */
  angle: number;
  /** Marks are always drawn; only labels reduce with distance. */
  markVisible: true;
};

function angleFrom(xPct: number, yPct: number): number {
  const angle = Math.atan2(yPct - 50, xPct - 50);
  return angle < 0 ? angle + Math.PI * 2 : angle;
}

/**
 * Place providers around the core.
 *
 * Rings are filled outward and each ring is rotated by a golden-angle offset so
 * adjacent rings do not align radially, which is what keeps marks from stacking on
 * top of one another as the count grows.
 */
export function buildConstellation(
  providers: readonly FluxProvider[],
): ConstellationNode[] {
  if (providers.length === 0) {
    return [];
  }

  const nodes: ConstellationNode[] = [];
  let index = 0;

  for (const provider of providers) {
    let xPct: number;
    let yPct: number;
    let ring: number;

    if (providers.length <= FLUX_APPROVED_PROVIDERS && index < APPROVED_POSITIONS.length) {
      // Approved baseline: exact positions, no drift.
      const approved = APPROVED_POSITIONS[index]!;
      xPct = approved.xPct;
      yPct = approved.yPct;
      ring = 0;
    } else {
      let remaining = index;
      ring = 0;
      while (ring < RING_CAPACITY.length - 1 && remaining >= RING_CAPACITY[ring]!) {
        remaining -= RING_CAPACITY[ring]!;
        ring += 1;
      }
      const capacity = RING_CAPACITY[ring]!;
      const radius = RING_RADII[ring]!;
      // Golden-angle offset per ring prevents radial alignment between rings.
      const offset = ring * 2.399963229728653;
      const theta = (remaining / capacity) * Math.PI * 2 + offset;
      xPct = 50 + Math.cos(theta) * radius;
      // Slight vertical compression keeps the field wide rather than circular,
      // matching the approved stage proportions.
      yPct = 50 + Math.sin(theta) * radius * 0.82;
    }

    nodes.push({
      id: provider.id,
      displayName: provider.displayName,
      state: provider.state,
      sharePercent: provider.sharePercent,
      // Defaulted rather than required: a model that omits participation still
      // renders, and an absent latency is absent rather than zero.
      routeParticipation:
        provider.routeParticipation ??
        (provider.state === "active" || provider.state === "recovering" ? "combo" : "none"),
      latencyMs:
        typeof provider.latencyMs === "number" && Number.isFinite(provider.latencyMs)
          ? Math.max(0, Math.round(provider.latencyMs))
          : undefined,
      incidentReason:
        typeof provider.incidentReason === "string" && provider.incidentReason.length > 0
          ? provider.incidentReason
          : undefined,
      xPct,
      yPct,
      ring,
      angle: angleFrom(xPct, yPct),
      markVisible: true,
    });
    index += 1;
  }

  return nodes;
}

export type IngressGroup = {
  /** Stable key for React and for trunk lookup. */
  key: string;
  /** Ingress angle at the core rim, in radians. */
  angle: number;
  /** Every provider routed through this trunk. Never merged away. */
  members: ConstellationNode[];
};

/** Above this many providers, filaments bundle into sector trunks. */
const BUNDLE_THRESHOLD = FLUX_APPROVED_PROVIDERS;
/** Sector count at high density; each becomes one braided trunk. */
const SECTORS = 12;

/**
 * Group provider filaments into ingress trunks.
 *
 * At the approved counts every provider keeps its own filament, so the approved
 * braiding is unchanged. Past that, spatially adjacent providers share a trunk —
 * purely a rendering decision. Every provider stays in `members`, so focusing one
 * still identifies exactly which traffic is its own.
 */
export function ingressGroups(
  nodes: readonly ConstellationNode[],
): IngressGroup[] {
  if (nodes.length <= BUNDLE_THRESHOLD) {
    return nodes.map((node) => ({
      key: `solo-${node.id}`,
      angle: node.angle,
      members: [node],
    }));
  }

  const buckets = new Map<number, ConstellationNode[]>();
  for (const node of nodes) {
    const sector = Math.floor((node.angle / (Math.PI * 2)) * SECTORS) % SECTORS;
    const list = buckets.get(sector);
    if (list === undefined) {
      buckets.set(sector, [node]);
    } else {
      list.push(node);
    }
  }

  return [...buckets.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([sector, members]) => ({
      key: `trunk-${sector}`,
      // The trunk enters the core at its sector centre, so distinct trunks never
      // share an ingress angle.
      angle: ((sector + 0.5) / SECTORS) * Math.PI * 2,
      members,
    }));
}

/** Which trunk carries a given provider's traffic. */
export function trunkFor(
  groups: readonly IngressGroup[],
  providerId: string,
): IngressGroup | undefined {
  return groups.find((group) =>
    group.members.some((member) => member.id === providerId),
  );
}
