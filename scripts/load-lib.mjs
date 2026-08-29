/**
 * Load measurement library — 9I Task 5. Shared by `scripts/load-smoke.mjs`.
 *
 * Design constraints that shaped this file, all from the plan:
 *
 *   - **Real** listener, real `fetch`, real loopback origins. No `app.inject`.
 *   - Stability properties only. **No latency threshold is asserted** — this is a shared Android
 *     device, so a performance gate would be noise, and a green suite that goes red because the
 *     phone got warm teaches people to ignore it.
 *   - A summary table may not be printed without a transcript on disk. Enforced in code, because
 *     a capacity figure with no provenance is exactly the fake benchmark this phase forbids.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";

const clientLib = await import("./verify-client-lib.mjs");

export const { startBayz } = clientLib;

/** A throwaway data directory per listener. `startBayz` requires a real path. */
export function freshDataDir(label) {
  return mkdtempSync(join(tmpdir(), `bayz-load-${label}-`));
}

export const ADMIN_TOKEN = "LOAD-ADMIN-TOKEN-3f2a1b";
export const CREDENTIAL = "LOAD-PROVIDER-CREDENTIAL-8c7d6e";
export const KEK_HEX = "5".repeat(64);
export const MODEL = "load-model";

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

/**
 * A fast loopback origin.
 *
 * Deliberately minimal: no artificial delay, because the plan asks for the *system's* behaviour
 * under concurrency, and an origin that sleeps would measure the sleep. `delayMs` exists for the
 * cap proof, where a slow upstream is the only way to hold permits long enough to observe queueing.
 *
 * Echoes a per-request sentinel back in the completion content. That sentinel is the cross-talk
 * guard: if response N ever carries request M's sentinel, two requests have been interleaved
 * somewhere, which is the single worst thing a proxy can do and is invisible to a latency chart.
 */
export async function startFastOrigin({ delayMs = 0 } = {}) {
  const state = { hits: 0, maxConcurrent: 0, concurrent: 0, sentinels: new Set() };

  const server = createServer((request, response) => {
    state.hits += 1;
    state.concurrent += 1;
    state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);

    const finish = (body, stream) => {
      const done = () => {
        state.concurrent -= 1;
      };
      if (stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        // Two frames then [DONE], so time-to-first-byte is a real measurement rather than
        // indistinguishable from total duration.
        response.write(`data: ${JSON.stringify(body.first)}\n\n`);
        setTimeout(() => {
          response.write(`data: ${JSON.stringify(body.second)}\n\n`);
          response.write("data: [DONE]\n\n");
          response.end();
          done();
        }, 1);
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
      done();
    };

    if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: MODEL, object: "model" }] }));
      state.concurrent -= 1;
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
      /*
       * The sentinel travels in the *user message* and comes back in the content. Reading it out
       * of the request the origin actually received is what makes the cross-talk check meaningful:
       * a mock that echoed a value the harness already knew would prove nothing.
       */
      const sentinel = String(parsed?.messages?.[0]?.content ?? "").match(/LOADSENT-[0-9a-f]+/)?.[0] ?? "none";
      state.sentinels.add(sentinel);
      const streaming = parsed?.stream === true;

      const send = () =>
        finish(
          streaming
            ? {
                first: {
                  id: `chatcmpl-${sentinel}`,
                  model: MODEL,
                  choices: [{ index: 0, delta: { role: "assistant", content: sentinel }, finish_reason: null }],
                },
                second: {
                  choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
                  usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
                },
              }
            : {
                id: `chatcmpl-${sentinel}`,
                model: MODEL,
                choices: [{ index: 0, message: { role: "assistant", content: sentinel }, finish_reason: "stop" }],
                usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
              },
          streaming,
        );

      if (delayMs > 0) setTimeout(send, delayMs);
      else send();
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

/** Register a provider, a route, and a client identity through the real management API. */
export async function seed(bayz, { port, providerId = "load-origin", routeId = "load-route", model = MODEL } = {}) {
  await bayz.admin("POST", "/api/providers", {
    id: providerId,
    kind: "openai-compatible",
    displayName: "Load Origin",
    baseUrl: `http://127.0.0.1:${port}`,
    config: { allowLoopback: true },
  });
  await bayz.admin("PUT", `/api/providers/${providerId}/credential`, { value: CREDENTIAL });
  await bayz.admin("POST", "/api/routes", {
    id: routeId,
    model,
    providerId,
    freeOnly: false,
    config: { requestTimeoutMs: 30_000 },
  });
  const identity = await bayz.admin("POST", "/api/identities", {
    id: "load-client",
    displayName: "Load Client",
    scopes: ["chat.completions", "models.read", "usage.read"],
  });
  return identity.json.key;
}

/** Percentile from a sorted array, nearest-rank. */
export function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

export function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
  };
}

let sentinelCounter = 0;
export function nextSentinel() {
  sentinelCounter += 1;
  return `LOADSENT-${sentinelCounter.toString(16).padStart(6, "0")}`;
}

