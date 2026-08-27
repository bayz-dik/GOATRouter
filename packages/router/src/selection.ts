import { isFreeEconomics, type ModelEconomics } from "@bayz/providers";
import { RouterError } from "./errors.js";
import { assertModelId, matchesModelPattern, patternSpecificity } from "./model.js";
import type { RouteRecord } from "./repository.js";

/**
 * Order the enabled routes that match `model`, most preferred first.
 *
 * Ordering is total and deterministic — specificity, then priority, then id — so
 * the same registry always produces the same choice. Falling back to row order
 * would make routing depend on insertion history, which is impossible to reason
 * about when a request fails and an operator has to explain why it went where it
 * did.
 *
 * The input array is never mutated: callers hold repository results and would be
 * surprised by a reordered list.
 */
export function resolveCandidates(
  routes: readonly RouteRecord[],
  model: string,
): RouteRecord[] {
  const requested = assertModelId(model);

  return routes
    .filter((route) => route.enabled && matchesModelPattern(route.model, requested))
    .slice()
    .sort((left, right) => {
      const specificity =
        patternSpecificity(right.model) - patternSpecificity(left.model);
      if (specificity !== 0) {
        return specificity;
      }
      if (right.priority !== left.priority) {
        return right.priority - left.priority;
      }
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
}

/**
 * The single most preferred route for a model.
 *
 * `no_route` is deliberately distinct from `route_not_found`: the first means the
 * operator has not bound this model anywhere (or disabled every binding), the
 * second means a specific route id does not exist. The remedies differ.
 */
export function selectRoute(
  routes: readonly RouteRecord[],
  model: string,
): RouteRecord {
  const [best] = resolveCandidates(routes, model);
  if (best === undefined) {
    throw new RouterError("no_route", "select-route");
  }
  return best;
}

/**
 * Whether a candidate is eligible for a free-only route.
 *
 * Split out and exported so the router, the API layer, and the tests all read the same
 * rule. The `undefined` case — the provider has no catalogue row for this model — is
 * **not free**: an undiscovered model is unproven, and treating "we never checked" as
 * free is exactly the mistake that produces a bill.
 */
export function isFreeCandidate(
  economics: ModelEconomics | undefined,
): boolean {
  return economics === undefined ? false : isFreeEconomics(economics);
}

/**
 * Narrow candidates to those a free-only route may use.
 *
 * A route that is not free-only keeps every candidate: free-only is a per-route
 * decision, so two routes for the same model can legitimately disagree.
 *
 * `lookup` reads a *cached* classification rather than performing discovery. A
 * per-request discovery call would add an upstream round trip to every chat, and worse,
 * a discovery outage would empty the free set and turn an availability problem into a
 * `no_free_route` storm.
 */
export function filterFreeCandidates(
  candidates: readonly RouteRecord[],
  lookup: (route: RouteRecord) => ModelEconomics | undefined,
): RouteRecord[] {
  return candidates.filter(
    (route) => !route.freeOnly || isFreeCandidate(lookup(route)),
  );
}
