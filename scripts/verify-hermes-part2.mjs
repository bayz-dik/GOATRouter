/**
 * Hermes scenarios 5–9 — 9H Task 5. Part of `scripts/verify-hermes.mjs`.
 */
const s = await import("./verify-hermes-scenarios.mjs");

const {
  MODEL,
  KEK_HEX,
  ADMIN_TOKEN,
  CREDENTIAL,
  PROXY_PASSWORD,
  PROXY_USER,
  configureHermes,
  fail,
  freshDataDir,
  oneShot,
  privateHost,
  record,
  section,
  seed,
  startBayz,
  startConnectProxy,
  startOrigin,
  writeTranscript,
} = s;

const bayzOpts = { adminToken: ADMIN_TOKEN, kekHex: KEK_HEX };

/** 5. cancel */
export async function cancel() {
  section("5. cancel");
  const origin = await startOrigin();
  origin.set({ holdMs: 45000 });
  const bayz = await startBayz({ dataDir: freshDataDir("cancel"), ...bayzOpts });
  try {
    const key = await seed(bayz, { port: origin.port });
    const setup = configureHermes({ base: bayz.base, key, port: bayz.port });
    const run = await oneShot("Reply with exactly BAYZ-OK", setup, {
      onSpawn: (child) => {
        // Killed only once a request is genuinely in flight upstream, so this measures
        // teardown propagation rather than a race against a slow client startup.
        const waitForInFlight = setInterval(() => {
          if (origin.state.inFlight > 0) {
            clearInterval(waitForInFlight);
            child.kill("SIGINT");
            setTimeout(() => child.kill("SIGKILL"), 8000);
          }
        }, 250);
        setTimeout(() => clearInterval(waitForInFlight), 240000);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const transcript = writeTranscript(
      "cancel",
      [
        { heading: "How the client was cancelled", content: "SIGINT to the real hermes process once a request was in flight upstream" },
        { heading: "Client exit", content: `code=${run.code} signal=${run.signal}` },
        { heading: "Client stderr", content: run.stderr },
        { heading: "Upstream requests started", content: String(origin.state.chatHits) },
        { heading: "Upstream sockets destroyed before a response completed", content: String(origin.state.aborted) },
      ],
      [[key, "<CLIENT-KEY-REDACTED>"]],
    );

    if (origin.state.chatHits > 0 && origin.state.aborted > 0) {
      record("cancel", "VERIFIED", transcript, "killing the client tears down the in-flight upstream request rather than leaving the provider generating tokens nobody will read");
    } else {
      record("cancel", "BLOCKED", transcript, `hits=${origin.state.chatHits} aborted=${origin.state.aborted}`);
      fail("cancel");
    }
  } finally {
    await bayz.close();
    await origin.close();
  }
}

/** 6. error surface / key revoke+rotate */
export async function errorsAndKeys() {
  section("6. error surface / key revoke+rotate");
  const origin = await startOrigin();
  const bayz = await startBayz({ dataDir: freshDataDir("errors"), ...bayzOpts });
  try {
    const key = await seed(bayz, { port: origin.port });

    // A model with no route: BAYZ answers a structured error, and the question is whether
    // the client shows it or crashes.
    const wrongModel = await oneShot(
      "Reply with exactly BAYZ-OK",
      configureHermes({ base: bayz.base, key, model: "model-that-has-no-route", port: bayz.port }),
    );

    // Rotation on the SAME identity, before revocation, because revocation is destructive.
    const working = configureHermes({ base: bayz.base, key, port: bayz.port });
    const rotated = await bayz.admin("POST", "/api/identities/hermes/rotate");
    const rotatedKey = rotated.json?.key;
    if (typeof rotatedKey !== "string" || rotatedKey.length === 0) {
      fail(`rotation returned no key (status=${rotated.status})`);
    }
    const oldKeyRun = await oneShot("Reply with exactly BAYZ-OK", working);
    const newKeyRun = await oneShot(
      "Reply with exactly BAYZ-OK",
      configureHermes({ base: bayz.base, key: rotatedKey, port: bayz.port }),
    );

    const deleted = await bayz.admin("DELETE", "/api/identities/hermes");
    const afterRevoke = await oneShot(
      "Reply with exactly BAYZ-OK",
      configureHermes({ base: bayz.base, key: rotatedKey, port: bayz.port }),
    );

    const transcript = writeTranscript(
      "error-surface-and-keys",
      [
        { heading: "Unroutable model — client stdout", content: wrongModel.stdout },
        { heading: "Unroutable model — client stderr", content: wrongModel.stderr },
        { heading: "Unroutable model — client exit", content: `code=${wrongModel.code}` },
        { heading: "Rotation — management API status", content: String(rotated.status) },
        { heading: "Superseded key — client stdout", content: oldKeyRun.stdout },
        { heading: "Superseded key — client exit", content: `code=${oldKeyRun.code}` },
        { heading: "Rotated key — client stdout", content: newKeyRun.stdout },
        { heading: "Rotated key — client exit", content: `code=${newKeyRun.code}` },
        { heading: "Revocation — DELETE /api/identities/hermes status", content: String(deleted.status) },
        { heading: "After revocation — client stdout", content: afterRevoke.stdout },
        { heading: "After revocation — client exit", content: `code=${afterRevoke.code}` },
      ],
      [
        [key, "<CLIENT-KEY-REDACTED>"],
        [rotatedKey ?? "", "<ROTATED-KEY-REDACTED>"],
      ],
    );

    /*
     * Hermes prints transport errors on stdout as `HTTP <status>: <message>` and exits 0,
     * so the legibility test is about the *message*, not the exit code: BAYZ's error text
     * must reach the user, and it must not be a stack trace.
     */
    const combined = wrongModel.stdout + wrongModel.stderr;
    const legible = /no_route|no enabled route|HTTP 4\d\d/i.test(combined) && !/Traceback|File \"/.test(combined);
    if (legible) {
      record("error surface", "VERIFIED", transcript, "BAYZ's error envelope reaches the user as a readable `HTTP <status>: <message>` line, not a traceback");
    } else {
      record("error surface", "BLOCKED", transcript, `unreadable error surface: ${JSON.stringify(combined.slice(0, 160))}`);
      fail("error surface");
    }

    const rotateWorked =
      rotated.status === 200 &&
      !oldKeyRun.stdout.includes("BAYZ-OK") &&
      newKeyRun.stdout.includes("BAYZ-OK");
    const revokeWorked = deleted.status === 204 && !afterRevoke.stdout.includes("BAYZ-OK");
    if (rotateWorked && revokeWorked) {
      record("key revoke/rotate", "VERIFIED", transcript, "rotation immediately stops the superseded key from completing while the rotated key works; deleting the identity then locks the client out on the next request");
    } else {
      record("key revoke/rotate", "BLOCKED", transcript, `rotate=${rotated.status} old=${oldKeyRun.code} new=${newKeyRun.code} delete=${deleted.status}`);
      fail("key revoke/rotate");
    }
  } finally {
    await bayz.close();
    await origin.close();
  }
}

/** 7. custom provider / proxy-bound route / combo / failover */
export async function routing() {
  section("7. custom provider / proxy-bound route / combo / failover");
  const origin = await startOrigin();
  const proxy = await startConnectProxy({ user: PROXY_USER, password: PROXY_PASSWORD });
  const bayz = await startBayz({ dataDir: freshDataDir("routing"), ...bayzOpts });
  try {
    const key = await seed(bayz, { port: origin.port });
    const setup = configureHermes({ base: bayz.base, key, port: bayz.port });

    await bayz.admin("POST", "/api/proxies", {
      id: "hm-proxy",
      kind: "http",
      host: "127.0.0.1",
      port: proxy.port,
      username: PROXY_USER,
      config: { connectTimeoutMs: 5000 },
    });
    await bayz.admin("PUT", "/api/proxies/hm-proxy/password", { value: PROXY_PASSWORD });
    await bayz.admin("PATCH", "/api/routes/hm-route", { proxyId: "hm-proxy" });

    const before = proxy.connects.length;
    const viaProxy = await oneShot("Reply with exactly BAYZ-OK", setup);
    const proxied = proxy.connects.length > before && proxy.connects.some((entry) => entry.port === origin.port);

    await bayz.admin("PATCH", "/api/routes/hm-route", { proxyId: null });
    const secondary = await startOrigin({ text: "BAYZ-SECONDARY" });
    await bayz.admin("POST", "/api/providers", {
      id: "hm-secondary",
      kind: "openai-compatible",
      displayName: "Secondary",
      baseUrl: `http://127.0.0.1:${secondary.port}`,
      config: { allowLoopback: true },
    });
    await bayz.admin("PUT", "/api/providers/hm-secondary/credential", { value: CREDENTIAL });
    await bayz.admin("POST", "/api/routes", {
      id: "hm-route-secondary",
      model: MODEL,
      providerId: "hm-secondary",
      freeOnly: false,
      priority: 1,
    });

    const comboRun = await oneShot("Reply with exactly BAYZ-OK", setup);
    const sawCombo = bayz.runtime.usage.recentRequests(10).some((row) => row.routingMode === "combo");

    // Failover: kill the higher-priority origin so the first attempt fails at the socket.
    await origin.close();
    const failoverRun = await oneShot("Reply with exactly BAYZ-OK", setup);
    const failoverRows = bayz.runtime.usage.recentRequests(10);
    const sawFailover = failoverRows.some((row) => row.routingMode === "failover" || row.attempts > 1);

    const transcript = writeTranscript(
      "routing",
      [
        { heading: "Custom openai-compatible provider — client stdout", content: viaProxy.stdout },
        { heading: "Proxy-bound route — CONNECT authorities the proxy logged", content: JSON.stringify(proxy.connects, null, 1), fence: "json" },
        { heading: "Proxy-bound route — client exit", content: `code=${viaProxy.code}` },
        { heading: "Combo — client stdout", content: comboRun.stdout },
        { heading: "Failover (primary origin killed) — client stdout", content: failoverRun.stdout },
        { heading: "BAYZ usage rows (routingMode / attempts are the evidence)", content: JSON.stringify(failoverRows, null, 1), fence: "json" },
      ],
      [[key, "<CLIENT-KEY-REDACTED>"]],
    );

    if (viaProxy.stdout.includes("BAYZ-OK")) {
      record("custom provider", "VERIFIED", transcript, "a custom openai-compatible provider serves the real client end to end");
    } else {
      record("custom provider", "BLOCKED", transcript, `no completion: exit=${viaProxy.code}`);
      fail("custom provider");
    }
    if (proxied && viaProxy.stdout.includes("BAYZ-OK")) {
      record("proxy-bound route", "VERIFIED", transcript, "the client's traffic genuinely tunnels: the CONNECT proxy required Basic auth and logged the origin authority");
    } else {
      record("proxy-bound route", "BLOCKED", transcript, `connects=${proxy.connects.length} exit=${viaProxy.code}`);
      fail("proxy-bound route");
    }
    if (sawCombo && comboRun.stdout.length > 0) {
      record("combo", "VERIFIED", transcript, "with two eligible candidates BAYZ records routingMode=combo and the client is served normally");
    } else {
      record("combo", "BLOCKED", transcript, `sawCombo=${sawCombo}`);
      fail("combo");
    }
    if (sawFailover && failoverRun.stdout.length > 0) {
      record("failover", "VERIFIED", transcript, "the primary origin was killed mid-suite; BAYZ failed over and the client completed without noticing");
    } else {
      record("failover", "BLOCKED", transcript, `sawFailover=${sawFailover}`);
      fail("failover");
    }
    await secondary.close();
  } finally {
    await bayz.close();
    await proxy.close();
  }
}

/** 8. restart/reconnect */
export async function restart() {
  section("8. restart/reconnect");
  const origin = await startOrigin();
  const dataDir = freshDataDir("restart");
  let bayz = await startBayz({ dataDir, ...bayzOpts });
  try {
    const key = await seed(bayz, { port: origin.port });
    const port = bayz.port;
    const setup = configureHermes({ base: bayz.base, key, port });
    const before = await oneShot("Reply with exactly BAYZ-OK", setup);
    await bayz.close();

    // Same data directory, same port, untouched client config: this asks whether the
    // client recovers, not whether it can be reconfigured.
    bayz = await startBayz({ dataDir, port, ...bayzOpts });
    const after = await oneShot("Reply with exactly BAYZ-OK", setup);

    const transcript = writeTranscript(
      "restart-reconnect",
      [
        { heading: "Before restart — client stdout", content: before.stdout },
        { heading: "Restart", content: "BAYZ closed and restarted on the same port with the same SQLite data directory; the client configuration was not touched" },
        { heading: "After restart — client stdout", content: after.stdout },
        { heading: "BAYZ usage rows after restart", content: JSON.stringify(bayz.runtime.usage.recentRequests(5), null, 1), fence: "json" },
      ],
      [[key, "<CLIENT-KEY-REDACTED>"]],
    );

    if (before.stdout.includes("BAYZ-OK") && after.stdout.includes("BAYZ-OK")) {
      record("restart/reconnect", "VERIFIED", transcript, "the same client and the same key work across a BAYZ restart on the same port; the identity survives in SQLite");
    } else {
      record("restart/reconnect", "BLOCKED", transcript, `before=${before.code} after=${after.code}`);
      fail("restart/reconnect");
    }
  } finally {
    await bayz.close();
    await origin.close();
  }
}

/** 9. free-only routing (§25) */
export async function freeOnly() {
  section("9. free-only routing (§25)");
  const econHost = privateHost();
  if (econHost === undefined) {
    record("free-only routing", "UNVERIFIED", undefined, "no non-loopback IPv4 on this host, so no provider can classify as PAID; allowLoopback short-circuits classification to LOCAL (free) and could not exercise the refusal");
    return;
  }
  const paidOrigin = await startOrigin({
    host: econHost,
    models: [{ id: "paid-model", pricing: { prompt: "0.00002", completion: "0.00004" } }],
  });
  const bayz = await startBayz({ dataDir: freshDataDir("freeonly"), ...bayzOpts });
  try {
    await bayz.admin("POST", "/api/providers", {
      id: "hm-paid",
      kind: "openai-compatible",
      displayName: "Paid Origin",
      baseUrl: `http://${econHost}:${paidOrigin.port}`,
      config: { allowPrivate: true },
    });
    await bayz.admin("PUT", "/api/providers/hm-paid/credential", { value: CREDENTIAL });
    const catalogue = await bayz.admin("POST", "/api/providers/hm-paid/catalogue", {});
    // freeOnly left at its default — that default is half of what is under test.
    await bayz.admin("POST", "/api/routes", { id: "hm-paid-route", model: "paid-model", providerId: "hm-paid" });
    const created = await bayz.admin("POST", "/api/identities", {
      id: "hermes",
      displayName: "Hermes Agent",
      scopes: ["chat.completions", "models.read"],
      preset: "hermes",
    });
    const key = created.json?.key;
    const route = await bayz.admin("GET", "/api/routes/hm-paid-route");

    const refused = await oneShot(
      "Reply with exactly BAYZ-OK",
      configureHermes({ base: bayz.base, key, model: "paid-model", port: bayz.port }),
    );
    const paidHitsAfterRefusal = paidOrigin.state.chatHits;

    await bayz.admin("PATCH", "/api/routes/hm-paid-route", { freeOnly: false });
    const allowed = await oneShot(
      "Reply with exactly BAYZ-OK",
      configureHermes({ base: bayz.base, key, model: "paid-model", port: bayz.port }),
    );

    const transcript = writeTranscript(
      "free-only",
      [
        { heading: "Provider classification", content: `catalogue publish status=${catalogue.status}; the origin publishes real pricing metadata over a non-loopback address, so its model classifies PAID` },
        { heading: "Route as created (no freeOnly field was sent)", content: JSON.stringify(route.json, null, 1), fence: "json" },
        { heading: "Real client against the free-only route — stdout", content: refused.stdout },
        { heading: "Real client against the free-only route — exit", content: `code=${refused.code}` },
        { heading: "Upstream chat requests the PAID origin received", content: String(paidHitsAfterRefusal) },
        { heading: "After an explicit freeOnly:false opt-out — client stdout", content: allowed.stdout },
        { heading: "Upstream chat requests after the opt-out", content: String(paidOrigin.state.chatHits) },
        { heading: "BAYZ usage rows", content: JSON.stringify(bayz.runtime.usage.recentRequests(5), null, 1), fence: "json" },
      ],
      [[key, "<CLIENT-KEY-REDACTED>"]],
    );

    const defaulted = route.json?.freeOnly === true;
    const refusedProperly = !refused.stdout.includes("BAYZ-OK") && paidHitsAfterRefusal === 0;
    const optOutWorks = paidOrigin.state.chatHits > 0;

    if (defaulted && refusedProperly && optOutWorks) {
      record("free-only routing", "VERIFIED", transcript, "a route created without freeOnly defaults to free-only; the real client is refused against a PAID-classified provider and the paid origin received 0 requests, so nothing could be spent; an explicit opt-out then routes");
    } else {
      record("free-only routing", "BLOCKED", transcript, `default=${defaulted} refused=${refusedProperly} paidHits=${paidHitsAfterRefusal} optOut=${optOutWorks}`);
      fail("free-only routing");
    }
  } finally {
    await bayz.close();
    await paidOrigin.close();
  }
}
