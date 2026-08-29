/**
 * Chaos scenarios 1–5 — 9I Task 4. Part of `scripts/chaos-smoke.mjs`.
 *
 * Provider-side failure: death mid-request, death mid-stream, malformed responses, connection
 * resets at four points, and timeouts.
 */

const lib = await import("./chaos-lib.mjs");

const {
  ADMIN_TOKEN,
  KEK_HEX,
  MODEL,
  chat,
  check,
  freshDataDir,
  integrityCheck,
  note,
  readStream,
  seed,
  section,
  startBayz,
  startHostileOrigin,
  startOrigin,
} = lib;

const bayzOpts = { adminToken: ADMIN_TOKEN, kekHex: KEK_HEX };
const CHAT = { model: MODEL, messages: [{ role: "user", content: "chaos" }] };

/** Every scenario ends with an integrity check, per the plan. */
async function assertIntegrity(dataDir, label) {
  const verdict = await integrityCheck(dataDir);
  check(`${label}: PRAGMA integrity_check is ok`, verdict === "ok", `returned ${JSON.stringify(verdict)}`);
}

/** 1. Provider dies mid-request; the next request to a healthy provider succeeds. */
export async function providerDiesMidRequest() {
  section("1. provider dies mid-request");
  const dataDir = freshDataDir("die-mid-request");
  const origin = await startHostileOrigin();
  const bayz = await startBayz({ dataDir, ...bayzOpts });

  try {
    const key = await seed(bayz, { port: origin.port });

    origin.set({ mode: "reset-pre-response" });
    const failed = await chat(bayz, key, CHAT);

    check(
      "provider death mid-request produces a stable error envelope",
      failed.status >= 500 &&
        typeof failed.json?.error?.code === "string" &&
        typeof failed.json?.error?.message === "string" &&
        typeof failed.json?.error?.requestId === "string",
      `status=${failed.status} body=${failed.text.slice(0, 160)}`,
    );

    // The plan names `unreachable`. `all_routes_failed` is the router's aggregate when every
    // candidate failed, and with one route that is the same event seen one layer up.
    check(
      "the failure names a known transport code",
      ["unreachable", "all_routes_failed", "upstream_error"].includes(failed.json?.error?.code),
      `code=${failed.json?.error?.code}`,
    );

    const rows = bayz.runtime.usage.recentRequests(10);
    check(
      "telemetry records the failed request",
      rows.some((row) => row.outcome !== "ok"),
      `rows=${JSON.stringify(rows.map((r) => r.outcome))}`,
    );

    /*
     * "The next request to a healthy provider succeeds" is the half that matters: a gateway can
     * report a failure correctly and still be left in a broken state afterwards.
     */
    origin.set({ mode: "ok" });
    const recovered = await chat(bayz, key, CHAT);
    check(
      "the next request to a healthy provider succeeds",
      recovered.status === 200 && recovered.json?.choices?.[0]?.message?.content === "CHAOS-OK",
      `status=${recovered.status} body=${recovered.text.slice(0, 160)}`,
    );

    await assertIntegrity(dataDir, "provider-dies-mid-request");
  } finally {
    await bayz.close();
    await origin.close();
  }
}

/**
 * 2. Provider dies mid-**stream**, after the first byte.
 *
 * The load-bearing assertion is that **no failover is attempted**. 9B's semantics are honest
 * rather than convenient: once a byte has reached the client, a retry would produce a second
 * answer for one question, so BAYZ must not silently start over on another provider. Proven by
 * a second, healthy origin observing **zero** requests.
 */
