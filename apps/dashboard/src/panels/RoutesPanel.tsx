import { useCallback, useState } from "react";
import type {
  CreateRouteBody,
  ProviderView,
  ProxyView,
  RouteView,
  UpdateRouteBody,
} from "../api/types";
import { PanelError, useAsync } from "./shared";

export type RoutesApi = {
  listRoutes(): Promise<RouteView[]>;
  listProviders(): Promise<ProviderView[]>;
  listProxies(): Promise<ProxyView[]>;
  createRoute(body: CreateRouteBody): Promise<RouteView>;
  updateRoute(id: string, body: UpdateRouteBody): Promise<RouteView>;
  deleteRoute(id: string): Promise<void>;
};

/** How a route arrived at the proxy it will actually use. */
type EffectiveProxy =
  | { kind: "proxy"; proxyId: string; origin: "inherited" | "overridden" }
  | { kind: "direct"; origin: "default" | "override" }
  | { kind: "unknown" };

/**
 * The proxy a route will actually use, and why.
 *
 * This mirrors `effectiveProxyId` in `@bayz/router` exactly, including the order:
 * `forceDirect` first, then the route override, then the provider default. The panel
 * disagreeing with the router would mean the dashboard claims traffic goes direct while
 * it tunnels, which is worse than showing nothing.
 *
 * A route whose provider is not in the list returns `unknown` rather than `direct` — the
 * effective proxy genuinely cannot be computed, and `Direct` would be a fabricated claim.
 */
function effectiveProxy(
  route: RouteView,
  providers: readonly ProviderView[],
): EffectiveProxy {
  const provider = providers.find((candidate) => candidate.id === route.providerId);
  if (provider === undefined) {
    return { kind: "unknown" };
  }
  if (route.forceDirect) {
    // An override only when it overrides something; a forced-direct route under a direct
    // provider changes nothing and should not be dressed up as a decision.
    return {
      kind: "direct",
      origin: provider.proxyId === undefined ? "default" : "override",
    };
  }
  if (route.proxyId !== undefined) {
    // Pinned on the route. Called "overridden" whether or not the provider had a default,
    // because the route is no longer following whatever the provider does next.
    return { kind: "proxy", proxyId: route.proxyId, origin: "overridden" };
  }
  if (provider.proxyId !== undefined) {
    return { kind: "proxy", proxyId: provider.proxyId, origin: "inherited" };
  }
  return { kind: "direct", origin: "default" };
}

/** One short, unambiguous phrase per state. */
function describeEffectiveProxy(effective: EffectiveProxy): string {
  switch (effective.kind) {
    case "unknown":
      return "Effective proxy unknown (provider missing)";
    case "direct":
      return effective.origin === "override" ? "Direct (override)" : "Direct";
    case "proxy":
      return effective.origin === "inherited"
        ? `Proxy ${effective.proxyId} (inherited)`
        : `Proxy ${effective.proxyId} (overridden)`;
  }
}


/**
 * The help text shown when the server refuses on economics grounds.
 *
 * A bare `no_free_route` reads as a bug. Naming the refusal and stating that nothing was
 * charged is what tells an operator this was policy working, not a failure.
 */
function NoFreeRouteHelp() {
  return (
    <p data-testid="no-free-route-help">
      no_free_route: no model proven free is available for this route, so nothing was
      charged and no request was sent. Add a provider with free models, or allow paid
      models on this route.
    </p>
  );
}

/** Whether a thrown value is the server's 409 economics refusal. */
function isNoFreeRoute(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "no_free_route"
  );
}

