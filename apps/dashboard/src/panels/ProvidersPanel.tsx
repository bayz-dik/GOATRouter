import { useCallback, useMemo, useState } from "react";
import type {
  ConnectionResult,
  CreateProviderBody,
  ModelCatalogueEntry,
  ProviderConfigInput,
  ProviderKind,
  ProviderView,
  ProxyAssignResult,
  ProxyUnassignResult,
  ProxyView,
} from "../api/types";
import { asEconomics, describeEconomics, isFreeEconomics } from "../api/types";
import { PanelError, useAsync, type PanelHeadingProps } from "./shared";

/** Only the calls this panel needs, so a test can supply a narrow stub. */
export type ProvidersApi = {
  listProviders(): Promise<ProviderView[]>;
  createProvider(body: CreateProviderBody): Promise<ProviderView>;
  updateProvider(id: string, body: { enabled?: boolean }): Promise<ProviderView>;
  deleteProvider(id: string): Promise<void>;
  setProviderCredential(id: string, value: string): Promise<void>;
  clearProviderCredential(id: string): Promise<void>;
  discoverModels(id: string): Promise<string[]>;
  /**
   * Models with their economics.
   *
   * Separate from `discoverModels` so the legacy `string[]` caller keeps working; this
   * is the call the free-first list uses.
   */
  discoverModelCatalogue(id: string): Promise<ModelCatalogueEntry[]>;
  testProviderConnection(id: string): Promise<ConnectionResult>;
  /** Proxies offered in the bulk-assign selector. */
  listProxies(): Promise<ProxyView[]>;
  assignProxy(id: string, providerIds: string[]): Promise<ProxyAssignResult>;
  unassignProxy(id: string, providerIds: string[]): Promise<ProxyUnassignResult>;
};

/**
 * The largest batch one assignment call may carry.
 *
 * Mirrors the server's `MAX_BULK_PROVIDER_IDS`. The panel refuses a larger selection
 * rather than splitting it: two calls would give up the single transaction the server
 * provides, and a half-applied assignment is worse than a refused one.
 */
const MAX_BULK_PROVIDER_IDS = 200;


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

/**
 * Derive a legal provider id from a display name.
 *
 * The id is not cosmetic: it becomes part of the physical secret name
 * `provider:<id>:api_key`, so `assertProviderId` in `@bayz/providers` restricts it to
 * `^[a-z0-9][a-z0-9-]{0,62}$` with no trailing hyphen. Asking an operator to satisfy that
 * by hand, as the first field of the form, was the single largest cost of adding a
 * provider — and getting it wrong produced `invalid_provider_id`, which reads as a bug.
 *
 * Derivation is mirrored from the server's rule rather than imported, because the server
 * remains the authority and re-validates; this only spares a round trip. An id that cannot
 * be derived (a name of pure punctuation, or of a non-Latin script) yields `""`, and the
 * form then says so instead of sending something the server will refuse.
 */
export function deriveProviderId(displayName: string): string {
  return displayName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 63)
    .replace(/-+$/, "");
}

/**
 * The derived id, made unique against the ids already in use.
 *
 * Two providers called "Relay" are a normal thing to want; a silent 409 on the second is
 * not. The suffix keeps the result inside the 63-character bound.
 */
export function uniqueProviderId(base: string, taken: readonly string[]): string {
  if (base.length === 0) {
    return "";
  }
  const used = new Set(taken);
  if (!used.has(base)) {
    return base;
  }
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${base.slice(0, 63 - tail.length).replace(/-+$/, "")}${tail}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  return "";
}

/**
 * Provider kinds that can be recognised from the endpoint itself.
 *
 * Only hosts whose kind is a *fact* are listed. The kind decides the discovery path and
 * the auth shape — `gemini` uses `/v1beta/models` and a query-parameter key, the others use
 * `/v1/models` and a bearer header — so guessing it from an unknown host would silently
 * misconfigure both. Where it cannot be recognised the form asks; that is what
 * "kind only if required" means in practice.
 */
const KIND_BY_HOST: ReadonlyArray<readonly [RegExp, ProviderKind]> = [
  [/(^|\.)openrouter\.ai$/, "openrouter"],
  [/(^|\.)generativelanguage\.googleapis\.com$/, "gemini"],
];

