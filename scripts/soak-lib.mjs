/**
 * Soak measurement library — 9I Task 6. Shared by `scripts/soak-smoke.mjs`.
 *
 * The question a soak answers is not "does it survive" — a process can survive while leaking a
 * descriptor per request until the 1,024th one fails. It is "does anything grow that shouldn't".
 * So every sample is a *series*, every assertion is about a trend, and a leak is a failure with the
 * numbers attached rather than a warning nobody reads.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { cpus, freemem, tmpdir, totalmem } from "node:os";
import { join } from "node:path";

const clientLib = await import("./verify-client-lib.mjs");

export const { startBayz } = clientLib;

/**
 * Start a listener with a **real** low telemetry retention.
 *
 * `startBayz` hardcodes its env to `{ BAYZ_MASTER_KEY, BAYZ_API_TOKEN }`
 * (`verify-client-lib.mjs:319`), so `BAYZ_USAGE_RETENTION` cannot be threaded through it. Rather
 * than widen a fixture every other harness depends on, the runtime is built here with the extra
 * variable — the same `createBayzRuntime` and `buildApp` the server itself uses, just with one more
 * documented env var set.
 */
export async function startSoakBayz({ dataDir, retention = SOAK_RETENTION }) {
  const { buildApp } = await import("../apps/server/src/app.ts");
  const { createBayzRuntime } = await import("../apps/server/src/runtime.ts");

  const runtime = createBayzRuntime(
    { host: "127.0.0.1", port: 0, dataDir, dashboardRoot: "/nonexistent" },
    {
      env: {
        BAYZ_MASTER_KEY: KEK_HEX,
        BAYZ_API_TOKEN: ADMIN_TOKEN,
        BAYZ_USAGE_RETENTION: String(retention),
      },
      notify: () => {},
      logger: () => {},
    },
  );
  const app = buildApp({ logger: false, apiToken: ADMIN_TOKEN, runtime, rateLimit: { max: 1_000_000, authMax: 1_000_000 } });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;

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

  return {
    base,
    admin,
    retention,
    async close() {
      await app.close();
      runtime.close();
    },
  };
}

export const ADMIN_TOKEN = "SOAK-ADMIN-TOKEN-7d4e2a";
export const CREDENTIAL = "SOAK-PROVIDER-CREDENTIAL-1a9b8c";
export const KEK_HEX = "7".repeat(64);
export const MODEL = "soak-model";
export const TOOL_MODEL = "soak-tool-model";

/**
 * Telemetry retention for the run, set low **on purpose**.
 *
 * `DEFAULT_REQUEST_RETENTION` is 5,000 rows (`packages/telemetry/src/repository.ts:16`), which a
 * 10-minute soak on this device will not reach — so pruning would never be exercised and the
 * "telemetry rows are pruned rather than growing forever" assertion would pass vacuously.
 *
 * 200 is a **real configuration value** through the documented `BAYZ_USAGE_RETENTION` env var, not a
 * weakened limit: the pruning code path, the SQL, and the bound are all the production ones. The
 * only thing changed is where the ceiling sits, so the run actually crosses it.
 */
export const SOAK_RETENTION = 200;

export function freshDataDir(label) {
  return mkdtempSync(join(tmpdir(), `bayz-soak-${label}-`));
}

const results = [];
let checkNumber = 0;
const failures = [];
const notes = [];

export function check(label, ok, detail) {
  checkNumber += 1;
  if (ok) {
    console.log(`  ok   ${String(checkNumber).padStart(2)}  ${label}`);
  } else {
    console.log(`  FAIL ${String(checkNumber).padStart(2)}  ${label}${detail ? ` — ${detail}` : ""}`);
    failures.push({ number: checkNumber, label, detail });
  }
  return ok;
}

export function note(text) {
  notes.push(text);
  console.log(`  note     ${text}`);
}

export function section(title) {
  console.log(`\n${title}`);
}

export function summary() {
  return { checkNumber, failures, notes, results };
}

