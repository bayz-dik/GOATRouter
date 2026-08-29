/**
 * Fuzz target: SSE framing — 9I Task 3.
 *
 * Covers the plan's named shapes explicitly rather than hoping a random walk reaches them:
 * interleaved partial frames, a frame split mid-UTF-8-sequence, a 64 KiB line, a 3 MiB total
 * stream, `[DONE]` inside a JSON string, and a stream of pure `\r` bytes.
 *
 * The bound that matters most is `sse-after-done`: content arriving after `[DONE]` is either
 * an upstream bug or an attempt to append to a completion the client already considers
 * finished, and a reader that accepted it would let a provider extend a finished answer.
 */

import { generateSseStream, generateUtf8String } from "../generators.mjs";
import { assertGlobalStateUnchanged, expectBayzError, globalStateSnapshot } from "./shared.mjs";

const { MAX_SSE_LINE_BYTES, MAX_SSE_TOTAL_BYTES, SseLineReader } = await import("../../../packages/router/src/sse.ts");

const CODES = new Set(["invalid_response"]);

/**
 * Generated inputs are **descriptors, not buffers.**
 *
 * The plan requires pushing a 3 MiB total stream through the reader to prove the 2 MiB
 * `MAX_SSE_TOTAL_BYTES` bound holds. The harness caps a single generated input at 1 MiB — for
 * a good reason: a runaway generator must not exhaust memory. Both constraints are real and
 * they collide, so the generator emits a recipe and `run` builds the bytes. The stream that
 * reaches the boundary is genuinely 3 MiB; the *generated value* stays a few hundred bytes,
 * which is what the cap is actually about.
 *
 * The first version returned materialised chunk arrays and aborted at iteration 2 with a
 * 12,588,034-byte input, because a `Buffer` array measured through `JSON.stringify` inflates
 * to base64 on top of the real size.
 *
 * ## Why the two expensive shapes are swept rather than sampled
 *
 * Drawn at even odds, `overflow` came up 481 times and `long-line` 612 times in 5,000
 * iterations. RSS grew **147 MiB**, over the plan's 64 MiB bound. That figure was chased to a
 * cause rather than accommodated:
 *
 *   - Scaling: across 1,250 → 10,000 iterations, heap growth was 0.4, −1.1, 0.0, 0.0 MiB and
 *     `arrayBuffers` growth 0.0 MiB every time, while RSS decelerated (67.6, 34.6, 50.1,
 *     5.8 MiB) and plateaued near 220 MiB.
 *   - Halves: first half +65.1 MiB, second half +40.9 MiB — decelerating, which is the opposite
 *     of a leak's signature.
 *   - Isolation: building the 64 KiB buffer and discarding it costs **6.5 MiB** over 600
 *     iterations; pushing it through a real `SseLineReader` costs **65.1 MiB**. Retention scales
 *     with bytes decoded (600 × 64 KiB ≈ 38 MiB of text), and a shared `TextDecoder`, a fresh
 *     one, and `Buffer.toString("utf8")` all cost ~0 MiB on their own.
 *
 * So: glibc and V8 holding freed pages from large short-lived strings, with heap, external and
 * `arrayBuffers` all flat. Not a leak in the reader.
 *
 * The bound is nonetheless left at the plan's 64 MiB — raising it would blind this target to a
 * future real leak, which is the only thing the bound is for. What changed instead is that the
 * two expensive shapes stopped being re-proved hundreds of times. A byte cap is proved by
 * hitting it at, below and above the boundary; 612 random draws prove nothing the 3rd draw did
 * not. Both now run on a deterministic sparse schedule, and the cheap shapes — which are where
 * malformed framing actually hides — keep the full iteration budget.
 */
function generate(rng, { iteration }) {
  /*
   * Deterministic sparse schedule for the two byte-cap shapes: ten overflow and ten long-line
   * draws per 5,000-iteration run, at fixed offsets so they never collide and so a replay from
   * the seed reproduces the same schedule.
   */
  if (iteration % 500 === 0) {
    return { shape: "overflow", frameSize: 32 * 1024, totalBytes: 3 * 1024 * 1024, expectOverflow: true };
  }
  if (iteration % 500 === 250) {
    // At the bound and either side of it — the cap is a limit, not a margin.
    const size = [MAX_SSE_LINE_BYTES - 16, MAX_SSE_LINE_BYTES, MAX_SSE_LINE_BYTES + 16][(iteration / 250) % 3];
    return { shape: "long-line", size };
  }

  switch (rng.int(0, 6)) {
    case 0:
      // Pure CR bytes: not a valid SSE terminator, so nothing may be emitted as a line.
      return { shape: "bare-cr", count: rng.int(1, 4096) };
    case 1:
      // Split mid-UTF-8: a multi-byte character cut across two pushes must not decode into a
      // replacement character prematurely.
      return { shape: "split-utf8", text: generateUtf8String(rng), cutSeed: rng.int(1, 10_000) };
    case 2:
      // [DONE] inside a JSON string must not terminate the stream.
      return { shape: "quoted-done", expectAlive: true };
    case 3:
      // Content after a real [DONE]: must be refused.
      return { shape: "after-done", expectAfterDone: true };
    case 4:
      return {
        shape: "sliced",
        stream: generateSseStream(rng).toString("base64"),
        pieces: rng.int(2, 8),
        cutSeed: rng.int(1, 10_000),
      };
    case 5:
      return { shape: "empty-padded", stream: generateSseStream(rng).toString("base64") };
    default:
      return { shape: "raw", stream: generateSseStream(rng).toString("base64") };
  }
}

