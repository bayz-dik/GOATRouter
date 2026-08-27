import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer, connect, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { ProviderError } from "@bayz/providers";
import { RouterError, sendChatRequest } from "../src/index.js";

/**
 * Driven against a real loopback origin, and for the proxy cases a real HTTP
 * CONNECT proxy. A mocked transport would not show that the request genuinely
 * traverses the proxy, which is the whole point of Phase 5.
 */

type OriginHandler = (
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  body: string,
) => void;

const sockets = new Set<Socket>();

function track(socket: Socket): Socket {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  return socket;
}

async function withOrigin(
  handler: OriginHandler,
  run: (port: number, seen: Array<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
  const seen: Array<Record<string, unknown>> = [];
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        googKey: request.headers["x-goog-api-key"],
        contentType: request.headers["content-type"],
        body,
      });
      handler(request, response, body);
    });
  });
  server.on("connection", track);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(port, seen);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A real CONNECT proxy that records the tunnels it was asked to open. */
async function withConnectProxy(
  originPort: number,
  run: (proxyPort: number, connects: string[]) => Promise<void>,
): Promise<void> {
  const connects: string[] = [];
  const proxy = createServer((client) => {
    track(client);
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, Buffer.from(chunk)]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        return;
      }
      client.off("data", onData);
      connects.push(head.subarray(0, end).toString("utf8"));
      const rest = head.subarray(end + 4);
      const upstream = track(
        connect({ host: "127.0.0.1", port: originPort }, () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (rest.length > 0) {
            upstream.write(rest);
          }
          client.pipe(upstream);
          upstream.pipe(client);
        }),
      );
      upstream.on("error", () => client.destroy());
    };
    client.on("data", onData);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const { port } = proxy.address() as AddressInfo;
  try {
    await run(port, connects);
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
}

function jsonReply(body: unknown, status = 200): OriginHandler {
  return (_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(typeof body === "string" ? body : JSON.stringify(body));
  };
}