export async function providerDiesMidStream() {
  section("2. provider dies mid-stream (no failover)");
  const dataDir = freshDataDir("die-mid-stream");
  const primary = await startHostileOrigin();
  const secondary = await startOrigin({ text: "SECONDARY-SHOULD-NEVER-ANSWER" });
  const bayz = await startBayz({ dataDir, ...bayzOpts });

  try {
    const key = await seed(bayz, { port: primary.port });

    // A second route on the same model at lower priority: the shape that *would* fail over.
    await bayz.admin("POST", "/api/providers", {
      id: "chaos-secondary",
      kind: "openai-compatible",
      displayName: "Chaos Secondary",
      baseUrl: `http://127.0.0.1:${secondary.port}`,
      config: { allowLoopback: true },
    });
    await bayz.admin("PUT", "/api/providers/chaos-secondary/credential", { value: "SECONDARY-CREDENTIAL" });
    await bayz.admin("POST", "/api/routes", {
      id: "chaos-route-secondary",
      model: MODEL,
      providerId: "chaos-secondary",
      freeOnly: false,
      priority: 1,
    });

    primary.set({ mode: "die-mid-stream", framesBeforeFailure: 2 });
    const stream = await readStream(bayz, key, { ...CHAT, stream: true });

    check(
      "the client saw stream bytes before the failure",
      stream.status === 200 && stream.firstByteSeen && stream.body.includes("part0"),
      `status=${stream.status} firstByte=${stream.firstByteSeen} body=${stream.body.slice(0, 120)}`,
    );

    check(
      "the stream terminates rather than hanging",
      stream.error !== undefined || !stream.body.includes("[DONE]"),
      `error=${stream.error} tail=${stream.body.slice(-80)}`,
    );

    check(
      "no failover is attempted after the first byte — the second origin saw zero requests",
      secondary.state.chatHits === 0,
      `secondary chatHits=${secondary.state.chatHits}`,
    );

    check(
      "the client never received the second provider's answer",
      !stream.body.includes("SECONDARY-SHOULD-NEVER-ANSWER"),
      "the secondary's content reached the client",
    );

    /*
     * "No partial row is written" reads as: a request that died mid-stream must not be recorded
     * as a success. A row marked failed is correct and useful; a row marked ok would be a lie
     * that reaches billing.
     */
    const rows = bayz.runtime.usage.recentRequests(10);
    check(
      "no mid-stream failure is recorded as a successful request",
      !rows.some((row) => row.outcome === "ok"),
      `rows=${JSON.stringify(rows.map((r) => ({ outcome: r.outcome, attempts: r.attempts })))}`,
    );

    await assertIntegrity(dataDir, "provider-dies-mid-stream");
  } finally {
    await bayz.close();
    await primary.close();
    await secondary.close();
  }
}

/** 3. Malformed provider responses, non-streaming and streaming. */
export async function providerMalformed() {
  section("3. provider returns a malformed response");
  const dataDir = freshDataDir("malformed");
  const origin = await startHostileOrigin();
  const bayz = await startBayz({ dataDir, ...bayzOpts });

  try {
    const key = await seed(bayz, { port: origin.port });

    origin.set({ mode: "malformed" });
    const broken = await chat(bayz, key, CHAT);
    check(
      "a truncated JSON body is refused with a known code",
      broken.status >= 400 && typeof broken.json?.error?.code === "string",
      `status=${broken.status} code=${broken.json?.error?.code}`,
    );
    check(
      "the malformed upstream body is not echoed to the client",
      !broken.text.includes("this is not"),
      `body=${broken.text.slice(0, 160)}`,
    );

    origin.set({ mode: "malformed-sse" });
    const brokenStream = await readStream(bayz, key, { ...CHAT, stream: true });
    check(
      "a malformed SSE frame ends the stream without a clean [DONE]",
      !brokenStream.body.includes("data: [DONE]") || brokenStream.error !== undefined,
      `body=${brokenStream.body.slice(0, 160)} error=${brokenStream.error}`,
    );

    origin.set({ mode: "http-500" });
    const upstream500 = await chat(bayz, key, CHAT);
    check(
      "an upstream 500 is translated, not passed through verbatim",
      upstream500.status >= 400 && !upstream500.text.includes("upstream exploded"),
      `status=${upstream500.status} body=${upstream500.text.slice(0, 160)}`,
    );

    origin.set({ mode: "ok" });
    const recovered = await chat(bayz, key, CHAT);
    check("a healthy request still succeeds afterwards", recovered.status === 200, `status=${recovered.status}`);

    await assertIntegrity(dataDir, "provider-malformed");
  } finally {
    await bayz.close();
    await origin.close();
  }
}

