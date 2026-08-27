import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SSE_LINE_BYTES,
  MAX_SSE_TOTAL_BYTES,
  MAX_SSE_MALFORMED,
  RouterError,
  SseLineReader,
  encodeSseDone,
  encodeSseEvent,
} from "../src/index.js";

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

test("encodeSseEvent produces exactly one data frame", () => {
  assert.equal(encodeSseEvent({ a: 1 }), 'data: {"a":1}\n\n');
});

test("encodeSseDone produces the terminal frame", () => {
  assert.equal(encodeSseDone(), "data: [DONE]\n\n");
});

test("a payload containing a newline is JSON-escaped, never emitted raw", () => {
  // Frame-injection guard. A raw newline inside a data payload would terminate the
  // frame early and let a completion's content forge a second event, which a
  // client would parse as if BAYZ had sent it.
  const encoded = encodeSseEvent({ content: "line one\n\ndata: injected" });
  assert.equal(encoded.split("\n\n").length, 2, "payload must not create a frame");
  assert.ok(encoded.includes("\\n\\ndata: injected"));
  assert.ok(encoded.endsWith("\n\n"));
});

test("a payload containing a carriage return is escaped", () => {
  const encoded = encodeSseEvent({ content: "a\r\nb" });
  assert.ok(!encoded.slice(0, -2).includes("\r"));
  assert.ok(encoded.includes("\\r\\n"));
});

test("a payload containing a lone surrogate is escaped, not emitted raw", () => {
  // Measured behaviour, corrected from an initial wrong assumption: since
  // well-formed `JSON.stringify` (ES2019), a lone surrogate is emitted as the
  // escape sequence `\ud800` rather than as a raw code unit. That is already safe
  // — the frame stays valid UTF-8 — so refusing it would reject a completion a
  // client could read perfectly well. What matters is that no raw unpaired
  // surrogate reaches the wire, which is what this asserts.
  const encoded = encodeSseEvent({ content: "\ud800" });
  assert.ok(encoded.includes("\\ud800"));
  const roundTripped = new TextDecoder("utf-8", { fatal: true }).decode(
    new TextEncoder().encode(encoded),
  );
  assert.equal(roundTripped, encoded);
  assert.equal(
    JSON.parse(encoded.slice("data: ".length).trimEnd()).content,
    "\ud800",
  );
});

test("an unserializable payload is refused", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(
    () => encodeSseEvent(cyclic),
    (error: unknown) =>
      error instanceof RouterError && error.code === "invalid_response",
  );
});

test("a reader reassembles a payload split across three chunks", () => {
  const reader = new SseLineReader();
  assert.deepEqual(reader.push(bytes('data: {"a"')), []);
  assert.deepEqual(reader.push(bytes(":1")), []);
  assert.deepEqual(reader.push(bytes("}\n\n")), ['{"a":1}']);
});

test("a reader handles a multi-byte character split across chunks", () => {
  // A naive per-chunk `toString("utf8")` would emit a replacement character here
  // and silently corrupt a completion containing any non-ASCII text.
  const encoded = bytes('data: {"c":"é"}\n');
  const reader = new SseLineReader();
  const split = 15;
  assert.deepEqual(reader.push(encoded.slice(0, split)), []);
  assert.deepEqual(reader.push(encoded.slice(split)), ['{"c":"é"}']);
});

test("a reader accepts a data line with no space after the colon", () => {
  const reader = new SseLineReader();
  assert.deepEqual(reader.push(bytes('data:{"a":1}\n')), ['{"a":1}']);
});

test("a reader accepts CRLF line endings", () => {
  const reader = new SseLineReader();
  assert.deepEqual(reader.push(bytes('data: {"a":1}\r\n')), ['{"a":1}']);
});

test("a reader ignores comment, event, id, and retry lines", () => {
  const reader = new SseLineReader();
  assert.deepEqual(
    reader.push(bytes(': heartbeat\nevent: message\nid: 7\nretry: 100\ndata: {"a":1}\n')),
    ['{"a":1}'],
  );
});

test("a reader ignores a blank line", () => {
  const reader = new SseLineReader();
  assert.deepEqual(reader.push(bytes('\n\n\ndata: {"a":1}\n')), ['{"a":1}']);
});

test("a reader reports the terminal marker and then refuses more data", () => {
  const reader = new SseLineReader();
  assert.deepEqual(reader.push(bytes("data: [DONE]\n")), []);
  assert.equal(reader.terminated, true);
  // Anything after [DONE] is either an upstream bug or an attempt to append
  // content after the client believes the stream ended.
  assert.throws(
    () => reader.push(bytes('data: {"a":1}\n')),
    (error: unknown) =>
      error instanceof RouterError && error.code === "invalid_response",
  );
});

test("a reader surfaces payloads before the terminal marker in one push", () => {
  const reader = new SseLineReader();
  assert.deepEqual(
    reader.push(bytes('data: {"a":1}\ndata: [DONE]\n')),
    ['{"a":1}'],
  );
  assert.equal(reader.terminated, true);
});

