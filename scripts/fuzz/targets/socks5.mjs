/**
 * Fuzz target: SOCKS5 and HTTP CONNECT handshake replies — 9I Task 3.
 *
 * Driven over **real TCP sockets** against a real listener that emits fuzzed reply bytes. Not a
 * fake duplex: `socks5Connect` and `httpConnect` attach data/end/close/error listeners and race
 * a timeout, and a stub stream would exercise none of that. A hostile proxy is a network peer,
 * so the test peer has to be one too.
 *
 * The property under test is that a malicious or broken proxy can produce **only** a bounded
 * BAYZ `ProxyError` — never a hang, never an engine error, and never a socket handed back as
 * though the tunnel were established.
 */

import { createServer } from "node:net";
import { connect } from "node:net";

import { generateConnectHandshake, generateSocks5Handshake } from "../generators.mjs";
import { assertGlobalStateUnchanged, expectBayzError, globalStateSnapshot } from "./shared.mjs";

const { socks5Connect } = await import("../../../packages/proxy/src/socks5.ts");
const { httpConnect } = await import("../../../packages/proxy/src/http-connect.ts");

/** BAYZ's own handshake deadline for these iterations. */
const HANDSHAKE_TIMEOUT_MS = 60;

/**
 * Per-iteration budget, widened from the default 250 ms **with a measured reason**.
 *
 * `scripts/fuzz/host-baseline.mjs` runs a bare `connect` + `setTimeout(60)` + `destroy` loop with
 * no BAYZ code in it and, under swap pressure on this Termux/proot ARM64 host, produced p50
 * 63 ms with individual iterations at 8.2 s, 88 s and 184 s. Load average was 0.12 and only four
 * descriptors were open, so this is a scheduling/paging stall in the host stack, not contention
 * BAYZ created.
 *
 * The budget is therefore not the boundedness signal for this target — the returned
 * `ProxyError("timeout")` is, asserted in `run`. It stays present at a level that would still
 * catch a genuine unbounded wait (a handshake that never returns produces no error at all), but
 * it no longer reports the host's stalls as BAYZ hangs. Lowering it back to 250 ms would make
 * this target flaky for reasons unrelated to the code under test; removing it entirely would
 * lose the one signal that still works.
 */
const ITERATION_BUDGET_MS = 30_000;

/*
 * The full `ProxyErrorCode` vocabulary reachable from a handshake, read from `errors.ts` and
 * `mapReply`/`mapStatus` rather than guessed.
 *
 * `unsupported_operation` was missing from the first draft and produced a false failure at
 * iteration 433: RFC 1928 reply codes 0x07 (command not supported) and 0x08 (address type not
 * supported) map to it, and a fuzzed status byte reaches them. The code is legitimate and
 * declared; the target's expectation was wrong.
 */
const CODES = new Set([
  "protocol_error",
  "timeout",
  "auth_failed",
  "forbidden",
  "refused",
  "unreachable",
  "proxy_error",
  "password_missing",
  "unsupported_operation",
  "invalid_proxy_config",
  "invalid_proxy_id",
]);

/**
 * One listener for the whole run.
 *
 * `reply` is swapped per iteration rather than starting a server each time: 5,000 listen/close
 * cycles would spend the budget on socket teardown, and on this host would risk exhausting
 * ephemeral ports.
 */
let reply = Buffer.alloc(0);
let closeEarly = false;

const server = createServer((socket) => {
  socket.on("error", () => {});
  socket.on("data", () => {});
  if (closeEarly) {
    socket.destroy();
    return;
  }
  if (reply.length > 0) socket.write(reply);
});
server.on("error", () => {});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const PORT = server.address().port;