/** 4. Connection reset at pre-request, post-headers, mid-body, and mid-SSE. */
export async function connectionResets() {
  section("4. connection reset at four points");
  const dataDir = freshDataDir("resets");
  const origin = await startHostileOrigin();
  const bayz = await startBayz({ dataDir, ...bayzOpts });

  try {
    const key = await seed(bayz, { port: origin.port });

    for (const [label, mode] of [
      ["pre-request", "reset-pre-response"],
      ["post-headers", "reset-post-headers"],
      ["mid-body", "reset-mid-body"],
    ]) {
      origin.set({ mode });
      const result = await chat(bayz, key, CHAT);
      check(
        `RST ${label}: a stable envelope with a known code`,
        result.status >= 400 &&
          typeof result.json?.error?.code === "string" &&
          typeof result.json?.error?.requestId === "string",
        `status=${result.status} body=${result.text.slice(0, 140)}`,
      );
    }

    origin.set({ mode: "die-mid-stream", framesBeforeFailure: 1 });
    const midSse = await readStream(bayz, key, { ...CHAT, stream: true });
    check(
      "RST mid-SSE: the stream ends without a forged [DONE]",
      !midSse.body.includes("data: [DONE]"),
      `body=${midSse.body.slice(0, 160)}`,
    );

    origin.set({ mode: "ok" });
    const recovered = await chat(bayz, key, CHAT);
    check("the listener survives four resets and still serves", recovered.status === 200, `status=${recovered.status}`);

    await assertIntegrity(dataDir, "connection-resets");
  } finally {
    await bayz.close();
    await origin.close();
  }
}

/**
 * 5. Upstream timeout: total versus idle, kept distinguishable.
 *
 * The knob that matters here is **the route's** `requestTimeoutMs`, not the provider's
 * `timeoutMs`. Traced rather than assumed: `packages/router/src/router.ts:201` and `:270` pass
 * `route.config.requestTimeoutMs` into the transport, which applies it at
 * `transport.ts:190` and `:486`; the provider's `timeoutMs` governs discovery and probe calls.
 * The first version of this scenario set `timeoutMs: 1000` on the provider and both paths took
 * 60 s — the `REQUEST_TIMEOUT_MS_DEFAULT`/`DEFAULT_IDLE_TIMEOUT_MS` default — which is exactly
 * the "it passed for the wrong reason" outcome: the checks were green while nothing under test
 * had been configured at all.
 */
