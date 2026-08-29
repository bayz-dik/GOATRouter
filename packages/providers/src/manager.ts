import { redactSecrets } from "@bayz/security";
import { scopedSecretStorage, type SecretStorage } from "@bayz/storage";
import {
  detectCapabilities as detectProviderCapabilities,
  testConnection as testProviderConnection,
  type ConnectionResult,
  type ProbeTarget,
  type ProviderCapabilities,
} from "./capabilities.js";
import type { ProviderConfig } from "./config.js";
import {
  createCatalogueRepository,
  type CatalogueRepository,
  type CatalogueRow,
} from "./catalogue.js";
import { isFreeEconomics, type ModelEconomics } from "./economics.js";
import { discoverGeminiCatalogue, discoverGeminiModels } from "./discovery-gemini.js";
import { discoverOpenAiCatalogue, discoverOpenAiModels } from "./discovery-openai.js";
import { ProviderError } from "./errors.js";
import type { Fetcher } from "./http.js";
import { assertProviderId } from "./identity.js";
import type { ModelCatalogueEntry } from "./model-list.js";
import {
  createProviderRepository,
  type CreateProviderInput,
  type ProviderRecord,
  type ProviderRepository,
  type UpdateProviderInput,
} from "./repository.js";
import type { ProviderKind } from "./url.js";

/** The single field name every provider credential is stored under. */
const CREDENTIAL_FIELD = "api_key";

/**
 * The config shape a caller is allowed to see.
 *
 * Identical to `ProviderConfig` except that `headers` becomes `headerNames`. Header
 * values are configuration rather than secrets, but echoing them back widens the
 * surface for no benefit: nothing in the dashboard needs to read one, and an operator
 * who has to change a header retypes it. The *names* are kept, because otherwise the
 * operator cannot see which headers are configured at all.
 */
export type ProviderConfigView = Omit<ProviderConfig, "headers"> & {
  headerNames?: string[];
};

/**
 * What callers are allowed to see.
 *
 * `credentialPresent` is a boolean on purpose: there is no accessor anywhere in
 * this package that returns a stored credential to a caller. Plaintext leaves the
 * manager only inside an upstream request header, which is why an executable
 * source-scan test asserts that no credential-reading accessor exists — the rule
 * is enforced against the source text, not just against this comment.
 */
