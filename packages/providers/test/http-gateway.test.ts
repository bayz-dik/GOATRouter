import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import test from "node:test";
import { ProviderError, fetchJsonCapped } from "../src/index.js";

type Handler = (
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
) => void;

async function withServer(
  handler: Handler,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function expectCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof ProviderError && error.code === code;
}

test("a JSON response is parsed and returned", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }));
    },
    async (base) => {
      const body = await fetchJsonCapped({ url: `${base}/v1/models` });
      assert.deepEqual(body, { data: [{ id: "gpt-4o-mini" }] });
    },
  );
});

test("supplied headers reach the upstream and defaults stay minimal", async () => {
  const seen: Record<string, string | undefined> = {};
  await withServer(
    (request, response) => {
      seen.authorization = request.headers.authorization;
      seen.accept = request.headers.accept;
      seen.googKey = request.headers["x-goog-api-key"] as string | undefined;
      seen.url = request.url;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    },
    async (base) => {
      await fetchJsonCapped({
        url: `${base}/v1/models`,
        headers: { authorization: "Bearer sk-test-value" },
      });
      assert.equal(seen.authorization, "Bearer sk-test-value");
      assert.equal(seen.accept, "application/json");
      assert.equal(seen.googKey, undefined);
      assert.equal(seen.url, "/v1/models", "no credential may ride in the URL");
    },
  );
});

test("a 401 and a 403 map to auth_failed", async () => {
  for (const status of [401, 403]) {
    await withServer(
      (_request, response) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end('{"error":"invalid api key sk-leaked-from-upstream"}');
      },
      async (base) => {
        await assert.rejects(
          fetchJsonCapped({ url: `${base}/v1/models` }),
          (error: unknown) => {
            assert.ok(expectCode("auth_failed")(error));
            assert.equal(
              (error as ProviderError).message.includes("sk-leaked-from-upstream"),
              false,
              "upstream body must never reach the error message",
            );
            return true;
          },
        );
      },
    );
  }
});

test("a 429 maps to rate_limited", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(429);
      response.end("slow down");
    },
    async (base) => {
      await assert.rejects(
        fetchJsonCapped({ url: `${base}/v1/models` }),
        expectCode("rate_limited"),
      );
    },
  );
});

test("other error statuses map to upstream_error", async () => {
  for (const status of [400, 404, 500, 503]) {
    await withServer(
      (_request, response) => {
        response.writeHead(status);
        response.end("boom");
      },
      async (base) => {
        await assert.rejects(
          fetchJsonCapped({ url: `${base}/v1/models` }),
          expectCode("upstream_error"),
        );
      },
    );
  }
});

test("a slow upstream is aborted and reported as unreachable", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      // Never finishes within the timeout.
      response.write("{");
    },
    async (base) => {
      const started = Date.now();
      await assert.rejects(
        fetchJsonCapped({ url: `${base}/v1/models`, timeoutMs: 150 }),
        expectCode("unreachable"),
      );
      assert.ok(
        Date.now() - started < 5000,
        "the timeout must bound the request, not the test runner",
      );
    },
  );
});

test("a refused connection is reported as unreachable", async () => {
  // Bind and immediately close to obtain a port nothing is listening on.
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));

  await assert.rejects(
    fetchJsonCapped({ url: `http://127.0.0.1:${port}/v1/models`, timeoutMs: 2000 }),
    (error: unknown) => {
      assert.ok(expectCode("unreachable")(error));
      assert.equal(
        (error as ProviderError).message.includes(String(port)),
        false,
        "the peer address must not leak into the message",
      );
      return true;
    },
  );
});

test("an oversized body is refused instead of buffered", async () => {
  const huge = `{"pad":"${"A".repeat(300_000)}"}`;
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(huge);
    },
    async (base) => {
      await assert.rejects(
        fetchJsonCapped({ url: `${base}/v1/models`, maxBytes: 4096 }),
        expectCode("upstream_error"),
      );
    },
  );
});

test("the caller can choose the failure code for a malformed body", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("this is not json");
    },
    async (base) => {
      await assert.rejects(
        fetchJsonCapped({ url: `${base}/v1/models` }),
        expectCode("upstream_error"),
      );
      await assert.rejects(
        fetchJsonCapped({ url: `${base}/v1/models`, malformedCode: "discovery_failed" }),
        expectCode("discovery_failed"),
      );
    },
  );
});

test("an empty body is malformed rather than silently null", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("");
    },
    async (base) => {
      await assert.rejects(
        fetchJsonCapped({ url: `${base}/v1/models` }),
        expectCode("upstream_error"),
      );
    },
  );
});

test("invalid UTF-8 is rejected rather than replaced", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]));
    },
    async (base) => {
      await assert.rejects(
        fetchJsonCapped({ url: `${base}/v1/models` }),
        expectCode("upstream_error"),
      );
    },
  );
});

test("an injected fetcher is used instead of global fetch", async () => {
  let seenUrl = "";
  const body = await fetchJsonCapped({
    url: "https://upstream.invalid/v1/models",
    fetcher: async (input) => {
      seenUrl = String(input);
      return new Response('{"data":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(body, { data: [] });
  assert.equal(seenUrl, "https://upstream.invalid/v1/models");
});

test("a fetcher that throws is reported as unreachable", async () => {
  await assert.rejects(
    fetchJsonCapped({
      url: "https://upstream.invalid/v1/models",
      fetcher: async () => {
        throw new Error("getaddrinfo ENOTFOUND upstream.invalid");
      },
    }),
    (error: unknown) => {
      assert.ok(expectCode("unreachable")(error));
      assert.equal(
        (error as ProviderError).message.includes("ENOTFOUND"),
        false,
      );
      return true;
    },
  );
});

test("a response without a body stream is reported, not crashed on", async () => {
  await assert.rejects(
    fetchJsonCapped({
      url: "https://upstream.invalid/v1/models",
      fetcher: async () =>
        new Response(null, { status: 204, headers: { "content-type": "application/json" } }),
    }),
    expectCode("upstream_error"),
  );
});

test("a hostile content-length cannot bypass the byte cap", async () => {
  await assert.rejects(
    fetchJsonCapped({
      url: "https://upstream.invalid/v1/models",
      maxBytes: 64,
      fetcher: async () =>
        new Response("x".repeat(10_000), {
          status: 200,
          headers: { "content-type": "application/json", "content-length": "8" },
        }),
    }),
    expectCode("upstream_error"),
  );
});
