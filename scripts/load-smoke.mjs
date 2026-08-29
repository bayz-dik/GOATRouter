#!/usr/bin/env node
/**
 * Load measurement — 9I Task 5.
 *
 * Drives a **real** BAYZ listener with real `fetch` at concurrency 1, 8, 32, 128 and 256 against
 * fast loopback origins, for both non-streaming and streaming requests, and proves the 9F
 * concurrency cap actually bounds work.
 *
 * What is asserted: stability and correctness — valid envelopes, error codes only from the known
 * set, no cross-talk between concurrent requests, telemetry rows equal to completed requests, and
 * the cap's queue-then-refuse behaviour. What is **not** asserted: any latency threshold.
 *
 * Numbered `ok N` / `FAIL N` output, citable as `smoke:load#N`. Numbers are contractual: append,
 * never insert.
 *
 * Exits non-zero on any failed check.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.env.BAYZ_LOAD_LOADER) {
  const relaunch = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, BAYZ_LOAD_LOADER: "1" },
  });
  process.exit(relaunch.status ?? 1);
}

const { dirname, join } = await import("node:path");
const lib = await import("./load-lib.mjs");
const cap = await import("./load-cap.mjs");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { ADMIN_TOKEN, KEK_HEX, MODEL, check, drive, freshDataDir, note, section, seed, startBayz, startFastOrigin, stats, summary, telemetryRowCount, writeTranscript } = lib;

const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim() || "unknown";
const quick = process.argv.includes("--quick");

/*
 * The plan's five levels, verbatim. `total` is chosen per level so every level issues enough
 * requests for a p99 to mean something (a p99 over 8 samples is just the max) while keeping the
 * whole run inside a few minutes on this device.
 */
const LEVELS = quick
  ? [
      { concurrency: 1, total: 10 },
      { concurrency: 8, total: 40 },
      { concurrency: 32, total: 64 },
    ]
  : [
      { concurrency: 1, total: 100 },
      { concurrency: 8, total: 200 },
      { concurrency: 32, total: 320 },
      { concurrency: 128, total: 512 },
      { concurrency: 256, total: 512 },
    ];

/** Codes a load run may legitimately produce. Anything else is a defect, not noise. */
const KNOWN_CODES = new Set(["rate_limited", "unreachable", "timeout", "upstream_error", "invalid_response"]);

console.log("BAYZ load measurement");
console.log(`  node ${process.version}, ${process.arch}, ${lib.DEVICE.cpus} CPUs`);
console.log(`  commit ${commit}`);
if (quick) console.log("  --quick: reduced levels, transcript marked as such");

const unhandled = [];
process.on("unhandledRejection", (reason) => unhandled.push(String(reason)));

const rows = [];

