/**
 * Concurrency cap proof — 9I Task 5.
 *
 * The plan asks for two specific behaviours, and they are different claims:
 *
 *   1. The 33rd concurrent request **waits** rather than opening a socket.
 *   2. Beyond the queue depth it is **refused with `rate_limited`** rather than queued forever.
 *
 * "Waits rather than opening a socket" is the sharp one, and it is only observable from the
 * *origin's* side: the origin counts how many upstream connections were concurrently open. If the
 * cap works, that count never exceeds the limit no matter how many clients pile in. Asserting on
 * client-visible latency instead would be satisfied by a system that opened 200 sockets and was
 * merely slow.
 *
 * Both are proved against a **small explicit limit** rather than the default 32. Two reasons, and
 * neither is convenience: a queue-full proof at the default needs 32 + 256 = 289 simultaneous
 * sockets, which on this device measures the phone rather than the semaphore; and a small limit
 * makes the boundary exact — with limit 4 and queue 2, the 7th caller must be refused, and that is
 * an arithmetic claim rather than a statistical one.
 *
 * The limits are **restored** afterwards. Leaving a 4-permit semaphore installed process-wide
 * would silently throttle every later measurement.
 */

export async function proveCap({ lib, check, note, section }) {
  section("concurrency cap");

  const { ADMIN_TOKEN, KEK_HEX, MODEL, drive, freshDataDir, seed, startBayz, startFastOrigin } = lib;
  const concurrency = await import("../packages/router/src/concurrency.ts");

  const lines = [];
  const record = (text) => {
    lines.push(text);
    note(text);
  };

  record(
    `defaults read from packages/router/src/concurrency.ts: OUTBOUND_CONCURRENCY_DEFAULT=${concurrency.OUTBOUND_CONCURRENCY_DEFAULT}, OUTBOUND_QUEUE_DEPTH_DEFAULT=${concurrency.OUTBOUND_QUEUE_DEPTH_DEFAULT}, MIN=${concurrency.OUTBOUND_CONCURRENCY_MIN}, MAX=${concurrency.OUTBOUND_CONCURRENCY_MAX}`,
  );

  check(
    "the documented default concurrency is 32",
    concurrency.OUTBOUND_CONCURRENCY_DEFAULT === 32,
    `OUTBOUND_CONCURRENCY_DEFAULT=${concurrency.OUTBOUND_CONCURRENCY_DEFAULT}`,
  );

  /*
   * Part 1 — the semaphore's own arithmetic, directly.
   *
   * Unit-level, deliberately: this is the boundary where "the 33rd waits and the 257th is refused"
   * is a statement about exact numbers. Driving it through HTTP would add scheduling noise to a
   * claim that should be exact.
   */
  const semaphore = concurrency.createSemaphore({ limit: 4, queueLimit: 2 });
  const held = [];
  for (let index = 0; index < 4; index += 1) held.push(await semaphore.acquire());

  check("a semaphore at its limit reports the expected in-flight count", semaphore.inFlight() === 4, `inFlight=${semaphore.inFlight()}`);

  // The 5th and 6th wait: the promises must still be pending.
  let fifthSettled = false;
  let sixthSettled = false;
  const fifth = semaphore.acquire().then((release) => {
    fifthSettled = true;
    return release;
  });
  const sixth = semaphore.acquire().then((release) => {
    sixthSettled = true;
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  check(
    "past the limit a caller waits rather than proceeding",
    fifthSettled === false && sixthSettled === false && semaphore.queued() === 2,
    `fifthSettled=${fifthSettled} sixthSettled=${sixthSettled} queued=${semaphore.queued()}`,
  );

  /*
   * The 7th exceeds the queue depth and must be refused immediately.
   *
   * Raced against a timer rather than simply awaited. Mutation A removed the queue-full rejection
   * entirely, and a bare `await` then hung the whole run — Node exited 13 with "unsettled top-level
   * await", which is technically red but reports the wrong thing: the log ends mid-suite with no
   * failing check, so a reader learns the harness broke rather than that the bound is gone. With
   * the race the same mutation produces `FAIL 35 … refused=timeout`, which names the defect.
   */
  const refusal = await Promise.race([
    semaphore.acquire().then(
      () => undefined,
      (error) => error,
    ),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 200)),
  ]);
  check(
    "beyond the queue depth a caller is refused rate_limited rather than queued forever",
    refusal !== "timeout" && refusal?.code === "rate_limited" && refusal?.stage === "concurrency-queue-full",
    refusal === "timeout"
      ? "the 7th acquire never settled — the queue is unbounded"
      : `code=${refusal?.code} stage=${refusal?.stage}`,
  );
  record(
    refusal === "timeout"
      ? "queue-full refusal: NONE — the caller waited indefinitely"
      : `queue-full refusal: ${refusal?.name} code=${refusal?.code} stage=${refusal?.stage}`,
  );

  // Releasing hands permits to the waiters in order, and a double release returns only one.
  held[0]();
  held[0]();
  await new Promise((resolve) => setTimeout(resolve, 30));
  check(
    "an idempotent release hands exactly one permit to exactly one waiter",
    fifthSettled === true && sixthSettled === false,
    `fifthSettled=${fifthSettled} sixthSettled=${sixthSettled} inFlight=${semaphore.inFlight()}`,
  );

  held[1]();
  const [fifthRelease, sixthRelease] = await Promise.all([fifth, sixth]);
  fifthRelease();
  sixthRelease();
  held[2]();
  held[3]();
  check("every permit is returned once the run drains", semaphore.inFlight() === 0, `inFlight=${semaphore.inFlight()}`);

  /*
   * Part 2 — the cap bounding *real work*, observed from the origin.
   *
   * A slow origin (40 ms) is required: with an instant origin, requests complete faster than they
   * can pile up and the concurrency never reaches the limit, so the measurement would show a low
   * number and prove nothing. This is the one place a delay is legitimate — it creates the
   * contention the cap exists to bound.
   */
  const limit = 4;
  const previous = concurrency.outboundSemaphore().limit;
  concurrency.configureOutboundConcurrency({ limit, queueLimit: 256 });

  const origin = await startFastOrigin({ delayMs: 40 });
  const bayz = await startBayz({ dataDir: freshDataDir("cap"), adminToken: ADMIN_TOKEN, kekHex: KEK_HEX });

  let observed;
  try {
    const key = await seed(bayz, { port: origin.port });
    const run = await drive({ base: bayz.base, key, concurrency: 32, total: 64, stream: false });

    observed = {
      ok: run.results.filter((entry) => entry.status === 200).length,
      failed: run.results.filter((entry) => entry.status !== 200).length,
      originMaxConcurrent: origin.state.maxConcurrent,
      clientPeak: run.peakInFlight,
      elapsedMs: run.elapsedMs,
    };

    record(
      `outbound limit ${limit}: 32 clients issued 64 requests; the origin never saw more than ${observed.originMaxConcurrent} concurrent upstream connections (client peak in flight ${observed.clientPeak}), ${observed.ok} ok / ${observed.failed} failed in ${observed.elapsedMs} ms`,
    );

    /*
     * The load-bearing assertion. 32 clients are hammering, but the process-wide semaphore is set
     * to 4, so the origin — a real HTTP server counting its own concurrent connections — must
     * never see a 5th. This is what "waits rather than opening a socket" means, measured where the
     * socket would actually be opened.
     */
    check(
      "the outbound cap bounds real upstream concurrency: the origin never saw more connections than the limit",
      observed.originMaxConcurrent <= limit,
      `origin saw ${observed.originMaxConcurrent} concurrent upstream connections with a limit of ${limit}`,
    );

    check(
      "capped work still completes rather than being dropped",
      observed.ok === 64,
      `ok=${observed.ok} failed=${observed.failed}`,
    );

    // A queue-full refusal, if any occurred, must be `rate_limited` and nothing else.
    const badCodes = run.results.filter((entry) => entry.status !== 200 && entry.code !== "rate_limited");
    check(
      "under the cap the only refusal code is rate_limited",
      badCodes.length === 0,
      `unexpected codes: ${badCodes.map((entry) => entry.code).join(", ")}`,
    );
  } finally {
    await bayz.close();
    await origin.close();
    // Restore, or every later measurement runs behind a 4-permit gate.
    concurrency.configureOutboundConcurrency({ limit: previous });
  }

  check(
    "the process-wide limit is restored after the cap proof",
    concurrency.outboundSemaphore().limit === previous,
    `limit=${concurrency.outboundSemaphore().limit} expected=${previous}`,
  );

  /*
   * Part 3 — the *inbound* gate, which is a different cap with different behaviour.
   *
   * Worth separating explicitly, because conflating the two is easy and would misdescribe the
   * system. The outbound semaphore **queues** then refuses past its queue depth. The inbound gate
   * at `auth.ts:190` has no queue at all: it refuses with `429 rate_limited` the instant
   * `inFlight >= concurrency`. Both are correct for what they protect — outbound protects sockets
   * and upstream spend, inbound protects this process from being asked to hold more work than it
   * can — but only one of them waits.
   *
   * `startBayz` cannot express this (it takes no `concurrency`), so the app is built directly.
   */
  const inbound = await proveInboundGate({ lib, check, record });

  return { transcript: lines.map((entry) => `- ${entry}`).join("\n"), observed, inbound };
}

