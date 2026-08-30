import { describe, expect, it } from "vitest";
import {
  CHART_HEIGHT,
  PERIOD_MS,
  UNKNOWN_VALUE,
  formatAge,
  formatCount,
  formatLatency,
  formatTokenPair,
  paceBars,
  paceLinePath,
  requestStatus,
  tokenPace,
} from "../src/usage/format";
import type { UsageRequestView } from "../src/api/types";

/**
 * Usage display formatting.
 *
 * The property every test here defends is the one the reference preview broke by
 * design: **an unknown value is never printed as a number.** The preview shipped
 * `128 / 184K / 36K / 71K` as constants under a `DEMO DATA` caption; production has no
 * such caption and therefore no such constants, so a missing measurement has to be
 * visibly missing rather than plausibly zero.
 */

function request(overrides: Partial<UsageRequestView> = {}): UsageRequestView {
  return {
    requestId: "req_1",
    occurredAt: new Date("2026-08-31T12:00:00.000Z").toISOString(),
    routeId: "r1",
    providerId: "p1",
    proxyId: null,
    model: "gpt-4o",
    routingMode: "direct",
    outcome: "ok",
    failureCategory: null,
    latencyMs: 400,
    attempts: 1,
    promptTokens: 1200,
    completionTokens: 340,
    cachedTokens: 90,
    ...overrides,
  };
}

describe("formatCount", () => {
  it("prints small counts exactly", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(1)).toBe("1");
    expect(formatCount(128)).toBe("128");
    expect(formatCount(999)).toBe("999");
  });

  it("compacts large counts the way the approved strip does", () => {
    expect(formatCount(1200)).toBe("1.2K");
    expect(formatCount(18_400)).toBe("18.4K");
    expect(formatCount(184_000)).toBe("184K");
    expect(formatCount(2_800_000)).toBe("2.8M");
    expect(formatCount(15_800_000)).toBe("15.8M");
    expect(formatCount(4_000_000_000)).toBe("4.0B");
  });

  it("prints UNKNOWN rather than zero for a value that does not exist", () => {
    // The load-bearing case. `null` from the API means nobody reported the count, and
    // `0` would be a fabricated measurement.
    expect(formatCount(null)).toBe(UNKNOWN_VALUE);
    expect(formatCount(undefined)).toBe(UNKNOWN_VALUE);
  });

  it("refuses a hostile number instead of rendering it", () => {
    expect(formatCount(Number.NaN)).toBe(UNKNOWN_VALUE);
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe(UNKNOWN_VALUE);
    expect(formatCount(-1)).toBe(UNKNOWN_VALUE);
    expect(formatCount("184K" as never)).toBe(UNKNOWN_VALUE);
  });
});

describe("formatLatency", () => {
  it("prints a measured latency in whole milliseconds", () => {
    expect(formatLatency(412)).toBe("412 ms");
    expect(formatLatency(412.7)).toBe("413 ms");
    expect(formatLatency(0)).toBe("0 ms");
  });

  it("prints UNKNOWN for an unmeasured or hostile latency", () => {
    expect(formatLatency(null)).toBe(UNKNOWN_VALUE);
    expect(formatLatency(Number.NaN)).toBe(UNKNOWN_VALUE);
    expect(formatLatency(-5)).toBe(UNKNOWN_VALUE);
  });
});

describe("formatAge", () => {
  const now = Date.parse("2026-08-31T12:00:00.000Z");

  it("uses the approved short forms", () => {
    expect(formatAge("2026-08-31T11:59:42.000Z", now)).toBe("18s");
    expect(formatAge("2026-08-31T11:57:00.000Z", now)).toBe("3m");
    expect(formatAge("2026-08-31T08:00:00.000Z", now)).toBe("4h");
    expect(formatAge("2026-08-29T12:00:00.000Z", now)).toBe("2d");
  });

  it("clamps a future timestamp instead of showing a negative age", () => {
    // Clock skew between a browser and a local daemon is ordinary; a negative duration
    // would read as a router bug.
    expect(formatAge("2026-08-31T12:00:30.000Z", now)).toBe("0s");
  });

  it("prints UNKNOWN for an unparseable timestamp", () => {
    expect(formatAge("not-a-date", now)).toBe(UNKNOWN_VALUE);
    expect(formatAge("", now)).toBe(UNKNOWN_VALUE);
  });
});