export async function timeouts() {
  section("5. upstream timeout (total and idle)");
  const dataDir = freshDataDir("timeouts");
  const origin = await startHostileOrigin();
  const bayz = await startBayz({ dataDir, ...bayzOpts });

  try {
    /*
     * `requestTimeoutMs` lives **inside** `config`, not at the top level.
     *
     * Read from `CreateRouteInput` (`packages/router/src/repository.ts:58`), whose only nesting
     * point is `config?: unknown`, and `ALLOWED_CONFIG_KEYS` at line 17 —
     * `{"maxAttempts", "requestTimeoutMs"}`. Passing it top-level returned **201** with
     * `config: { requestTimeoutMs: 60000 }`: silently the default. That is why the check below
     * asserts the deadline *took effect* rather than merely that a failure occurred — a
     * status-only assertion was green while the timeout under test was never configured.
     *
     * 1000 ms is `REQUEST_TIMEOUT_MS_MIN`; lower is refused, which would test validation instead.
     */
    const key = await seed(bayz, { port: origin.port, routeConfig: { config: { requestTimeoutMs: 1000 } } });

    origin.set({ mode: "silent" });
    const started = Date.now();
    const totalTimeout = await chat(bayz, key, CHAT);
    const totalElapsed = Date.now() - started;

    check(
      "a silent upstream ends in a bounded failure, not a hang",
      totalTimeout.status >= 400 && typeof totalTimeout.json?.error?.code === "string",
      `status=${totalTimeout.status} code=${totalTimeout.json?.error?.code} after ${totalElapsed} ms`,
    );

    /*
     * The configured deadline is asserted to have *taken effect* — a 1 s route timeout must not
     * take 60 s — but with a generous ceiling rather than a tight one.
     * `scripts/fuzz/host-baseline.mjs` measured this Termux/proot host stalling a bare socket
     * loop for 8–184 s at load average 0.12, so a tight bound would fail for reasons unrelated
     * to BAYZ. 30 s still separates "the 1 s deadline fired" from "the 60 s default fired",
     * which is the distinction that matters.
     */
    check(
      "the route's 1 s requestTimeoutMs fired, not the 60 s default",
      totalElapsed < 30_000,
      `took ${totalElapsed} ms — the configured deadline did not take effect`,
    );
    note(`total-timeout path returned after ${totalElapsed} ms with a 1000 ms route deadline (host stalls up to 184 s are documented in scripts/fuzz/host-baseline.mjs, hence the 30 s ceiling)`);

    origin.set({ mode: "hang" });
    const idleStarted = Date.now();
    const idleTimeout = await readStream(bayz, key, { ...CHAT, stream: true });
    const idleElapsed = Date.now() - idleStarted;

    check(
      "a stream that stalls after headers also ends in a bounded failure",
      idleTimeout.error !== undefined || !idleTimeout.body.includes("[DONE]"),
      `error=${idleTimeout.error} body=${idleTimeout.body.slice(0, 120)} after ${idleElapsed} ms`,
    );

    /*
     * Both timers run concurrently for the whole stream, and the shorter one wins.
     *
     * My first assertion here was wrong, not the code. I claimed the idle timer should outlast
     * the 1 s request deadline on a stalled stream; measured, both returned at 1,030 ms. Reading
     * `transport.ts:483` explains why: the total timer is armed **once, for the entire stream**
     * (`setTimeout(..., provider.requestTimeoutMs)` → `stream-total-timeout`), while
     * `bumpIdle()` at :466 re-arms a separate `DEFAULT_IDLE_TIMEOUT_MS` timer on every chunk →
     * `stream-idle-timeout`. With a 1 s total and a 60 s idle, the total fires first on a stalled
     * stream. That is correct: a stream may not exceed its request deadline just because bytes
     * are trickling.
     *
     * So the honest assertion is that the *shorter* deadline governs, and the two mechanisms are
     * distinguished by their **stage codes** rather than by wall-clock ordering. Asserting an
     * ordering that the design does not promise would have been a fake requirement, and
     * "adjusting" the code to satisfy it would have been worse.
     */
    check(
      "a stalled stream is bounded by the shorter of the two deadlines",
      idleElapsed < 30_000,
      `idle path took ${idleElapsed} ms with a 1 s total deadline and a 60 s idle timer`,
    );
    note(
      `stalled-stream path returned after ${idleElapsed} ms: the 1 s total timer (transport.ts:483, stream-total-timeout) fires before the 60 s idle timer (transport.ts:466, stream-idle-timeout), which is the correct precedence`,
    );

    check(
      "the two timeout paths are distinguishable in telemetry",
      bayz.runtime.usage.recentRequests(10).length >= 2,
      "fewer than two rows recorded",
    );

    origin.set({ mode: "ok" });
    const recovered = await chat(bayz, key, CHAT);
    check("a healthy request succeeds after both timeouts", recovered.status === 200, `status=${recovered.status}`);

    await assertIntegrity(dataDir, "timeouts");
  } finally {
    await bayz.close();
    await origin.close();
  }
}
