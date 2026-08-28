/**
 * The scenario body for `scripts/verify-opencode.mjs` — 9H Task 4.
 *
 * Split out only so neither file becomes unreadable; run
 * `node scripts/verify-opencode.mjs`, never this file directly. Everything shared
 * (redaction, transcript writing, the origin fixture, the real-client launcher) lives
 * in the entry script.
 *
 * Scenario ordering is deliberate: the cheap wiring cells first, so a broken
 * configuration fails in seconds rather than after eight 20-second client runs.
 */
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = await import("./verify-opencode-lib.mjs");
const {
  CELLS,
  failures,
  record,
  fail,
  section,
  writeTranscript,
  startOrigin,
  startConnectProxy,
  startBayz,
  configureOpenCode,
  runOpenCode,
  usageJson,
  privateHost,
  sockets,
  CREDENTIAL,
  PROXY_USER,
  PROXY_PASSWORD,
  MODEL,
  REPO_ROOT,
} = entry;

/** Seed one provider + route + client identity. Returns the client key. */
async function seed(bayz, { providerId = "oc-origin", routeId = "oc-route", port, freeOnly = false, proxyId, model = MODEL } = {}) {
  await bayz.admin("POST", "/api/providers", {
    id: providerId,
    kind: "openai-compatible",
    displayName: "OpenCode Verification Origin",
    baseUrl: `http://127.0.0.1:${port}`,
    config: { allowLoopback: true },
  });
  await bayz.admin("PUT", `/api/providers/${providerId}/credential`, { value: CREDENTIAL });
  await bayz.admin("POST", "/api/routes", {
    id: routeId,
    model,
    providerId,
    ...(freeOnly ? {} : { freeOnly: false }),
    ...(proxyId === undefined ? {} : { proxyId }),
  });
  const created = await bayz.admin("POST", "/api/identities", {
    id: "opencode",
    displayName: "OpenCode",
    scopes: ["chat.completions", "models.read"],
    preset: "opencode",
  });
  return created.json?.key;
}

function freshDataDir(label) {
  return join(mkdtempSync(join(tmpdir(), `bayz-verify-oc-${label}-`)), ".bayz");
}