/** The inbound gate: refuses immediately at the limit, no queue. */
async function proveInboundGate({ lib, check, record }) {
  const { ADMIN_TOKEN, KEK_HEX, MODEL, freshDataDir, nextSentinel, seed, startFastOrigin } = lib;
  const { buildApp } = await import("../apps/server/src/app.ts");
  const { createBayzRuntime } = await import("../apps/server/src/runtime.ts");

  const limit = 4;
  const origin = await startFastOrigin({ delayMs: 120 });
  const dataDir = freshDataDir("inbound");
  const runtime = createBayzRuntime(
    { host: "127.0.0.1", port: 0, dataDir, dashboardRoot: "/nonexistent" },
    { env: { BAYZ_MASTER_KEY: KEK_HEX, BAYZ_API_TOKEN: ADMIN_TOKEN }, notify: () => {}, logger: () => {} },
  );
  const app = buildApp({
    logger: false,
    apiToken: ADMIN_TOKEN,
    runtime,
    rateLimit: { max: 100_000, authMax: 100_000 },
    concurrency: limit,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;

  try {
    const admin = async (method, path, body) => {
      const headers = { authorization: `Bearer ${ADMIN_TOKEN}` };
      if (body !== undefined) headers["content-type"] = "application/json";
      const response = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text();
      let json;
      try {
        json = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      return { status: response.status, json, text };
    };
    const key = await seed({ admin }, { port: origin.port });

    // 16 simultaneous requests against a gate of 4, with a 120 ms origin so they genuinely overlap.
    const attempts = await Promise.all(
      Array.from({ length: 16 }, async () => {
        const response = await fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: nextSentinel() }] }),
        });
        const text = await response.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        return { status: response.status, code: json?.error?.code, retryAfter: response.headers.get("retry-after") };
      }),
    );

    const ok = attempts.filter((entry) => entry.status === 200).length;
    const refused = attempts.filter((entry) => entry.status === 429);

    record(
      `inbound gate ${limit}: 16 simultaneous requests → ${ok} served, ${refused.length} refused 429 rate_limited (retry-after present on ${refused.filter((entry) => entry.retryAfter !== null).length})`,
    );

    check(
      "the inbound gate refuses past its limit rather than queueing",
      refused.length > 0 && refused.every((entry) => entry.code === "rate_limited"),
      `refused=${refused.length} codes=${[...new Set(refused.map((entry) => entry.code))].join(",")}`,
    );

    check(
      "the inbound gate serves no more than its limit concurrently",
      origin.state.maxConcurrent <= limit,
      `origin saw ${origin.state.maxConcurrent} concurrent with an inbound limit of ${limit}`,
    );

    check(
      "an inbound refusal carries retry-after so a client can back off",
      refused.every((entry) => entry.retryAfter !== null),
      `${refused.filter((entry) => entry.retryAfter === null).length} refusals without retry-after`,
    );

    // The gate releases: once the burst drains, a fresh request succeeds.
    const after = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: nextSentinel() }] }),
    });
    check("the inbound gate releases its slots after the burst", after.status === 200, `status=${after.status}`);

    return { served: ok, refused: refused.length, limit };
  } finally {
    await app.close();
    runtime.close();
    await origin.close();
  }
}