/** An origin that answers chat, streaming chat, tool calls, and model listing. */
export async function startSoakOrigin() {
  const state = { chat: 0, stream: 0, tool: 0, models: 0 };

  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
      state.models += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: MODEL, object: "model" }, { id: TOOL_MODEL, object: "model" }] }));
      return;
    }

    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = {};
      }

      const wantsTool = Array.isArray(parsed?.tools) && parsed.tools.length > 0;
      const hasToolResult = (parsed?.messages ?? []).some((entry) => entry?.role === "tool");

      if (parsed?.stream === true) {
        state.stream += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-soak-stream",
            model: MODEL,
            choices: [{ index: 0, delta: { role: "assistant", content: "SOAK" }, finish_reason: null }],
          })}\n\n`,
        );
        setTimeout(() => {
          response.write(
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: { content: "-OK" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
            })}\n\n`,
          );
          response.write("data: [DONE]\n\n");
          response.end();
        }, 1);
        return;
      }

      if (wantsTool && !hasToolResult) {
        state.tool += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "chatcmpl-soak-tool",
            model: TOOL_MODEL,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [{ id: "call_soak_1", type: "function", function: { name: "soak_probe", arguments: '{"n":1}' } }],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
          }),
        );
        return;
      }

      state.chat += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-soak",
          model: MODEL,
          choices: [{ index: 0, message: { role: "assistant", content: "SOAK-OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
        }),
      );
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    port: server.address().port,
    state,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function seed(bayz, { port }) {
  await bayz.admin("POST", "/api/providers", {
    id: "soak-origin",
    kind: "openai-compatible",
    displayName: "Soak Origin",
    baseUrl: `http://127.0.0.1:${port}`,
    config: { allowLoopback: true },
  });
  await bayz.admin("PUT", "/api/providers/soak-origin/credential", { value: CREDENTIAL });
  for (const [id, model] of [
    ["soak-route", MODEL],
    ["soak-tool-route", TOOL_MODEL],
  ]) {
    await bayz.admin("POST", "/api/routes", {
      id,
      model,
      providerId: "soak-origin",
      freeOnly: false,
      config: { requestTimeoutMs: 30_000 },
    });
  }
  const identity = await bayz.admin("POST", "/api/identities", {
    id: "soak-client",
    displayName: "Soak Client",
    scopes: ["chat.completions", "models.read", "usage.read"],
  });
  return identity.json.key;
}

/**
 * One resource sample.
 *
 * `getActiveResourcesInfo` rather than the deprecated `process._getActiveHandles`: it is the
 * supported API in Node 24 and it names each resource, so timers and sockets can be counted
 * separately instead of being lumped into one "handles" number that hides which thing leaked.
 *
 * ## Why the heap is collected before it is read
 *
 * Raw `heapUsed` is a **sawtooth**, and sampling it on a fixed cadence measures which tooth you
 * landed on. Measured on this device across two identical 600 s runs: the series swung between
 * 29.7 and 137.7 MiB, and the second-half slope came out **−338 KiB/sample on run 1 and +295
 * KiB/sample on run 2** — same code, opposite verdicts, one either side of the 256 KiB tolerance.
 *
 * A leak check that flips sign between identical runs is measuring allocation *rate*, not retention.
 * The fix is not a wider tolerance — that would keep the noise and blind the check — but to measure
 * the **post-collection floor**: force a major GC, then read the heap. What survives a collection is
 * what is actually retained, which is the only thing a leak can be.
 *
 * `--expose-gc` is therefore load-bearing rather than a nicety. Without it the caller is told the
 * trend is unverifiable rather than being handed a noisy number dressed up as a measurement.
 */
export const gcAvailable = typeof globalThis.gc === "function";