export type ProviderView = {
  id: string;
  kind: ProviderKind;
  displayName: string;
  baseUrl: string;
  enabled: boolean;
  config: ProviderConfigView;
  /**
   * The proxy every route to this provider uses unless the route overrides it.
   *
   * An id, never a password: the password stays in the encrypted secret store under
   * `proxy:<id>:password` and has no accessor here at all.
   */
  proxyId?: string;
  credentialPresent: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProviderLogger = (payload: Record<string, unknown>) => void;

export type CreateProviderManagerOptions = {
  storage: SecretStorage;
  fetcher?: Fetcher;
  logger?: ProviderLogger;
  now?: () => string;
};

export interface ProviderManager {
  createProvider(input: CreateProviderInput): ProviderView;
  getProvider(id: string): ProviderView | undefined;
  requireProvider(id: string): ProviderView;
  listProviders(): ProviderView[];
  /** Ids of provider rows that could not be decoded; see `ProviderRepository.list`. */
  listUnreadableProviders(): string[];
  updateProvider(id: string, patch: UpdateProviderInput): ProviderView;
  deleteProvider(id: string): boolean;
  setCredential(id: string, credential: string): void;
  hasCredential(id: string): boolean;
  deleteCredential(id: string): boolean;
  /**
   * Lend the stored credential to `use` for the duration of one call.
   *
   * This is scoped use, not a getter: the manager never hands a credential back
   * to a caller as a return value, so the source-scan test that forbids a
   * credential accessor still holds. The router needs the plaintext to build one
   * upstream request header and has no reason to hold it afterwards.
   */
  withCredential<T>(id: string, use: (credential: string) => T): T;
  discoverModels(id: string): Promise<string[]>;
  /**
   * Discover models with their economics.
   *
   * Additive: `discoverModels` keeps its `string[]` contract because every existing
   * caller and smoke depends on it. Both go through one collector, so the two cannot
   * disagree about which models exist.
   */
  discoverModelCatalogue(id: string): Promise<ModelCatalogueEntry[]>;
  /**
   * Discover, persist, and return the catalogue.
   *
   * Separate from `discoverModelCatalogue` so a caller can still probe without writing:
   * the API's discover endpoint persists, and a capability probe should not.
   */
  refreshModelCatalogue(id: string): Promise<ModelCatalogueEntry[]>;
  /** The cached classification for one model, or `undefined` if never discovered. */
  modelEconomics(providerId: string, model: string): ModelEconomics | undefined;
  /** Every free (provider, model) pair known, sorted by model then provider. */
  listFreeModels(): CatalogueRow[];
  /**
   * Report what a provider can do.
   *
   * Throws only for a caller error (unknown id, disabled provider). A failed probe is
   * *reported* in the result, because "discovery does not work" answers the question
   * that was asked.
   */
  detectCapabilities(id: string): Promise<ProviderCapabilities>;
  /** Probe reachability. Never throws for an upstream failure; reports it. */
  testConnection(id: string): Promise<ConnectionResult>;
  /**
   * The full stored config, including header **values**, for building a request.
   *
   * Separate from `getProvider` on purpose. `ProviderView.config` withholds header
   * values because it is what the HTTP API serializes, and echoing them back widens
   * the surface for no benefit. The router is in-process and genuinely needs the
   * values to put them on the wire, so it asks for them explicitly — which also means
   * every consumer of the header values is greppable.
   */
  requestConfig(id: string): ProviderConfig;
  /** Provider ids currently defaulting to this proxy, sorted. Empty if unknown. */
  providersUsingProxy(proxyId: string): string[];
  /**
   * Point a batch of providers at one proxy, or at direct with `null`.
   *
   * One call, atomically. This is the operation that makes "assign one proxy to forty
   * providers" a single action instead of forty.
   */
  assignProxy(proxyId: string | null, providerIds: readonly string[]): number;
  close(): void;
}

export function createProviderManager(
  options: CreateProviderManagerOptions,
): ProviderManager {
  const { storage, fetcher, now } = options;
  const log: ProviderLogger = options.logger ?? (() => {});
  const repository: ProviderRepository = createProviderRepository(storage.sql, {
    ...(now === undefined ? {} : { now }),
  });
  const catalogue: CatalogueRepository = createCatalogueRepository(storage.sql, {
    ...(now === undefined ? {} : { now }),
  });

  const credentials = (id: string) =>
    scopedSecretStorage(storage, ["provider", id]);

  /**
   * Read a credential for internal use only.
   *
   * Corruption propagates as `secret_corrupt` rather than being downgraded to
   * "absent": a tampered credential must not look like an unconfigured one.
   */
  const readCredential = (id: string): string | undefined =>
    credentials(id).find(CREDENTIAL_FIELD);

  const present = (id: string): boolean => readCredential(id) !== undefined;

  /** Replace header values with their names. See `ProviderConfigView`. */
  const toConfigView = (config: ProviderConfig): ProviderConfigView => {
    const { headers, ...rest } = config;
    return {
      ...rest,
      ...(headers === undefined ? {} : { headerNames: Object.keys(headers).sort() }),
    };
  };

  const toView = (record: ProviderRecord): ProviderView => ({
    id: record.id,
    kind: record.kind,
    displayName: record.displayName,
    baseUrl: record.baseUrl,
    enabled: record.enabled,
    config: toConfigView(record.config),
    ...(record.proxyId === undefined ? {} : { proxyId: record.proxyId }),
    credentialPresent: present(record.id),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });

  /**
   * Build a probe's inputs from a freshly read row.
   *
   * Read per call rather than cached: a cache keyed on the provider id would report
   * the old endpoint's answer immediately after the operator changed it, which is the
   * one moment they need the new one.
   */
  const probeOptions = (record: ProviderRecord) => {
    const target: ProbeTarget = {
      id: record.id,
      kind: record.kind,
      baseUrl: record.baseUrl,
      enabled: record.enabled,
      config: record.config,
    };
    const credential = readCredential(record.id);
    return {
      target,
      ...(credential === undefined ? {} : { credential }),
      ...(fetcher === undefined ? {} : { fetcher }),
    };
  };

  /** One shape for both discovery entry points, so they cannot drift apart. */
  const discoveryOptions = (record: ProviderRecord) => {
    const credential = readCredential(record.id);
    return {
      provider: {
        kind: record.kind,
        baseUrl: record.baseUrl,
        config: record.config,
      },
      ...(credential === undefined ? {} : { credential }),
      ...(fetcher === undefined ? {} : { fetcher }),
    };
  };

  const manager: ProviderManager = {
    createProvider(input: CreateProviderInput): ProviderView {
      const record = repository.create(input);
      log(redactSecrets({ event: "provider_created", id: record.id, kind: record.kind }));
      return toView(record);
    },

    getProvider(id: string): ProviderView | undefined {
      const record = repository.get(id);
      return record === undefined ? undefined : toView(record);
    },

    requireProvider(id: string): ProviderView {
      return toView(repository.require(id));
    },

    listProviders(): ProviderView[] {
      return repository.list().map(toView);
    },

    listUnreadableProviders(): string[] {
      // Surfaced so the API and dashboard can tell an operator which row to repair; see
      // `ProviderRepository.list`.
      return repository.listUnreadable();
    },

    updateProvider(id: string, patch: UpdateProviderInput): ProviderView {
      const record = repository.update(id, patch);
      log(redactSecrets({ event: "provider_updated", id: record.id }));
      return toView(record);
    },

    deleteProvider(id: string): boolean {
      const validated = assertProviderId(id);
      /*
       * Existence is checked with `exists`, not `get`.
       *
       * `get` decodes the row, so a corrupt `config_json` threw `invalid_provider_config` here and
       * the documented repair — delete the bad provider and recreate it — failed with HTTP 400 on
       * exactly the rows that need it. Found by the 9J upgrade ladder against the installed artifact.
       */
      if (!repository.exists(validated)) {
        return false;
      }
      // The credential goes first: a row removed while its secret survived would
      // leave an unreachable credential in the database forever.
      try {
        credentials(validated).delete(CREDENTIAL_FIELD);
      } catch {
        // A corrupt or absent credential must not block removing the provider.
      }
      const removed = repository.delete(validated);
      if (removed) {
        log(redactSecrets({ event: "provider_deleted", id: validated }));
      }
      return removed;
    },

    setCredential(id: string, credential: string): void {
      const record = repository.require(id);
      if (record.kind === "codex-oauth") {
        // Codex uses an OAuth flow that is not implemented; accepting a static
        // token here would imply working custody that does not exist.
        throw new ProviderError("unsupported_operation", "codex-credential");
      }
      if (typeof credential !== "string" || credential.trim().length === 0) {
        throw new ProviderError("credential_missing", "set-credential");
      }
      credentials(record.id).put(CREDENTIAL_FIELD, credential);
      log(redactSecrets({ event: "provider_credential_set", id: record.id }));
    },

    hasCredential(id: string): boolean {
      return present(repository.require(id).id);
    },

    deleteCredential(id: string): boolean {
      const record = repository.require(id);
      const removed = credentials(record.id).delete(CREDENTIAL_FIELD);
      if (removed) {
        log(redactSecrets({ event: "provider_credential_deleted", id: record.id }));
      }
      return removed;
    },

    withCredential<T>(id: string, use: (credential: string) => T): T {
      const record = repository.require(id);
      if (record.kind === "codex-oauth") {
        throw new ProviderError("unsupported_operation", "codex-credential-use");
      }
      const credential = readCredential(record.id);
      if (credential === undefined) {
        // The callback never runs without a credential, so a caller cannot
        // accidentally send an unauthenticated request believing it was signed.
        throw new ProviderError("credential_missing", "with-credential");
      }
      return use(credential);
    },

    async discoverModels(id: string): Promise<string[]> {
      const record = repository.require(id);
      if (!record.enabled) {
        throw new ProviderError("unsupported_operation", "provider-disabled");
      }
      const options = discoveryOptions(record);

      const models =
        record.kind === "gemini"
          ? await discoverGeminiModels(options)
          : await discoverOpenAiModels(options);

      log(
        redactSecrets({
          event: "provider_models_discovered",
          id: record.id,
          kind: record.kind,
          count: models.length,
        }),
      );
      return models;
    },

    async discoverModelCatalogue(id: string): Promise<ModelCatalogueEntry[]> {
      const record = repository.require(id);
      if (!record.enabled) {
        throw new ProviderError("unsupported_operation", "provider-disabled");
      }
      const options = discoveryOptions(record);

      const entries =
        record.kind === "gemini"
          ? await discoverGeminiCatalogue(options)
          : await discoverOpenAiCatalogue(options);

      log(
        redactSecrets({
          event: "provider_catalogue_discovered",
          id: record.id,
          kind: record.kind,
          count: entries.length,
          // Counts per classification, never a price. The pricing metadata itself is
          // upstream text and has no business in a log line.
          freeCount: entries.filter((entry) => isFreeEconomics(entry.economics)).length,
        }),
      );
      return entries;
    },

    async refreshModelCatalogue(id: string): Promise<ModelCatalogueEntry[]> {
      const entries = await manager.discoverModelCatalogue(id);
      const stored = catalogue.replace(assertProviderId(id), entries);
      log(
        redactSecrets({
          event: "provider_catalogue_stored",
          id,
          count: stored,
        }),
      );
      return entries;
    },

    modelEconomics(providerId: string, model: string): ModelEconomics | undefined {
      return catalogue.get(assertProviderId(providerId), model)?.economics;
    },

    listFreeModels(): CatalogueRow[] {
      return catalogue.listFree();
    },

    requestConfig(id: string): ProviderConfig {
      // A fresh copy, so a caller cannot mutate the row's parsed config in place.
      const { config } = repository.require(id);
      return {
        ...config,
        ...(config.headers === undefined ? {} : { headers: { ...config.headers } }),
      };
    },

    providersUsingProxy(proxyId: string): string[] {
      return repository.providersUsingProxy(proxyId);
    },

    assignProxy(proxyId: string | null, providerIds: readonly string[]): number {
      const changed = repository.assignProxy(proxyId, providerIds);
      log(
        redactSecrets({
          event: "provider_proxy_assigned",
          // The proxy id and a count. Never the password, and never the provider list —
          // a bulk assignment of 200 ids would make the log line the largest thing in
          // the file for no operational benefit.
          proxyId: proxyId ?? "direct",
          providerCount: changed,
        }),
      );
      return changed;
    },

    close(): void {
      storage.close();
    },

    async detectCapabilities(id: string): Promise<ProviderCapabilities> {
      const record = repository.require(id);
      if (!record.enabled) {
        throw new ProviderError("unsupported_operation", "capabilities-disabled");
      }
      const capabilities = await detectProviderCapabilities(probeOptions(record));
      log(
        redactSecrets({
          event: "provider_capabilities_probed",
          id: record.id,
          kind: record.kind,
          models: capabilities.models,
          count: capabilities.modelCount,
          // The code, never a message: an upstream error body is exactly what must
          // not reach a log line.
          ...(capabilities.failureCode === undefined
            ? {}
            : { failureCode: capabilities.failureCode }),
        }),
      );
      return capabilities;
    },

    async testConnection(id: string): Promise<ConnectionResult> {
      const record = repository.require(id);
      const result = await testProviderConnection(probeOptions(record));
      log(
        redactSecrets({
          event: "provider_connection_tested",
          id: record.id,
          ok: result.ok,
          latencyMs: result.latencyMs,
          ...(result.failureCode === undefined
            ? {}
            : { failureCode: result.failureCode }),
        }),
      );
      return result;
    },
  };

  return manager;
}