/**
 * One non-streaming request. Returns what was measured, never throws.
 *
 * A thrown error would abort a whole concurrency level and lose the other 199 measurements, so a
 * transport failure is recorded as an outcome like any other. The caller decides whether it is
 * acceptable.
 */
export async function oneRequest(base, key, { stream = false } = {}) {
  const sentinel = nextSentinel();
  const started = process.hrtime.bigint();
  let firstByteAt;

  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: sentinel }], ...(stream ? { stream: true } : {}) }),
    });

    let body = "";
    if (stream && response.body !== null) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstByteAt === undefined) firstByteAt = process.hrtime.bigint();
        body += decoder.decode(value, { stream: true });
      }
    } else {
      body = await response.text();
      firstByteAt = process.hrtime.bigint();
    }

    const ended = process.hrtime.bigint();
    let json;
    try {
      json = body.length > 0 && !stream ? JSON.parse(body) : undefined;
    } catch {
      json = undefined;
    }

    return {
      sentinel,
      status: response.status,
      totalMs: Number(ended - started) / 1e6,
      ttfbMs: firstByteAt === undefined ? undefined : Number(firstByteAt - started) / 1e6,
      code: json?.error?.code,
      // What the response actually carried, for the cross-talk guard.
      echoed: stream ? (body.match(/LOADSENT-[0-9a-f]+/)?.[0] ?? undefined) : json?.choices?.[0]?.message?.content,
      streamComplete: stream ? body.includes("[DONE]") : undefined,
      bodyLength: body.length,
    };
  } catch (error) {
    const ended = process.hrtime.bigint();
    return {
      sentinel,
      status: 0,
      totalMs: Number(ended - started) / 1e6,
      ttfbMs: undefined,
      code: error?.cause?.code ?? error?.code ?? "transport_error",
      echoed: undefined,
      transport: true,
    };
  }
}

/**
 * Run `total` requests with at most `concurrency` outstanding at any moment.
 *
 * A worker-pool rather than `Promise.all` over the whole batch: `Promise.all` on 256 promises
 * created up front issues all 256 immediately and then measures the *queue*, not the concurrency
 * level. The pool keeps exactly `concurrency` in flight, which is what the plan asks to measure.
 */
export async function drive({ base, key, concurrency, total, stream = false, onResult }) {
  let issued = 0;
  let peak = 0;
  let active = 0;
  const collected = [];

  const worker = async () => {
    for (;;) {
      if (issued >= total) return;
      issued += 1;
      active += 1;
      peak = Math.max(peak, active);
      const result = await oneRequest(base, key, { stream });
      active -= 1;
      collected.push(result);
      onResult?.(result);
    }
  };

  const started = Date.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  const elapsedMs = Date.now() - started;

  return { results: collected, elapsedMs, peakInFlight: peak };
}

/**
 * Count telemetry rows straight from the database.
 *
 * The management API caps `limit` at 200 (`routes/usage.ts:24`), so a 512-request level cannot be
 * counted through it — an earlier version of this check read the endpoint, got `undefined`, and
 * asserted `rowCount >= 0`, which is true of every number and therefore proved nothing. Counting
 * in SQL is the only honest way to compare rows against requests.
 */
export async function telemetryRowCount(dataDir) {
  const { nodeSqliteDriver } = await import("../packages/storage/src/drivers/node-sqlite.ts");
  const path = join(dataDir, "bayz.db");
  if (!existsSync(path)) return undefined;
  const db = nodeSqliteDriver.open(path);
  try {
    const requests = db.prepare("SELECT COUNT(*) AS n FROM usage_requests").get();
    const attempts = db.prepare("SELECT COUNT(*) AS n FROM usage_attempts").get();
    const ok = db.prepare("SELECT COUNT(*) AS n FROM usage_requests WHERE outcome = 'ok'").get();
    return { requests: requests?.n ?? 0, attempts: attempts?.n ?? 0, ok: ok?.n ?? 0 };
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

/**
 * Write the transcript, and refuse to summarise without it.
 *
 * The plan's wording is "the script must refuse to print a summary table without writing its
 * transcript". Implemented as a hard failure rather than a warning: a load figure whose provenance
 * is not on disk is indistinguishable from one somebody typed, and this phase forbids exactly that.
 */
export function writeTranscript({ root, name, commit, command, body }) {
  const dir = join(root, "docs/transcripts/load");
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
    "Latency figures are from this device only. They are recorded for provenance, not asserted",
    "against a threshold: a performance gate on a shared Android phone would fail on a warm day",
    "and teach everyone to ignore it. The assertions in the run are stability and correctness",
    "properties.",
    "",
  ].join("\n");

  writeFileSync(path, `${header}${body}\n`);

  if (!existsSync(path)) {
    throw new Error(`transcript was not written to ${path} — refusing to print a summary`);
  }
  return path;
}
