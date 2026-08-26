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
