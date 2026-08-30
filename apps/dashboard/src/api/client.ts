import type {
  ChatRequestBody,
  ConnectionResult,
  CreateIdentityBody,
  IdentityView,
  IdentityWithKey,
  ModelCatalogueEntry,
  ProviderCapabilities,
  UpdateIdentityBody,
  ChatResult,
  CreateProviderBody,
  CreateProxyBody,
  CreateRouteBody,
  ProviderView,
  ProxyAssignResult,
  ProxyCheckResult,
  ProxyUnassignResult,
  ProxyUsage,
  ProxyView,
  RouteView,
  RuntimeStatus,
  UpdateProviderBody,
  UpdateProxyBody,
  UpdateRouteBody,
  UsagePeriod,
  UsageProviderView,
  UsageRequestView,
  UsageSummaryView,
} from "./types";

/** Client-side ceiling on any single request. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * A failure from the Bayz API, carrying the server's own envelope fields.
 *
 * The server guarantees its messages never contain a secret or an upstream body,
 * so surfacing `code` and `message` verbatim is both safe and far more useful to
 * an operator than a generic failure string.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

type Envelope = {
  error?: { code?: unknown; message?: unknown; requestId?: unknown };
};

export type CreateApiClientOptions = {
  fetcher?: typeof fetch;
  /** Read lazily so a rotated or cleared token takes effect on the next call. */
  token: () => string | undefined;
  /** Invoked when the API rejects the token, so the UI can return to the gate. */
  onUnauthorized?: () => void;
};

export type ApiClient = ReturnType<typeof createApiClient>;

