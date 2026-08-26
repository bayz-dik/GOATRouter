import type { ConstellationNode } from "./constellation";
import { FLUX_APPROVED_PROVIDERS, type FluxProviderState } from "./types";

/**
 * Semantic zoom and label-collision resolution.
 *
 * The rule this file exists to enforce: overlap is solved by reducing label
 * detail, never by removing provider nodes. Every mark is always drawn and every
 * provider stays discoverable through zoom, focus, or the incident list.
 */

export const DETAIL_FAR = "far";
export const DETAIL_MEDIUM = "medium";
export const DETAIL_NEAR = "near";

export type DetailLevel = typeof DETAIL_FAR | typeof DETAIL_MEDIUM | typeof DETAIL_NEAR;

export function detailLevel(zoom: number): DetailLevel {
  if (!Number.isFinite(zoom) || zoom < 1.15) {
    return DETAIL_FAR;
  }
  return zoom < 2.1 ? DETAIL_MEDIUM : DETAIL_NEAR;
}

/**
 * Label priority, highest first.
 *
 * Ordering is the stated requirement: selected, then failed, then
 * degraded/recovering, then active routing, then traffic share. Share only breaks
 * ties within a state, so a busy healthy provider never outranks an incident.
 */
const STATE_RANK: Record<FluxProviderState, number> = {
  failed: 5000,
  recovering: 4000,
  degraded: 4000,
  active: 3000,
  standby: 1500,
  off: 500,
};

export function labelPriority(input: {
  state: FluxProviderState;
  selected: boolean;
  share: number;
}): number {
  const base = input.selected ? 10000 : (STATE_RANK[input.state] ?? 500);
  const share = Number.isFinite(input.share) ? Math.max(0, Math.min(100, input.share)) : 0;
  return base + share;
}

/** How many labels fit without overlapping, by detail band. */
const LABEL_BUDGET: Record<DetailLevel, number> = {
  [DETAIL_FAR]: 4,
  [DETAIL_MEDIUM]: 10,
  [DETAIL_NEAR]: 24,
};

/** States that must be accounted for even when they cannot be labelled. */
const EXCEPTIONAL: ReadonlySet<FluxProviderState> = new Set([
  "failed",
  "recovering",
  "degraded",
]);

export type ResolvedLabels = {
  detail: DetailLevel;
  /** Never filtered: one entry per provider, always. */
  nodes: ConstellationNode[];
  /** Provider ids whose label is drawn this frame. */
  labelled: string[];
  labelBudget: number;
  /** Exceptional providers that did not fit; surfaced as incidents instead. */
  overflowIncidents: string[];
  showState: boolean;
  showShare: boolean;
  showIcon: boolean;
};

export function resolveLabels(
  nodes: readonly ConstellationNode[],
  options: { zoom: number; selectedId: string | undefined },
): ResolvedLabels {
  const detail = detailLevel(options.zoom);
  /*
   * At the approved counts the layout has no overlap by construction, so every
   * provider keeps its label at every zoom level. Reducing detail there would be a
   * visual regression against the approved baseline, not a collision fix.
   */
  const budget =
    nodes.length <= FLUX_APPROVED_PROVIDERS
      ? nodes.length
      : Math.min(LABEL_BUDGET[detail], nodes.length);

  const ranked = nodes
    .map((node) => ({
      id: node.id,
      priority: labelPriority({
        state: node.state,
        selected: node.id === options.selectedId,
        share: node.sharePercent,
      }),
      exceptional: EXCEPTIONAL.has(node.state),
    }))
    // Ties resolved by id so ordering is stable frame to frame.
    .sort((left, right) =>
      right.priority - left.priority || (left.id < right.id ? -1 : 1),
    );

  const labelled = ranked.slice(0, budget).map((entry) => entry.id);
  const labelledSet = new Set(labelled);

  // An exception that cannot be labelled is reported, not hidden behind "+N".
  const overflowIncidents = ranked
    .filter((entry) => entry.exceptional && !labelledSet.has(entry.id))
    .map((entry) => entry.id);

  return {
    detail,
    nodes: [...nodes],
    labelled,
    labelBudget: budget,
    overflowIncidents,
    // At the approved counts the full chip detail is always shown, matching the
    // standalone source where share and state are permanently visible.
    showState: detail === DETAIL_NEAR || nodes.length <= FLUX_APPROVED_PROVIDERS,
    showShare: detail === DETAIL_NEAR || nodes.length <= FLUX_APPROVED_PROVIDERS,
    showIcon: true,
  };
}
