import { useCallback, useState } from "react";
import type { CreateProviderBody, ProviderKind, ProviderView } from "../api/types";
import { PanelError, useAsync } from "./shared";

/** Only the calls this panel needs, so a test can supply a narrow stub. */
export type ProvidersApi = {
  listProviders(): Promise<ProviderView[]>;
  createProvider(body: CreateProviderBody): Promise<ProviderView>;
  updateProvider(id: string, body: { enabled?: boolean }): Promise<ProviderView>;
  deleteProvider(id: string): Promise<void>;
  setProviderCredential(id: string, value: string): Promise<void>;
  clearProviderCredential(id: string): Promise<void>;
  discoverModels(id: string): Promise<string[]>;
};

const KINDS: ProviderKind[] = [
  "openai-compatible",
  "openrouter",
  "gemini",
  "codex-oauth",
];

export function ProvidersPanel({ api }: { api: ProvidersApi }) {
  const { value, error, loading, reload } = useAsync(() => api.listProviders());
  const [actionError, setActionError] = useState<unknown>(undefined);
  const [models, setModels] = useState<Record<string, string[]>>({});
  // Credential drafts are keyed per provider and cleared the moment they are sent.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [form, setForm] = useState({
    id: "",
    kind: "openai-compatible" as ProviderKind,
    displayName: "",
    baseUrl: "",
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

  const submitCredential = useCallback(
    (id: string) => {
      const draft = drafts[id] ?? "";
      if (draft.trim().length === 0) {
        setActionError(new Error("Enter a credential before saving."));
        return;
      }
      void (async () => {
        setActionError(undefined);
        try {
          await api.setProviderCredential(id, draft);
          // Cleared immediately so the value is never re-rendered.
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

  const providers = value ?? [];

  return (
    <section className="bayz-panel" aria-labelledby="providers-heading">
      <h2 id="providers-heading">Providers</h2>

      {actionError !== undefined && <PanelError error={actionError} />}
      {error !== undefined && <PanelError error={error} />}
      {loading && <p>Loading providers…</p>}

      <ul className="bayz-list">
        {providers.map((provider) => (
          <li key={provider.id} className="bayz-list-item">
            <div>
              <strong>{provider.displayName}</strong>
              <span>{provider.id}</span>
              <span>{provider.kind}</span>
              <span>{provider.baseUrl}</span>
              <span>{provider.enabled ? "enabled" : "disabled"}</span>
              {/* A boolean indicator only: the value itself is unreadable. */}
              <span data-testid={`credential-${provider.id}`}>
                {provider.credentialPresent ? "Credential stored" : "Credential not set"}
              </span>
            </div>

            <div className="bayz-actions">
              <label htmlFor={`credential-input-${provider.id}`}>
                Credential for {provider.id}
              </label>
              <input
                id={`credential-input-${provider.id}`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={drafts[provider.id] ?? ""}
                onChange={(event) =>
                  setDrafts((current) => ({
                    ...current,
                    [provider.id]: event.target.value,
                  }))
                }
              />
              <button type="button" onClick={() => submitCredential(provider.id)}>
                Save credential for {provider.id}
              </button>
              <button
                type="button"
                onClick={() => void run(() => api.clearProviderCredential(provider.id))}
              >
                Clear credential for {provider.id}
              </button>
              <button
                type="button"
                onClick={() =>
                  void run(() =>
                    api.updateProvider(provider.id, { enabled: !provider.enabled }),
                  )
                }
              >
                {provider.enabled ? `Disable ${provider.id}` : `Enable ${provider.id}`}
              </button>
              <button
                type="button"
                onClick={() =>
                  void run(async () => {
                    const found = await api.discoverModels(provider.id);
                    setModels((current) => ({ ...current, [provider.id]: found }));
                  })
                }
              >
                Discover models for {provider.id}
              </button>
              <button
                type="button"
                onClick={() => void run(() => api.deleteProvider(provider.id))}
              >
                Delete {provider.id}
              </button>
            </div>

            {models[provider.id] !== undefined && (
              <ul className="bayz-models">
                {models[provider.id]!.map((model) => (
                  // React escapes the text, so a hostile model name renders as
                  // text rather than being parsed as markup.
                  <li key={model}>{model}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>

      <form
        className="bayz-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await api.createProvider({
              id: form.id,
              kind: form.kind,
              displayName: form.displayName,
              baseUrl: form.baseUrl,
            });
            setForm({
              id: "",
              kind: "openai-compatible",
              displayName: "",
              baseUrl: "",
            });
          });
        }}
      >
        <label htmlFor="provider-id">Provider id</label>
        <input
          id="provider-id"
          value={form.id}
          onChange={(event) => setForm({ ...form, id: event.target.value })}
        />

        <label htmlFor="provider-kind">Kind</label>
        <select
          id="provider-kind"
          value={form.kind}
          onChange={(event) =>
            setForm({ ...form, kind: event.target.value as ProviderKind })
          }
        >
          {KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>

        <label htmlFor="provider-display-name">Display name</label>
        <input
          id="provider-display-name"
          value={form.displayName}
          onChange={(event) => setForm({ ...form, displayName: event.target.value })}
        />

        <label htmlFor="provider-base-url">Base URL</label>
        <input
          id="provider-base-url"
          value={form.baseUrl}
          onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
        />

        <button type="submit">Add provider</button>
      </form>
    </section>
  );
}