/** One series — all five levels, either streaming or not. */
async function series({ stream, label }) {
  section(`${label} series`);
  const origin = await startFastOrigin();
  const dataDir = freshDataDir(stream ? "stream" : "plain");
  /*
   * No inbound concurrency gate here, deliberately — and this is a correction.
   *
   * The first version passed `concurrency: 32` to `startBayz`, which **does not accept that
   * option** (`verify-client-lib.mjs:314` takes `{ dataDir, port, adminToken, kekHex }`). It was
   * silently ignored, so the series measured an ungated listener while the code claimed otherwise.
   * Exactly the kind of argument that looks like configuration and is decoration.
   *
   * Left ungated on purpose now that it is understood. The inbound gate in `auth.ts:190` **refuses**
   * with `429 rate_limited` the moment `inFlight >= concurrency`; a series run behind it at c=128
   * would measure rejection, not latency. The cap the plan actually describes — "the 33rd waits
   * rather than opening a socket, and beyond the queue depth it is refused" — is the *outbound*
   * semaphore, and it is proved in `load-cap.mjs` where it can be observed at the origin.
   */
  const bayz = await startBayz({ dataDir, adminToken: ADMIN_TOKEN, kekHex: KEK_HEX });

  try {
    const key = await seed(bayz, { port: origin.port });
    const seriesRows = [];
    let totalOk = 0;
    let totalCompleted = 0;

    for (const level of LEVELS) {
      const before = origin.state.hits;
      const run = await drive({ base: bayz.base, key, concurrency: level.concurrency, total: level.total, stream });

      const ok = run.results.filter((entry) => entry.status === 200);
      const nonOk = run.results.filter((entry) => entry.status !== 200);
      const totals = stats(ok.map((entry) => entry.totalMs));
      const ttfb = stats(ok.filter((entry) => entry.ttfbMs !== undefined).map((entry) => entry.ttfbMs));
      const byCode = new Map();
      for (const entry of nonOk) byCode.set(entry.code ?? `status_${entry.status}`, (byCode.get(entry.code ?? `status_${entry.status}`) ?? 0) + 1);

      const row = {
        stream,
        concurrency: level.concurrency,
        requested: level.total,
        completed: run.results.length,
        ok: ok.length,
        failed: nonOk.length,
        elapsedMs: run.elapsedMs,
        throughput: run.results.length === 0 ? 0 : (run.results.length / run.elapsedMs) * 1000,
        peakInFlight: run.peakInFlight,
        originHits: origin.state.hits - before,
        originMaxConcurrent: origin.state.maxConcurrent,
        totals,
        ttfb,
        byCode: [...byCode.entries()].map(([code, count]) => `${code}×${count}`).join(", ") || "none",
      };
      seriesRows.push(row);
      rows.push(row);
      totalOk += ok.length;
      totalCompleted += run.results.length;

      console.log(
        `  c=${String(level.concurrency).padStart(3)}  n=${String(row.completed).padStart(3)}  ok=${String(row.ok).padStart(3)}  ` +
          `p50=${row.totals.p50.toFixed(1)}ms p95=${row.totals.p95.toFixed(1)}ms p99=${row.totals.p99.toFixed(1)}ms max=${row.totals.max.toFixed(1)}ms  ` +
          `${row.throughput.toFixed(1)} req/s  peak=${row.peakInFlight}  codes=${row.byCode}`,
      );

      check(
        `${label} c=${level.concurrency}: every request completed with an outcome`,
        row.completed === level.total,
        `completed ${row.completed} of ${level.total}`,
      );

      check(
        `${label} c=${level.concurrency}: no unknown error code`,
        nonOk.every((entry) => KNOWN_CODES.has(entry.code ?? "")),
        `codes=${row.byCode}`,
      );

      /*
       * Cross-talk: every successful response carried back its **own** sentinel. This is the check
       * that would catch two concurrent requests being spliced together, which no latency
       * measurement can see.
       */
      const crossTalk = ok.filter((entry) => entry.echoed !== undefined && !String(entry.echoed).includes(entry.sentinel));
      check(
        `${label} c=${level.concurrency}: no response carried another request's data`,
        crossTalk.length === 0,
        `${crossTalk.length} mismatched sentinels, first=${crossTalk[0]?.sentinel} got=${crossTalk[0]?.echoed}`,
      );

      const sentinels = new Set(ok.map((entry) => entry.sentinel));
      check(
        `${label} c=${level.concurrency}: every successful response is distinct`,
        sentinels.size === ok.length,
        `${ok.length} successes but ${sentinels.size} distinct sentinels`,
      );

      if (stream) {
        check(
          `${label} c=${level.concurrency}: every successful stream terminated with [DONE]`,
          ok.every((entry) => entry.streamComplete === true),
          `${ok.filter((entry) => entry.streamComplete !== true).length} streams without [DONE]`,
        );
        note(
          `${label} c=${level.concurrency}: TTFB p50=${ttfb.p50.toFixed(1)}ms p95=${ttfb.p95.toFixed(1)}ms p99=${ttfb.p99.toFixed(1)}ms max=${ttfb.max.toFixed(1)}ms over ${ttfb.count} streams`,
        );
      }
    }

    /*
     * Telemetry integrity, counted in SQL rather than through the API.
     *
     * `/api/usage/requests` caps `limit` at 200, so at 512 requests the endpoint cannot answer the
     * question at all. The comparison that matters: one `usage_requests` row per request the router
     * actually attempted — which is what the origin counted — with no invented rows.
     */
    const counts = await telemetryRowCount(dataDir);
    note(
      `${label} telemetry: ${counts?.requests ?? "?"} usage_requests rows (${counts?.ok ?? "?"} ok), ${counts?.attempts ?? "?"} usage_attempts rows; origin served ${origin.state.hits} upstream requests`,
    );

    check(
      `${label}: one telemetry row per successful request, none invented`,
      counts !== undefined && counts.ok === totalOk && counts.requests === totalCompleted,
      `usage_requests=${counts?.requests} ok=${counts?.ok} expected ok=${totalOk} completed=${totalCompleted}`,
    );

    check(
      `${label}: every telemetry row has an attempt row behind it`,
      counts !== undefined && counts.attempts >= counts.requests,
      `attempts=${counts?.attempts} requests=${counts?.requests}`,
    );

    return { seriesRows, originHits: origin.state.hits, counts };
  } finally {
    await bayz.close();
    await origin.close();
  }
}

const nonStreaming = await series({ stream: false, label: "non-streaming" });
const streaming = await series({ stream: true, label: "streaming" });
const capResult = await cap.proveCap({ lib, check, note, section });

check("no unhandled rejection during the load run", unhandled.length === 0, unhandled.slice(0, 3).join(" | "));

