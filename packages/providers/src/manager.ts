import { redactSecrets } from "@bayz/security";
import { scopedSecretStorage, type SecretStorage } from "@bayz/storage";
import type { ProviderConfig } from "./config.js";
import { discoverGeminiModels } from "./discovery-gemini.js";
import { discoverOpenAiModels } from "./discovery-openai.js";
import { ProviderError } from "./errors.js";
import type { Fetcher } from "./http.js";
import { assertProviderId } from "./identity.js";
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
  config: ProviderConfig;
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
  updateProvider(id: string, patch: UpdateProviderInput): ProviderView;
  deleteProvider(id: string): boolean;
  setCredential(id: string, credential: string): void;
  hasCredential(id: string): boolean;
  deleteCredential(id: string): boolean;
  discoverModels(id: string): Promise<string[]>;
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

  const toView = (record: ProviderRecord): ProviderView => ({
    id: record.id,
    kind: record.kind,
    displayName: record.displayName,
    baseUrl: record.baseUrl,
    enabled: record.enabled,
    config: record.config,
    credentialPresent: present(record.id),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });

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

    updateProvider(id: string, patch: UpdateProviderInput): ProviderView {
      const record = repository.update(id, patch);
      log(redactSecrets({ event: "provider_updated", id: record.id }));
      return toView(record);
    },

    deleteProvider(id: string): boolean {
      const validated = assertProviderId(id);
      if (repository.get(validated) === undefined) {
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

    async discoverModels(id: string): Promise<string[]> {
      const record = repository.require(id);
      if (!record.enabled) {
        throw new ProviderError("unsupported_operation", "provider-disabled");
      }
      const credential = readCredential(record.id);
      const target = {
        kind: record.kind,
        baseUrl: record.baseUrl,
        config: record.config,
      };

      const models =
        record.kind === "gemini"
          ? await discoverGeminiModels({
              provider: target,
              ...(credential === undefined ? {} : { credential }),
              ...(fetcher === undefined ? {} : { fetcher }),
            })
          : await discoverOpenAiModels({
              provider: target,
              ...(credential === undefined ? {} : { credential }),
              ...(fetcher === undefined ? {} : { fetcher }),
            });

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

    close(): void {
      storage.close();
    },
  };

  return manager;
}