export function createApiClient(options: CreateApiClientOptions) {
  const fetcher = options.fetcher ?? fetch;

  async function request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<{ value: T; headers: Headers }> {
    const headers = new Headers({ accept: "application/json" });
    const token = options.token();
    if (token !== undefined && token.length > 0) {
      headers.set("authorization", `Bearer ${token}`);
    }
    if (body !== undefined) {
      headers.set("content-type", "application/json");
    }

    let response: Response;
    try {
      response = await fetcher(path, {
        method,
        headers,
        // The API is cookie-free by design; omitting ambient credentials removes
        // any chance of a cookie being attached and widening CSRF surface.
        credentials: "omit",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      // Network failures, aborts, and DNS errors are indistinguishable here and
      // equally not actionable in detail.
      throw new ApiError(0, "network_error", "The Bayz Core could not be reached");
    }

    if (response.status === 401) {
      options.onUnauthorized?.();
    }

    if (!response.ok) {
      let envelope: Envelope | undefined;
      try {
        envelope = (await response.json()) as Envelope;
      } catch {
        envelope = undefined;
      }
      const code =
        typeof envelope?.error?.code === "string"
          ? envelope.error.code
          : `http_${response.status}`;
      // A non-envelope body is upstream- or proxy-controlled text, so it is
      // replaced rather than shown.
      const message =
        typeof envelope?.error?.message === "string"
          ? envelope.error.message
          : `Request failed with status ${response.status}`;
      const requestId =
        typeof envelope?.error?.requestId === "string"
          ? envelope.error.requestId
          : undefined;
      throw new ApiError(response.status, code, message, requestId);
    }

    if (response.status === 204) {
      return { value: undefined as T, headers: response.headers };
    }
    try {
      return { value: (await response.json()) as T, headers: response.headers };
    } catch {
      throw new ApiError(
        response.status,
        "invalid_response",
        "The Bayz Core returned an unreadable response",
      );
    }
  }

  /** Ids reach a URL path, so they are escaped rather than interpolated raw. */
  const segment = (id: string): string => encodeURIComponent(id);

  const send = async <T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> => (await request<T>(method, path, body)).value;

  return {
    getStatus: (): Promise<RuntimeStatus> => send("GET", "/api/status"),

    listIdentities: async (): Promise<IdentityView[]> =>
      (await send<{ identities: IdentityView[] }>("GET", "/api/identities")).identities ??
      [],
    /**
     * Create an identity.
     *
     * The response is the only place a client key ever appears. It is returned to
     * the caller and deliberately not cached, stored, or logged anywhere in the
     * dashboard.
     */
    createIdentity: (body: CreateIdentityBody): Promise<IdentityWithKey> =>
      send("POST", "/api/identities", body),
    updateIdentity: (id: string, body: UpdateIdentityBody): Promise<IdentityView> =>
      send("PATCH", `/api/identities/${segment(id)}`, body),
    revokeIdentity: (id: string): Promise<void> =>
      send("DELETE", `/api/identities/${segment(id)}`),
    rotateIdentityKey: (id: string): Promise<IdentityWithKey> =>
      send("POST", `/api/identities/${segment(id)}/rotate`),

    listProviders: async (): Promise<ProviderView[]> =>
      (await send<{ providers: ProviderView[] }>("GET", "/api/providers")).providers ?? [],
    getProvider: (id: string): Promise<ProviderView> =>
      send("GET", `/api/providers/${segment(id)}`),
    createProvider: (body: CreateProviderBody): Promise<ProviderView> =>
      send("POST", "/api/providers", body),
    updateProvider: (id: string, body: UpdateProviderBody): Promise<ProviderView> =>
      send("PATCH", `/api/providers/${segment(id)}`, body),
    deleteProvider: (id: string): Promise<void> =>
      send("DELETE", `/api/providers/${segment(id)}`),
    // Write-only: the value goes in the body, never the URL, and nothing is
    // returned that could be rendered.
    setProviderCredential: (id: string, value: string): Promise<void> =>
      send("PUT", `/api/providers/${segment(id)}/credential`, { value }),
    clearProviderCredential: (id: string): Promise<void> =>
      send("DELETE", `/api/providers/${segment(id)}/credential`),
    discoverModels: async (id: string): Promise<string[]> =>
      (await send<{ models: string[] }>("POST", `/api/providers/${segment(id)}/discover`))
        .models ?? [],
    /** Models with their economics. Separate endpoint; see the server's route. */
    discoverModelCatalogue: async (id: string): Promise<ModelCatalogueEntry[]> =>
      (
        await send<{ models: ModelCatalogueEntry[] }>(
          "POST",
          `/api/providers/${segment(id)}/catalogue`,
        )
      ).models ?? [],
    /**
     * Test whether a provider answers.
     *
     * A failed test is a 200 with `ok: false`, not an HTTP error, so this resolves
     * rather than throwing when the *provider* is unreachable.
     */
    testProviderConnection: (id: string): Promise<ConnectionResult> =>
      send("POST", `/api/providers/${segment(id)}/test`),
    detectProviderCapabilities: (id: string): Promise<ProviderCapabilities> =>
      send("POST", `/api/providers/${segment(id)}/capabilities`),

    listProxies: async (): Promise<ProxyView[]> =>
      (await send<{ proxies: ProxyView[] }>("GET", "/api/proxies")).proxies ?? [],
    getProxy: (id: string): Promise<ProxyView> => send("GET", `/api/proxies/${segment(id)}`),
    createProxy: (body: CreateProxyBody): Promise<ProxyView> =>
      send("POST", "/api/proxies", body),
    updateProxy: (id: string, body: UpdateProxyBody): Promise<ProxyView> =>
      send("PATCH", `/api/proxies/${segment(id)}`, body),
    deleteProxy: (id: string): Promise<void> => send("DELETE", `/api/proxies/${segment(id)}`),
    setProxyPassword: (id: string, value: string): Promise<void> =>
      send("PUT", `/api/proxies/${segment(id)}/password`, { value }),
    clearProxyPassword: (id: string): Promise<void> =>
      send("DELETE", `/api/proxies/${segment(id)}/password`),
    checkProxy: (id: string): Promise<ProxyCheckResult> =>
      send("POST", `/api/proxies/${segment(id)}/check`),
    /**
     * What a proxy is used by.
     *
     * Read with `proxies.read`, so a read-only operator can still answer "what breaks
     * if I delete this" before being offered a delete.
     */
    proxyUsage: (id: string): Promise<ProxyUsage> =>
      send("GET", `/api/proxies/${segment(id)}/usage`),
    /**
     * Put a set of providers behind a proxy in **one** request.
     *
     * One call, not one per provider: the server applies the batch in a transaction,
     * so a failure leaves nothing half-assigned. Splitting it client-side would throw
     * that guarantee away.
     */
    assignProxy: (id: string, providerIds: string[]): Promise<ProxyAssignResult> =>
      send("POST", `/api/proxies/${segment(id)}/assign`, { providerIds }),
    unassignProxy: (id: string, providerIds: string[]): Promise<ProxyUnassignResult> =>
      send("POST", `/api/proxies/${segment(id)}/unassign`, { providerIds }),

    listRoutes: async (): Promise<RouteView[]> =>
      (await send<{ routes: RouteView[] }>("GET", "/api/routes")).routes ?? [],
    getRoute: (id: string): Promise<RouteView> => send("GET", `/api/routes/${segment(id)}`),
    createRoute: (body: CreateRouteBody): Promise<RouteView> =>
      send("POST", "/api/routes", body),
    updateRoute: (id: string, body: UpdateRouteBody): Promise<RouteView> =>
      send("PATCH", `/api/routes/${segment(id)}`, body),
    deleteRoute: (id: string): Promise<void> => send("DELETE", `/api/routes/${segment(id)}`),

    listModels: async (): Promise<string[]> => {
      const body = await send<{ data?: Array<{ id?: unknown }> }>("GET", "/v1/models");
      return (body.data ?? [])
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === "string");
    },

    /**
     * Usage telemetry for one period.
     *
     * The period reaches a query string, so it is encoded rather than interpolated —
     * even though the caller can only pass one of the four literals the server accepts.
     */
    getUsageSummary: (period: UsagePeriod): Promise<UsageSummaryView> =>
      send("GET", `/api/usage/summary?period=${encodeURIComponent(period)}`),

    /**
     * Per-provider attempt history for one period.
     *
     * Registered providers are the spine of the server's list, so a provider carrying
     * no traffic still appears — which is what makes "standby" distinguishable from
     * "not configured".
     */
    listUsageProviders: async (period: UsagePeriod): Promise<UsageProviderView[]> =>
      (
        await send<{ providers: UsageProviderView[] }>(
          "GET",
          `/api/usage/providers?period=${encodeURIComponent(period)}`,
        )
      ).providers ?? [],

    /**
     * The most recent requests, newest first.
     *
     * Metadata only: the server stores no prompt and no completion, so there is
     * nothing here that could render message content.
     */
    listUsageRequests: async (limit: number): Promise<UsageRequestView[]> =>
      (
        await send<{ requests: UsageRequestView[] }>(
          "GET",
          `/api/usage/requests?limit=${encodeURIComponent(String(limit))}`,
        )
      ).requests ?? [],

    /**
     * Send one chat request.
     *
     * `stream` is never included: the API rejects it, and offering it would
     * advertise a capability that does not exist.
     */
    chat: async (body: ChatRequestBody): Promise<ChatResult> => {
      const { value, headers } = await request<{
        model?: unknown;
        choices?: Array<{
          message?: { content?: unknown };
          finish_reason?: unknown;
        }>;
      }>("POST", "/v1/chat/completions", body);

      const content = value.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new ApiError(
          200,
          "invalid_response",
          "The Bayz Core returned a completion without content",
        );
      }
      const finish = value.choices?.[0]?.finish_reason;
      return {
        content,
        finishReason: typeof finish === "string" ? finish : undefined,
        model: typeof value.model === "string" ? value.model : undefined,
        routeId: headers.get("x-bayz-route") ?? undefined,
        providerId: headers.get("x-bayz-provider") ?? undefined,
        proxyId: headers.get("x-bayz-proxy") ?? undefined,
      };
    },
  };
}