/*
 * Resource observations, recorded rather than asserted.
 *
 * Recorded because the plan forbids a threshold here and because this device's own numbers are the
 * context a later reader needs: without load average and free memory alongside a p99, a
 * multi-second tail is indistinguishable between "BAYZ is slow" and "the phone was busy".
 * `scripts/fuzz/host-baseline.mjs` measured stalls up to 184 s on an idle loop with no BAYZ code in
 * it, which is why no latency figure in this file is a gate.
 */
const { readFileSync } = await import("node:fs");
const { freemem, loadavg } = await import("node:os");
const memory = process.memoryUsage();
let openFds;
try {
  const { readdirSync } = await import("node:fs");
  openFds = readdirSync("/proc/self/fd").length;
} catch {
  openFds = undefined;
}
let loadAverage;
try {
  loadAverage = readFileSync("/proc/loadavg", "utf8").trim().split(" ").slice(0, 3).join(" ");
} catch {
  loadAverage = loadavg().map((entry) => entry.toFixed(2)).join(" ");
}
const resourceLine =
  `after ${rows.reduce((sum, row) => sum + row.completed, 0)} load requests: RSS ${(memory.rss / 1048576).toFixed(1)} MiB, ` +
  `heap ${(memory.heapUsed / 1048576).toFixed(1)}/${(memory.heapTotal / 1048576).toFixed(1)} MiB, ` +
  `external ${(memory.external / 1048576).toFixed(1)} MiB, open fds ${openFds ?? "unknown"}, ` +
  `host free ${(freemem() / 1048576).toFixed(0)} MiB, load average ${loadAverage}`;
note(resourceLine);

/*
 * Transcript first, table second. `writeTranscript` throws if the file is not on disk, so the
 * summary below cannot be printed for a run whose provenance was never recorded.
 */
function table(seriesRows, includeTtfb) {
  const head = includeTtfb
    ? "| concurrency | requested | ok | failed | p50 ms | p95 ms | p99 ms | max ms | TTFB p50 | TTFB p95 | req/s | peak in flight | codes |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|"
    : "| concurrency | requested | ok | failed | p50 ms | p95 ms | p99 ms | max ms | req/s | peak in flight | codes |\n|---|---|---|---|---|---|---|---|---|---|---|";
  const body = seriesRows
    .map((row) =>
      includeTtfb
        ? `| ${row.concurrency} | ${row.requested} | ${row.ok} | ${row.failed} | ${row.totals.p50.toFixed(1)} | ${row.totals.p95.toFixed(1)} | ${row.totals.p99.toFixed(1)} | ${row.totals.max.toFixed(1)} | ${row.ttfb.p50.toFixed(1)} | ${row.ttfb.p95.toFixed(1)} | ${row.throughput.toFixed(1)} | ${row.peakInFlight} | ${row.byCode} |`
        : `| ${row.concurrency} | ${row.requested} | ${row.ok} | ${row.failed} | ${row.totals.p50.toFixed(1)} | ${row.totals.p95.toFixed(1)} | ${row.totals.p99.toFixed(1)} | ${row.totals.max.toFixed(1)} | ${row.throughput.toFixed(1)} | ${row.peakInFlight} | ${row.byCode} |`,
    )
    .join("\n");
  return `${head}\n${body}`;
}

const { checkNumber, failures, notes } = summary();

const transcriptBody = [
  quick ? "> **--quick run**: reduced concurrency levels. Not evidence for the full series.\n" : "",
  "## Non-streaming",
  "",
  table(nonStreaming.seriesRows, false),
  "",
  "## Streaming",
  "",
  "Time-to-first-byte is reported separately from total duration, because TTFB is the number a",
  "client actually feels while the total includes the origin's own two-frame pacing.",
  "",
  table(streaming.seriesRows, true),
  "",
  "## Concurrency cap",
  "",
  capResult.transcript,
  "",
  "## Observations",
  "",
  ...notes.map((entry) => `- ${entry}`),
  "",
  "## Result",
  "",
  `${checkNumber - failures.length}/${checkNumber} checks passed.`,
  failures.length === 0 ? "" : failures.map((entry) => `- FAIL ${entry.number} ${entry.label}`).join("\n"),
].join("\n");

const transcriptPath = writeTranscript({
  root,
  name: quick ? "load-quick.md" : "load.md",
  commit,
  command: `node scripts/load-smoke.mjs${quick ? " --quick" : ""}`,
  body: transcriptBody,
});

console.log("");
console.log(`transcript: ${transcriptPath.replace(`${root}/`, "")}`);
console.log("");
console.log("Non-streaming:");
console.log(table(nonStreaming.seriesRows, false));
console.log("");
console.log("Streaming:");
console.log(table(streaming.seriesRows, true));
console.log("");
console.log(`${checkNumber - failures.length}/${checkNumber} checks passed`);

if (failures.length > 0) {
  console.log("");
  for (const failure of failures) console.log(`  FAIL ${failure.number}  ${failure.label}`);
  console.log("load: FAIL");
  process.exit(1);
}
console.log("load: PASS");
