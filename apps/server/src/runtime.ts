import { redactSecrets } from "@bayz/security";
import { createProviderManager, type ProviderManager } from "@bayz/providers";
import { createProxyManager, type ProxyManager } from "@bayz/proxy";
import { createRouter, type Router } from "@bayz/router";
import {
  createUsageRepository,
  normalizeUsageEvent,
  type UsageRepository,
} from "@bayz/telemetry";
import {
  openSecretStorage,
  type BayzSecurityMode,
  type SecretStorage,
  type StorageLogger,
} from "@bayz/storage";
import { resolveApiToken, type ApiTokenSource } from "./api-token.js";
import type { RuntimeConfig } from "./config.js";

export type BayzRuntimeStatus = {
  schemaVersion: number;
  journalMode: string;
  driver: string;
  keyProvider: string;
  keyId: string;
  counts: { providers: number; proxies: number; routes: number };
};

export type BayzRuntime = {
  readonly providers: ProviderManager;
  readonly proxies: ProxyManager;
  readonly router: Router;
  readonly usage: UsageRepository;
  readonly apiToken: string;
  readonly apiTokenSource: ApiTokenSource;
  describe(): BayzRuntimeStatus;
  close(): void;
};

export type CreateBayzRuntimeOptions = {
  env?: Record<string, string | undefined>;
  logger?: StorageLogger;
  notify?: (line: string) => void;
  /**
   * Whether a freshly generated token may be used when binding a non-loopback
   * host. Defaults to false: exposing the API on a reachable interface while the
   * only credential is a line printed to a log the operator may not be watching
   * is a silent weakening of authentication.
   */
  allowGeneratedTokenForRemote?: boolean;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** Parse `BAYZ_USAGE_RETENTION`; a malformed value falls back to the default. */
function retentionFrom(env: Record<string, string | undefined>): number | undefined {
  const raw = env.BAYZ_USAGE_RETENTION;
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Build the whole managed runtime on a single storage connection.
 *
 * One connection means one set of pragmas, one lock holder, and one place a
 * credential can live. The managers are constructed here rather than by each
 * route module so nothing can quietly open a second database.
 */
export function createBayzRuntime(
  config: RuntimeConfig,
  options: CreateBayzRuntimeOptions = {},
): BayzRuntime {
  const env = options.env ?? process.env;
  const notify = options.notify ?? ((line: string) => console.log(line));
  const allowGeneratedTokenForRemote = options.allowGeneratedTokenForRemote ?? false;

  const mode = env.BAYZ_SECURITY_MODE as BayzSecurityMode | undefined;
  const storage: SecretStorage = openSecretStorage({
    dataDir: config.dataDir,
    env,
    ...(mode === undefined ? {} : { mode }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  let closed = false;
  const closeStorage = (): void => {
    if (!closed) {
      closed = true;
      storage.close();
    }
  };

  try {
    const remote = !LOOPBACK_HOSTS.has(config.host);
    const resolved = resolveApiToken({ storage, env, notify });
    if (remote && resolved.source === "generated" && !allowGeneratedTokenForRemote) {
      throw new Error(
        "Remote exposure requires an explicit BAYZ_API_TOKEN; refusing to bind a non-loopback host with a freshly generated token",
      );
    }

    const providers = createProviderManager({
      storage,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    const proxies = createProxyManager({
      storage,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });

    const retention = retentionFrom(env);
    const usage = createUsageRepository(storage.sql, {
      ...(retention === undefined ? {} : { requestRetention: retention }),
    });

    const router = createRouter({
      storage,
      providers,
      proxies,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      /**
       * Telemetry is observational: a validation failure or a storage error here
       * must never turn into a failed chat, so the sink swallows its own faults.
       * The router additionally guards the call, so this is defence in depth.
       */
      recorder: (event) => {
        try {
          const row = normalizeUsageEvent(event);
          if (row !== undefined) {
            usage.record(row);
          }
        } catch {
          // A telemetry write is never worth failing a request over.
        }
      },
    });

    return {
      providers,
      proxies,
      router,
      usage,
      apiToken: resolved.token,
      apiTokenSource: resolved.source,

      describe(): BayzRuntimeStatus {
        // Only operational facts. The key is represented by its one-way
        // fingerprint, and the API token appears nowhere at all.
        return redactSecrets({
          schemaVersion: storage.schemaVersion,
          journalMode: storage.journalMode,
          driver: storage.driver,
          keyProvider: storage.keyProvider,
          keyId: storage.keyId,
          counts: {
            providers: providers.listProviders().length,
            proxies: proxies.listProxies().length,
            routes: router.listRoutes().length,
          },
        }) as BayzRuntimeStatus;
      },

      close(): void {
        closeStorage();
      },
    };
  } catch (error) {
    closeStorage();
    throw error;
  }
}