function generate(rng) {
  const which = rng.bool() ? "socks5" : "connect";
  const kind = rng.int(0, 7);

  if (kind === 0) return { which, shape: "close-early" };
  if (kind === 1) return { which, shape: "silent" }; // never replies: the timeout path
  if (kind === 2) {
    return {
      which,
      shape: "bytes",
      // Reuse the corpus generators so the handshake shapes are the committed ones.
      reply: (which === "socks5" ? generateSocks5Handshake(rng) : Buffer.from(generateConnectHandshake(rng), "latin1")).toString("base64"),
    };
  }
  if (kind === 3) return { which, shape: "random", length: rng.int(1, 512), seed: rng.int(1, 0xffffff) };
  if (kind === 4) {
    // A well-formed SOCKS5 greeting reply followed by a hostile connect reply.
    return { which: "socks5", shape: "two-stage", method: rng.pick([0x00, 0x02, 0xff, 0x01]), status: rng.int(0, 255) };
  }
  if (kind === 5) {
    return { which: "connect", shape: "status", status: rng.pick([200, 201, 301, 400, 401, 403, 407, 500, 502, 999, 0]) };
  }
  if (kind === 6) {
    // Header block that never terminates: the reader must bound it rather than buffer forever.
    return { which: "connect", shape: "endless-headers", lines: rng.int(1, 64) };
  }
  return { which, shape: "credential", username: rng.pick(["user", "", "u\r\nx", "u\u0000", "u".repeat(300)]), password: rng.pick(["p", "", "p\r\n"]) };
}

function replyFor(input) {
  switch (input.shape) {
    case "bytes":
      return Buffer.from(input.reply, "base64");
    case "random": {
      const out = Buffer.allocUnsafe(input.length);
      let state = input.seed;
      for (let i = 0; i < out.length; i += 1) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        out[i] = state & 0xff;
      }
      return out;
    }
    case "two-stage":
      // greeting reply, then a connect reply with a fuzzed status and a truncated address
      return Buffer.from([0x05, input.method, 0x05, input.status, 0x00, 0x01, 0x7f, 0x00]);
    case "status":
      return Buffer.from(`HTTP/1.1 ${input.status} X\r\n\r\n`, "latin1");
    case "endless-headers":
      return Buffer.from(`HTTP/1.1 200 OK\r\n${"x-pad: y\r\n".repeat(input.lines)}`, "latin1");
    default:
      return Buffer.alloc(0);
  }
}

async function run(input, { iteration }) {
  const before = globalStateSnapshot();
  const context = `socks5#${iteration}/${input.which}/${input.shape}`;

  reply = replyFor(input);
  closeEarly = input.shape === "close-early";

  const socket = connect({ host: "127.0.0.1", port: PORT });
  socket.on("error", () => {});

  let established;
  const started = Date.now();
  try {
    const options = {
      socket,
      target: { host: "example.com", port: 443 },
      timeoutMs: HANDSHAKE_TIMEOUT_MS,
      ...(input.shape === "credential" ? { username: input.username, password: input.password } : {}),
    };
    established =
      input.which === "socks5"
        ? await socks5Connect({ ...options, target: { kind: "domain", host: "example.com", port: 443 } })
        : await httpConnect(options);
  } catch (error) {
    const code = expectBayzError(error, CODES, context);
    socket.destroy();

    /*
     * **This** is the boundedness assertion, replacing the wall-clock one.
     *
     * A silent peer must produce `timeout` — proof that BAYZ's own deadline fired and the
     * handshake did not wait forever. Wall-clock elapsed time cannot carry that claim on this
     * host (see `scripts/fuzz/host-baseline.mjs`: a bare socket loop with no BAYZ code shows
     * 60 ms medians with multi-second and occasionally multi-minute outliers under swap
     * pressure). Asserting the error code tests the deadline logic; asserting the clock would
     * test Android's scheduler.
     */
    if (input.shape === "silent" && code !== "timeout") {
      throw new Error(`${context}: a silent proxy produced ${code}, expected the deadline to fire as timeout`);
    }
    if (input.shape === "close-early" && code !== "protocol_error" && code !== "timeout") {
      throw new Error(`${context}: an early close produced ${code}`);
    }
    assertGlobalStateUnchanged(before, context);
    return;
  }

  /*
   * A returned socket is a claim that the tunnel is open. That is only legitimate for a reply
   * that actually granted it, so anything reached from a hostile shape is a defect.
   */
  socket.destroy();
  if (input.shape !== "two-stage" && input.shape !== "status" && input.shape !== "bytes" && input.shape !== "credential") {
    throw new Error(`${context}: a tunnel was established from a ${input.shape} reply after ${Date.now() - started} ms`);
  }
  if (established !== socket) {
    throw new Error(`${context}: returned a socket that is not the one dialled`);
  }

  assertGlobalStateUnchanged(before, context);
}

export function cleanup() {
  server.close();
}

export const target = {
  name: "socks5",
  seed: "9i-socks5-1",
  iterations: 5000,
  iterationBudgetMs: ITERATION_BUDGET_MS,
  generate,
  run,
  cleanup,
};
