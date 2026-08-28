import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import test from "node:test";
import { ProviderError } from "@bayz/providers";
import {
  OUTBOUND_CONCURRENCY_DEFAULT,
  OUTBOUND_CONCURRENCY_MAX,
  OUTBOUND_CONCURRENCY_MIN,
  OUTBOUND_QUEUE_DEPTH_DEFAULT,
  RouterError,
  configureOutboundConcurrency,
  createSemaphore,
  outboundSemaphore,
  resetOutboundConcurrency,
  sendChatRequest,
  type TransportProvider,
} from "../src/index.js";

/* ------------------------------------------------------------------ *
 * The semaphore itself
 * ------------------------------------------------------------------ */

test("the semaphore admits up to its limit and makes the next caller wait", async () => {
  const semaphore = createSemaphore({ limit: 2 });
  const first = await semaphore.acquire();
  const second = await semaphore.acquire();
  assert.equal(semaphore.inFlight(), 2);

  let thirdAdmitted = false;
  const third = semaphore.acquire().then((release) => {
    thirdAdmitted = true;
    return release;
  });
  // Deliberately not a timer: a macrotask turn is enough to prove the promise did
  // not resolve, and a sleep would make the test slow and flaky instead of exact.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(thirdAdmitted, false, "the third caller must wait, not proceed");
  assert.equal(semaphore.queued(), 1);

  first();
  const release = await third;
  assert.equal(thirdAdmitted, true);
  assert.equal(semaphore.queued(), 0);
  assert.equal(semaphore.inFlight(), 2);

  second();
  release();
  assert.equal(semaphore.inFlight(), 0);
});

test("the default limit is 32 and the configurable range is 1 to 512", () => {
  assert.equal(OUTBOUND_CONCURRENCY_DEFAULT, 32);
  assert.equal(OUTBOUND_CONCURRENCY_MIN, 1);
  assert.equal(OUTBOUND_CONCURRENCY_MAX, 512);
  assert.equal(createSemaphore().limit, OUTBOUND_CONCURRENCY_DEFAULT);

  for (const limit of [OUTBOUND_CONCURRENCY_MIN, 32, OUTBOUND_CONCURRENCY_MAX]) {
    assert.equal(createSemaphore({ limit }).limit, limit);
  }
  // Out of range is refused rather than clamped: silently serving 512 when the
  // operator asked for 5000 would be a protection that lied about its value.
  for (const limit of [0, -1, 513, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createSemaphore({ limit }),
      (error: unknown) =>
        error instanceof RouterError && error.code === "invalid_route_config",
      `limit ${limit} was accepted`,
    );
  }
});

test("a caller beyond the queue depth is refused rather than queued forever", async () => {
  const semaphore = createSemaphore({ limit: 1, queueLimit: 2 });
  const held = await semaphore.acquire();

  const queued = [semaphore.acquire(), semaphore.acquire()];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(semaphore.queued(), 2);

  // An unbounded queue turns a slow upstream into unbounded memory growth and
  // unbounded latency: every caller waits, nobody is told, and the process dies
  // holding requests nobody is still waiting for.
  await assert.rejects(
    () => semaphore.acquire(),
    (error: unknown) => {
      assert.ok(error instanceof RouterError);
      assert.equal(error.code, "rate_limited");
      return true;
    },
  );

  held();
  (await queued[0]!)();
  (await queued[1]!)();
  assert.equal(semaphore.inFlight(), 0);
});

test("the default queue depth is bounded and documented", () => {
  assert.equal(OUTBOUND_QUEUE_DEPTH_DEFAULT, 256);
  assert.equal(createSemaphore().queueLimit, OUTBOUND_QUEUE_DEPTH_DEFAULT);
});