/** The kind implied by a base URL, or `undefined` when the host says nothing. */
export function inferProviderKind(baseUrl: string): ProviderKind | undefined {
  let host: string;
  try {
    host = new URL(baseUrl.trim()).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  for (const [pattern, kind] of KIND_BY_HOST) {
    if (pattern.test(host)) {
      return kind;
    }
  }
  return undefined;
}

/**
 * Whether a base URL points at this machine.
 *
 * The server refuses a loopback address unless `allowLoopback` is set, so a local runtime
 * entered without it is a guaranteed 400. The opt-in itself stays under Advanced — it is an
 * authorisation, not a routine field — but the primary flow says when it is needed.
 */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl.trim()).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    /^127\./.test(host) ||
    host.endsWith(".localhost")
  );
}

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

/**
 * A provider's models, free ones first and paid ones withheld.
 *
 * Extracted as its own component because it owns real logic — classification, ordering,
 * and the hidden count — unlike the assign bar in Task 5, which was four pieces of state
 * with one call site.
 *
 * `UNKNOWN` is grouped with `PAID`. Absence of a price is not evidence of zero, so an
 * unclassified model must not be offered as free.
 */
function CatalogueList({
  providerId,
  entries,
  paidShown,
  onShowPaid,
}: {
  providerId: string;
  entries: readonly ModelCatalogueEntry[];
  paidShown: boolean;
  onShowPaid: () => void;
}) {
  // `asEconomics` narrows an untrusted value: a tampered or future classification reads
  // as UNKNOWN, so it groups with paid rather than becoming silently spendable.
  const classified = entries.map((entry) => ({
    id: entry.id,
    economics: asEconomics(entry.economics),
  }));
  const free = classified.filter((entry) => isFreeEconomics(entry.economics));
  const paid = classified.filter((entry) => !isFreeEconomics(entry.economics));
  const visible = paidShown ? [...free, ...paid] : free;

  return (
    <div>
      <ul className="bayz-models" data-testid={`catalogue-list-${providerId}`}>
        {visible.map((entry) => (
          // React escapes both values, so a hostile id or classification renders as text
          // rather than being parsed as markup.
          <li
            key={entry.id}
            data-testid={`model-${entry.id}`}
            data-economics={entry.economics}
          >
            <span>{entry.id}</span>
            <span>{describeEconomics(entry.economics)}</span>
          </li>
        ))}
      </ul>
      {paid.length > 0 && !paidShown && (
        <p data-testid={`paid-hidden-count-${providerId}`}>
          {/* Disclosed, never silent: hiding a count is how an operator concludes a
              model is missing rather than withheld. */}
          {`${paid.length} paid or unclassified model(s) hidden`}
          <button type="button" data-testid={`show-paid-${providerId}`} onClick={onShowPaid}>
            Show paid models for {providerId}
          </button>
        </p>
      )}
    </div>
  );
}