export function RoutesPanel({ api }: { api: RoutesApi }) {
  const routes = useAsync(() => api.listRoutes());
  const providers = useAsync(() => api.listProviders());
  const proxies = useAsync(() => api.listProxies());
  const [actionError, setActionError] = useState<unknown>(undefined);
  const [priorities, setPriorities] = useState<Record<string, string>>({});
  const [form, setForm] = useState({
    id: "",
    model: "",
    providerId: "",
    proxyId: "",
    priority: "",
  });
  /*
   * The new-route economics choice, defaulting to free-only.
   *
   * Held as its own boolean rather than a string in `form` so the checkbox cannot end up
   * in a third state, and defaulted to `true` to match the server: a form that quietly
   * created paid routes would defeat the policy no matter what the server allows.
   */
  const [freeOnly, setFreeOnly] = useState(true);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setActionError(undefined);
      try {
        await action();
        routes.reload();
      } catch (failure) {
        setActionError(failure);
      }
    },
    [routes],
  );

  const list = routes.value ?? [];
  const providerList = providers.value ?? [];

  return (
    <section className="bayz-panel" aria-labelledby="routes-heading">
      <h2 id="routes-heading">Routes</h2>

      {actionError !== undefined && <PanelError error={actionError} />}
      {isNoFreeRoute(actionError) && <NoFreeRouteHelp />}
      {routes.error !== undefined && <PanelError error={routes.error} />}
      {routes.loading && <p>Loading routes…</p>}

      <ul className="bayz-list">
        {list.map((route) => (
          <li key={route.id} className="bayz-list-item" data-testid={`route-${route.id}`}>
            <div>
              <strong>{route.model}</strong>
              <span>{route.id}</span>
              <span>{route.providerId}</span>
              {/*
                The effective proxy, not the raw column: an operator needs to know where
                traffic actually goes. React escapes the id, so a hostile one renders as
                text rather than being parsed as markup.
              */}
              <span data-testid={`route-proxy-${route.id}`}>
                {describeEffectiveProxy(effectiveProxy(route, providerList))}
              </span>
              {/*
                The economics posture, stated on every row. An operator scanning a route
                list needs to see which routes can spend money without opening each one.
              */}
              <span data-testid={`route-economics-${route.id}`}>
                {route.freeOnly ? "Free only" : "Paid allowed"}
              </span>
              <span>{route.priority}</span>
              <span>{route.enabled ? "enabled" : "disabled"}</span>
            </div>

            <div className="bayz-actions">
              <label htmlFor={`priority-${route.id}`}>Priority for {route.id}</label>
              <input
                id={`priority-${route.id}`}
                inputMode="numeric"
                value={priorities[route.id] ?? String(route.priority)}
                onChange={(event) =>
                  setPriorities((current) => ({ ...current, [route.id]: event.target.value }))
                }
              />
              <button
                type="button"
                onClick={() =>
                  void run(() =>
                    api.updateRoute(route.id, {
                      priority: Number(priorities[route.id] ?? route.priority),
                    }),
                  )
                }
              >
                Save priority for {route.id}
              </button>
              <button
                type="button"
                onClick={() =>
                  void run(() => api.updateRoute(route.id, { enabled: !route.enabled }))
                }
              >
                {route.enabled ? `Disable ${route.id}` : `Enable ${route.id}`}
              </button>
              <button
                type="button"
                data-testid={`toggle-free-only-${route.id}`}
                onClick={() =>
                  void run(() =>
                    api.updateRoute(route.id, { freeOnly: !route.freeOnly }),
                  )
                }
              >
                {route.freeOnly
                  ? `Allow paid models on ${route.id}`
                  : `Restrict ${route.id} to free models`}
              </button>
              {route.proxyId !== undefined && (
                <button
                  type="button"
                  onClick={() => void run(() => api.updateRoute(route.id, { proxyId: null }))}
                >
                  Unbind proxy from {route.id}
                </button>
              )}
              <button type="button" onClick={() => void run(() => api.deleteRoute(route.id))}>
                Delete {route.id}
              </button>
            </div>
          </li>
        ))}
      </ul>

      <form
        className="bayz-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const priority = form.priority.trim();
            await api.createRoute({
              id: form.id,
              model: form.model,
              providerId: form.providerId,
              // Always sent explicitly, never left to the server's default: the operator
              // saw a checkbox, so the request should say what it said.
              freeOnly,
              ...(form.proxyId.length === 0 ? {} : { proxyId: form.proxyId }),
              ...(priority.length === 0 ? {} : { priority: Number(priority) }),
            });
            setForm({ id: "", model: "", providerId: "", proxyId: "", priority: "" });
            // The economics choice is deliberately *not* reset: an operator adding
            // several paid routes should not have to re-confirm on each one.
          });
        }}
      >
        <label htmlFor="route-id">Route id</label>
        <input
          id="route-id"
          data-testid="route-id-input"
          value={form.id}
          onChange={(event) => setForm({ ...form, id: event.target.value })}
        />

        <label htmlFor="route-model">Model</label>
        <input
          id="route-model"
          data-testid="route-model-input"
          value={form.model}
          onChange={(event) => setForm({ ...form, model: event.target.value })}
        />

        <label htmlFor="route-provider">Provider</label>
        <select
          id="route-provider"
          data-testid="route-provider-input"
          value={form.providerId}
          onChange={(event) => setForm({ ...form, providerId: event.target.value })}
        >
          <option value="">Select a provider</option>
          {(providers.value ?? []).map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.id}
            </option>
          ))}
        </select>

        <label htmlFor="route-proxy">Proxy</label>
        <select
          id="route-proxy"
          value={form.proxyId}
          onChange={(event) => setForm({ ...form, proxyId: event.target.value })}
        >
          <option value="">Direct (no proxy)</option>
          {(proxies.value ?? []).map((proxy) => (
            <option key={proxy.id} value={proxy.id}>
              {proxy.id}
            </option>
          ))}
        </select>

        <label htmlFor="route-priority">Priority</label>
        <input
          id="route-priority"
          inputMode="numeric"
          value={form.priority}
          onChange={(event) => setForm({ ...form, priority: event.target.value })}
        />

        <label htmlFor="route-free-only">Free-only routing</label>
        <input
          id="route-free-only"
          data-testid="route-free-only"
          type="checkbox"
          checked={freeOnly}
          onChange={(event) => setFreeOnly(event.target.checked)}
        />
        {!freeOnly && (
          // Shown at the moment of the decision, not after submitting. Plain language,
          // and it names the consequence rather than the flag.
          <p data-testid="paid-warning">
            This route may use paid models. Requests on it can be charged by the
            provider.
          </p>
        )}

        <button type="submit" data-testid="route-submit">
          Add route
        </button>
      </form>
    </section>
  );
}