test("a release is idempotent, so a double release cannot inflate the limit", async () => {
  const semaphore = createSemaphore({ limit: 1 });
  const release = await semaphore.acquire();
  release();
  release();
  release();
  assert.equal(semaphore.inFlight(), 0);

  // If the double release had leaked a permit, two callers would now be admitted.
  const first = await semaphore.acquire();
  let secondAdmitted = false;
  void semaphore.acquire().then(() => {
    secondAdmitted = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondAdmitted, false, "a double release must not create a permit");
  first();
});

test("the cap recovers after a hundred mixed outcomes", async () => {
  const semaphore = createSemaphore({ limit: 4, queueLimit: 256 });
  let peak = 0;

  await Promise.all(
    Array.from({ length: 100 }, async (_unused, index) => {
      const release = await semaphore.acquire();
      peak = Math.max(peak, semaphore.inFlight());
      try {
        if (index % 3 === 0) {
          throw new Error("failure");
        }
        if (index % 3 === 1) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      } catch {
        // A failing task must still release, which is what the finally proves.
      } finally {
        release();
      }
    }),
  );

  assert.ok(peak <= 4, `the cap was exceeded: peak ${peak}`);
  assert.equal(semaphore.inFlight(), 0, "every permit must come back");
  assert.equal(semaphore.queued(), 0);
});

test("an aborted waiter leaves the queue instead of holding a slot forever", async () => {
  const semaphore = createSemaphore({ limit: 1, queueLimit: 4 });
  const held = await semaphore.acquire();

  const controller = new AbortController();
  const waiting = semaphore.acquire(controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(semaphore.queued(), 1);

  controller.abort();
  await assert.rejects(
    () => waiting,
    (error: unknown) => error instanceof ProviderError,
  );
  assert.equal(semaphore.queued(), 0, "an abandoned waiter must be removed");

  // Releasing must not hand the permit to the departed waiter and lose it.
  held();
  const next = await semaphore.acquire();
  assert.equal(semaphore.inFlight(), 1);
  next();
});

test("an already-aborted caller never takes a permit", async () => {
  const semaphore = createSemaphore({ limit: 4 });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => semaphore.acquire(controller.signal),
    (error: unknown) => error instanceof ProviderError,
  );
  assert.equal(semaphore.inFlight(), 0);
});

/* ------------------------------------------------------------------ *
 * The process-wide limiter
 * ------------------------------------------------------------------ */

test("the outbound limiter is per-process, not per-provider", () => {
  resetOutboundConcurrency();
  // Sockets, file descriptors, and memory are process resources. A per-provider cap
  // would let twenty providers open twenty times the sockets while every individual
  // cap looked respected.
  assert.equal(outboundSemaphore(), outboundSemaphore());
  assert.equal(outboundSemaphore().limit, OUTBOUND_CONCURRENCY_DEFAULT);

  configureOutboundConcurrency({ limit: 8 });
  assert.equal(outboundSemaphore().limit, 8);
  assert.equal(outboundSemaphore(), outboundSemaphore());

  assert.throws(
    () => configureOutboundConcurrency({ limit: 0 }),
    (error: unknown) => error instanceof RouterError,
  );
  resetOutboundConcurrency();
  assert.equal(outboundSemaphore().limit, OUTBOUND_CONCURRENCY_DEFAULT);
});

/* ------------------------------------------------------------------ *
 * The cap against a real origin
 * ------------------------------------------------------------------ */

const REPLY = JSON.stringify({
  choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
});

type Origin = {
  port: number;
  /** How many TCP connections the origin has accepted. */
  connections(): number;
  /** How many requests are inside the handler right now. */
  inHandler(): number;
  releaseAll(): void;
  close(): Promise<void>;
};

/**
 * A real HTTP origin that holds every request open until told to answer.
 *
 * The cap has to be observed at the *socket*, not at the caller: a limiter that let
 * every request open a connection and merely delayed reading the response would pass
 * a caller-side assertion while providing none of the protection.
 */
async function withHeldOrigin(): Promise<Origin> {
  let accepted = 0;
  let inHandler = 0;
  const pending: Array<() => void> = [];
  const sockets = new Set<Socket>();

  const server: Server = createHttpServer((request, response) => {
    inHandler += 1;
    request.resume();
    const answer = (): void => {
      inHandler -= 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(REPLY);
    };
    pending.push(answer);
  });
  server.on("connection", (socket: Socket) => {
    accepted += 1;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    port,
    connections: () => accepted,
    inHandler: () => inHandler,
    releaseAll: () => {
      while (pending.length > 0) {
        pending.shift()!();
      }
    },
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function provider(port: number): TransportProvider {
  return {
    id: "cap-provider",
    kind: "openai-compatible",
    baseUrl: `http://127.0.0.1:${port}`,
    requestTimeoutMs: 5_000,
    // Loopback is denied by default, and these tests drive a real loopback origin, so
    // the policy has to be opted into exactly as an operator running a local runtime
    // would. Without it the attempt is refused before the permit is even taken.
    egress: { allowLoopback: true, allowPrivate: false },
  } as TransportProvider;
}

const CHAT = {
  model: "m",
  messages: [{ role: "user" as const, content: "hi" }],
} as never;

test("the transport cap stops the over-limit request from opening a socket", async (t) => {
  const origin = await withHeldOrigin();
  t.after(async () => {
    origin.releaseAll();
    await origin.close();
  });

  const semaphore = createSemaphore({ limit: 2, queueLimit: 8 });

  const held = [
    sendChatRequest({ provider: provider(origin.port), request: CHAT, semaphore }),
    sendChatRequest({ provider: provider(origin.port), request: CHAT, semaphore }),
  ];

  // Wait until both are genuinely at the origin rather than merely dispatched.
  const deadline = Date.now() + 4000;
  while (origin.inHandler() < 2) {
    if (Date.now() > deadline) {
      throw new Error(`only ${origin.inHandler()} requests reached the origin`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const connectionsWhileFull = origin.connections();

  const queued = sendChatRequest({
    provider: provider(origin.port),
    request: CHAT,
    semaphore,
  });
  // Give the queued attempt every chance to misbehave.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    origin.connections(),
    connectionsWhileFull,
    "the capped request opened a socket instead of waiting",
  );
  assert.equal(origin.inHandler(), 2);

  origin.releaseAll();
  const first = await Promise.all(held);
  assert.equal(first.length, 2);

  // Once a permit frees the queued attempt proceeds for real.
  const settleBy = Date.now() + 4000;
  while (origin.inHandler() < 1) {
    if (Date.now() > settleBy) {
      throw new Error("the queued request never reached the origin");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  origin.releaseAll();
  const third = await queued;
  assert.equal(third.content, "ok");
  assert.equal(semaphore.inFlight(), 0, "the transport leaked a permit");
});

test("a transport failure returns its permit", async (t) => {
  const origin = await withHeldOrigin();
  t.after(async () => {
    origin.releaseAll();
    await origin.close();
  });

  const semaphore = createSemaphore({ limit: 1, queueLimit: 8 });

  // A closed port: the attempt fails at connect, well before any response.
  const dead = provider(1);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      () => sendChatRequest({ provider: dead, request: CHAT, semaphore }),
      (error: unknown) => error instanceof ProviderError,
    );
    assert.equal(semaphore.inFlight(), 0, `permit leaked on attempt ${attempt}`);
  }

  // And the cap still works afterwards, which is the property that matters: a
  // limiter that leaks on the error path degrades into a permanent outage.
  origin.releaseAll();
  const ok = sendChatRequest({ provider: provider(origin.port), request: CHAT, semaphore });
  const settleBy = Date.now() + 4000;
  while (origin.inHandler() < 1) {
    if (Date.now() > settleBy) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  origin.releaseAll();
  assert.equal((await ok).content, "ok");
  assert.equal(semaphore.inFlight(), 0);
});

test("a request refused by the queue bound never touches the origin", async (t) => {
  const origin = await withHeldOrigin();
  t.after(async () => {
    origin.releaseAll();
    await origin.close();
  });

  const semaphore = createSemaphore({ limit: 1, queueLimit: 1 });
  const held = sendChatRequest({
    provider: provider(origin.port),
    request: CHAT,
    semaphore,
  });
  const deadline = Date.now() + 4000;
  while (origin.inHandler() < 1) {
    if (Date.now() > deadline) {
      throw new Error("the first request never reached the origin");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const queued = sendChatRequest({
    provider: provider(origin.port),
    request: CHAT,
    semaphore,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const before = origin.connections();

  await assert.rejects(
    () => sendChatRequest({ provider: provider(origin.port), request: CHAT, semaphore }),
    (error: unknown) => error instanceof RouterError && error.code === "rate_limited",
  );
  assert.equal(origin.connections(), before, "a refused request must not connect");

  origin.releaseAll();
  await held;
  const settleBy = Date.now() + 4000;
  while (origin.inHandler() < 1) {
    if (Date.now() > settleBy) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  origin.releaseAll();
  await queued;
  assert.equal(semaphore.inFlight(), 0);
});
