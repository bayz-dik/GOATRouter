import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api/client";
import type {
  CreateProxyBody,
  ProxyCheckResult,
  ProxyKind,
  ProxyUsage,
  ProxyView,
  UpdateProxyBody,
} from "../api/types";
import { PanelError, useAsync } from "./shared";

export type ProxiesApi = {
  listProxies(): Promise<ProxyView[]>;
  createProxy(body: CreateProxyBody): Promise<ProxyView>;
  updateProxy(id: string, body: UpdateProxyBody): Promise<ProxyView>;
  deleteProxy(id: string): Promise<void>;
  setProxyPassword(id: string, value: string): Promise<void>;
  clearProxyPassword(id: string): Promise<void>;
  checkProxy(id: string): Promise<ProxyCheckResult>;
  proxyUsage(id: string): Promise<ProxyUsage>;
};

const KINDS: ProxyKind[] = ["socks5", "http"];

/**
 * The result of the last connection test, as the panel is allowed to describe it.
 *
 * There are three states and no fourth: measured success carries a real latency,
 * failure carries the envelope's own code and message and **no** latency, and
 * `unmeasured` is stated outright. Rendering `0 ms` or an optimistic "ok" for a check
 * that never ran would be a fabricated measurement.
 */
type CheckState =
  | { kind: "ok"; latencyMs: number }
  | { kind: "failed"; code: string; message: string };

/** Usage is either measured or explicitly unavailable — never assumed to be zero. */
type UsageState = { kind: "ok"; usage: ProxyUsage } | { kind: "unavailable" };

type EditDraft = {
  host: string;
  port: string;
  username: string;
  connectTimeoutMs: string;
};

function draftFrom(proxy: ProxyView): EditDraft {
  return {
    host: proxy.host,
    port: String(proxy.port),
    username: proxy.username ?? "",
    connectTimeoutMs: String(proxy.config.connectTimeoutMs),
  };
}

/**
 * Build the patch for an edit, containing only what actually changed.
 *
 * Sending every field would rewrite values the operator did not touch, and would make
 * an accidental save indistinguishable from a deliberate one in the audit log.
 * `username` clears with `null` rather than `""`: the API models absence as null, and
 * an empty string would be a second way to say the same thing.
 */
function patchFor(proxy: ProxyView, draft: EditDraft): UpdateProxyBody {
  const patch: UpdateProxyBody = {};
  if (draft.host !== proxy.host) {
    patch.host = draft.host;
  }
  const port = Number(draft.port);
  if (Number.isInteger(port) && port !== proxy.port) {
    patch.port = port;
  }
  const username = draft.username.trim();
  const current = proxy.username ?? "";
  if (username !== current) {
    patch.username = username.length === 0 ? null : username;
  }
  const timeout = Number(draft.connectTimeoutMs);
  if (Number.isInteger(timeout) && timeout !== proxy.config.connectTimeoutMs) {
    patch.config = { connectTimeoutMs: timeout };
  }
  return patch;
}

