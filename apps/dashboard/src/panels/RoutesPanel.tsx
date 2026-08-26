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

  return (
    <section className="bayz-panel" aria-labelledby="routes-heading">
      <h2 id="routes-heading">Routes</h2>

      {actionError !== undefined && <PanelError error={actionError} />}
      {routes.error !== undefined && <PanelError error={routes.error} />}
      {routes.loading && <p>Loading routes…</p>}

      <ul className="bayz-list">
        {list.map((route) => (
          <li key={route.id} className="bayz-list-item" data-testid={`route-${route.id}`}>
            <div>
              <strong>{route.model}</strong>
              <span>{route.id}</span>
              <span>{route.providerId}</span>
              {route.proxyId !== undefined && <span>{route.proxyId}</span>}
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
              ...(form.proxyId.length === 0 ? {} : { proxyId: form.proxyId }),
              ...(priority.length === 0 ? {} : { priority: Number(priority) }),
            });
            setForm({ id: "", model: "", providerId: "", proxyId: "", priority: "" });
          });
        }}
      >
        <label htmlFor="route-id">Route id</label>
        <input
          id="route-id"
          value={form.id}
          onChange={(event) => setForm({ ...form, id: event.target.value })}
        />

        <label htmlFor="route-model">Model</label>
        <input
          id="route-model"
          value={form.model}
          onChange={(event) => setForm({ ...form, model: event.target.value })}
        />

        <label htmlFor="route-provider">Provider</label>
        <select
          id="route-provider"
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

        <button type="submit">Add route</button>
      </form>
    </section>
  );
}
