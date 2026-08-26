import { useCallback, useState } from "react";
import type { CreateProxyBody, ProxyCheckResult, ProxyKind, ProxyView } from "../api/types";
import { PanelError, useAsync } from "./shared";

export type ProxiesApi = {
  listProxies(): Promise<ProxyView[]>;
  createProxy(body: CreateProxyBody): Promise<ProxyView>;
  updateProxy(id: string, body: { enabled?: boolean }): Promise<ProxyView>;
  deleteProxy(id: string): Promise<void>;
  setProxyPassword(id: string, value: string): Promise<void>;
  clearProxyPassword(id: string): Promise<void>;
  checkProxy(id: string): Promise<ProxyCheckResult>;
};

const KINDS: ProxyKind[] = ["socks5", "http"];

export function ProxiesPanel({ api }: { api: ProxiesApi }) {
  const { value, error, loading, reload } = useAsync(() => api.listProxies());
  const [actionError, setActionError] = useState<unknown>(undefined);
  const [checks, setChecks] = useState<Record<string, ProxyCheckResult>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [form, setForm] = useState({
    id: "",
    kind: "socks5" as ProxyKind,
    host: "",
    port: "",
    username: "",
  });

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setActionError(undefined);
      try {
        await action();
        reload();
      } catch (failure) {
        setActionError(failure);
      }
    },
    [reload],
  );

  const submitPassword = useCallback(
    (id: string) => {
      const draft = drafts[id] ?? "";
      if (draft.trim().length === 0) {
        setActionError(new Error("Enter a password before saving."));
        return;
      }
      void (async () => {
        setActionError(undefined);
        try {
          await api.setProxyPassword(id, draft);
          setDrafts((current) => ({ ...current, [id]: "" }));
          reload();
        } catch (failure) {
          setDrafts((current) => ({ ...current, [id]: "" }));
          setActionError(failure);
        }
      })();
    },
    [api, drafts, reload],
  );

  const proxies = value ?? [];

  return (
    <section className="bayz-panel" aria-labelledby="proxies-heading">
      <h2 id="proxies-heading">Proxies</h2>

      {actionError !== undefined && <PanelError error={actionError} />}
      {error !== undefined && <PanelError error={error} />}
      {loading && <p>Loading proxies…</p>}

      <ul className="bayz-list">
        {proxies.map((proxy) => (
          <li key={proxy.id} className="bayz-list-item">
            <div>
              <strong>{proxy.id}</strong>
              <span>{proxy.kind}</span>
              <span>{proxy.host}</span>
              <span>{proxy.port}</span>
              {proxy.username !== undefined && <span>{proxy.username}</span>}
              <span>{proxy.enabled ? "enabled" : "disabled"}</span>
              {/* Boolean indicator only; the password itself is unreadable. */}
              <span data-testid={`password-${proxy.id}`}>
                {proxy.passwordPresent ? "Password stored" : "Password not set"}
              </span>
            </div>

            <div className="bayz-actions">
              <label htmlFor={`password-input-${proxy.id}`}>Password for {proxy.id}</label>
              <input
                id={`password-input-${proxy.id}`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={drafts[proxy.id] ?? ""}
                onChange={(event) =>
                  setDrafts((current) => ({ ...current, [proxy.id]: event.target.value }))
                }
              />
              <button type="button" onClick={() => submitPassword(proxy.id)}>
                Save password for {proxy.id}
              </button>
              <button
                type="button"
                onClick={() => void run(() => api.clearProxyPassword(proxy.id))}
              >
                Clear password for {proxy.id}
              </button>
              <button
                type="button"
                onClick={() =>
                  void run(() => api.updateProxy(proxy.id, { enabled: !proxy.enabled }))
                }
              >
                {proxy.enabled ? `Disable ${proxy.id}` : `Enable ${proxy.id}`}
              </button>
              <button
                type="button"
                onClick={() =>
                  void run(async () => {
                    const result = await api.checkProxy(proxy.id);
                    setChecks((current) => ({ ...current, [proxy.id]: result }));
                  })
                }
              >
                Check {proxy.id}
              </button>
              <button type="button" onClick={() => void run(() => api.deleteProxy(proxy.id))}>
                Delete {proxy.id}
              </button>
            </div>

            {checks[proxy.id] !== undefined && (
              <p data-testid={`check-${proxy.id}`}>
                Reachable in {checks[proxy.id]!.latencyMs} ms
              </p>
            )}
          </li>
        ))}
      </ul>

      <form
        className="bayz-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const username = form.username.trim();
            await api.createProxy({
              id: form.id,
              kind: form.kind,
              host: form.host,
              port: Number(form.port),
              ...(username.length === 0 ? {} : { username }),
            });
            setForm({ id: "", kind: "socks5", host: "", port: "", username: "" });
          });
        }}
      >
        <label htmlFor="proxy-id">Proxy id</label>
        <input
          id="proxy-id"
          value={form.id}
          onChange={(event) => setForm({ ...form, id: event.target.value })}
        />

        <label htmlFor="proxy-kind">Kind</label>
        <select
          id="proxy-kind"
          value={form.kind}
          onChange={(event) => setForm({ ...form, kind: event.target.value as ProxyKind })}
        >
          {KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>

        <label htmlFor="proxy-host">Host</label>
        <input
          id="proxy-host"
          value={form.host}
          onChange={(event) => setForm({ ...form, host: event.target.value })}
        />

        <label htmlFor="proxy-port">Port</label>
        <input
          id="proxy-port"
          inputMode="numeric"
          value={form.port}
          onChange={(event) => setForm({ ...form, port: event.target.value })}
        />

        <label htmlFor="proxy-username">Username</label>
        <input
          id="proxy-username"
          autoComplete="off"
          value={form.username}
          onChange={(event) => setForm({ ...form, username: event.target.value })}
        />

        <button type="submit">Add proxy</button>
      </form>
    </section>
  );
}