/**
 * Materialise a descriptor into the chunk sequence the reader will see.
 *
 * The overflow case is a generator function rather than an array so `run` can stop pulling once
 * the reader has refused: materialising all 96 frames would decode the full 3 MiB even though
 * the cap fires at 2 MiB.
 */
function* chunksFor(input) {
  switch (input.shape) {
    case "long-line":
      yield Buffer.from(`data: ${"x".repeat(input.size)}\n\n`, "utf8");
      return;
    case "overflow": {
      const frame = Buffer.from(`data: ${"y".repeat(input.frameSize)}\n\n`, "utf8");
      const count = Math.ceil(input.totalBytes / frame.length);
      for (let i = 0; i < count; i += 1) yield frame;
      return;
    }
    case "bare-cr":
      yield Buffer.from("\r".repeat(input.count), "latin1");
      return;
    case "split-utf8": {
      const text = Buffer.from(`data: {"content":"${input.text}€日"}\n\n`, "utf8");
      const at = 1 + (input.cutSeed % Math.max(1, text.length - 1));
      yield text.subarray(0, at);
      yield text.subarray(at);
      return;
    }
    case "quoted-done":
      yield Buffer.from('data: {"choices":[{"delta":{"content":"a literal [DONE] token"}}]}\n\n', "utf8");
      yield Buffer.from('data: {"choices":[{"delta":{"content":"still going"}}]}\n\n', "utf8");
      return;
    case "after-done":
      yield Buffer.from("data: [DONE]\n\n", "utf8");
      yield Buffer.from('data: {"a":1}\n\n', "utf8");
      return;
    case "sliced":
      yield* sliceDeterministic(Buffer.from(input.stream, "base64"), input.pieces, input.cutSeed);
      return;
    case "empty-padded":
      yield Buffer.alloc(0);
      yield Buffer.from(input.stream, "base64");
      yield Buffer.alloc(0);
      return;
    default:
      yield Buffer.from(input.stream, "base64");
  }
}

/**
 * Cut a buffer into `pieces` chunks at offsets derived from `seed`.
 *
 * Derived from the recorded seed rather than drawn from the rng inside `run`, so replaying a
 * saved failing input reproduces the same cuts. Taking fresh rng draws at run time would make
 * the recorded input insufficient to reproduce the failure — the exact property Task 1 exists
 * to guarantee.
 */
function sliceDeterministic(buffer, pieces, seed) {
  const cuts = [0, buffer.length];
  let state = seed;
  for (let i = 0; i < pieces - 1; i += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    cuts.push(state % (buffer.length + 1));
  }
  cuts.sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    if (cuts[i + 1] > cuts[i]) out.push(buffer.subarray(cuts[i], cuts[i + 1]));
  }
  return out.length > 0 ? out : [buffer];
}

function run(input, { iteration }) {
  const before = globalStateSnapshot();
  const context = `sse#${iteration}`;
  const reader = new SseLineReader();

  let overflowed = false;
  let afterDone = false;
  const lines = [];

  try {
    for (const chunk of chunksFor(input)) {
      for (const line of reader.push(chunk)) lines.push(line);
    }
    reader.done();
  } catch (error) {
    const code = expectBayzError(error, CODES, context);
    if (code === "invalid_response") {
      if (/after-done/.test(error.message)) afterDone = true;
      else overflowed = true;
    }
  }

  /*
   * The named shapes are asserted, not merely survived. "It didn't crash" would pass even if
   * the reader silently truncated a stream or terminated early on a quoted [DONE].
   */
  if (input.expectOverflow && !overflowed) {
    throw new Error(`${context}: a stream over ${MAX_SSE_TOTAL_BYTES} bytes was not refused`);
  }
  if (input.expectAfterDone && !afterDone) {
    throw new Error(`${context}: content after [DONE] was accepted`);
  }
  if (input.expectAlive) {
    if (reader.terminated) throw new Error(`${context}: a quoted [DONE] terminated the stream`);
    if (lines.length !== 2) throw new Error(`${context}: expected 2 frames, saw ${lines.length}`);
  }

  assertGlobalStateUnchanged(before, context);
}

export const target = {
  name: "sse",
  seed: "9i-sse-1",
  iterations: 5000,
  generate,
  run,
};
