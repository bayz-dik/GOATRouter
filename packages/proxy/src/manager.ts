import type { Agent as HttpAgent } from "node:http";
import type { Agent as HttpsAgent } from "node:https";
import { redactSecrets } from "@bayz/security";
import { scopedSecretStorage, type SecretStorage } from "@bayz/storage";
import type { ProxyConfig } from "./config.js";
import {
  createProxyAgent,
  dialThroughProxy,
  type ConnectFn,
  type DialProxy,
} from "./dial.js";
import { assertProxyId, type ProxyKind } from "./endpoint.js";
import { ProxyError } from "./errors.js";
import {
  createProxyRepository,
  type CreateProxyInput,
  type ProxyRecord,
  type ProxyRepository,
  type UpdateProxyInput,
} from "./repository.js";

/** The single field name every proxy password is stored under. */
const PASSWORD_FIELD = "password";

/**
 * What callers are allowed to see.
 *
 * `passwordPresent` is a boolean on purpose: no method in this package returns a
 * stored password to a caller. Plaintext leaves the manager only inside a SOCKS5
 * sub-negotiation or a `Proxy-Authorization` header, which is why a source-scan
 * test asserts that no password-reading accessor exists.
 */
export type ProxyView = {
  id: string;
  kind: ProxyKind;
  host: string;
  port: number;
  username: string | undefined;
  enabled: boolean;
  config: ProxyConfig;
  passwordPresent: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProxyCheckResult = {
  ok: true;
  kind: ProxyKind;
  latencyMs: number;
};

export type ProxyLogger = (payload: Record<string, unknown>) => void;

export type CreateProxyManagerOptions = {
  storage: SecretStorage;
  logger?: ProxyLogger;
  connect?: ConnectFn;
  now?: () => string;
};

export interface ProxyManager {
  createProxy(input: CreateProxyInput): ProxyView;
  getProxy(id: string): ProxyView | undefined;
  requireProxy(id: string): ProxyView;
  listProxies(): ProxyView[];
  updateProxy(id: string, patch: UpdateProxyInput): ProxyView;
  deleteProxy(id: string): boolean;
  setPassword(id: string, password: string): void;
  hasPassword(id: string): boolean;
  deletePassword(id: string): boolean;
  checkProxy(id: string): Promise<ProxyCheckResult>;
  agentFor(id: string, options?: { tls?: boolean }): HttpAgent | HttpsAgent;
  close(): void;
}

export function createProxyManager(
  options: CreateProxyManagerOptions,
): ProxyManager {
  const { storage, connect, now } = options;
  const log: ProxyLogger = options.logger ?? (() => {});
  const repository: ProxyRepository = createProxyRepository(storage.sql, {
    ...(now === undefined ? {} : { now }),
  });

  const passwords = (id: string) => scopedSecretStorage(storage, ["proxy", id]);

  /**
   * Read a password for internal use only.
   *
   * Corruption propagates as `secret_corrupt` rather than being downgraded to
   * "absent": a tampered password must not look like an unconfigured one.
   */
  const readPassword = (id: string): string | undefined =>
    passwords(id).find(PASSWORD_FIELD);

  const toView = (record: ProxyRecord): ProxyView => ({
    id: record.id,
    kind: record.kind,
    host: record.host,
    port: record.port,
    username: record.username,
    enabled: record.enabled,
    config: record.config,
    passwordPresent: readPassword(record.id) !== undefined,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });

  const dialProxyOf = (record: ProxyRecord): DialProxy => ({
    kind: record.kind,
    host: record.host,
    port: record.port,
    username: record.username,
    config: record.config,
  });

  /** Resolve the credential a dial needs, failing before any socket is opened. */
  const credentialFor = (record: ProxyRecord): string | undefined => {
    if (record.username === undefined) {
      return undefined;
    }
    const password = readPassword(record.id);
    if (password === undefined) {
      throw new ProxyError("password_missing", "proxy-credential");
    }
    return password;
  };

  const requireEnabled = (id: string): ProxyRecord => {
    const record = repository.require(id);
    if (!record.enabled) {
      throw new ProxyError("unsupported_operation", "proxy-disabled");
    }
    return record;
  };

  const manager: ProxyManager = {
    createProxy(input: CreateProxyInput): ProxyView {
      const record = repository.create(input);
      log(redactSecrets({ event: "proxy_created", id: record.id, kind: record.kind }));
      return toView(record);
    },

    getProxy(id: string): ProxyView | undefined {
      const record = repository.get(id);
      return record === undefined ? undefined : toView(record);
    },

    requireProxy(id: string): ProxyView {
      return toView(repository.require(id));
    },

    listProxies(): ProxyView[] {
      return repository.list().map(toView);
    },

    updateProxy(id: string, patch: UpdateProxyInput): ProxyView {
      const record = repository.update(id, patch);
      log(redactSecrets({ event: "proxy_updated", id: record.id }));
      return toView(record);
    },

    deleteProxy(id: string): boolean {
      const validated = assertProxyId(id);
      if (repository.get(validated) === undefined) {
        return false;
      }
      // The password goes first: a row removed while its secret survived would
      // leave an unreachable credential in the database forever.
      try {
        passwords(validated).delete(PASSWORD_FIELD);
      } catch {
        // A corrupt or absent password must not block removing the proxy.
      }
      const removed = repository.delete(validated);
      if (removed) {
        log(redactSecrets({ event: "proxy_deleted", id: validated }));
      }
      return removed;
    },

    setPassword(id: string, password: string): void {
      const record = repository.require(id);
      if (record.username === undefined) {
        // Neither SOCKS5 nor Basic proxy auth can send a password without a
        // username, so storing one would be dead, misleading state.
        throw new ProxyError("invalid_proxy_config", "password-without-username");
      }
      if (typeof password !== "string" || password.trim().length === 0) {
        throw new ProxyError("password_missing", "set-password");
      }
      passwords(record.id).put(PASSWORD_FIELD, password);
      log(redactSecrets({ event: "proxy_password_set", id: record.id }));
    },

    hasPassword(id: string): boolean {
      return readPassword(repository.require(id).id) !== undefined;
    },

    deletePassword(id: string): boolean {
      const record = repository.require(id);
      const removed = passwords(record.id).delete(PASSWORD_FIELD);
      if (removed) {
        log(redactSecrets({ event: "proxy_password_deleted", id: record.id }));
      }
      return removed;
    },

    async checkProxy(id: string): Promise<ProxyCheckResult> {
      const record = requireEnabled(id);
      const password = credentialFor(record);
      const started = Date.now();

      const socket = await dialThroughProxy({
        proxy: dialProxyOf(record),
        target: {
          host: record.config.healthCheckHost,
          port: record.config.healthCheckPort,
        },
        ...(password === undefined ? {} : { password }),
        ...(connect === undefined ? {} : { connect }),
      });
      const latencyMs = Date.now() - started;
      // The tunnel proved reachability; holding it open would waste a proxy slot.
      socket.destroy();

      log(
        redactSecrets({
          event: "proxy_checked",
          id: record.id,
          kind: record.kind,
          latencyMs,
        }),
      );
      return { ok: true, kind: record.kind, latencyMs };
    },

    agentFor(id: string, agentOptions = {}): HttpAgent | HttpsAgent {
      const record = requireEnabled(id);
      const password = credentialFor(record);
      return createProxyAgent({
        proxy: dialProxyOf(record),
        ...(password === undefined ? {} : { password }),
        ...(connect === undefined ? {} : { connect }),
        ...(agentOptions.tls === undefined ? {} : { tls: agentOptions.tls }),
      });
    },

    close(): void {
      storage.close();
    },
  };

  return manager;
}