export function sample({ dataDir, elapsedMs, requests }) {
  /*
   * Two collections, not one: the first sweeps young objects and can promote survivors, the second
   * then collects what the first promoted. A single pass leaves recently-promoted garbage counted as
   * retained, which reintroduces exactly the noise this is here to remove.
   */
  if (gcAvailable) {
    globalThis.gc();
    globalThis.gc();
  }

  const memory = process.memoryUsage();
  const active = typeof process.getActiveResourcesInfo === "function" ? process.getActiveResourcesInfo() : [];
  const counts = new Map();
  for (const entry of active) counts.set(entry, (counts.get(entry) ?? 0) + 1);

  let fds;
  try {
    fds = readdirSync("/proc/self/fd").length;
  } catch {
    fds = undefined;
  }

  const sizeOf = (path) => {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  };

  return {
    elapsedMs,
    requests,
    heapUsed: memory.heapUsed,
    heapTotal: memory.heapTotal,
    external: memory.external,
    rss: memory.rss,
    arrayBuffers: memory.arrayBuffers,
    handles: active.length,
    timers: (counts.get("Timeout") ?? 0) + (counts.get("Immediate") ?? 0),
    sockets: (counts.get("TCPSocketWrap") ?? 0) + (counts.get("TCPServerWrap") ?? 0) + (counts.get("TCPWRAP") ?? 0),
    requestsActive: counts.get("HTTPClientRequest") ?? 0,
    fds,
    dbBytes: sizeOf(join(dataDir, "bayz.db")),
    walBytes: sizeOf(join(dataDir, "bayz.db-wal")),
    hostFreeMiB: Math.round(freemem() / 1048576),
  };
}

/**
 * Least-squares slope of `y` against sample index, in units per sample.
 *
 * A slope, not a first-to-last delta: one hiccup at the end of a run would dominate a delta while
 * a slope over the whole second half reflects the actual trend. That distinction is the difference
 * between detecting a leak and detecting a garbage collection that happened to be late.
 */
export function slope(values) {
  const n = values.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    numerator += (index - meanX) * (values[index] - meanY);
    denominator += (index - meanX) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

export async function telemetryCounts(dataDir) {
  const { nodeSqliteDriver } = await import("../packages/storage/src/drivers/node-sqlite.ts");
  const path = join(dataDir, "bayz.db");
  if (!existsSync(path)) return undefined;
  const db = nodeSqliteDriver.open(path);
  try {
    return {
      requests: db.prepare("SELECT COUNT(*) AS n FROM usage_requests").get()?.n ?? 0,
      attempts: db.prepare("SELECT COUNT(*) AS n FROM usage_attempts").get()?.n ?? 0,
    };
  } finally {
    db.close?.();
  }
}

export async function integrityCheck(dataDir) {
  const { nodeSqliteDriver } = await import("../packages/storage/src/drivers/node-sqlite.ts");
  const path = join(dataDir, "bayz.db");
  if (!existsSync(path)) return "missing";
  const db = nodeSqliteDriver.open(path);
  try {
    const row = db.prepare("PRAGMA integrity_check").get();
    return row?.integrity_check ?? Object.values(row ?? {})[0] ?? "unknown";
  } finally {
    db.close?.();
  }
}

export const DEVICE = {
  platform: "Termux/Android ARM64 (Ubuntu proot)",
  cpus: cpus().length,
  totalMemGiB: (totalmem() / 1073741824).toFixed(1),
  node: process.version,
  arch: process.arch,
};

/** Write the transcript; refuse to summarise without it, exactly as in Task 5. */
export function writeTranscript({ root, name, commit, command, body }) {
  const dir = join(root, "docs/transcripts/soak");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);

  const header = [
    `# ${name.replace(/\.md$/, "")}`,
    "",
    `- Device: ${DEVICE.platform}, ${DEVICE.cpus} CPUs, ${DEVICE.totalMemGiB} GiB RAM`,
    `- Node: ${DEVICE.node} (${DEVICE.arch})`,
    `- Timestamp: ${new Date().toISOString()}`,
    `- Commit: ${commit}`,
    `- Command: \`${command}\``,
    "",
  ].join("\n");

  writeFileSync(path, `${header}${body}\n`);
  if (!existsSync(path)) {
    throw new Error(`transcript was not written to ${path} — refusing to print a summary`);
  }
  return path;
}