test("a line exceeding the per-line cap throws response_too_large", () => {
  const reader = new SseLineReader();
  assert.throws(
    () => reader.push(bytes(`data: ${"x".repeat(MAX_SSE_LINE_BYTES + 1)}`)),
    (error: unknown) =>
      error instanceof RouterError && error.code === "response_too_large",
  );
});

test("a provider that never emits a newline cannot exhaust memory", () => {
  // The scenario the per-line cap exists for: an upstream that streams forever
  // without a delimiter. The reader must fail rather than buffer indefinitely.
  const reader = new SseLineReader();
  const block = bytes("x".repeat(8 * 1024));
  assert.throws(
    () => {
      for (let index = 0; index < 64; index += 1) {
        reader.push(block);
      }
    },
    (error: unknown) =>
      error instanceof RouterError && error.code === "response_too_large",
  );
});

test("total buffered bytes exceeding the stream cap throws", () => {
  const reader = new SseLineReader();
  const frame = bytes(`data: {"p":"${"y".repeat(32 * 1024)}"}\n`);
  assert.throws(
    () => {
      for (let index = 0; index < Math.ceil(MAX_SSE_TOTAL_BYTES / frame.length) + 2; index += 1) {
        reader.push(frame);
      }
    },
    (error: unknown) =>
      error instanceof RouterError && error.code === "response_too_large",
  );
});

test("the caps are the documented values", () => {
  assert.equal(MAX_SSE_LINE_BYTES, 64 * 1024);
  assert.equal(MAX_SSE_TOTAL_BYTES, 2 * 1024 * 1024);
  assert.equal(MAX_SSE_MALFORMED, 8);
});

test("malformed payloads are skipped up to the bound, then the stream fails", () => {
  // Skipping a few bad frames tolerates a flaky upstream; skipping without bound
  // would let a provider stream garbage forever while the client waits.
  const reader = new SseLineReader();
  for (let index = 0; index < MAX_SSE_MALFORMED; index += 1) {
    assert.deepEqual(reader.push(bytes("data: not-json\n")), []);
  }
  assert.equal(reader.malformed, MAX_SSE_MALFORMED);
  assert.throws(
    () => reader.push(bytes("data: still-not-json\n")),
    (error: unknown) =>
      error instanceof RouterError && error.code === "invalid_response",
  );
});

test("a well-formed payload does not count toward the malformed bound", () => {
  const reader = new SseLineReader();
  reader.push(bytes("data: bad\n"));
  reader.push(bytes('data: {"a":1}\n'));
  assert.equal(reader.malformed, 1);
});

test("[DONE] inside a JSON string does not terminate the stream", () => {
  const reader = new SseLineReader();
  assert.deepEqual(
    reader.push(bytes('data: {"content":"[DONE]"}\n')),
    ['{"content":"[DONE]"}'],
  );
  assert.equal(reader.terminated, false);
});

test("done reports an unterminated stream as an error", () => {
  // A stream that stops without [DONE] is a truncation. Reporting success would
  // hand the client a silently incomplete completion.
  const reader = new SseLineReader();
  reader.push(bytes('data: {"a":1}\n'));
  assert.throws(
    () => reader.done(),
    (error: unknown) =>
      error instanceof RouterError && error.code === "invalid_response",
  );
});

test("done accepts a properly terminated stream", () => {
  const reader = new SseLineReader();
  reader.push(bytes("data: [DONE]\n"));
  reader.done();
});

test("done flushes a trailing line with no newline before termination", () => {
  const reader = new SseLineReader();
  reader.push(bytes("data: [DONE]"));
  assert.equal(reader.terminated, false);
  reader.done();
  assert.equal(reader.terminated, true);
});

test("a stream of pure carriage returns is bounded", () => {
  const reader = new SseLineReader();
  const block = bytes("\r".repeat(4096));
  for (let index = 0; index < 16; index += 1) {
    assert.deepEqual(reader.push(block), []);
  }
  assert.equal(reader.malformed, 0);
});

test("an empty push is a no-op", () => {
  const reader = new SseLineReader();
  assert.deepEqual(reader.push(new Uint8Array(0)), []);
  assert.equal(reader.terminated, false);
});

test("a data line with an empty payload is ignored", () => {
  const reader = new SseLineReader();
  assert.deepEqual(reader.push(bytes("data: \ndata:\n")), []);
  assert.equal(reader.malformed, 0);
});

test("a non-object JSON payload is treated as malformed", () => {
  // The router's chunk parser expects an object. A bare number or string is not a
  // chunk, and passing it downstream would push the type confusion further in.
  const reader = new SseLineReader();
  for (const payload of ["42", '"text"', "null", "true", "[1,2]"]) {
    reader.push(bytes(`data: ${payload}\n`));
  }
  assert.equal(reader.malformed, 5);
});