describe("formatTokenPair", () => {
  it("keeps each side independently unknown", () => {
    expect(formatTokenPair(18_400, 326)).toBe("18.4K / 326");
    expect(formatTokenPair(null, 326)).toBe(`${UNKNOWN_VALUE} / 326`);
    expect(formatTokenPair(18_400, null)).toBe(`18.4K / ${UNKNOWN_VALUE}`);
    expect(formatTokenPair(null, null)).toBe(`${UNKNOWN_VALUE} / ${UNKNOWN_VALUE}`);
  });
});

describe("requestStatus", () => {
  it("reports OK only for a first-attempt success", () => {
    expect(requestStatus(request())).toEqual({ word: "OK", retried: false, failed: false });
  });

  it("reports RETRY for a success that took more than one attempt", () => {
    // Collapsing this into OK would hide a provider wobbling, which is the thing an
    // operator opens this screen to find.
    expect(requestStatus(request({ attempts: 3 }))).toEqual({
      word: "RETRY",
      retried: true,
      failed: false,
    });
  });

  it("reports FAILED for any non-ok outcome", () => {
    const status = requestStatus(
      request({ outcome: "failed", attempts: 2, failureCategory: "timeout" }),
    );
    expect(status.word).toBe("FAILED");
    expect(status.failed).toBe(true);
  });

  it("tolerates a hostile attempt count", () => {
    expect(requestStatus(request({ attempts: Number.NaN })).word).toBe("OK");
  });
});

describe("tokenPace", () => {
  const now = Date.parse("2026-08-31T12:00:00.000Z");

  function at(offsetMs: number, overrides: Partial<UsageRequestView> = {}): UsageRequestView {
    return request({
      requestId: `req_${offsetMs}`,
      occurredAt: new Date(now - offsetMs).toISOString(),
      ...overrides,
    });
  }

  it("buckets real rows and sums real token counts", () => {
    const pace = tokenPace([at(60_000), at(120_000)], "today", now);
    expect(pace.counted).toBe(2);
    expect(pace.tokensKnown).toBe(true);
    // 1200 + 340 per request, both in the final bucket of a 24h window.
    expect(pace.buckets.reduce((sum, bucket) => sum + bucket.tokens, 0)).toBe(3080);
    expect(pace.buckets.reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(2);
  });

  it("drops rows outside the window rather than piling them on the first bucket", () => {
    const outside = at(PERIOD_MS.today + 60_000);
    const pace = tokenPace([outside, at(60_000)], "today", now);
    expect(pace.counted).toBe(1);
  });

  it("records that token counts are unknown without inventing zeros as data", () => {
    const pace = tokenPace(
      [at(60_000, { promptTokens: null, completionTokens: null })],
      "today",
      now,
    );
    expect(pace.counted).toBe(1);
    expect(pace.tokensKnown).toBe(false);
    expect(pace.maxTokens).toBe(0);
  });

  it("returns an empty series for no rows, not a flat line", () => {
    const pace = tokenPace([], "7d", now);
    expect(pace.counted).toBe(0);
    expect(paceLinePath(pace)).toBeUndefined();
    expect(paceBars(pace)).toEqual([]);
  });

  it("ignores an unparseable timestamp", () => {
    const pace = tokenPace([at(60_000, { occurredAt: "nope" })], "today", now);
    expect(pace.counted).toBe(0);
  });

  it("builds a path and bars that stay inside the chart box", () => {
    const rows = Array.from({ length: 8 }, (_unused, index) =>
      at(index * 3600_000, { promptTokens: 100 * (index + 1), completionTokens: 10 }),
    );
    const pace = tokenPace(rows, "today", now);
    const path = paceLinePath(pace)!;
    expect(path.startsWith("M0 ")).toBe(true);

    for (const [, value] of path.matchAll(/[ML](\d+) (\d+)/g)) {
      expect(Number(value)).toBeGreaterThanOrEqual(0);
    }
    for (const bar of paceBars(pace)) {
      expect(bar.y).toBeGreaterThanOrEqual(0);
      expect(bar.y + bar.height).toBeLessThanOrEqual(CHART_HEIGHT);
      expect(bar.height).toBeGreaterThan(0);
    }
  });
});
