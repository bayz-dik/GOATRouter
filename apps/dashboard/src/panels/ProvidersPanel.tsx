import { useCallback, useState } from "react";
import type {
  ConnectionResult,
  CreateProviderBody,
  ProviderConfigInput,
  ProviderKind,
  ProviderView,
} from "../api/types";
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
  testProviderConnection(id: string): Promise<ConnectionResult>;
};

const KINDS: ProviderKind[] = [
  "openai-compatible",
  "openrouter",
  "gemini",
  "codex-oauth",
  "custom-openai",
];

/**
 * The header editor's row count.
 *
 * Matches the server's `MAX_CUSTOM_HEADERS`. Collecting a ninth here would produce a
 * 400 the operator could have been spared.
 */
const HEADER_ROWS = 8;

/** Mirrors the server's rules so a mistake is caught before a round trip. */
const HEADER_NAME_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const HEADER_VALUE_RE = /^[\x20-\x7e]*$/;
const MAX_HEADER_VALUE_LENGTH = 1024;
const DENIED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "host",
  "cookie",
  "set-cookie",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "keep-alive",
  "accept-encoding",
]);
const DENIED_PREFIXES = ["sec-", "proxy-"];

type HeaderRow = { name: string; value: string };

const EMPTY_HEADERS: HeaderRow[] = Array.from({ length: HEADER_ROWS }, () => ({
  name: "",
  value: "",
}));

/**
 * Validate one header row locally.
 *
 * Duplicating the server's rules is deliberate. The server remains the authority — it
 * re-validates everything — but an operator who mistypes a header should be told
 * immediately and by name, not after a round trip that returns a bare code.
 */
function headerRowError(row: HeaderRow, earlier: readonly HeaderRow[]): string | undefined {
  if (row.name.length === 0 && row.value.length === 0) {
    return undefined;
  }
  if (row.name.length === 0) {
    return "A header value needs a name.";
  }
  if (!HEADER_NAME_RE.test(row.name)) {
    return "A header name must start with a letter and contain only letters, digits, and hyphens.";
  }
  const name = row.name.toLowerCase();
  if (DENIED_HEADERS.has(name) || DENIED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    // Named explicitly: `authorization` is the one an operator is most likely to reach
    // for, and "not allowed" without the name is a guessing game.
    return `The header ${name} cannot be set by a provider config.`;
  }
  if (
    earlier.some(
      (other) => other.name.length > 0 && other.name.toLowerCase() === name,
    )
  ) {
    return `The header ${name} is set more than once.`;
  }
  if (row.value.length > MAX_HEADER_VALUE_LENGTH) {
    return "A header value cannot exceed 1024 characters.";
  }
  if (!HEADER_VALUE_RE.test(row.value)) {
    return "A header value must be printable ASCII with no line breaks.";
  }
  return undefined;
}