export function ProvidersPanel({
  api,
  headingId,
}: { api: ProvidersApi } & PanelHeadingProps) {
  const { value, error, loading, reload } = useAsync(() => api.listProviders());
  const proxies = useAsync(() => api.listProxies());
  const [actionError, setActionError] = useState<unknown>(undefined);
  const [models, setModels] = useState<Record<string, string[]>>({});
  /*
   * The economics-bearing catalogue, per provider.
   *
   * Kept separate from `models` rather than replacing it: `discoverModels` remains the
   * legacy `string[]` call and other tests depend on its behaviour.
   */
  const [catalogues, setCatalogues] = useState<
    Record<string, ModelCatalogueEntry[]>
  >({});
  /** Providers whose paid models the operator has explicitly asked to see. */
  const [paidShown, setPaidShown] = useState<Record<string, boolean>>({});
  const [tests, setTests] = useState<Record<string, ConnectionResult>>({});
  // Credential drafts are keyed per provider and cleared the moment they are sent.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [headers, setHeaders] = useState<HeaderRow[]>(EMPTY_HEADERS);
  const [headerErrors, setHeaderErrors] = useState<Record<number, string>>({});
  const [allowLoopback, setAllowLoopback] = useState(false);
  /**
   * Advanced is collapsed by default, and that is the whole point of this pass.
   *
   * The form used to open with `Provider id` — a field whose alphabet is dictated by the
   * secret-name grammar — followed by `Kind`, then sixteen header inputs and a loopback
   * authorisation, before reaching the three things an operator actually knows: what to
   * call it, where it lives, and the key. Everything that is a *fact about the endpoint*
   * is now primary; everything that is an override or an authorisation is behind here.
   */
  const [advancedOpen, setAdvancedOpen] = useState(false);
  /** An explicit id, when the operator overrides the one derived from the name. */
  const [idOverride, setIdOverride] = useState("");
  /**
   * An explicit kind, when the base URL does not imply one.
   *
   * Empty means "not chosen": the form then uses the inferred kind, and asks only when
   * inference fails. Stored separately from the inferred value so that typing a
   * recognised URL cannot silently overwrite a deliberate choice.
   */
  const [kindOverride, setKindOverride] = useState<ProviderKind | "">("");
  /**
   * Compatibility overrides, held as strings.
   *
   * Strings rather than numbers because an empty field must mean "server default" and
   * `Number("")` is `0`, which is a different request that the server would refuse. They
   * are parsed once, at submit.
   */
  const [discoveryPath, setDiscoveryPath] = useState("");
  const [timeoutMs, setTimeoutMs] = useState("");
  const [modelLimit, setModelLimit] = useState("");
  /** `""` = undetermined, which is a real answer and the server's default. */
  const [supportsTools, setSupportsTools] = useState<"" | "yes" | "no">("");
  /** The API key for the provider being created. Cleared the moment it is sent. */
  const [newCredential, setNewCredential] = useState("");
  /** The result of the create's own connection test, when one was asked for. */
  const [createTest, setCreateTest] = useState<ConnectionResult | undefined>(undefined);
  const [createNote, setCreateNote] = useState<string | undefined>(undefined);
  // Bulk assignment state. `selected` holds ids, not indexes, so it survives a
  // reload that reorders or shortens the list.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState("");
  const [assignProxyId, setAssignProxyId] = useState("");
  const [assignNote, setAssignNote] = useState<string | undefined>(undefined);
  const [form, setForm] = useState({
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
   *
   * Every field here comes from Advanced. A number is sent only when the operator typed
   * one — `Number("")` is `0`, which the server refuses as out of range, so an empty box
   * must not become a value.
   */
  const buildConfig = useCallback((): ProviderConfigInput | undefined => {
    const collected: Record<string, string> = {};
    for (const row of headers) {
      if (row.name.length > 0) {
        collected[row.name.toLowerCase()] = row.value;
      }
    }
    const hasHeaders = Object.keys(collected).length > 0;
    const timeout = timeoutMs.trim().length > 0 ? Number(timeoutMs) : undefined;
    const limit = modelLimit.trim().length > 0 ? Number(modelLimit) : undefined;
    const path = discoveryPath.trim();
    const config: ProviderConfigInput = {
      ...(hasHeaders ? { headers: collected } : {}),
      ...(allowLoopback ? { allowLoopback: true } : {}),
      ...(path.length > 0 ? { discoveryPath: path } : {}),
      ...(timeout !== undefined && Number.isFinite(timeout) ? { timeoutMs: timeout } : {}),
      ...(limit !== undefined && Number.isFinite(limit) ? { modelLimit: limit } : {}),
      ...(supportsTools === "" ? {} : { supportsTools: supportsTools === "yes" }),
    };
    return Object.keys(config).length === 0 ? undefined : config;
  }, [allowLoopback, discoveryPath, headers, modelLimit, supportsTools, timeoutMs]);

  const providers = value ?? [];

  /*
   * ================= the primary create flow =================
   *
   * Four things reach the operator: display name, base URL, API key, and a kind selector
   * that appears only when the URL does not imply one. Everything else the server accepts
   * is an override, and overrides live under Advanced.
   */

  /** The kind the endpoint itself implies, when it implies one. */
  const inferredKind = useMemo(() => inferProviderKind(form.baseUrl), [form.baseUrl]);

  /**
   * Whether the operator is *shown* a kind selector.
   *
   * Only when the host is not one that can be recognised. A URL is required first: asking
   * about an endpoint that has not been named yet is asking a question whose answer might
   * be derivable a keystroke later.
   *
   * It is shown, not demanded. `openai-compatible` is the correct answer for an arbitrary
   * `/v1` endpoint and is preselected, so the primary flow stays three fields long — an
   * earlier version *blocked* on an explicit choice here, which added a mandatory step to
   * every self-hosted relay and is exactly the friction this pass exists to remove. What
   * must not happen is a *silent* guess, so the control is visible whenever it is a guess.
   */
  const kindVisible = form.baseUrl.trim().length > 0 && inferredKind === undefined;

  /** The kind that will actually be sent. Explicit choice beats inference. */
  const effectiveKind: ProviderKind =
    kindOverride !== "" ? kindOverride : (inferredKind ?? "openai-compatible");

  /**
   * The id that will actually be sent.
   *
   * Derived from the display name and made unique against the existing providers, unless
   * the operator overrode it under Advanced. Shown read-only in the primary flow so the
   * value is never a surprise — it is what appears in every log line and in the secret
   * name — but it is not a field they have to fill in.
   */
  const derivedId = useMemo(
    () => uniqueProviderId(deriveProviderId(form.displayName), providers.map((p) => p.id)),
    [form.displayName, providers],
  );
  const effectiveId = idOverride.trim().length > 0 ? idOverride.trim() : derivedId;

  /**
   * A loopback URL entered without the Advanced opt-in.
   *
   * A **warning, not a blocker**, and the distinction was established by reading the server
   * rather than assumed: `allowLoopback` is consulted by the egress classifier at
   * request/probe time (`packages/providers/src/egress.ts`), not by `createProvider`. So the
   * row is created either way, and refusing to create it here would invent a rule the API
   * does not have and break a legitimate workflow — entering the provider now and
   * authorising loopback later. What the operator does need is to be told *before* their
   * first request fails as `unreachable`.
   */
  const loopbackWarning = isLoopbackBaseUrl(form.baseUrl) && !allowLoopback;

  /**
   * Everything wrong with the form right now, as one message or none.
   *
   * Returned rather than thrown so both buttons can consult it: an "Add and test" that
   * dials nothing because a field is blank must say which field, not report a failed
   * connection.
   */
  const createBlocker = useMemo((): string | undefined => {
    if (form.displayName.trim().length === 0) {
      return "Enter a display name.";
    }
    if (form.baseUrl.trim().length === 0) {
      return "Enter the provider's base URL.";
    }
    if (effectiveId.length === 0) {
      return idOverride.trim().length > 0
        ? "That provider id is not usable. Use lowercase letters, digits and hyphens."
        : "A provider id could not be derived from that name. Set one under Advanced.";
    }
    return undefined;
  }, [effectiveId, form.baseUrl, form.displayName, idOverride]);

  /** Header validation, shared by Add and Test so neither can send an invalid set. */
  const validateHeaders = useCallback((): boolean => {
    const errors: Record<number, string> = {};
    headers.forEach((row, index) => {
      const failure = headerRowError(row, headers.slice(0, index));
      if (failure !== undefined) {
        errors[index] = failure;
      }
    });
    setHeaderErrors(errors);
    return Object.keys(errors).length === 0;
  }, [headers]);

  const resetCreateForm = useCallback(() => {
    setForm({ displayName: "", baseUrl: "" });
    setHeaders(EMPTY_HEADERS);
    setAllowLoopback(false);
    setIdOverride("");
    setKindOverride("");
    setDiscoveryPath("");
    setTimeoutMs("");
    setModelLimit("");
    setSupportsTools("");
    setNewCredential("");
  }, []);

  /**
   * Create the provider, store its key, and report what happened.
   *
   * The key goes through `setProviderCredential`, which is the same encrypted-storage path
   * the per-row credential field uses — `PUT /api/providers/:id/credential`, a body of
   * exactly `{ value }`, a 204 with no echo, and no read accessor anywhere. Nothing new was
   * added for this flow, and the draft is cleared the moment it is sent so it is never
   * re-rendered.
   *
   * `thenTest` runs the connection test against the created provider afterwards. It has to
   * be afterwards: the test endpoint dials a *stored* provider using its stored credential,
   * so there is nothing to test until both exist. That is also why Test Connection creates.
   */
  const submitCreate = useCallback(
    (thenTest: boolean) => {
      setCreateNote(undefined);
      setCreateTest(undefined);
      if (createBlocker !== undefined) {
        setActionError(new Error(createBlocker));
        return;
      }
      if (!validateHeaders()) {
        return;
      }
      const config = buildConfig();
      const id = effectiveId;
      const credential = newCredential;
      void (async () => {
        setActionError(undefined);
        try {
          await api.createProvider({
            id,
            kind: effectiveKind,
            displayName: form.displayName.trim(),
            baseUrl: form.baseUrl.trim(),
            ...(config === undefined ? {} : { config }),
          });
          if (credential.trim().length > 0) {
            await api.setProviderCredential(id, credential);
          }
          // Cleared before anything can re-render with it in state.
          resetCreateForm();
          if (thenTest) {
            const result = await api.testProviderConnection(id);
            setCreateTest(result);
          }
          setCreateNote(
            `Added ${id}.` +
              (credential.trim().length > 0 ? " API key stored." : " No API key stored yet.") +
              " Routing is direct unless you assign a proxy.",
          );
          reload();
        } catch (failure) {
          // The key is dropped on failure too: a half-created provider must not leave a
          // secret sitting in component state waiting for a second submit.
          setNewCredential("");
          setActionError(failure);
        }
      })();
    },
    [
      api,
      buildConfig,
      createBlocker,
      effectiveId,
      effectiveKind,
      form.baseUrl,
      form.displayName,
      newCredential,
      reload,
      resetCreateForm,
      validateHeaders,
    ],
  );

  /**
   * The rows the filter leaves visible.
   *
   * Matching is on id and display name, lowercased — the two things an operator reads
   * off a row. Substring rather than prefix: "groq" should find "eu-groq-3".
   */
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) {
      return providers;
    }
    return providers.filter(
      (provider) =>
        provider.id.toLowerCase().includes(needle) ||
        provider.displayName.toLowerCase().includes(needle),
    );
  }, [filter, providers]);

  const toggleOne = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  /**
   * Select-all operates on the *visible* rows only.
   *
   * With a filter applied, "all" can only sensibly mean what the operator is looking
   * at. Rows hidden by the filter keep whatever selection they already had — quietly
   * dropping a selection the operator made would lose work.
   */
  const allVisibleSelected =
    visible.length > 0 && visible.every((provider) => selected.has(provider.id));

  const toggleAllVisible = useCallback(() => {
    setSelected((current) => {
      const next = new Set(current);
      const everySelected =
        visible.length > 0 && visible.every((provider) => next.has(provider.id));
      for (const provider of visible) {
        if (everySelected) {
          next.delete(provider.id);
        } else {
          next.add(provider.id);
        }
      }
      return next;
    });
  }, [visible]);

  /**
   * Run one bulk call for the whole selection.
   *
   * A failure keeps the selection: rebuilding a 40-provider selection by hand after a
   * transient 502 would be punishing, and the server applied nothing.
   */
  const runBulk = useCallback(
    (mode: "assign" | "direct") => {
      const ids = [...selected];
      setAssignNote(undefined);
      if (ids.length === 0) {
        setActionError(new Error("Select at least one provider first."));
        return;
      }
      if (assignProxyId.length === 0) {
        setActionError(new Error("Choose a proxy before assigning."));
        return;
      }
      if (ids.length > MAX_BULK_PROVIDER_IDS) {
        setActionError(
          new Error(
            `A single assignment carries at most ${MAX_BULK_PROVIDER_IDS} providers. ` +
              `${ids.length} are selected — narrow the filter and assign in batches.`,
          ),
        );
        return;
      }
      void (async () => {
        setActionError(undefined);
        try {
          if (mode === "assign") {
            const result = await api.assignProxy(assignProxyId, ids);
            setAssignNote(
              `Assigned ${result.providerCount} providers to ${result.proxyId}` +
                (result.proxyEnabled ? "." : " — that proxy is disabled, so traffic stays direct until it is enabled.") +
                (result.notes.length > 0 ? ` Notes: ${result.notes.join(", ")}.` : ""),
            );
          } else {
            const result = await api.unassignProxy(assignProxyId, ids);
            setAssignNote(
              `Set ${result.providerCount} providers to direct; ` +
                `${result.detachedFromProxy} were using ${result.proxyId}.`,
            );
          }
          setSelected(new Set());
          reload();
        } catch (failure) {
          setActionError(failure);
        }
      })();
    },
    [api, assignProxyId, reload, selected],
  );

  return (
    <section
      className="bayz-panel"
      aria-labelledby={headingId ?? "providers-heading"}
    >
      {/*
        The panel prints its own heading only when it is not already labelled by the
        screen's. Two `Providers` headings on one screen is a caption restating its
        caption — the same rule that removed the kickers.
      */}
      {headingId === undefined && <h2 id="providers-heading">Providers</h2>}

      {actionError !== undefined && <PanelError error={actionError} />}
      {error !== undefined && <PanelError error={error} />}
      {loading && <p>Loading providers…</p>}

      <div className="bayz-bulk-controls">
        <label htmlFor="provider-filter">Filter providers</label>
        <input
          id="provider-filter"
          data-testid="provider-filter"
          value={filter}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setFilter(event.target.value)}
        />
        <label htmlFor="provider-select-all">Select all providers</label>
        <input
          id="provider-select-all"
          data-testid="provider-select-all"
          type="checkbox"
          checked={allVisibleSelected}
          onChange={toggleAllVisible}
        />
        <span data-testid="provider-visible-count">
          {visible.length} of {providers.length} shown
        </span>
      </div>

      {selected.size > 0 && (
        // Only shown with a selection: an always-present bar inviting a bulk write on
        // nothing is a footgun.
        <div className="bayz-assign-bar" data-testid="proxy-assign-bar" role="group" aria-label="Bulk proxy assignment">
          <span>{selected.size} selected</span>
          <label htmlFor="bulk-proxy-id">Proxy to assign</label>
          <select
            id="bulk-proxy-id"
            data-testid="bulk-proxy-id"
            value={assignProxyId}
            onChange={(event) => setAssignProxyId(event.target.value)}
          >
            <option value="">Choose a proxy…</option>
            {(proxies.value ?? []).map((proxy) => (
              // Text nodes only; React escapes a hostile id rather than parsing it.
              <option key={proxy.id} value={proxy.id}>
                {proxy.id} ({proxy.kind} {proxy.host}:{proxy.port})
                {proxy.enabled ? "" : " — disabled"}
              </option>
            ))}
          </select>
          <button type="button" data-testid="assign-to-proxy" onClick={() => runBulk("assign")}>
            Assign to proxy
          </button>
          <button type="button" data-testid="set-to-direct" onClick={() => runBulk("direct")}>
            Set to direct
          </button>
          <button type="button" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}

      {assignNote !== undefined && <p data-testid="assign-result">{assignNote}</p>}

      <ul className="bayz-list">
        {visible.map((provider) => (
          <li
            key={provider.id}
            className="bayz-list-item"
            data-testid={`provider-row-${provider.id}`}
          >
            <div>
              <label htmlFor={`select-${provider.id}`}>Select {provider.id}</label>
              <input
                id={`select-${provider.id}`}
                data-testid={`select-${provider.id}`}
                type="checkbox"
                checked={selected.has(provider.id)}
                onChange={() => toggleOne(provider.id)}
              />
              <strong>{provider.displayName}</strong>
              <span>{provider.id}</span>
              <span>{provider.kind}</span>
              <span>{provider.baseUrl}</span>
              <span>{provider.enabled ? "enabled" : "disabled"}</span>
              {/* An id, never a password: the proxy password has no accessor at all. */}
              <span data-testid={`provider-proxy-${provider.id}`}>
                {provider.proxyId === undefined
                  ? "Direct"
                  : `Proxy ${provider.proxyId}`}
              </span>
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
                data-testid={`catalogue-${provider.id}`}
                onClick={() =>
                  void run(async () => {
                    const found = await api.discoverModelCatalogue(provider.id);
                    setCatalogues((current) => ({ ...current, [provider.id]: found }));
                    // Each fresh discovery re-hides paid models. The operator's earlier
                    // "show paid" was a decision about a list that no longer exists.
                    setPaidShown((current) => ({ ...current, [provider.id]: false }));
                  })
                }
              >
                List models with pricing for {provider.id}
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
            {catalogues[provider.id] !== undefined && (
              <CatalogueList
                providerId={provider.id}
                entries={catalogues[provider.id]!}
                paidShown={paidShown[provider.id] === true}
                onShowPaid={() =>
                  setPaidShown((current) => ({ ...current, [provider.id]: true }))
                }
              />
            )}
          </li>
        ))}
      </ul>

      {/*
        ================= add a provider =================

        The primary flow asks for what an operator knows: what to call it, where it is, and
        the key. `Kind` appears only when the base URL is not one that can be recognised;
        the provider id, custom headers, the loopback authorisation and the compatibility
        overrides are all under Advanced, collapsed.

        `Test connection` sits beside `Add provider` rather than before it, because the test
        endpoint dials a *stored* provider with its *stored* credential — there is nothing
        to dial until the provider exists. So Test creates and then tests, and says so on
        its own button. Testing an unsaved form would have to be a second, credential-taking
        endpoint, which is a secret-bearing surface this product does not need.
      */}
      <form
        className="bayz-form"
        data-testid="add-provider-form"
        onSubmit={(event) => {
          event.preventDefault();
          submitCreate(false);
        }}
      >
        <h3>Add a provider</h3>

        <label htmlFor="provider-display-name">Display name</label>
        <input
          id="provider-display-name"
          value={form.displayName}
          autoComplete="off"
          onChange={(event) => setForm({ ...form, displayName: event.target.value })}
        />

        <label htmlFor="provider-base-url">Base URL</label>
        <input
          id="provider-base-url"
          value={form.baseUrl}
          autoComplete="off"
          spellCheck={false}
          placeholder="https://api.example.com/v1"
          onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
        />

        {/*
          The key. Same encrypted path as the per-row field: it is sent as its own
          `PUT …/credential` request with a body of exactly `{ value }`, the server answers
          204 with no echo, and there is no read accessor anywhere in the API. Optional,
          because `codex-oauth` has no key to paste and a local runtime often needs none.
        */}
        <label htmlFor="provider-api-key">API key</label>
        <input
          id="provider-api-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={newCredential}
          onChange={(event) => setNewCredential(event.target.value)}
        />
        <span className="bayz-note" data-testid="api-key-note">
          Stored encrypted and never shown again. Leave blank if this provider needs no key.
        </span>

        {/* The derived id, shown so it is never a surprise — it appears in every log line. */}
        {effectiveId.length > 0 && (
          <span className="bayz-note" data-testid="derived-provider-id">
            Provider id: {effectiveId}
          </span>
        )}

        {/*
          Shown only when the endpoint does not answer the question, and preselected with
          the answer that is correct for an arbitrary `/v1` endpoint. A recognised host
          reports what was inferred instead, so the operator can see it was not a guess.
        */}
        {kindVisible ? (
          <>
            <label htmlFor="provider-kind">Kind</label>
            <select
              id="provider-kind"
              data-testid="provider-kind"
              value={kindOverride}
              onChange={(event) =>
                setKindOverride(event.target.value as ProviderKind | "")
              }
            >
              <option value="">openai-compatible</option>
              {KINDS.filter((kind) => kind !== "openai-compatible").map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
            <span className="bayz-note" data-testid="kind-note">
              This host is not one that can be recognised, so the kind is stated rather than
              guessed: it decides how models are discovered and how the key is sent.
            </span>
          </>
        ) : (
          inferredKind !== undefined && (
            <span className="bayz-note" data-testid="inferred-kind">
              Kind: {inferredKind} (recognised from the URL)
            </span>
          )
        )}

        {/*
          A loopback address is legal to store and will fail at request time without the
          Advanced opt-in — the egress classifier decides that, not the create call. So this
          warns rather than blocks.
        */}
        {loopbackWarning && (
          <span className="bayz-note" data-testid="loopback-hint">
            That address is on this machine. Requests to it are refused until you allow
            loopback under Advanced.
          </span>
        )}

        {/* Routing is direct by default. Stated here so it is never assumed otherwise. */}
        <span className="bayz-note" data-testid="proxy-optional-note">
          Traffic goes direct. A proxy is optional — assign one later from the list above if
          you want this provider routed through it.
        </span>

        <div className="bayz-actions">
          <button type="submit">Add provider</button>
          <button
            type="button"
            data-testid="create-and-test"
            onClick={() => submitCreate(true)}
          >
            Add and test connection
          </button>
        </div>

        {createNote !== undefined && (
          <p className="bayz-note" data-testid="create-result">
            {createNote}
          </p>
        )}
        {createTest !== undefined && (
          // Text nodes only, exactly as the per-row result is: a failure code is an
          // upstream-influenced string and must never be parsed.
          <p data-testid="create-test-result">
            {createTest.ok
              ? `Reachable in ${createTest.latencyMs} ms, ${createTest.modelCount ?? 0} models`
              : `Failed after ${createTest.latencyMs} ms: ${createTest.failureCode ?? "unknown"}`}
          </p>
        )}

        {/*
          Advanced. A real `<details>` rather than a state-toggled `div`: it is keyboard
          operable and screen-reader announced without any code, and its content stays in
          the DOM so a validation error inside it can still be found and reported.
        */}
        <details
          className="bayz-advanced"
          data-testid="provider-advanced"
          open={advancedOpen}
          onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
        >
          <summary>Advanced</summary>

          <label htmlFor="provider-id">Provider id override</label>
          <input
            id="provider-id"
            value={idOverride}
            autoComplete="off"
            spellCheck={false}
            placeholder={derivedId}
            onChange={(event) => setIdOverride(event.target.value)}
          />
          <span className="bayz-note" data-testid="provider-id-note">
            Derived from the display name unless set here. Lowercase letters, digits and
            hyphens only — the id becomes part of the stored secret's name, so its alphabet
            is not cosmetic.
          </span>

          {/*
            The kind selector is here as well as in the primary flow, because an operator
            may want to override a recognised host — a self-hosted OpenRouter-compatible
            relay, say. When it is required, the primary copy above is the one that asks.
          */}
          <label htmlFor="provider-kind-advanced">Kind override</label>
          <select
            id="provider-kind-advanced"
            value={kindOverride}
            onChange={(event) => setKindOverride(event.target.value as ProviderKind | "")}
          >
            <option value="">
              {inferredKind === undefined
                ? "openai-compatible (default)"
                : `${inferredKind} (recognised)`}
            </option>
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>

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

          <fieldset className="bayz-compat">
            <legend>Compatibility</legend>

            <label htmlFor="provider-discovery-path">Discovery path</label>
            <input
              id="provider-discovery-path"
              value={discoveryPath}
              autoComplete="off"
              spellCheck={false}
              placeholder={effectiveKind === "gemini" ? "/v1beta/models" : "/v1/models"}
              onChange={(event) => setDiscoveryPath(event.target.value)}
            />

            <label htmlFor="provider-timeout-ms">Request timeout (ms)</label>
            <input
              id="provider-timeout-ms"
              type="number"
              min={1000}
              max={120000}
              value={timeoutMs}
              autoComplete="off"
              placeholder="30000"
              onChange={(event) => setTimeoutMs(event.target.value)}
            />

            <label htmlFor="provider-model-limit">Model limit</label>
            <input
              id="provider-model-limit"
              type="number"
              min={1}
              max={500}
              value={modelLimit}
              autoComplete="off"
              placeholder="100"
              onChange={(event) => setModelLimit(event.target.value)}
            />

            {/*
              Three states, not a checkbox. `unknown` is a real answer that the capability
              report prints as `undetermined`, and a two-state control would force the
              operator to assert something they may not know.
            */}
            <label htmlFor="provider-supports-tools">Tool calling</label>
            <select
              id="provider-supports-tools"
              value={supportsTools}
              onChange={(event) =>
                setSupportsTools(event.target.value as "" | "yes" | "no")
              }
            >
              <option value="">Undetermined (default)</option>
              <option value="yes">Supported</option>
              <option value="no">Not supported</option>
            </select>
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
            Only enable this for a model runtime on this machine. It permits GOAT ROUTER
            to connect to 127.0.0.1, which is otherwise refused.
          </span>
        </details>
      </form>
    </section>
  );
}
