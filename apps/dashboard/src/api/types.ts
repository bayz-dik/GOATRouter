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
  | "codex-oauth";

export type ProviderConfig = {
  timeoutMs: number;
  discoveryPath: string;
  modelLimit: number;
};

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

export type CreateProviderBody = {
  id: string;
  kind: ProviderKind;
  displayName: string;
  baseUrl?: string;
  enabled?: boolean;
  config?: Partial<ProviderConfig>;
};

export type UpdateProviderBody = {
  displayName?: string;
  baseUrl?: string;
  enabled?: boolean;
  config?: Partial<ProviderConfig>;
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

export type RouteConfig = {
  maxAttempts: number;
  requestTimeoutMs: number;
};

export type RouteView = {
  id: string;
  model: string;
  providerId: string;
  proxyId: string | undefined;
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
  counts: { providers: number; proxies: number; routes: number };
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
