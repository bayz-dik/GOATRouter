import type { UsagePeriod, UsageRequestView } from "../api/types";

/**
 * Display formatting for the Usage screen.
 *
 * Every function here is pure and total, because it is fed values that crossed a
 * network boundary. The rule the whole file follows: **a value that is not known is
 * not invented.** `null` from the API means "no provider reported this", and it comes
 * out as `UNKNOWN_VALUE` rather than `0`, so an operator can never read a missing
 * measurement as a real one.
 */

/** What the screen prints where a number does not exist. Never `0`, never blank. */
export const UNKNOWN_VALUE = "—";

/** How the four API periods are labelled in the approved period switch. */
export const PERIOD_LABEL: Readonly<Record<UsagePeriod, string>> = {
  today: "Today",
  "24h": "24H",
  "7d": "7D",
  "30d": "30D",
};

/** Window length per period, matching the server's own `PERIODS` table. */
export const PERIOD_MS: Readonly<Record<UsagePeriod, number>> = {
  today: 24 * 3600_000,
  "24h": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
  "30d": 30 * 24 * 3600_000,
};

/**
 * A count in the approved compact form: `128`, `18.4K`, `184K`, `15.8M`.
 *
 * The decimal threshold is read off the approved reference rather than chosen: it
 * prints `18.4K`, `11.4K`, `2.8M` and `15.8M` with one decimal, and `184K`, `552K` and
 * `804K` without. So one decimal below 100 and none at or above it, which keeps every
 * value at four characters or fewer in a strip that is deliberately narrow.
 *
 * A hostile or absent value is `UNKNOWN_VALUE`, not `NaN` and not `0`. Negative is
 * treated as unusable for the same reason: the API contract has no negative counts, so
 * one means the value is wrong rather than small.
 */
export function formatCount(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return UNKNOWN_VALUE;
  }
  if (value < 1000) {
    return String(Math.round(value));
  }
  for (const unit of [
    { limit: 1e6, divisor: 1e3, suffix: "K" },
    { limit: 1e9, divisor: 1e6, suffix: "M" },
    { limit: 1e12, divisor: 1e9, suffix: "B" },
  ]) {
    if (value < unit.limit) {
      const scaled = value / unit.divisor;
      return `${scaled < 100 ? scaled.toFixed(1) : String(Math.round(scaled))}${unit.suffix}`;
    }
  }
  return `${Math.round(value / 1e12)}T`;
}

/** A latency in whole milliseconds, or `UNKNOWN_VALUE` when unmeasured. */
export function formatLatency(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return UNKNOWN_VALUE;
  }
  return `${Math.round(value)} ms`;
}

/**
 * How long ago something happened, in the approved short form: `18s`, `3m`, `4h`, `2d`.
 *
 * An unparseable timestamp yields `UNKNOWN_VALUE`. A future timestamp is clamped to
 * `0s` rather than rendered as a negative age — clock skew between a client and a local
 * daemon is ordinary, and a negative duration would look like a bug in the router.
 */
