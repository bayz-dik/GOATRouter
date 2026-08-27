import { RouterError } from "./errors.js";

/** 64 KiB. A single SSE line longer than this is an upstream fault or an attack. */
export const MAX_SSE_LINE_BYTES = 64 * 1024;
/** 2 MiB across the whole stream, matching the non-streaming response cap. */
export const MAX_SSE_TOTAL_BYTES = 2 * 1024 * 1024;
/** How many unparseable payloads to tolerate before failing the stream. */
export const MAX_SSE_MALFORMED = 8;

const DONE_MARKER = "[DONE]";

/**
 * Encode one server-sent event.
 *
 * `JSON.stringify` is what makes this frame-injection safe: a completion whose
 * content contains `\n\ndata: ...` is escaped into `\\n\\ndata: ...`, so a model's
 * output cannot forge an event the client would attribute to BAYZ. Well-formed
 * `JSON.stringify` also escapes an unpaired surrogate as `\ud800` rather than
 * emitting a raw code unit, so the frame is always valid UTF-8 without any extra
 * handling here — verified rather than assumed, in `sse.test.ts`.
 */
export function encodeSseEvent(data: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch {
    throw new RouterError("invalid_response", "sse-encode");
  }
  if (json === undefined) {
    throw new RouterError("invalid_response", "sse-encode-undefined");
  }
  if (/[\r\n]/.test(json)) {
    // Unreachable through JSON.stringify, kept as a structural backstop: if this
    // ever fires, frame integrity is broken and failing is the only safe answer.
    throw new RouterError("invalid_response", "sse-encode-newline");
  }
  return `data: ${json}\n\n`;
}

export function encodeSseDone(): string {
  return `data: ${DONE_MARKER}\n\n`;
}

/**
 * A bounded incremental SSE parser.
 *
 * Three properties matter and each is a test in `sse.test.ts`:
 *
 * 1. **Bounded.** A provider that never emits a newline hits `MAX_SSE_LINE_BYTES`
 *    rather than growing a buffer forever, and the whole stream is capped too.
 * 2. **Byte-correct.** Decoding is streaming, so a multi-byte character split
 *    across two network chunks is reassembled instead of becoming a replacement
 *    character that silently corrupts non-ASCII completions.
 * 3. **Honest about truncation.** `done()` on a stream that never sent `[DONE]`
 *    throws, because handing the client a silently incomplete completion is worse
 *    than an error.
 */
export class SseLineReader {
  #buffer = "";
  #totalBytes = 0;
  #malformed = 0;
  #terminated = false;
  readonly #decoder = new TextDecoder("utf-8");

  get terminated(): boolean {
    return this.#terminated;
  }

  get malformed(): number {
    return this.#malformed;
  }

  push(chunk: Uint8Array): string[] {
    if (this.#terminated) {
      // Content after [DONE] is either an upstream bug or an attempt to append to
      // a completion the client already considers finished.
      throw new RouterError("invalid_response", "sse-after-done");
    }
    if (chunk.byteLength === 0) {
      return [];
    }

    this.#totalBytes += chunk.byteLength;
    if (this.#totalBytes > MAX_SSE_TOTAL_BYTES) {
      throw new RouterError("response_too_large", "sse-total-bytes");
    }

    // `stream: true` keeps a partial multi-byte sequence inside the decoder rather
    // than emitting U+FFFD for it.
    this.#buffer += this.#decoder.decode(chunk, { stream: true });

    const payloads: string[] = [];
    for (;;) {
      const index = this.#buffer.indexOf("\n");
      if (index === -1) {
        break;
      }
      const raw = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      const payload = this.#consumeLine(raw);
      if (payload !== undefined) {
        payloads.push(payload);
      }
      if (this.#terminated) {
        return payloads;
      }
    }

    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_SSE_LINE_BYTES) {
      throw new RouterError("response_too_large", "sse-line-bytes");
    }
    return payloads;
  }

  /**
   * Finish the stream.
   *
   * A trailing line with no newline is flushed first, because a well-behaved
   * upstream may close immediately after `data: [DONE]` without the final newline.
   */
  done(): void {
    this.#buffer += this.#decoder.decode();
    const trailing = this.#buffer.trim();
    this.#buffer = "";
    if (trailing.length > 0 && !this.#terminated) {
      this.#consumeLine(trailing);
    }
    if (!this.#terminated) {
      throw new RouterError("invalid_response", "sse-truncated");
    }
  }

  #consumeLine(raw: string): string | undefined {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.length === 0 || line.startsWith(":")) {
      // Blank lines separate frames and `:` lines are comments — commonly used as
      // heartbeats, so treating one as malformed would fail healthy streams.
      return undefined;
    }
    if (!line.startsWith("data:")) {
      // `event:`, `id:`, and `retry:` are valid SSE fields BAYZ does not use.
      return undefined;
    }

    const payload = line.slice(5).trim();
    if (payload.length === 0) {
      return undefined;
    }
    if (payload === DONE_MARKER) {
      this.#terminated = true;
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return this.#recordMalformed();
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      // A bare number or string is not a chunk. Passing it on would push the type
      // confusion further into the router.
      return this.#recordMalformed();
    }
    return payload;
  }

  #recordMalformed(): undefined {
    this.#malformed += 1;
    if (this.#malformed > MAX_SSE_MALFORMED) {
      throw new RouterError("invalid_response", "sse-malformed-limit");
    }
    return undefined;
  }
}