export async function main() {
  console.log("OpenCode real-client verification — 9H Task 4");
  console.log("Driving the real `opencode` binary against a real BAYZ listener.\n");

  const version = (await runOpenCode(["--version"], { env: process.env, cwd: REPO_ROOT })).stdout.trim();
  console.log(`  client: opencode ${version}`);
  if (!version.startsWith("1.")) {
    fail(`unexpected opencode version output: ${JSON.stringify(version)}`);
  }

  /* ================================================================== *
   * 1. configure + authenticate + models.list — the cheap wiring cells
   * ================================================================== */
  section("1. configure / authenticate / models.list");
  {
    const origin = await startOrigin();
    const bayz = await startBayz({ dataDir: freshDataDir("wiring") });
    try {
      const key = await seed(bayz, { port: origin.port });

      const listed = await runOpenCode(["models", "bayz"], configureOpenCode({ base: bayz.base, key }));
      const sawModel = listed.stdout.includes(`bayz/${MODEL}`);

      // Authentication, proved in both directions by the client itself: a good key
      // reaches a completion, a corrupted one is refused. A 200 alone would not show
      // the key was checked at all.
      const good = await runOpenCode(["run", "Say BAYZ-OK"], configureOpenCode({ base: bayz.base, key }));
      const bad = await runOpenCode(
        ["run", "Say BAYZ-OK"],
        configureOpenCode({ base: bayz.base, key: `${key}-corrupted` }),
      );

      const setup = configureOpenCode({ base: bayz.base, key });
      const transcript = writeTranscript(
        "configure-authenticate",
        [
          { heading: "Client version", content: version },
          { heading: "Configuration written (key redacted)", content: setup.configJson.replace(key, "<CLIENT-KEY-REDACTED>"), fence: "json" },
          { heading: "opencode models bayz — stdout", content: listed.stdout },
          { heading: "opencode models bayz — stderr", content: listed.stderr },
          { heading: "opencode run with a valid key — stdout", content: good.stdout },
          { heading: "opencode run with a valid key — exit", content: `code=${good.code} signal=${good.signal}` },
          { heading: "opencode run with a corrupted key — stderr", content: bad.stderr },
          { heading: "opencode run with a corrupted key — exit", content: `code=${bad.code} signal=${bad.signal}` },
          { heading: "BAYZ gateway requests observed", content: bayz.gatewayPaths.join("\n") },
          { heading: "BAYZ usage rows", content: usageJson(bayz), fence: "json" },
        ],
        [[key, "<CLIENT-KEY-REDACTED>"]],
      );

      if (listed.code === 0 && sawModel) {
        record("configure", "VERIFIED", transcript, "the documented JSON config is accepted; the client lists bayz/probe-model");
      } else {
        record("configure", "BLOCKED", transcript, `models listing failed: exit=${listed.code}`);
        fail("configure");
      }

      if (good.code === 0 && bad.code !== 0) {
        record("authenticate", "VERIFIED", transcript, "a scoped client key completes a turn; a corrupted key is refused and the client exits non-zero");
      } else {
        record("authenticate", "BLOCKED", transcript, `good=${good.code} corrupted=${bad.code}`);
        fail("authenticate");
      }

      /*
       * models.list is the one cell where the honest answer is not what the plan
       * assumed. The client never calls `GET /v1/models`: it reads the models it will
       * offer from the `models` map in its own config file, so `opencode models bayz`
       * prints BAYZ's model without a single gateway request. That is a real, useful
       * fact about this client — and calling it VERIFIED would claim BAYZ's discovery
       * endpoint was exercised when no request ever reached it.
       */
      const calledModels = bayz.gatewayPaths.some((path) => path.includes("GET /v1/models"));
      if (calledModels) {
        record("models.list", "VERIFIED", transcript, "the client called GET /v1/models");
      } else {
        record(
          "models.list",
          "UNVERIFIED",
          undefined,
          "the client never calls GET /v1/models — it reads its own config `models` map, so BAYZ's discovery endpoint is not exercised by this client (transcript: docs/transcripts/opencode/configure-authenticate.md shows zero GET /v1/models)",
        );
      }
    } finally {
      await bayz.close();
      await origin.close();
    }
  }

  /* ================================================================== *
   * 2. chat + stream — the client streams by default
   * ================================================================== */
  section("2. chat / stream");
  {
    const origin = await startOrigin({ text: "BAYZ-STREAM-OK" });
    const bayz = await startBayz({ dataDir: freshDataDir("chat") });
    try {
      const key = await seed(bayz, { port: origin.port });
      const run = await runOpenCode(["run", "Reply with exactly BAYZ-STREAM-OK"], configureOpenCode({ base: bayz.base, key }));
      const streamed = origin.state.bodies.some((body) => {
        try {
          return JSON.parse(body).stream === true;
        } catch {
          return false;
        }
      });
      const transcript = writeTranscript(
        "chat-stream",
        [
          { heading: "Prompt", content: "Reply with exactly BAYZ-STREAM-OK" },
          { heading: "Client stdout", content: run.stdout },
          { heading: "Client stderr", content: run.stderr },
          { heading: "Client exit", content: `code=${run.code} signal=${run.signal}` },
          { heading: "Did the client request streaming?", content: String(streamed) },
          { heading: "Upstream request body (last)", content: origin.state.bodies.at(-1) ?? "", fence: "json" },
          { heading: "BAYZ usage rows", content: usageJson(bayz), fence: "json" },
        ],
        [[key, "<CLIENT-KEY-REDACTED>"]],
      );

      const answered = run.code === 0 && run.stdout.includes("BAYZ-STREAM-OK");
      if (answered) {
        record("chat", "VERIFIED", transcript, "a completion arrives intact and the client prints it");
      } else {
        record("chat", "BLOCKED", transcript, `exit=${run.code}, stdout did not contain the completion`);
        fail("chat");
      }
      if (answered && streamed) {
        record("stream", "VERIFIED", transcript, "the client sends stream:true and renders the SSE frames; usage arrives in the final chunk");
      } else {
        record("stream", "BLOCKED", transcript, `streamed=${streamed} exit=${run.code}`);
        fail("stream");
      }
    } finally {
      await bayz.close();
      await origin.close();
    }
  }

  /* ================================================================== *
   * 3. tool call + tool result roundtrip — where the real bug was
   * ================================================================== */
  section("3. tool call / tool result roundtrip");
  {
    const origin = await startOrigin({ mode: "tool" });
    const bayz = await startBayz({ dataDir: freshDataDir("tools") });
    try {
      const key = await seed(bayz, { port: origin.port });
      const run = await runOpenCode(
        ["run", "Run the bash tool with: echo BAYZ-TOOL-RAN"],
        configureOpenCode({ base: bayz.base, key }),
      );
      // The load-bearing observation: the client actually executed the call and sent a
      // `role: "tool"` message back. Without it, "tool call" would only mean the frames
      // were emitted, not that any client could use them.
      const executed = run.stderr.includes("BAYZ-TOOL-RAN") || run.stdout.includes("BAYZ-TOOL-RAN");
      const roundtrip = origin.state.sawToolResult && run.stdout.includes("TOOL-ROUNDTRIP-COMPLETE");
      const toolMessage = (() => {
        for (const body of origin.state.bodies) {
          try {
            const found = JSON.parse(body).messages?.find((message) => message.role === "tool");
            if (found) {
              return JSON.stringify(found, null, 1);
            }
          } catch {
            /* not JSON, skip */
          }
        }
        return "";
      })();

      const transcript = writeTranscript(
        "tool-roundtrip",
        [
          { heading: "Prompt", content: "Run the bash tool with: echo BAYZ-TOOL-RAN" },
          { heading: "Client stdout", content: run.stdout },
          { heading: "Client stderr (tool execution is echoed here)", content: run.stderr },
          { heading: "Client exit", content: `code=${run.code} signal=${run.signal}` },
          { heading: "Tool count the client advertised", content: String((() => { try { return JSON.parse(origin.state.bodies.at(-1)).tools?.length ?? 0; } catch { return 0; } })()) },
          { heading: "The tool result message the client sent back", content: toolMessage, fence: "json" },
          { heading: "Upstream chat requests", content: String(origin.state.chatHits) },
          { heading: "BAYZ usage rows", content: usageJson(bayz), fence: "json" },
        ],
        [[key, "<CLIENT-KEY-REDACTED>"]],
      );

      if (executed) {
        record("tool call", "VERIFIED", transcript, "the client received a streamed tool call, reassembled the fragments, and executed bash");
      } else {
        record("tool call", "BLOCKED", transcript, "the client never executed the tool");
        fail("tool call");
      }
      if (roundtrip) {
        record("tool result roundtrip", "VERIFIED", transcript, "the tool result returns as role:tool with tool_call_id and the model answers using it");
      } else {
        record("tool result roundtrip", "BLOCKED", transcript, `sawToolResult=${origin.state.sawToolResult}`);
        fail("tool result roundtrip");
      }
    } finally {
      await bayz.close();
      await origin.close();
    }
  }

  /* ================================================================== *
   * 4. large request — the client's own payload is already large
   * ================================================================== */
  section("4. large request");
  {
    const origin = await startOrigin();
    const bayz = await startBayz({ dataDir: freshDataDir("large") });
    try {
      const key = await seed(bayz, { port: origin.port });
      // ~40 KiB of prompt on top of the client's own ~30 KiB of system prompt and tool
      // schemas. Measured rather than assumed: the transcript records the real byte count.
      const filler = "BAYZ-LARGE-PAYLOAD ".repeat(2000);
      const run = await runOpenCode(["run", `Ignore this text and reply BAYZ-OK: ${filler}`], configureOpenCode({ base: bayz.base, key }));
      const largest = Math.max(0, ...origin.state.bodies.map((body) => Buffer.byteLength(body, "utf8")));
      const transcript = writeTranscript(
        "large-request",
        [
          { heading: "Prompt size (characters)", content: String(filler.length) },
          { heading: "Largest upstream request body (bytes)", content: String(largest) },
          { heading: "Client stdout", content: run.stdout },
          { heading: "Client stderr", content: run.stderr },
          { heading: "Client exit", content: `code=${run.code} signal=${run.signal}` },
          { heading: "BAYZ usage rows", content: usageJson(bayz), fence: "json" },
        ],
        [[key, "<CLIENT-KEY-REDACTED>"]],
      );
      if (run.code === 0 && largest > 60000) {
        record("large request", "VERIFIED", transcript, `a ${largest}-byte request is served intact, not truncated`);
      } else {
        record("large request", "BLOCKED", transcript, `exit=${run.code} largest=${largest}`);
        fail("large request");
      }
    } finally {
      await bayz.close();
      await origin.close();
    }
  }

  /* ================================================================== *
   * 5. cancel — kill the real client mid-stream
   * ================================================================== */
  section("5. cancel");
  {
    const origin = await startOrigin();
    origin.set({ holdMs: 30000 });
    const bayz = await startBayz({ dataDir: freshDataDir("cancel") });
    try {
      const key = await seed(bayz, { port: origin.port });
      const run = await runOpenCode(["run", "Say BAYZ-OK"], configureOpenCode({ base: bayz.base, key }), {
        onSpawn: (child) => {
          // Killed once a request is genuinely in flight upstream, so this measures
          // teardown propagation rather than a race against process startup.
          const waitForInFlight = setInterval(() => {
            if (origin.state.inFlight > 0) {
              clearInterval(waitForInFlight);
              child.kill("SIGINT");
              setTimeout(() => child.kill("SIGKILL"), 5000);
            }
          }, 250);
          setTimeout(() => clearInterval(waitForInFlight), 120000);
        },
      });
      // Give the abort a moment to land on the origin socket.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const transcript = writeTranscript(
        "cancel",
        [
          { heading: "How the client was cancelled", content: "SIGINT to the real opencode process once a request was in flight upstream" },
          { heading: "Client exit", content: `code=${run.code} signal=${run.signal}` },
          { heading: "Client stderr", content: run.stderr },
          { heading: "Upstream requests started", content: String(origin.state.chatHits) },
          { heading: "Upstream sockets destroyed before a response completed", content: String(origin.state.aborted) },
        ],
        [[key, "<CLIENT-KEY-REDACTED>"]],
      );
      if (origin.state.chatHits > 0 && origin.state.aborted > 0) {
        record("cancel", "VERIFIED", transcript, "killing the client tears down the in-flight upstream request rather than leaving it generating");
      } else {
        record("cancel", "BLOCKED", transcript, `hits=${origin.state.chatHits} aborted=${origin.state.aborted}`);
        fail("cancel");
      }
    } finally {
      await bayz.close();
      await origin.close();
    }
  }

  /* ================================================================== *
   * 6. error surface + key revoke/rotate
   * ================================================================== */
  section("6. error surface / key revoke+rotate");
  {
    const origin = await startOrigin();
    const bayz = await startBayz({ dataDir: freshDataDir("errors") });
    try {
      const key = await seed(bayz, { port: origin.port });

      // A model the route does not serve: BAYZ answers a structured error and the
      // question is whether the client shows it or crashes.
      const wrongModel = await runOpenCode(
        ["run", "Say BAYZ-OK"],
        configureOpenCode({ base: bayz.base, key, model: "model-that-has-no-route" }),
      );

      // Revocation, then rotation, both through the real management API.
      //
      // Rotation is exercised on the SAME identity, not on a deleted-and-recreated one:
      // recreating after a delete answers 409 identity_already_exists in some orders and
      // gives no key at all, which would make the rotation half of this cell test
      // nothing. So: capture the original key, rotate, then prove the original is dead
      // and the rotated one lives.
      const working = configureOpenCode({ base: bayz.base, key });
      const rotated = await bayz.admin("POST", "/api/identities/opencode/rotate");
      const rotatedKey = rotated.json?.key;
      if (typeof rotatedKey !== "string" || rotatedKey.length === 0) {
        fail(`rotation returned no key (status=${rotated.status})`);
      }
      const afterRotateOldKey = await runOpenCode(["run", "Say BAYZ-OK"], working);
      const afterRotateNewKey = await runOpenCode(
        ["run", "Say BAYZ-OK"],
        configureOpenCode({ base: bayz.base, key: rotatedKey }),
      );

      // Revocation last, because it is destructive: delete the identity and prove the
      // key that worked one command ago now fails.
      const deleted = await bayz.admin("DELETE", "/api/identities/opencode");
      const afterRevoke = await runOpenCode(
        ["run", "Say BAYZ-OK"],
        configureOpenCode({ base: bayz.base, key: rotatedKey }),
      );

      const transcript = writeTranscript(
        "error-surface-and-keys",
        [
          { heading: "Unroutable model — client stderr", content: wrongModel.stderr },
          { heading: "Unroutable model — client exit", content: `code=${wrongModel.code}` },
          { heading: "Rotation — management API response status", content: String(rotated.status) },
          { heading: "After rotation, using the superseded key — client stderr", content: afterRotateOldKey.stderr },
          { heading: "After rotation, using the superseded key — client exit", content: `code=${afterRotateOldKey.code}` },
          { heading: "After rotation, using the new key — client stdout", content: afterRotateNewKey.stdout },
          { heading: "After rotation, using the new key — client exit", content: `code=${afterRotateNewKey.code}` },
          { heading: "Revocation — DELETE /api/identities/opencode status", content: String(deleted.status) },
          { heading: "After revocation — client stderr", content: afterRevoke.stderr },
          { heading: "After revocation — client exit", content: `code=${afterRevoke.code}` },
        ],
        [
          [key, "<CLIENT-KEY-REDACTED>"],
          [rotatedKey ?? "", "<ROTATED-KEY-REDACTED>"],
        ],
      );

      // The client prints BAYZ's message rather than a stack trace — legible, which is
      // what the cell asks. It exits non-zero, which is how a shell caller learns.
      const legible = wrongModel.code !== 0 && /error/i.test(wrongModel.stderr) && !/at \w+ \(/.test(wrongModel.stderr);
      if (legible) {
        record("error surface", "VERIFIED", transcript, "BAYZ's error envelope reaches the user as a one-line message and a non-zero exit, not a stack trace");
      } else {
        record("error surface", "BLOCKED", transcript, `exit=${wrongModel.code}`);
        fail("error surface");
      }

      const rotateWorked = rotated.status === 200 && afterRotateOldKey.code !== 0 && afterRotateNewKey.code === 0;
      const revokeWorked = deleted.status === 204 && afterRevoke.code !== 0;
      if (revokeWorked && rotateWorked) {
        record("key revoke/rotate", "VERIFIED", transcript, "rotation immediately kills the superseded key while the new key keeps the real client working; deleting the identity then locks the client out on the next request");
      } else {
        record("key revoke/rotate", "BLOCKED", transcript, `rotate=${rotated.status} oldKey=${afterRotateOldKey.code} newKey=${afterRotateNewKey.code} delete=${deleted.status} afterRevoke=${afterRevoke.code}`);
        fail("key revoke/rotate");
      }
    } finally {
      await bayz.close();
      await origin.close();
    }
  }

  /* ================================================================== *
   * 7. custom provider + proxy-bound route + combo + failover
   * ================================================================== */
  section("7. custom provider / proxy-bound route / combo / failover");
  {
    const origin = await startOrigin();
    const proxy = await startConnectProxy();
    const bayz = await startBayz({ dataDir: freshDataDir("routing") });
    try {
      const key = await seed(bayz, { port: origin.port });

      // Proxy-bound: a real CONNECT proxy, and the proof is which authority it logged.
      await bayz.admin("POST", "/api/proxies", {
        id: "oc-proxy",
        kind: "http",
        host: "127.0.0.1",
        port: proxy.port,
        username: PROXY_USER,
        config: { connectTimeoutMs: 5000 },
      });
      await bayz.admin("PUT", "/api/proxies/oc-proxy/password", { value: PROXY_PASSWORD });
      await bayz.admin("PATCH", "/api/routes/oc-route", { proxyId: "oc-proxy" });

      const beforeConnects = proxy.connects.length;
      const viaProxy = await runOpenCode(["run", "Say BAYZ-OK"], configureOpenCode({ base: bayz.base, key }));
      const proxied = proxy.connects.length > beforeConnects && proxy.connects.some((entry) => entry.port === origin.port);

      // Back to a direct route, then a second provider so more than one candidate
      // exists: that is what makes the routing mode `combo` rather than `direct`.
      await bayz.admin("PATCH", "/api/routes/oc-route", { proxyId: null });
      const secondary = await startOrigin({ text: "BAYZ-SECONDARY" });
      await bayz.admin("POST", "/api/providers", {
        id: "oc-secondary",
        kind: "openai-compatible",
        displayName: "Secondary",
        baseUrl: `http://127.0.0.1:${secondary.port}`,
        config: { allowLoopback: true },
      });
      await bayz.admin("PUT", "/api/providers/oc-secondary/credential", { value: CREDENTIAL });
      await bayz.admin("POST", "/api/routes", {
        id: "oc-route-secondary",
        model: MODEL,
        providerId: "oc-secondary",
        freeOnly: false,
        priority: 1,
      });

      const comboRun = await runOpenCode(["run", "Say BAYZ-OK"], configureOpenCode({ base: bayz.base, key }));
      const comboRows = bayz.runtime.usage.recentRequests(10);
      const sawCombo = comboRows.some((row) => row.routingMode === "combo");

      // Failover: kill the higher-priority origin so the first attempt fails at the
      // socket and BAYZ must try the other candidate. The client must not notice.
      await origin.close();
      const failoverRun = await runOpenCode(["run", "Say BAYZ-OK"], configureOpenCode({ base: bayz.base, key }));
      const failoverRows = bayz.runtime.usage.recentRequests(10);
      const sawFailover = failoverRows.some((row) => row.routingMode === "failover" || row.attempts > 1);

      const transcript = writeTranscript(
        "routing",
        [
          { heading: "Custom openai-compatible provider — client stdout", content: viaProxy.stdout },
          { heading: "Proxy-bound route — CONNECT authorities the proxy logged", content: JSON.stringify(proxy.connects, null, 1), fence: "json" },
          { heading: "Proxy-bound route — client exit", content: `code=${viaProxy.code}` },
          { heading: "Combo — client stdout", content: comboRun.stdout },
          { heading: "Combo — client exit", content: `code=${comboRun.code}` },
          { heading: "Failover (primary origin killed) — client stdout", content: failoverRun.stdout },
          { heading: "Failover — client exit", content: `code=${failoverRun.code}` },
          { heading: "BAYZ usage rows (routingMode / attempts are the evidence)", content: JSON.stringify(failoverRows, null, 1), fence: "json" },
        ],
        [[key, "<CLIENT-KEY-REDACTED>"]],
      );

      if (viaProxy.code === 0) {
        record("custom provider", "VERIFIED", transcript, "a custom openai-compatible provider serves the real client end to end");
      } else {
        record("custom provider", "BLOCKED", transcript, `exit=${viaProxy.code}`);
        fail("custom provider");
      }
      if (proxied && viaProxy.code === 0) {
        record("proxy-bound route", "VERIFIED", transcript, "the client's traffic genuinely tunnels: the CONNECT proxy logged the origin authority and required Basic auth");
      } else {
        record("proxy-bound route", "BLOCKED", transcript, `connects=${proxy.connects.length} exit=${viaProxy.code}`);
        fail("proxy-bound route");
      }
      if (sawCombo && comboRun.code === 0) {
        record("combo", "VERIFIED", transcript, "with two eligible candidates BAYZ records routingMode=combo and the client is served normally");
      } else {
        record("combo", "BLOCKED", transcript, `sawCombo=${sawCombo} exit=${comboRun.code}`);
        fail("combo");
      }
      if (sawFailover && failoverRun.code === 0) {
        record("failover", "VERIFIED", transcript, "the primary origin was killed mid-suite; BAYZ failed over and the client completed without noticing");
      } else {
        record("failover", "BLOCKED", transcript, `sawFailover=${sawFailover} exit=${failoverRun.code}`);
        fail("failover");
      }
      await secondary.close();
    } finally {
      await bayz.close();
      await proxy.close();
    }
  }

  /* ================================================================== *
   * 8. restart/reconnect — the same client config across two listeners
   * ================================================================== */
  section("8. restart/reconnect");
  {
    const origin = await startOrigin();
    const dataDir = freshDataDir("restart");
    let bayz = await startBayz({ dataDir });
    let transcriptPath;
    let before;
    let after;
    let key;
    try {
      key = await seed(bayz, { port: origin.port });
      const port = bayz.port;
      const setup = configureOpenCode({ base: bayz.base, key });
      before = await runOpenCode(["run", "Say BAYZ-OK"], setup);
      await bayz.close();

      // Same data directory, same port: the client config is untouched, so this asks
      // whether the client recovers rather than whether it can be reconfigured.
      bayz = await startBayz({ dataDir, port });
      after = await runOpenCode(["run", "Say BAYZ-OK"], setup);

      transcriptPath = writeTranscript(
        "restart-reconnect",
        [
          { heading: "Before restart — client stdout", content: before.stdout },
          { heading: "Before restart — client exit", content: `code=${before.code}` },
          { heading: "Restart", content: "BAYZ closed and restarted on the same port with the same SQLite data directory; the client config was not touched" },
          { heading: "After restart — client stdout", content: after.stdout },
          { heading: "After restart — client exit", content: `code=${after.code}` },
          { heading: "BAYZ usage rows after restart", content: usageJson(bayz), fence: "json" },
        ],
        [[key, "<CLIENT-KEY-REDACTED>"]],
      );

      if (before.code === 0 && after.code === 0) {
        record("restart/reconnect", "VERIFIED", transcriptPath, "the same client and the same key work across a BAYZ restart on the same port; the identity survives in SQLite");
      } else {
        record("restart/reconnect", "BLOCKED", transcriptPath, `before=${before.code} after=${after.code}`);
        fail("restart/reconnect");
      }
    } finally {
      await bayz.close();
      await origin.close();
    }
  }

  /* ================================================================== *
   * 9. free-only routing — the §25 amendment
   * ================================================================== */
  section("9. free-only routing (§25)");
  {
    /*
     * This needs a **non-loopback** origin. `allowLoopback` short-circuits provider
     * classification to LOCAL, and LOCAL is free — so a loopback origin cannot exercise
     * the PAID path at all, and a "pass" against one would prove nothing.
     */
    const econHost = privateHost();
    if (econHost === undefined) {
      record("free-only routing", "UNVERIFIED", undefined, "no non-loopback IPv4 on this host, so no provider can classify as PAID; a loopback origin classifies LOCAL (free) and could not exercise the refusal");
    } else {
      const paidOrigin = await startOrigin({
        host: econHost,
        models: [{ id: "paid-model", pricing: { prompt: "0.00002", completion: "0.00004" } }],
      });
      const bayz = await startBayz({ dataDir: freshDataDir("freeonly") });
      try {
        await bayz.admin("POST", "/api/providers", {
          id: "oc-paid",
          kind: "openai-compatible",
          displayName: "Paid Origin",
          baseUrl: `http://${econHost}:${paidOrigin.port}`,
          config: { allowPrivate: true },
        });
        await bayz.admin("PUT", "/api/providers/oc-paid/credential", { value: CREDENTIAL });
        const catalogue = await bayz.admin("POST", "/api/providers/oc-paid/catalogue", {});

        // Free-only left at its default — that default is half of what is under test.
        await bayz.admin("POST", "/api/routes", { id: "oc-paid-route", model: "paid-model", providerId: "oc-paid" });
        const created = await bayz.admin("POST", "/api/identities", {
          id: "opencode",
          displayName: "OpenCode",
          scopes: ["chat.completions", "models.read"],
          preset: "opencode",
        });
        const key = created.json?.key;
        const route = await bayz.admin("GET", "/api/routes/oc-paid-route");

        const refused = await runOpenCode(["run", "Say BAYZ-OK"], configureOpenCode({ base: bayz.base, key, model: "paid-model" }));
        const paidHitsAfterRefusal = paidOrigin.state.chatHits;

        // Then the opt-out, so the guard is shown to be a bound rather than a wall.
        await bayz.admin("PATCH", "/api/routes/oc-paid-route", { freeOnly: false });
        const allowed = await runOpenCode(["run", "Say BAYZ-OK"], configureOpenCode({ base: bayz.base, key, model: "paid-model" }));

        const transcript = writeTranscript(
          "free-only",
          [
            { heading: "Provider classification", content: `catalogue publish status=${catalogue.status}; the origin publishes real pricing metadata over a non-loopback address, so its model classifies PAID` },
            { heading: "Route as created (no freeOnly field was sent)", content: JSON.stringify(route.json, null, 1), fence: "json" },
            { heading: "Real client against the free-only route — stderr", content: refused.stderr },
            { heading: "Real client against the free-only route — exit", content: `code=${refused.code}` },
            { heading: "Upstream chat requests the PAID origin received", content: String(paidHitsAfterRefusal) },
            { heading: "After an explicit freeOnly:false opt-out — client stdout", content: allowed.stdout },
            { heading: "After an explicit freeOnly:false opt-out — client exit", content: `code=${allowed.code}` },
            { heading: "Upstream chat requests after the opt-out", content: String(paidOrigin.state.chatHits) },
            { heading: "BAYZ usage rows", content: usageJson(bayz), fence: "json" },
          ],
          [[key, "<CLIENT-KEY-REDACTED>"]],
        );

        const defaultedFreeOnly = route.json?.freeOnly === true;
        const refusedProperly = refused.code !== 0 && paidHitsAfterRefusal === 0;
        const optOutWorks = allowed.code === 0 && paidOrigin.state.chatHits > 0;

        if (defaultedFreeOnly && refusedProperly && optOutWorks) {
          record(
            "free-only routing",
            "VERIFIED",
            transcript,
            "a route created without freeOnly defaults to free-only; the real client is refused against a PAID-classified provider and the paid origin was never called (0 upstream requests), so nothing could be spent; an explicit opt-out then routes",
          );
        } else {
          record("free-only routing", "BLOCKED", transcript, `default=${defaultedFreeOnly} refused=${refused.code} paidHits=${paidHitsAfterRefusal} optOut=${allowed.code}`);
          fail("free-only routing");
        }
      } finally {
        await bayz.close();
        await paidOrigin.close();
      }
    }
  }

  /* ================================================================== *
   * The self-certification refusal
   * ================================================================== */
  section("Evidence check — a claim without a transcript fails the run");
  for (const [capability, cell] of Object.entries(CELLS)) {
    if (cell.status !== "VERIFIED" && cell.status !== "PARTIAL") {
      continue;
    }
    if (cell.transcript === undefined) {
      fail(`${capability} is ${cell.status} with no transcript path`);
      continue;
    }
    if (!existsSync(new URL(cell.transcript, `file://${REPO_ROOT}`))) {
      fail(`${capability} is ${cell.status} but ${cell.transcript} is not on disk`);
      continue;
    }
    console.log(`  ok    ${capability.padEnd(23)} ${cell.transcript}`);
  }

  const expected = [
    "configure",
    "authenticate",
    "models.list",
    "chat",
    "stream",
    "tool call",
    "tool result roundtrip",
    "large request",
    "cancel",
    "error surface",
    "custom provider",
    "proxy-bound route",
    "combo",
    "failover",
    "restart/reconnect",
    "key revoke/rotate",
    "free-only routing",
  ];
  for (const capability of expected) {
    if (CELLS[capability] === undefined) {
      fail(`no verdict was recorded for ${capability}`);
    }
  }

  section("Matrix row — copy these verdicts into the opencode row");
  const tally = { VERIFIED: 0, PARTIAL: 0, BLOCKED: 0, UNVERIFIED: 0 };
  for (const capability of expected) {
    const cell = CELLS[capability];
    if (cell === undefined) {
      continue;
    }
    tally[cell.status] += 1;
    const citation = cell.transcript === undefined ? cell.note : `transcript:${cell.transcript} — ${cell.note}`;
    console.log(`| ${capability} | ${cell.status} | ${citation} |`);
  }
  console.log(`\n  tally: ${JSON.stringify(tally)}`);

  for (const socket of sockets) {
    socket.destroy();
  }

  if (failures.length > 0) {
    console.error(`\nopencode verification: FAIL (${failures.length})`);
    for (const entry of failures) {
      console.error(`  - ${entry}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("\nopencode verification: PASS");
}