const COMPLETION = {
  id: "chatcmpl-1",
  model: "gpt-4o",
  choices: [{ index: 0, message: { role: "assistant", content: "Hi!" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

const REQUEST = {
  model: "gpt-4o",
  messages: [{ role: "user" as const, content: "hello" }],
};

/** Every origin here is a real loopback server, which 9D's egress policy requires an
 * explicit opt-in for. Stating it in the helper is the policy working as intended. */
const LOOPBACK_EGRESS = { allowLoopback: true, allowPrivate: false } as const;

function target(port: number, kind: "openai-compatible" | "gemini" | "openrouter" = "openai-compatible") {
  return {
    kind,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requestTimeoutMs: 3000,
    egress: LOOPBACK_EGRESS,
  };
}

test("a direct POST reaches the origin and the response is normalized", async () => {
  await withOrigin(jsonReply(COMPLETION), async (port, seen) => {
    const result = await sendChatRequest({
      provider: target(port),
      request: REQUEST,
    });
    assert.equal(result.content, "Hi!");
    assert.deepEqual(result.usage, {
      promptTokens: 3,
      completionTokens: 2,
      totalTokens: 5,
    });

    const call = seen[0];
    assert.ok(call !== undefined);
    assert.equal(call.method, "POST");
    assert.equal(call.url, "/v1/chat/completions");
    assert.equal(call.contentType, "application/json");
    assert.deepEqual(JSON.parse(String(call.body)), {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
    });
  });
});

test("optional parameters are forwarded in OpenAI wire form", async () => {
  await withOrigin(jsonReply(COMPLETION), async (port, seen) => {
    await sendChatRequest({
      provider: target(port),
      request: {
        ...REQUEST,
        temperature: 0.4,
        maxTokens: 128,
        topP: 0.8,
        stop: ["END"],
      },
    });
    const body = JSON.parse(String(seen[0]?.body));
    assert.equal(body.temperature, 0.4);
    assert.equal(body.max_tokens, 128, "camelCase must become the wire name");
    assert.equal(body.top_p, 0.8);
    assert.deepEqual(body.stop, ["END"]);
    assert.equal("maxTokens" in body, false);
    assert.equal("stream" in body, false, "streaming is not implemented");
  });
});

test("a bearer credential is sent as a header and never in the URL", async () => {
  await withOrigin(jsonReply(COMPLETION), async (port, seen) => {
    await sendChatRequest({
      provider: target(port),
      request: REQUEST,
      credential: "sk-transport-secret",
    });
    assert.equal(seen[0]?.authorization, "Bearer sk-transport-secret");
    assert.equal(String(seen[0]?.url).includes("sk-transport-secret"), false);
    assert.equal(String(seen[0]?.url).includes("?"), false);
  });
});

test("a gemini provider uses x-goog-api-key and no bearer header", async () => {
  await withOrigin(jsonReply(COMPLETION), async (port, seen) => {
    await sendChatRequest({
      provider: target(port, "gemini"),
      request: REQUEST,
      credential: "AIza-transport",
    });
    assert.equal(seen[0]?.googKey, "AIza-transport");
    assert.equal(seen[0]?.authorization, undefined);
    assert.equal(String(seen[0]?.url).includes("AIza-transport"), false);
  });
});

test("no credential means no auth header at all", async () => {
  await withOrigin(jsonReply(COMPLETION), async (port, seen) => {
    await sendChatRequest({ provider: target(port), request: REQUEST });
    assert.equal(seen[0]?.authorization, undefined);
    assert.equal(seen[0]?.googKey, undefined);
  });
});

test("a proxied request really traverses the proxy", async () => {
  await withOrigin(jsonReply(COMPLETION), async (originPort, seen) => {
    await withConnectProxy(originPort, async (proxyPort, connects) => {
      const { createProxyAgent } = await import("@bayz/proxy");
      const agent = createProxyAgent({
        proxy: {
          kind: "http",
          host: "127.0.0.1",
          port: proxyPort,
          username: undefined,
          config: {
            connectTimeoutMs: 3000,
            healthCheckHost: "127.0.0.1",
            healthCheckPort: originPort,
          },
        },
      });

      const result = await sendChatRequest({
        provider: target(originPort),
        request: REQUEST,
        agent,
      });
      agent.destroy();

      assert.equal(result.content, "Hi!");
      assert.equal(seen.length, 1, "the origin was reached exactly once");
      assert.equal(connects.length, 1, "the proxy really opened a tunnel");
      assert.match(
        connects[0] ?? "",
        new RegExp(`^CONNECT 127\\.0\\.0\\.1:${originPort} HTTP/1\\.1`),
      );
    });
  });
});

test("a credential is never visible in the proxy CONNECT request", async () => {
  await withOrigin(jsonReply(COMPLETION), async (originPort) => {
    await withConnectProxy(originPort, async (proxyPort, connects) => {
      const { createProxyAgent } = await import("@bayz/proxy");
      const agent = createProxyAgent({
        proxy: {
          kind: "http",
          host: "127.0.0.1",
          port: proxyPort,
          username: undefined,
          config: {
            connectTimeoutMs: 3000,
            healthCheckHost: "127.0.0.1",
            healthCheckPort: originPort,
          },
        },
      });
      await sendChatRequest({
        provider: target(originPort),
        request: REQUEST,
        credential: "sk-proxy-invisible",
        agent,
      });
      agent.destroy();
      assert.equal(
        connects.some((entry) => entry.includes("sk-proxy-invisible")),
        false,
        "the CONNECT preamble must not carry the upstream credential",
      );
    });
  });
});

test("upstream status codes map to provider error codes", async () => {
  const mapping: Array<[number, string]> = [
    [401, "auth_failed"],
    [403, "auth_failed"],
    [429, "rate_limited"],
    [400, "upstream_error"],
    [500, "upstream_error"],
    [503, "upstream_error"],
  ];
  for (const [status, code] of mapping) {
    await withOrigin(
      jsonReply({ error: "sk-upstream-leak in body" }, status),
      async (port) => {
        await assert.rejects(
          sendChatRequest({ provider: target(port), request: REQUEST }),
          (error: unknown) => {
            assert.ok(error instanceof ProviderError, `expected ProviderError for ${status}`);
            assert.equal(error.code, code);
            assert.equal(error.message.includes("sk-upstream-leak"), false);
            return true;
          },
        );
      },
    );
  }
});

test("a refused connection is unreachable and leaks no peer detail", async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const deadPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  await assert.rejects(
    sendChatRequest({ provider: target(deadPort), request: REQUEST }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "unreachable");
      assert.equal(error.message.includes(String(deadPort)), false);
      return true;
    },
  );
});

test("a slow origin is bounded by the request timeout", async () => {
  await withOrigin(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
      // Never finishes.
    },
    async (port) => {
      const started = Date.now();
      await assert.rejects(
        sendChatRequest({
          provider: { ...target(port), requestTimeoutMs: 1000 },
          request: REQUEST,
        }),
        (error: unknown) =>
          error instanceof ProviderError && error.code === "unreachable",
      );
      assert.ok(Date.now() - started < 8000, "the timeout must bound the request");
    },
  );
});

test("an oversized response body is refused", async () => {
  const huge = JSON.stringify({
    choices: [{ message: { content: "x".repeat(3 * 1024 * 1024) } }],
  });
  await withOrigin(jsonReply(huge), async (port) => {
    await assert.rejects(
      sendChatRequest({ provider: target(port), request: REQUEST }),
      (error: unknown) =>
        (error instanceof RouterError && error.code === "response_too_large") ||
        (error instanceof ProviderError && error.code === "upstream_error"),
    );
  });
});

test("invalid JSON and invalid UTF-8 fail closed", async () => {
  await withOrigin(jsonReply("<html>gateway</html>"), async (port) => {
    await assert.rejects(
      sendChatRequest({ provider: target(port), request: REQUEST }),
      (error: unknown) =>
        error instanceof RouterError && error.code === "invalid_response",
    );
  });

  await withOrigin(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]));
    },
    async (port) => {
      await assert.rejects(
        sendChatRequest({ provider: target(port), request: REQUEST }),
        (error: unknown) =>
          error instanceof RouterError && error.code === "invalid_response",
      );
    },
  );
});