export function ProvidersPanel({ api }: { api: ProvidersApi }) {
  const { value, error, loading, reload } = useAsync(() => api.listProviders());
  const [actionError, setActionError] = useState<unknown>(undefined);
  const [models, setModels] = useState<Record<string, string[]>>({});
  const [tests, setTests] = useState<Record<string, ConnectionResult>>({});
  // Credential drafts are keyed per provider and cleared the moment they are sent.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [headers, setHeaders] = useState<HeaderRow[]>(EMPTY_HEADERS);
  const [headerErrors, setHeaderErrors] = useState<Record<number, string>>({});
  const [allowLoopback, setAllowLoopback] = useState(false);
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

  /**
   * Build the optional `config` for a create.
   *
   * Returns `undefined` when nothing optional was set, rather than `{}`: an empty
   * object is a different request and would override nothing while looking identical
   * to the operator. The server's defaults should apply.
   */
  const buildConfig = useCallback((): ProviderConfigInput | undefined => {
    const collected: Record<string, string> = {};
    for (const row of headers) {
      if (row.name.length > 0) {
        collected[row.name.toLowerCase()] = row.value;
      }
    }
    const hasHeaders = Object.keys(collected).length > 0;
    if (!hasHeaders && !allowLoopback) {
      return undefined;
    }
    return {
      ...(hasHeaders ? { headers: collected } : {}),
      ...(allowLoopback ? { allowLoopback: true } : {}),
    };
  }, [allowLoopback, headers]);

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
              {provider.config.allowLoopback === true && (
                // Visible after creation so an operator auditing their setup can see
                // which providers may dial the local machine.
                <span data-testid={`loopback-${provider.id}`}>Loopback allowed</span>
              )}
              {provider.config.headerNames !== undefined &&
                provider.config.headerNames.length > 0 && (
                  // Names only. React escapes them, so a hostile name renders as text
                  // rather than being parsed as markup.
                  <span data-testid={`headers-${provider.id}`}>
                    Custom headers: {provider.config.headerNames.join(", ")}
                  </span>
                )}
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
                onClick={() =>
                  void run(async () => {
                    const result = await api.testProviderConnection(provider.id);
                    setTests((current) => ({ ...current, [provider.id]: result }));
                  })
                }
              >
                Test connection for {provider.id}
              </button>
              <button
                type="button"
                onClick={() => void run(() => api.deleteProvider(provider.id))}
              >
                Delete {provider.id}
              </button>
            </div>

            {tests[provider.id] !== undefined && (
              // Rendered as text. An explicit failure code is what separates "bad key"
              // from "dead endpoint" for the operator.
              <p data-testid={`test-result-${provider.id}`}>
                {tests[provider.id]!.ok
                  ? `Reachable in ${tests[provider.id]!.latencyMs} ms, ${
                      tests[provider.id]!.modelCount ?? 0
                    } models`
                  : `Failed after ${tests[provider.id]!.latencyMs} ms: ${
                      tests[provider.id]!.failureCode ?? "unknown"
                    }`}
              </p>
            )}

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

          // Validated before the request, so a mistyped header is reported by name
          // rather than as a bare 400.
          const errors: Record<number, string> = {};
          headers.forEach((row, index) => {
            const failure = headerRowError(row, headers.slice(0, index));
            if (failure !== undefined) {
              errors[index] = failure;
            }
          });
          setHeaderErrors(errors);
          if (Object.keys(errors).length > 0) {
            return;
          }

          const config = buildConfig();
          void run(async () => {
            await api.createProvider({
              id: form.id,
              kind: form.kind,
              displayName: form.displayName,
              baseUrl: form.baseUrl,
              ...(config === undefined ? {} : { config }),
            });
            setForm({
              id: "",
              kind: "openai-compatible",
              displayName: "",
              baseUrl: "",
            });
            setHeaders(EMPTY_HEADERS);
            setAllowLoopback(false);
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

        <fieldset className="bayz-headers">
          <legend>Custom headers</legend>
          {headers.map((row, index) => (
            <div key={index} className="bayz-header-row">
              <label htmlFor={`provider-header-name-${index}`}>
                Header {index + 1} name
              </label>
              <input
                id={`provider-header-name-${index}`}
                value={row.name}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) =>
                  setHeaders((current) =>
                    current.map((existing, position) =>
                      position === index
                        ? { ...existing, name: event.target.value }
                        : existing,
                    ),
                  )
                }
              />
              <label htmlFor={`provider-header-value-${index}`}>
                Header {index + 1} value
              </label>
              <input
                id={`provider-header-value-${index}`}
                value={row.value}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) =>
                  setHeaders((current) =>
                    current.map((existing, position) =>
                      position === index
                        ? { ...existing, value: event.target.value }
                        : existing,
                    ),
                  )
                }
              />
              {headerErrors[index] !== undefined && (
                <span data-testid={`header-error-${index}`} role="alert">
                  {headerErrors[index]}
                </span>
              )}
            </div>
          ))}
        </fieldset>

        <label htmlFor="provider-allow-loopback">
          Allow loopback (local model runtime)
        </label>
        <input
          id="provider-allow-loopback"
          type="checkbox"
          checked={allowLoopback}
          onChange={(event) => setAllowLoopback(event.target.checked)}
        />
        <span data-testid="loopback-warning">
          Only enable this for a model runtime on this machine. It permits BAYZ to
          connect to 127.0.0.1, which is otherwise refused.
        </span>

        <button type="submit">Add provider</button>
      </form>
    </section>
  );
}
