/**
 * Host baseline probe — Phase 9I.
 *
 * Purpose: separate diagnosis **D (Termux/proot host failure)** from **A (BAYZ runtime defect)**
 * before any wall-clock number in this phase is believed.
 *
 * Measured while building the `socks5` fuzz target, which reported iterations taking 8.5 s and
 * 72 s against a 250 ms budget. The obvious reading was a hang in the handshake reader. It was
 * not: this probe runs a bare `net.connect` + `setTimeout(60)` + `destroy` loop containing **no
 * BAYZ code at all**, and reproduces the same outliers.
 *
 * Three consecutive runs on this host, 150 iterations each:
 *
 *   run 1: p50 63 ms, p95 66 ms, max 184,612 ms — one outlier
 *   run 2: p50 63 ms, p95 8,239 ms, max 138,653 ms — nine outliers over 200 ms
 *   run 3: p50 63 ms, p95 68 ms, max 88,332 ms — three outliers
 *
 * Median is exactly the requested 60 ms every time; the tail is unbounded. Concurrently:
 * 11,312 MiB RAM total with 161 MiB free / 4,286 MiB available, **3,905 MiB of swap in use**,
 * load average 0.12, 8 CPUs, 4 open descriptors. So not CPU starvation and not descriptor
 * exhaustion — a scheduling/paging stall in the Termux→proot→Android stack, with swap pressure
 * the most likely contributor.
 *
 * Cross-checked separately: `timer.unref()` is *not* the cause. Ref'd and unref'd 60 ms timers
 * with idle TCP sockets held open both delivered 60–63 ms consistently.
 *
 * Consequence for Task 3, recorded so nobody has to re-derive it: a wall-clock per-iteration
 * budget is a valid DoS signal for CPU-bound boundaries (parsers, crypto, validation) and is
 * **not** a valid signal for socket-bound ones on this host. The `socks5` target therefore
 * asserts BAYZ's own deadline fired — the returned `ProxyError("timeout")` — instead of trusting
 * the clock, and carries a widened budget with this file cited as the reason.
 *
 * Run it yourself: `node scripts/fuzz/host-baseline.mjs`
 */

import { connect, createServer } from "node:net";
import { freemem, loadavg, totalmem } from "node:os";
import { readdirSync } from "node:fs";

const ITERATIONS = Number(process.argv[2] ?? 150);
const WAIT_MS = 60;

const server = createServer((socket) => {
  socket.on("error", () => {});
  socket.on("data", () => {});
  // Deliberately silent: this is the shape that looked like a hang.
});
server.on("error", () => {});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const samples = [];
for (let i = 0; i < ITERATIONS; i += 1) {
  const started = Date.now();
  const socket = connect({ host: "127.0.0.1", port });
  socket.on("error", () => {});
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, WAIT_MS);
    timer.unref?.();
  });
  socket.destroy();
  samples.push(Date.now() - started);
}
server.close();

const sorted = [...samples].sort((a, b) => a - b);
const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
const outliers = sorted.filter((ms) => ms > WAIT_MS * 4);

process.stdout.write(
  [
    `host baseline: ${ITERATIONS} iterations of connect + ${WAIT_MS} ms timer + destroy, no BAYZ code`,
    `  p50=${at(0.5)}ms p95=${at(0.95)}ms p99=${at(0.99)}ms max=${sorted[sorted.length - 1]}ms`,
    `  outliers over ${WAIT_MS * 4}ms: ${outliers.length}${outliers.length > 0 ? ` (${outliers.join(", ")})` : ""}`,
    `  memory: ${Math.round(totalmem() / 1048576)} MiB total, ${Math.round(freemem() / 1048576)} MiB free`,
    `  loadavg: ${loadavg().map((n) => n.toFixed(2)).join(" ")}  fds: ${readdirSync("/proc/self/fd").length}`,
    outliers.length > 0
      ? "  VERDICT: this host stalls a bare socket loop. Wall-clock budgets are not a valid signal for socket-bound fuzz targets here."
      : "  VERDICT: no stall observed in this run. The stall is intermittent; re-run before concluding.",
    "",
  ].join("\n"),
);