export function formatAge(occurredAt: string, now: number): string {
  const at = Date.parse(occurredAt);
  if (!Number.isFinite(at)) {
    return UNKNOWN_VALUE;
  }
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)}h`;
  }
  return `${Math.floor(seconds / 86_400)}d`;
}

/** `18.4K / 326`, with either side independently unknown. */
export function formatTokenPair(
  promptTokens: number | null,
  completionTokens: number | null,
): string {
  return `${formatCount(promptTokens)} / ${formatCount(completionTokens)}`;
}

/**
 * The word shown in the Status column.
 *
 * A retried-but-successful request is `RETRY`, not `OK`: the attempt count is real
 * information about a provider wobbling, and collapsing it into `OK` hides the thing an
 * operator opened this screen to find. A failure keeps its category as the title text.
 */
export type RequestStatus = { word: string; retried: boolean; failed: boolean };

export function requestStatus(row: UsageRequestView): RequestStatus {
  const failed = row.outcome !== "ok";
  const attempts = Number.isFinite(row.attempts) ? row.attempts : 1;
  if (failed) {
    return { word: "FAILED", retried: attempts > 1, failed: true };
  }
  return attempts > 1
    ? { word: "RETRY", retried: true, failed: false }
    : { word: "OK", retried: false, failed: false };
}

/** One bucket of the token-pace chart. Counts are real sums, never smoothed. */
export type PaceBucket = {
  /** Bucket start, epoch ms. */
  startedAt: number;
  requests: number;
  /** Prompt + completion for the requests in this bucket that reported counts. */
  tokens: number;
  /** Whether any request in this bucket reported a token count at all. */
  tokensKnown: boolean;
};

export type TokenPace = {
  buckets: PaceBucket[];
  maxTokens: number;
  maxRequests: number;
  /** False when no request in range reported a token count. */
  tokensKnown: boolean;
  /** How many of the supplied rows fell inside the window. */
  counted: number;
};

const BUCKET_COUNT = 12;

/**
 * Bucket real request rows into a token-pace series.
 *
 * Deliberately not interpolated and not padded: an empty bucket is zero because zero
 * requests genuinely happened in it, and a bucket whose requests reported no token
 * counts contributes nothing to `tokens` while `tokensKnown` records the difference.
 *
 * Rows outside the window are dropped rather than clamped into the first bucket, which
 * would pile a month of history onto one column.
 */
export function tokenPace(
  requests: readonly UsageRequestView[],
  period: UsagePeriod,
  now: number,
): TokenPace {
  const span = PERIOD_MS[period];
  const width = span / BUCKET_COUNT;
  const start = now - span;

  const buckets: PaceBucket[] = Array.from({ length: BUCKET_COUNT }, (_unused, index) => ({
    startedAt: start + index * width,
    requests: 0,
    tokens: 0,
    tokensKnown: false,
  }));

  let counted = 0;
  for (const row of requests) {
    const at = Date.parse(row.occurredAt);
    if (!Number.isFinite(at) || at < start || at > now) {
      continue;
    }
    const index = Math.min(BUCKET_COUNT - 1, Math.max(0, Math.floor((at - start) / width)));
    const bucket = buckets[index]!;
    bucket.requests += 1;
    counted += 1;

    const prompt = typeof row.promptTokens === "number" && row.promptTokens >= 0 ? row.promptTokens : undefined;
    const completion =
      typeof row.completionTokens === "number" && row.completionTokens >= 0
        ? row.completionTokens
        : undefined;
    if (prompt !== undefined || completion !== undefined) {
      bucket.tokens += (prompt ?? 0) + (completion ?? 0);
      bucket.tokensKnown = true;
    }
  }

  return {
    buckets,
    maxTokens: buckets.reduce((max, bucket) => Math.max(max, bucket.tokens), 0),
    maxRequests: buckets.reduce((max, bucket) => Math.max(max, bucket.requests), 0),
    tokensKnown: buckets.some((bucket) => bucket.tokensKnown),
    counted,
  };
}

/** The chart's viewBox, shared by the path builders so they cannot disagree. */
export const CHART_WIDTH = 1200;
export const CHART_HEIGHT = 240;

/**
 * An SVG polyline path for a bucketed series.
 *
 * Returns `undefined` — not an empty `d` and not a flat line at zero — when there is
 * nothing to draw, so the caller renders an explicit empty state instead of a chart
 * that looks like measured silence.
 */
export function paceLinePath(pace: TokenPace): string | undefined {
  if (pace.counted === 0 || pace.maxTokens <= 0) {
    return undefined;
  }
  const step = CHART_WIDTH / Math.max(1, pace.buckets.length - 1);
  return pace.buckets
    .map((bucket, index) => {
      const x = Math.round(index * step);
      const y = Math.round(CHART_HEIGHT - (bucket.tokens / pace.maxTokens) * (CHART_HEIGHT - 20));
      return `${index === 0 ? "M" : "L"}${x} ${y}`;
    })
    .join(" ");
}

/** Request-count bars, one per bucket, scaled to the busiest bucket. */
export function paceBars(pace: TokenPace): Array<{ x: number; y: number; width: number; height: number }> {
  if (pace.counted === 0 || pace.maxRequests <= 0) {
    return [];
  }
  const slot = CHART_WIDTH / pace.buckets.length;
  const width = Math.max(6, Math.round(slot * 0.28));
  return pace.buckets
    .map((bucket, index) => {
      const height = Math.round((bucket.requests / pace.maxRequests) * (CHART_HEIGHT - 20));
      return {
        x: Math.round(index * slot + (slot - width) / 2),
        y: CHART_HEIGHT - height,
        width,
        height,
      };
    })
    .filter((bar) => bar.height > 0);
}