test("a structurally wrong completion fails closed", async () => {
  await withOrigin(jsonReply({ choices: [] }), async (port) => {
    await assert.rejects(
      sendChatRequest({ provider: target(port), request: REQUEST }),
      (error: unknown) =>
        error instanceof RouterError && error.code === "invalid_response",
    );
  });
});

test("the request path is built from the base url without doubling slashes", async () => {
  await withOrigin(jsonReply(COMPLETION), async (port, seen) => {
    await sendChatRequest({
      provider: {
        kind: "openai-compatible",
        baseUrl: `http://127.0.0.1:${port}/v1/`,
        requestTimeoutMs: 3000,
        egress: LOOPBACK_EGRESS,
      },
      request: REQUEST,
    });
    assert.equal(seen[0]?.url, "/v1/chat/completions");
  });
});

test("a codex-oauth provider is refused before any request", async () => {
  await withOrigin(jsonReply(COMPLETION), async (port, seen) => {
    await assert.rejects(
      sendChatRequest({
        provider: {
          kind: "codex-oauth",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          requestTimeoutMs: 3000,
          egress: LOOPBACK_EGRESS,
        },
        request: REQUEST,
      }),
      (error: unknown) =>
        error instanceof ProviderError && error.code === "unsupported_operation",
    );
    assert.equal(seen.length, 0, "no request may be made for a deferred kind");
  });
});
