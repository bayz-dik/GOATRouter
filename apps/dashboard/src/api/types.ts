/**
 * Shapes returned by the Bayz local API.
 *
 * These mirror the server's view types rather than re-deriving them: a credential
 * or password appears only as a boolean presence flag, because no endpoint returns
 * the value and nothing in the dashboard may render one.
 */

export type ProviderKind =
  | "openai-compatible"
  | "openrouter"
  | "gemini"
  | "codex-oauth"
  | "custom-openai";

/**
 * Provider configuration as the API *returns* it.
 *
 * `headerNames` rather than `headers`: the server never sends a configured header
 * value back. Nothing in the dashboard needs one, and an operator changing a header
 * retypes it.
 */
export type ProviderConfig = {
  timeoutMs: number;
  discoveryPath: string;
  modelLimit: number;
  supportsTools?: boolean;
  headerNames?: string[];
  allowLoopback?: boolean;
  allowPrivate?: boolean;
};

/** Provider configuration as a create or update *sends* it. */
export type ProviderConfigInput = {
  timeoutMs?: number;
  discoveryPath?: string;
  modelLimit?: number;
  supportsTools?: boolean;
  headers?: Record<string, string>;
  allowLoopback?: boolean;
  allowPrivate?: boolean;
};

/** Every failure code the connection test can report. */
export type ConnectionFailureCode =
  | "invalid_provider_config"
  | "credential_missing"
  | "unsupported_operation"
  | "unreachable"
  | "auth_failed"
  | "rate_limited"
  | "upstream_error"
  | "discovery_failed";

export type ConnectionResult = {
  ok: boolean;
  latencyMs: number;
  modelCount?: number;
  capped?: boolean;
  failureCode?: ConnectionFailureCode;
};

/** `unknown` is a real value: see the server's `ProviderCapabilities`. */
export type CapabilityState = "unknown" | "yes" | "no";

export type ProviderCapabilities = {
  models: boolean;
  modelCount: number;
  capped: boolean;
  tools: CapabilityState;
  toolsSource: "declared" | "undetermined";
  streaming: CapabilityState;
  streamingSource: "declared" | "undetermined";
  failureCode?: ConnectionFailureCode;
};

export type ModelEconomics =
  | "FREE_VERIFIED"
  | "FREE_TIER"
  | "FREE_PREVIEW"
  | "LOCAL"
  | "PAID"
  | "UNKNOWN";

export type ModelCatalogueEntry = {
  id: string;
  economics: ModelEconomics;
};

