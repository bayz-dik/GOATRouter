import { ProviderError, type ProviderErrorCode } from "./errors.js";

/** 64 KiB is far above any legitimate model list and far below a memory risk. */
export const DEFAULT_MAX_BYTES = 64 * 1024;

export type Fetcher = typeof fetch;

export type FetchJsonCappedOptions = {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Code used when the body is unusable (unparseable, oversized, non-UTF-8). */
  malformedCode?: ProviderErrorCode;
  fetcher?: Fetcher;
};

function mapStatus(status: number): ProviderErrorCode | undefined {
  if (status === 401 || status === 403) {
    return "auth_failed";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status >= 400) {
    return "upstream_error";
  }
  return undefined;
}

/** An abort raised by the timeout signal, distinguished from a bad payload. */
function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/**
 * Read at most `maxBytes` from a response stream.
 *
 * The body is streamed rather than awaited via `response.text()` so a hostile
 * upstream cannot force unbounded buffering: the read loop aborts as soon as the
 * cap is exceeded, and `content-length` is never trusted as the real size.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const stream = response.body;
  if (stream === null) {
    throw new ProviderError("upstream_error", "empty-body");
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        throw new ProviderError("upstream_error", "body-too-large");
      }
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream is already finished or errored; nothing to salvage.
    }
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * Perform a bounded upstream request and parse the response as JSON.
 *
 * Every failure is translated into a fixed-message `ProviderError`: upstream
 * bodies, peer addresses, and DNS text are all attacker- or operator-controlled
 * and would otherwise end up in logs.
 */
export async function fetchJsonCapped(
  options: FetchJsonCappedOptions,
): Promise<unknown> {
  const {
    url,
    method = "GET",
    headers = {},
    body,
    timeoutMs = 30000,
    maxBytes = DEFAULT_MAX_BYTES,
    malformedCode = "upstream_error",
    fetcher = fetch,
  } = options;

  let response: Response;
  try {
    response = await fetcher(url, {
      method,
      headers: { accept: "application/json", ...headers },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Timeouts, DNS failures, refused connections, and refused redirects are
    // indistinguishable to a caller and equally not actionable in detail.
    throw new ProviderError("unreachable", "upstream-request");
  }

  const statusCode = mapStatus(response.status);
  if (statusCode !== undefined) {
    try {
      await response.body?.cancel();
    } catch {
      // Nothing to release.
    }
    throw new ProviderError(statusCode, `status-${response.status}`);
  }

  let raw: Uint8Array;
  try {
    raw = await readCapped(response, maxBytes);
  } catch (error) {
    if (isAbort(error)) {
      // The timeout signal also covers body streaming, so a response that stalls
      // after its headers is a transport failure, not a malformed payload.
      throw new ProviderError("unreachable", "read-body-timeout");
    }
    if (error instanceof ProviderError && error.code === "upstream_error") {
      throw new ProviderError(malformedCode, error.stage);
    }
    throw new ProviderError(malformedCode, "read-body");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new ProviderError(malformedCode, "decode-body");
  }
  if (text.trim().length === 0) {
    throw new ProviderError(malformedCode, "empty-body");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError(malformedCode, "parse-body");
  }
}