export function ProxiesPanel({ api }: { api: ProxiesApi }) {
  const { value, error, loading, reload } = useAsync(() => api.listProxies());
  const [actionError, setActionError] = useState<unknown>(undefined);
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  const [usage, setUsage] = useState<Record<string, UsageState>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [edits, setEdits] = useState<Record<string, EditDraft>>({});
  const [pendingDelete, setPendingDelete] = useState<string | undefined>(undefined);
  const [form, setForm] = useState({
    id: "",
    kind: "socks5" as ProxyKind,
    host: "",
    port: "",
    username: "",
  });

  const proxies = value ?? [];
  // A stable key so the usage effect runs when the *set* of proxies changes rather
  // than on every render of the same set.
  const proxyKey = proxies.map((proxy) => proxy.id).join(",");

  useEffect(() => {
    let active = true;
    for (const proxy of proxies) {
      void (async () => {
        try {
          const measured = await api.proxyUsage(proxy.id);
          if (active) {
            setUsage((current) => ({
              ...current,
              [proxy.id]: { kind: "ok", usage: measured },
            }));
          }
        } catch {
          // A read-only credential, or an older Core, cannot answer this. Saying so is
          // correct; showing "0 providers" would be a measurement nobody took.
          if (active) {
            setUsage((current) => ({ ...current, [proxy.id]: { kind: "unavailable" } }));
          }
        }
      })();
    }
    return () => {
      active = false;
    };
    // `proxies` is derived from `value`; `proxyKey` is its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proxyKey]);

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

  const submitEdit = useCallback(
    (proxy: ProxyView) => {
      const draft = edits[proxy.id];
      if (draft === undefined) {
        return;
      }
      const patch = patchFor(proxy, draft);
      if (Object.keys(patch).length === 0) {
        setActionError(new Error("Change a value before saving."));
        return;
      }
      void run(async () => {
        await api.updateProxy(proxy.id, patch);
        setEdits((current) => {
          const next = { ...current };
          delete next[proxy.id];
          return next;
        });
      });
    },
    [api, edits, run],
  );

  const runCheck = useCallback(
    (id: string) => {
      setActionError(undefined);
      void (async () => {
        try {
          const result = await api.checkProxy(id);
          setChecks((current) => ({
            ...current,
            [id]: { kind: "ok", latencyMs: result.latencyMs },
          }));
        } catch (failure) {
          setChecks((current) => ({
            ...current,
            [id]: {
              kind: "failed",
              code: failure instanceof ApiError ? failure.code : "unknown_error",
              message: failure instanceof Error ? failure.message : "Request failed",
            },
          }));
          setActionError(failure);
        }
      })();
    },
    [api],
  );

  /**
   * The state a row displays.
   *
   * `disabled` outranks `degraded`: an operator who turned a proxy off already knows
   * why traffic is not flowing, and a failed check on a proxy nobody is using is not
   * the headline.
   */
  const stateOf = (proxy: ProxyView): "disabled" | "degraded" | "ok" => {
    if (!proxy.enabled) {
      return "disabled";
    }
    return checks[proxy.id]?.kind === "failed" ? "degraded" : "ok";
  };

  return (
    <section className="bayz-panel" aria-labelledby="proxies-heading">
      <h2 id="proxies-heading">Proxies</h2>

      {actionError !== undefined && <PanelError error={actionError} />}
      {error !== undefined && <PanelError error={error} />}
      {loading && <p>Loading proxies…</p>}

      <ul className="bayz-list">
        {proxies.map((proxy) => {
          const state = stateOf(proxy);
          const check = checks[proxy.id];
          const measured = usage[proxy.id];
          const edit = edits[proxy.id];
          return (
            <li
              key={proxy.id}
              className={`bayz-list-item bayz-proxy-${state}`}
              data-testid={`proxy-row-${proxy.id}`}
              data-state={state}
            >
              <div>
                <strong>{proxy.id}</strong>
                <span>{proxy.kind}</span>
                <span>{proxy.host}</span>
                <span>{proxy.port}</span>
                {proxy.username !== undefined && <span>{proxy.username}</span>}
                <span data-testid={`state-${proxy.id}`}>
                  {state === "disabled"
                    ? "disabled"
                    : state === "degraded"
                      ? "degraded"
                      : "enabled"}
                </span>
                {/* Boolean indicator only; the password itself is unreadable. */}
                <span data-testid={`password-${proxy.id}`}>
                  {proxy.passwordPresent ? "Password stored" : "Password not set"}
                </span>
                <span data-testid={`usage-${proxy.id}`}>
                  {measured === undefined
                    ? "Usage loading…"
                    : measured.kind === "unavailable"
                      ? "Usage unavailable"
                      : `Used by ${measured.usage.providerCount} providers, ${measured.usage.routeCount} routes`}
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
                    setEdits((current) =>
                      current[proxy.id] === undefined
                        ? { ...current, [proxy.id]: draftFrom(proxy) }
                        : current,
                    )
                  }
                >
                  Edit {proxy.id}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void run(() => api.updateProxy(proxy.id, { enabled: !proxy.enabled }))
                  }
                >
                  {proxy.enabled ? `Disable ${proxy.id}` : `Enable ${proxy.id}`}
                </button>
                <button type="button" onClick={() => runCheck(proxy.id)}>
                  Check {proxy.id}
                </button>
                <button type="button" onClick={() => setPendingDelete(proxy.id)}>
                  Delete {proxy.id}
                </button>
              </div>

              {edit !== undefined && (
                <div className="bayz-proxy-edit">
                  <label htmlFor={`edit-host-${proxy.id}`}>Host for {proxy.id}</label>
                  <input
                    id={`edit-host-${proxy.id}`}
                    value={edit.host}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) =>
                      setEdits((current) => ({
                        ...current,
                        [proxy.id]: { ...edit, host: event.target.value },
                      }))
                    }
                  />
                  <label htmlFor={`edit-port-${proxy.id}`}>Port for {proxy.id}</label>
                  <input
                    id={`edit-port-${proxy.id}`}
                    inputMode="numeric"
                    value={edit.port}
                    onChange={(event) =>
                      setEdits((current) => ({
                        ...current,
                        [proxy.id]: { ...edit, port: event.target.value },
                      }))
                    }
                  />
                  <label htmlFor={`edit-username-${proxy.id}`}>Username for {proxy.id}</label>
                  <input
                    id={`edit-username-${proxy.id}`}
                    value={edit.username}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) =>
                      setEdits((current) => ({
                        ...current,
                        [proxy.id]: { ...edit, username: event.target.value },
                      }))
                    }
                  />
                  <label htmlFor={`edit-timeout-${proxy.id}`}>
                    Connect timeout for {proxy.id}
                  </label>
                  <input
                    id={`edit-timeout-${proxy.id}`}
                    inputMode="numeric"
                    value={edit.connectTimeoutMs}
                    onChange={(event) =>
                      setEdits((current) => ({
                        ...current,
                        [proxy.id]: { ...edit, connectTimeoutMs: event.target.value },
                      }))
                    }
                  />
                  <button type="button" onClick={() => submitEdit(proxy)}>
                    Save {proxy.id}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setEdits((current) => {
                        const next = { ...current };
                        delete next[proxy.id];
                        return next;
                      })
                    }
                  >
                    Cancel edit {proxy.id}
                  </button>
                </div>
              )}

              {pendingDelete === proxy.id && (
                <div data-testid={`confirm-delete-${proxy.id}`} role="group">
                  <p>
                    Deleting {proxy.id} sets every provider using it back to Direct. Their
                    traffic will leave this machine untunnelled.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setPendingDelete(undefined);
                      void run(() => api.deleteProxy(proxy.id));
                    }}
                  >
                    Confirm delete {proxy.id}
                  </button>
                  <button type="button" onClick={() => setPendingDelete(undefined)}>
                    Cancel delete {proxy.id}
                  </button>
                </div>
              )}

              <p data-testid={`check-${proxy.id}`}>
                {check === undefined
                  ? "Connection not measured"
                  : check.kind === "ok"
                    ? `Reachable in ${check.latencyMs} ms`
                    : `Check failed: ${check.code} ${check.message}`}
              </p>
            </li>
          );
        })}
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