export type ProviderView = {
  id: string;
  kind: ProviderKind;
  displayName: string;
  baseUrl: string;
  enabled: boolean;
  config: ProviderConfig;
  /**
   * The proxy every route to this provider uses unless the route overrides it.
   *
   * An id, never a password — the password has no read accessor anywhere in the API.
   * Absent means direct.
   */
  proxyId?: string;
  credentialPresent: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CreateProviderBody = {
  id: string;
  kind: ProviderKind;
  displayName: string;
  baseUrl?: string;
  enabled?: boolean;
  config?: ProviderConfigInput;
};

export type UpdateProviderBody = {
  displayName?: string;
  baseUrl?: string;
  enabled?: boolean;
  config?: ProviderConfigInput;
};

export type ProxyKind = "socks5" | "http";

export type ProxyConfig = {
  connectTimeoutMs: number;
  healthCheckHost: string;
  healthCheckPort: number;
};

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

export type CreateProxyBody = {
  id: string;
  kind: ProxyKind;
  host: string;
  port: number;
  username?: string;
  enabled?: boolean;
  config?: Partial<ProxyConfig>;
};

export type UpdateProxyBody = {
  host?: string;
  port?: number;
  username?: string | null;
  enabled?: boolean;
  config?: Partial<ProxyConfig>;
};

export type ProxyCheckResult = {
  ok: boolean;
  kind: ProxyKind;
  latencyMs: number;
};

/**
 * What a proxy is currently used by.
 *
 * Ids and counts only — the endpoint returns no password state and nothing about
 * provider credentials, so there is nothing here the panel could accidentally render.
 * `routeCount` counts routes *pinned* to the proxy; a route inheriting it follows its
 * provider and is already represented by `providerCount`.
 */
export type ProxyUsage = {
  proxyId: string;
  providerCount: number;
  routeCount: number;
  providerIds: string[];
};

export type ProxyAssignResult = {
  proxyId: string;
  providerCount: number;
  proxyEnabled: boolean;
  notes: string[];
};

export type ProxyUnassignResult = {
  proxyId: string;
  providerCount: number;
  detachedFromProxy: number;
};

export type RouteConfig = {
  maxAttempts: number;
  requestTimeoutMs: number;
};

export type RouteView = {
  id: string;
  model: string;
  providerId: string;
  /**
   * A proxy this route uses regardless of its provider's default.
   *
   * `undefined` means **inherit the provider's proxy**, not direct — which is why
   * `forceDirect` exists as a separate flag.
   */
  proxyId: string | undefined;
  /** Never proxy this route, even when its provider has a default. */
  forceDirect: boolean;
  priority: number;
  enabled: boolean;
  config: RouteConfig;
  createdAt: string;
  updatedAt: string;
};

export type CreateRouteBody = {
  id: string;
  model: string;
  providerId: string;
  proxyId?: string;
  priority?: number;
  enabled?: boolean;
  config?: Partial<RouteConfig>;
};

export type UpdateRouteBody = {
  proxyId?: string | null;
  priority?: number;
  enabled?: boolean;
  config?: Partial<RouteConfig>;
};

export type RuntimeStatus = {
  schemaVersion: number;
  journalMode: string;
  driver: string;
  keyProvider: string;
  keyId: string;
  counts: {
    providers: number;
    proxies: number;
    routes: number;
    identities: number;
  };
};

/**
 * The ten scopes a client identity may hold.
 *
 * Duplicated from `@bayz/identity` deliberately: the dashboard must not depend on a
 * server package, which is the same rule the Flux Core failure categories follow.
 * Drift surfaces as a scope the UI cannot offer, not as a security hole — the server
 * revalidates every scope it receives.
 */
export const CLIENT_SCOPE_NAMES = [
  "chat.completions",
  "models.read",
  "usage.read",
  "providers.read",
  "providers.write",
  "proxies.read",
  "proxies.write",
  "routes.read",
  "routes.write",
  "admin",
] as const;

export type ClientScopeName = (typeof CLIENT_SCOPE_NAMES)[number];

export const CLIENT_PRESET_NAMES = [
  "opencode",
  "hermes",
  "antigravity",
  "generic-openai",
] as const;

export type ClientPresetName = (typeof CLIENT_PRESET_NAMES)[number];

/**
 * Default scopes per preset.
 *
 * Data only, exactly as `packages/gateway/src/presets.ts` is. A preset seeds the
 * create form; it never constrains what the operator can then choose.
 */
export const PRESET_SCOPES: Readonly<Record<ClientPresetName, readonly ClientScopeName[]>> = {
  opencode: ["chat.completions", "models.read"],
  hermes: ["chat.completions", "models.read"],
  antigravity: ["chat.completions", "models.read"],
  "generic-openai": ["chat.completions", "models.read"],
};

/**
 * What the API returns for an identity.
 *
 * There is no key field, and no fingerprint. A fingerprint would be a verifier for
 * an offline guessing attack against the key, and the display name already lets an
 * operator tell two identities apart.
 */
export type IdentityView = {
  id: string;
  displayName: string;
  scopes: string[];
  preset: string | undefined;
  revoked: boolean;
  expiresAt: string | undefined;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | undefined;
};

export type CreateIdentityBody = {
  id: string;
  displayName: string;
  scopes: string[];
  preset?: string;
  expiresAt?: string;
};

export type UpdateIdentityBody = {
  displayName?: string;
  scopes?: string[];
  expiresAt?: string | null;
};

/** A creation or rotation response. The key appears here and nowhere else. */
export type IdentityWithKey = {
  identity: IdentityView;
  key: string;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatRequestBody = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
};

export type ChatResult = {
  content: string;
  finishReason: string | undefined;
  model: string | undefined;
  routeId: string | undefined;
  providerId: string | undefined;
  proxyId: string | undefined;
};
