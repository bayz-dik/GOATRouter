import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "../src/api/client";

type StubCall = {
  url: string;
  init: RequestInit;
};

function stub(
  responder: (call: StubCall) => Response | Promise<Response>,
): { fetcher: typeof fetch; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { fetcher, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TOKEN = "dashboard-token-0123456789abcdef";

function client(
  responder: (call: StubCall) => Response | Promise<Response>,
): {
  api: ReturnType<typeof createApiClient>;
  calls: StubCall[];
} {
  const { fetcher, calls } = stub(responder);
  return { api: createApiClient({ fetcher, token: () => TOKEN }), calls };
}

describe("dashboard API client", () => {
  it("injects the bearer token on every call", async () => {
    const { api, calls } = client(() => json({ providers: [] }));
    await api.listProviders();
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("omits ambient credentials so no cookie can be sent", async () => {
    const { api, calls } = client(() => json({ proxies: [] }));
    await api.listProxies();
    expect(calls[0]?.init.credentials).toBe("omit");
  });

  it("sends a JSON content type only when there is a body", async () => {
    const { api, calls } = client(() => json({ routes: [] }));
    await api.listRoutes();
    expect(new Headers(calls[0]?.init.headers).get("content-type")).toBeNull();

    const { api: writer, calls: writes } = client(() => json({ id: "p1" }, 201));
    await writer.createProvider({
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: "http://127.0.0.1:1/v1",
    });
    expect(new Headers(writes[0]?.init.headers).get("content-type")).toBe(
      "application/json",
    );
  });

  it("parses the Bayz error envelope into a typed error", async () => {
    const { api } = client(() =>
      json(
        {
          error: {
            code: "provider_not_found",
            message: "no provider is registered with that id",
            requestId: "req_abc",
          },
        },
        404,
      ),
    );

    await expect(api.getProvider("ghost")).rejects.toBeInstanceOf(ApiError);
    try {
      await api.getProvider("ghost");
      expect.unreachable("should have thrown");
    } catch (error) {
      const apiError = error as ApiError;
      expect(apiError.status).toBe(404);
      expect(apiError.code).toBe("provider_not_found");
      expect(apiError.message).toBe("no provider is registered with that id");
      expect(apiError.requestId).toBe("req_abc");
    }
  });

  it("still produces a usable error when the body is not an envelope", async () => {
    const { api } = client(() => new Response("<html>gateway</html>", { status: 502 }));
    try {
      await api.listProviders();
      expect.unreachable("should have thrown");
    } catch (error) {
      const apiError = error as ApiError;
      expect(apiError).toBeInstanceOf(ApiError);
      expect(apiError.status).toBe(502);
      expect(apiError.code).toBe("http_502");
      // The raw body must not become the message: it is upstream-controlled text.
      expect(apiError.message).not.toContain("<html>");
    }
  });

  it("reports a transport failure without inventing a status", async () => {
    const { api } = client(() => {
      throw new TypeError("Failed to fetch");
    });
    try {
      await api.listProviders();
      expect.unreachable("should have thrown");
    } catch (error) {
      const apiError = error as ApiError;
      expect(apiError.status).toBe(0);
      expect(apiError.code).toBe("network_error");
    }
  });

  it("escapes ids so a hostile value cannot alter the path", async () => {
    const { api, calls } = client(() => json({ id: "x" }));
    await api.getProvider("a/../../admin?x=1");
    expect(calls[0]?.url).toBe("/api/providers/a%2F..%2F..%2Fadmin%3Fx%3D1");
    expect(calls[0]?.url).not.toContain("?x=1");
  });

  it("bounds every request with an abort signal", async () => {
    const { api, calls } = client(() => json({ providers: [] }));
    await api.listProviders();
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("treats a 204 as a successful empty result", async () => {
    const { api } = client(() => new Response(null, { status: 204 }));
    await expect(api.setProviderCredential("p1", "sk-value")).resolves.toBeUndefined();
  });

  it("never sends a credential in a URL", async () => {
    const { api, calls } = client(() => new Response(null, { status: 204 }));
    await api.setProviderCredential("p1", "sk-secret-value");
    expect(calls[0]?.url).not.toContain("sk-secret-value");
    expect(calls[0]?.url).not.toContain("?");
    expect(String(calls[0]?.init.body)).toContain("sk-secret-value");
  });

  it("exposes no credential or password read method", () => {
    const { api } = client(() => json({}));
    for (const name of Object.keys(api)) {
      expect(name).not.toMatch(/get(Credential|Password)|reveal|export/i);
    }
    expect((api as unknown as Record<string, unknown>).getCredential).toBeUndefined();
    expect((api as unknown as Record<string, unknown>).getPassword).toBeUndefined();
  });

  it("calls the documented method and path for each endpoint", async () => {
    const { api, calls } = client((call) => {
      if (call.url === "/v1/chat/completions") {
        return json({
          choices: [{ message: { role: "assistant", content: "hi" } }],
        });
      }
      if (call.url === "/v1/models") {
        return json({ object: "list", data: [{ id: "gpt-4o" }] });
      }
      return json({});
    });

    await api.getStatus();
    await api.listProviders();
    await api.createProvider({
      id: "p1",
      kind: "openai-compatible",
      displayName: "P",
      baseUrl: "http://127.0.0.1:1/v1",
    });
    await api.updateProvider("p1", { enabled: false });
    await api.deleteProvider("p1");
    await api.setProviderCredential("p1", "v");
    await api.clearProviderCredential("p1");
    await api.discoverModels("p1");
    await api.listProxies();
    await api.checkProxy("x1");
    await api.setProxyPassword("x1", "v");
    await api.listRoutes();
    await api.listModels();
    await api.chat({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });

    expect(calls.map((call) => `${call.init.method ?? "GET"} ${call.url}`)).toEqual([
      "GET /api/status",
      "GET /api/providers",
      "POST /api/providers",
      "PATCH /api/providers/p1",
      "DELETE /api/providers/p1",
      "PUT /api/providers/p1/credential",
      "DELETE /api/providers/p1/credential",
      "POST /api/providers/p1/discover",
      "GET /api/proxies",
      "POST /api/proxies/x1/check",
      "PUT /api/proxies/x1/password",
      "GET /api/routes",
      "GET /v1/models",
      "POST /v1/chat/completions",
    ]);
  });

  it("returns the routing headers alongside a chat reply", async () => {
    const { api } = client(
      () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { role: "assistant", content: "answer" }, finish_reason: "stop" },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-bayz-route": "r1",
              "x-bayz-provider": "p1",
              "x-bayz-proxy": "x1",
            },
          },
        ),
    );

    const result = await api.chat({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.content).toBe("answer");
    expect(result.routeId).toBe("r1");
    expect(result.providerId).toBe("p1");
    expect(result.proxyId).toBe("x1");
  });

  it("never includes stream in a chat request body", async () => {
    const { api, calls } = client(() =>
      json({ choices: [{ message: { content: "x" } }] }),
    );
    await api.chat({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    expect(String(calls[0]?.init.body)).not.toContain("stream");
  });

  it("reads the token lazily so a rotation takes effect immediately", async () => {
    let current = "first-token-value-here";
    const { fetcher, calls } = stub(() => json({ providers: [] }));
    const api = createApiClient({ fetcher, token: () => current });

    await api.listProviders();
    current = "second-token-value-here";
    await api.listProviders();

    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(
      "Bearer first-token-value-here",
    );
    expect(new Headers(calls[1]?.init.headers).get("authorization")).toBe(
      "Bearer second-token-value-here",
    );
  });

  it("sends no authorization header when no token is held", async () => {
    const { fetcher, calls } = stub(() => json({ providers: [] }));
    const api = createApiClient({ fetcher, token: () => undefined });
    await api.listProviders();
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBeNull();
  });

  it("does not write the token anywhere observable", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { api } = client(() => json({ providers: [] }));
    await api.listProviders();
    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).toBe("");
    setItem.mockRestore();
  });
});
