import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { ProviderError } from "@bayz/providers";
import {
  RouterError,
  sendChatRequestStreaming,
  type ChatChunk,
} from "../src/index.js";

const REQUEST = {
  model: "stream-model",
  messages: [{ role: "user" as const, content: "hi" }],
};

type OriginController = {
  port: number;
  connections: number;
  requests: number;
  destroyedSockets: number;
  close(): Promise<void>;
};

type Handler = (write: (text: string) => void, end: () => void, destroy: () => void) => void;

/**
 * A real `node:http` origin.
 *
 * Deliberately not a mock: the properties under test are socket lifetime, chunk
 * arrival order, and abort propagation, none of which a stubbed transport can
 * demonstrate.
 */
async function startOrigin(
  handler: Handler,
  options: { status?: number; contentType?: string } = {},
): Promise<OriginController> {
  const state = { connections: 0, requests: 0, destroyedSockets: 0 };
  const server: Server = createServer((request, response) => {
    state.requests += 1;
    request.socket.on("close", (hadError) => {
      if (hadError || !response.writableEnded) {
        state.destroyedSockets += 1;
      }
    });
    request.resume();
    response.writeHead(options.status ?? 200, {
      "content-type": options.contentType ?? "text/event-stream",
      "cache-control": "no-cache",
    });
    handler(
      (text) => {
        if (!response.writableEnded) {
          response.write(text);
        }
      },
      () => {
        if (!response.writableEnded) {
          response.end();
        }
      },
      () => response.socket?.destroy(),
    );
  });
  server.on("connection", () => {
    state.connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    get connections() {
      return state.connections;
    },
    get requests() {
      return state.requests;
    },
    get destroyedSockets() {
      return state.destroyedSockets;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function frame(content: string): string {
  return `data: ${JSON.stringify({
    model: "stream-model",
    choices: [{ delta: { content } }],
  })}\n\n`;
}

function providerFor(port: number, overrides: Partial<{ requestTimeoutMs: number; idleTimeoutMs: number }> = {}) {
  return {
    kind: "openai-compatible" as const,
    baseUrl: `http://127.0.0.1:${port}`,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 5000,
    ...(overrides.idleTimeoutMs === undefined
      ? {}
      : { idleTimeoutMs: overrides.idleTimeoutMs }),
  };
}

async function collect(iterable: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return chunks;
}

test("chunks arrive incrementally, before the origin finishes", async (t) => {
  let finish: (() => void) | undefined;
  const origin = await startOrigin((write, end) => {
    write(frame("one"));
    finish = () => {
      write(frame("two"));
      write("data: [DONE]\n\n");
      end();
    };
  });
  t.after(() => origin.close());

  const iterator = sendChatRequestStreaming({
    provider: providerFor(origin.port),
    request: REQUEST,
  })[Symbol.asyncIterator]();

  const first = await iterator.next();
  // The whole point of streaming: the consumer has usable content while the
  // origin is still writing. A buffered implementation would deadlock here.
  assert.equal(first.done, false);
  assert.equal(first.value?.contentDelta, "one");
  assert.ok(finish !== undefined);

  finish!();
  const second = await iterator.next();
  assert.equal(second.value?.contentDelta, "two");
  assert.equal((await iterator.next()).done, true);
});

test("a complete stream yields every delta in order and terminates", async (t) => {
  const origin = await startOrigin((write, end) => {
    write(frame("a"));
    write(frame("b"));
    write(frame("c"));
    write("data: [DONE]\n\n");
    end();
  });
  t.after(() => origin.close());

  const chunks = await collect(
    sendChatRequestStreaming({ provider: providerFor(origin.port), request: REQUEST }),
  );
  assert.deepEqual(
    chunks.map((chunk) => chunk.contentDelta),
    ["a", "b", "c"],
  );
});

test("a terminal usage chunk is surfaced with its counts", async (t) => {
  const origin = await startOrigin((write, end) => {
    write(frame("a"));
    write(
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      })}\n\n`,
    );
    write("data: [DONE]\n\n");
    end();
  });
  t.after(() => origin.close());

  const chunks = await collect(
    sendChatRequestStreaming({ provider: providerFor(origin.port), request: REQUEST }),
  );
  const last = chunks.at(-1);
  assert.equal(last?.finishReason, "stop");
  assert.deepEqual(last?.usage, {
    promptTokens: 4,
    completionTokens: 1,
    totalTokens: 5,
  });
});

test("absent usage stays undefined rather than becoming zero", async (t) => {
  const origin = await startOrigin((write, end) => {
    write(frame("a"));
    write("data: [DONE]\n\n");
    end();
  });
  t.after(() => origin.close());

  const chunks = await collect(
    sendChatRequestStreaming({ provider: providerFor(origin.port), request: REQUEST }),
  );
  for (const chunk of chunks) {
    assert.equal(chunk.usage, undefined);
  }
});

test("an idle gap beyond the idle timeout aborts with unreachable", async (t) => {
  const origin = await startOrigin((write) => {
    write(frame("a"));
    // Then nothing, forever. The idle timeout is the only thing that ends this.
  });
  t.after(() => origin.close());

  const iterator = sendChatRequestStreaming({
    provider: providerFor(origin.port, { requestTimeoutMs: 60000, idleTimeoutMs: 120 }),
    request: REQUEST,
  })[Symbol.asyncIterator]();

  assert.equal((await iterator.next()).value?.contentDelta, "a");
  await assert.rejects(
    () => iterator.next(),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.code === "unreachable" &&
      error.stage === "stream-idle-timeout",
  );
});

test("the idle timeout is distinct from the total timeout", async (t) => {
  // A stream that keeps sending must not be killed by an idle timeout, and a
  // stream that sends forever must still be killed by the total timeout.
  const timers: NodeJS.Timeout[] = [];
  const origin = await startOrigin((write) => {
    const timer = setInterval(() => write(frame("tick")), 20);
    timers.push(timer);
  });
  t.after(() => {
    timers.forEach(clearInterval);
    return origin.close();
  });

  const started = Date.now();
  await assert.rejects(
    () =>
      collect(
        sendChatRequestStreaming({
          provider: providerFor(origin.port, {
            requestTimeoutMs: 250,
            idleTimeoutMs: 5000,
          }),
          request: REQUEST,
        }),
      ),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "unreachable",
  );
  // It ended because of the total budget, not the idle one.
  assert.ok(Date.now() - started < 3000);
});

test("an upstream socket destroyed mid-stream is a terminal error, never a silent end", async (t) => {
  const origin = await startOrigin((write, _end, destroy) => {
    write(frame("partial"));
    setTimeout(destroy, 30);
  });
  t.after(() => origin.close());

  const iterator = sendChatRequestStreaming({
    provider: providerFor(origin.port),
    request: REQUEST,
  })[Symbol.asyncIterator]();

  assert.equal((await iterator.next()).value?.contentDelta, "partial");
  // Returning `done: true` here would hand the consumer a truncated completion
  // that looks complete, which is the worst possible outcome.
  await assert.rejects(
    () => iterator.next(),
    (error: unknown) =>
      (error instanceof ProviderError && error.code === "unreachable") ||
      (error instanceof RouterError && error.code === "invalid_response"),
  );
});

test("a stream that ends without DONE is a terminal error", async (t) => {
  const origin = await startOrigin((write, end) => {
    write(frame("truncated"));
    end();
  });
  t.after(() => origin.close());

  const iterator = sendChatRequestStreaming({
    provider: providerFor(origin.port),
    request: REQUEST,
  })[Symbol.asyncIterator]();

  assert.equal((await iterator.next()).value?.contentDelta, "truncated");
  await assert.rejects(
    () => iterator.next(),
    (error: unknown) =>
      error instanceof RouterError &&
      error.code === "invalid_response" &&
      error.stage === "sse-truncated",
  );
});

test("an abort signal destroys the upstream socket", async (t) => {
  const origin = await startOrigin((write) => {
    write(frame("a"));
  });
  t.after(() => origin.close());

  const controller = new AbortController();
  const iterator = sendChatRequestStreaming({
    provider: providerFor(origin.port),
    request: REQUEST,
    signal: controller.signal,
  })[Symbol.asyncIterator]();

  assert.equal((await iterator.next()).value?.contentDelta, "a");
  controller.abort();
  await assert.rejects(
    () => iterator.next(),
    (error: unknown) =>
      error instanceof ProviderError && error.stage === "stream-aborted",
  );
  // Give the socket close event a turn to land.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(origin.destroyedSockets, 1, "the upstream socket must be destroyed");
});

test("an already-aborted signal opens no socket at all", async (t) => {
  const origin = await startOrigin((write, end) => {
    write("data: [DONE]\n\n");
    end();
  });
  t.after(() => origin.close());

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      collect(
        sendChatRequestStreaming({
          provider: providerFor(origin.port),
          request: REQUEST,
          signal: controller.signal,
        }),
      ),
    (error: unknown) => error instanceof ProviderError,
  );
  assert.equal(origin.connections, 0, "no connection may be opened");
});

test("breaking out of the loop destroys the upstream socket", async (t) => {
  // A client that disconnects mid-stream leaves the consumer's `for await` early.
  // If that did not tear down the upstream, every abandoned stream would leak a
  // socket and keep the provider generating tokens nobody will read.
  const origin = await startOrigin((write) => {
    write(frame("a"));
    write(frame("b"));
  });
  t.after(() => origin.close());

  for await (const chunk of sendChatRequestStreaming({
    provider: providerFor(origin.port),
    request: REQUEST,
  })) {
    assert.equal(chunk.contentDelta, "a");
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(origin.destroyedSockets, 1);
});

test("a 401 before the first chunk maps to auth_failed", async (t) => {
  const origin = await startOrigin(
    (_write, end) => end(),
    { status: 401, contentType: "application/json" },
  );
  t.after(() => origin.close());

  await assert.rejects(
    () =>
      collect(
        sendChatRequestStreaming({
          provider: providerFor(origin.port),
          request: REQUEST,
        }),
      ),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "auth_failed",
  );
});

test("a 429 maps to rate_limited and a 500 to upstream_error", async (t) => {
  for (const [status, code] of [
    [429, "rate_limited"],
    [500, "upstream_error"],
    [404, "upstream_error"],
  ] as const) {
    const origin = await startOrigin(
      (_write, end) => end(),
      { status, contentType: "application/json" },
    );
    try {
      await assert.rejects(
        () =>
          collect(
            sendChatRequestStreaming({
              provider: providerFor(origin.port),
              request: REQUEST,
            }),
          ),
        (error: unknown) => error instanceof ProviderError && error.code === code,
        `status ${status}`,
      );
    } finally {
      await origin.close();
    }
  }
});

test("an error status body is never surfaced to the caller", async (t) => {
  const SENTINEL = "sk-leaked-credential-in-error-body";
  const origin = await startOrigin(
    (write, end) => {
      write(JSON.stringify({ error: SENTINEL }));
      end();
    },
    { status: 500, contentType: "application/json" },
  );
  t.after(() => origin.close());

  await assert.rejects(
    () =>
      collect(
        sendChatRequestStreaming({
          provider: providerFor(origin.port),
          request: REQUEST,
        }),
      ),
    (error: unknown) => {
      // An upstream error page routinely echoes the credential it just rejected.
      assert.ok(!String((error as Error).message).includes(SENTINEL));
      return error instanceof ProviderError;
    },
  );
});

test("response bytes beyond the cap abort mid-stream", async (t) => {
  const timers: NodeJS.Timeout[] = [];
  const origin = await startOrigin((write) => {
    const big = frame("z".repeat(32 * 1024));
    const timer = setInterval(() => write(big), 1);
    timers.push(timer);
  });
  t.after(() => {
    timers.forEach(clearInterval);
    return origin.close();
  });

  await assert.rejects(
    () =>
      collect(
        sendChatRequestStreaming({
          provider: providerFor(origin.port, { requestTimeoutMs: 30000 }),
          request: REQUEST,
          maxResponseBytes: 256 * 1024,
        }),
      ),
    (error: unknown) =>
      error instanceof RouterError && error.code === "response_too_large",
  );
});

test("the request body never carries the stream flag as false", async (t) => {
  // A streaming request must ask the upstream to stream. Sending `stream: false`
  // while parsing SSE would hang until the total timeout.
  let seen = "";
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      seen = Buffer.concat(chunks).toString("utf8");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  await collect(
    sendChatRequestStreaming({ provider: providerFor(port), request: REQUEST }),
  );
  assert.equal(JSON.parse(seen).stream, true);
});

test("a codex provider refuses to stream rather than pretending", async () => {
  await assert.rejects(
    () =>
      collect(
        sendChatRequestStreaming({
          provider: {
            kind: "codex-oauth",
            baseUrl: "http://127.0.0.1:1",
            requestTimeoutMs: 1000,
          },
          request: REQUEST,
        }),
      ),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "unsupported_operation",
  );
});

test("fifty sequential streams leak no handle and no timer", async (t) => {
  const origin = await startOrigin((write, end) => {
    write(frame("a"));
    write("data: [DONE]\n\n");
    end();
  });
  t.after(() => origin.close());

  // Warm up first: the agent's socket pool and the decoder allocate on first use,
  // and counting that as a leak would make the test permanently red.
  await collect(
    sendChatRequestStreaming({ provider: providerFor(origin.port), request: REQUEST }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  type WithHandles = { _getActiveHandles?: () => unknown[] };
  const handles = (): number =>
    (process as unknown as WithHandles)._getActiveHandles?.().length ?? 0;
  const baseline = handles();

  for (let index = 0; index < 50; index += 1) {
    const chunks = await collect(
      sendChatRequestStreaming({
        provider: providerFor(origin.port),
        request: REQUEST,
      }),
    );
    assert.equal(chunks.length, 1);
  }

  await new Promise((resolve) => setTimeout(resolve, 100));
  const after = handles();
  assert.ok(
    after <= baseline + 2,
    `handles grew from ${baseline} to ${after} across 50 streams`,
  );
});

test("a malformed chunk is skipped and the stream continues", async (t) => {
  const origin = await startOrigin((write, end) => {
    write("data: not-json\n\n");
    write(frame("recovered"));
    write("data: [DONE]\n\n");
    end();
  });
  t.after(() => origin.close());

  const chunks = await collect(
    sendChatRequestStreaming({ provider: providerFor(origin.port), request: REQUEST }),
  );
  assert.deepEqual(
    chunks.map((chunk) => chunk.contentDelta),
    ["recovered"],
  );
});

test("nine malformed chunks fail the stream", async (t) => {
  const origin = await startOrigin((write, end) => {
    for (let index = 0; index < 9; index += 1) {
      write("data: nope\n\n");
    }
    write("data: [DONE]\n\n");
    end();
  });
  t.after(() => origin.close());

  await assert.rejects(
    () =>
      collect(
        sendChatRequestStreaming({
          provider: providerFor(origin.port),
          request: REQUEST,
        }),
      ),
    (error: unknown) =>
      error instanceof RouterError && error.code === "invalid_response",
  );
});

test("an empty delta chunk yields no content but is not an error", async (t) => {
  // Providers routinely send a role-only first chunk and keepalive chunks with an
  // empty delta. Treating either as malformed would fail healthy streams.
  const origin = await startOrigin((write, end) => {
    write(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`);
    write(frame("text"));
    write("data: [DONE]\n\n");
    end();
  });
  t.after(() => origin.close());

  const chunks = await collect(
    sendChatRequestStreaming({ provider: providerFor(origin.port), request: REQUEST }),
  );
  assert.deepEqual(
    chunks.map((chunk) => chunk.contentDelta),
    [undefined, "text"],
  );
});
