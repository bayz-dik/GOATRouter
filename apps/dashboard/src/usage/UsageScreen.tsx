import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FluxCoreSlot } from "../FluxCoreSlot";
import { buildLiveViewModel } from "../flux/adapter";
import type { FluxActivityEvent, FluxCoreViewModel } from "../flux/types";
import { PanelError } from "../panels/shared";
import {
  USAGE_PERIODS,
  type UsagePeriod,
  type UsageProviderView,
  type UsageRequestView,
  type UsageSummaryView,
} from "../api/types";
import {
  CHART_HEIGHT,
  CHART_WIDTH,
  PERIOD_LABEL,
  UNKNOWN_VALUE,
  formatAge,
  formatCount,
  formatLatency,
  formatTokenPair,
  paceBars,
  paceLinePath,
  requestStatus,
  tokenPace,
} from "./format";

/**
 * The GOAT ROUTER Usage screen.
 *
 * Every figure on this screen comes from the authenticated `/api/usage/*` endpoints —
 * the same Phase 8 telemetry the router writes. There is no demo data path and no
 * simulated fallback: when the API reports nothing, the screen says so. That is the
 * whole point of the rule the adapter documents, and it is why the reference preview's
 * `DEMO DATA` captions and its `128 / 184K / 36K / 71K` constants are not carried over.
 *
 * Cost stays unavailable by design. GOAT ROUTER has no pricing table and no billing API, so
 * the panel prints the server's own `costReason` instead of an estimate. A plausible
 * dollar figure here would be a fabricated measurement, which is worse than a blank.
 */

/** How many request rows to pull. The server's own ceiling is 200. */
const REQUEST_LIMIT = 50;

/** Live refresh cadence. Bounded and cleared on unmount. */
const REFRESH_MS = 15_000;

export type UsageApi = {
  getUsageSummary(period: UsagePeriod): Promise<UsageSummaryView>;
  listUsageProviders(period: UsagePeriod): Promise<UsageProviderView[]>;
  listUsageRequests(limit: number): Promise<UsageRequestView[]>;
};

type Loaded = {
  summary: UsageSummaryView;
  providers: UsageProviderView[];
  requests: UsageRequestView[];
};

/**
 * Recent router events, for the Flux Core activity feed.
 *
 * Built from real request rows rather than the reference's ambient simulation strings.
 * The label is the provider that served the request (or `CORE` when the router failed
 * before choosing one), and the message is the outcome — a failure keeps its category
 * so the feed names what went wrong instead of saying "something did".
 */
function activityFrom(requests: readonly UsageRequestView[]): FluxActivityEvent[] {
  return requests.slice(0, 6).map((row) => ({
    id: row.requestId,
    label: row.providerId ?? "CORE",
    message:
      row.outcome === "ok"
        ? `${row.routingMode} / ${row.model}`
        : `${row.failureCategory ?? "failed"} / ${row.model}`,
  }));
}

export function UsageScreen({ api }: { api: UsageApi }) {
  const [period, setPeriod] = useState<UsagePeriod>("today");
  const [data, setData] = useState<Loaded | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  /**
   * Bumped to force a reload. A nonce rather than calling the loader directly, so a
   * refresh cannot start a second in-flight load that resolves out of order.
   */
  const [nonce, setNonce] = useState(0);
  /** Tracks the latest requested period so a slow response cannot overwrite a newer one. */
  const activePeriod = useRef(period);

  useEffect(() => {
    activePeriod.current = period;
    let active = true;
    setLoading(true);

    void (async () => {
      try {
        // Three independent reads, issued together: they are separate endpoints and
        // serialising them would triple the time the screen shows nothing.
        const [summary, providers, requests] = await Promise.all([
          api.getUsageSummary(period),
          api.listUsageProviders(period),
          api.listUsageRequests(REQUEST_LIMIT),
        ]);
        if (!active || activePeriod.current !== period) {
          return;
        }
        setData({ summary, providers, requests });
        setError(undefined);
        setNow(Date.now());
      } catch (failure) {
        if (active) {
          // The stale view is dropped: showing last minute's numbers under a failed
          // reload would present them as current.
          setData(undefined);
          setError(failure);
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    })();

    return () => {
      active = false;
    };
    // `api` is stable for the lifetime of the session; the loader is keyed on what
    // actually changes what is fetched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, nonce]);

  useEffect(() => {
    const timer = setInterval(() => setNonce((value) => value + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  /**
   * The display-safe Flux Core model.
   *
   * `source: "live"` throughout — the adapter is the only thing that builds it, and it
   * never backfills an empty live field with demo values.
   */
  const model = useMemo<FluxCoreViewModel | undefined>(() => {
    if (data === undefined) {
      return undefined;
    }
    const base = buildLiveViewModel({
      summary: data.summary,
      providers: data.providers,
      requests: data.requests,
    });
    return {
      ...base,
      period: PERIOD_LABEL[period],
      activity: activityFrom(data.requests),
    };
  }, [data, period]);

  const pace = useMemo(
    () => (data === undefined ? undefined : tokenPace(data.requests, period, now)),
    [data, now, period],
  );

  const summary = data?.summary;
  const tokensKnown = (summary?.tokenReports ?? 0) > 0;
  /**
   * A token total is shown only when at least one provider reported counts. Otherwise
   * the cell reads `—` with `Not reported` underneath, because "no provider told us" and
   * "genuinely zero" are different facts and the screen must not merge them.
   *
   * Sentence case throughout this screen: the facts are unchanged, the shouting is not a
   * fact. `NOT REPORTED` in caps read as an error when it is a normal, expected state.
   */
  const tokenValue = (value: number | null | undefined): string =>
    tokensKnown ? formatCount(value) : UNKNOWN_VALUE;
  const tokenNote = tokensKnown
    ? `${formatCount(summary?.tokenReports)} reported`
    : "Not reported";

  const linePath = pace === undefined ? undefined : paceLinePath(pace);
  const bars = pace === undefined ? [] : paceBars(pace);

  return (
    <section className="screen" aria-labelledby="usage-title">
      <div className="screen-header">
        <div>
          {/*
            "Usage" — the screen's name, nothing more. The trailing period was an affectation
            carried from the reference preview, and the "Request performance" kicker above it
            was a caption that said less than the one-word title it captioned.
          */}
          <h1 className="screen-title" id="usage-title">
            Usage
          </h1>
        </div>
        <div className="header-actions">
          {/*
            The source badge stays: whether these figures are real telemetry is a fact worth
            stating, and it is the honest counterpart to the Flux panel's simulated mode.
          */}
          <span className="tag" data-testid="usage-source">
            Live telemetry
          </span>
          <div className="periods" role="tablist" aria-label="Usage period">
            {USAGE_PERIODS.map((value) => (
              <button
                key={value}
                className={`period-button${value === period ? " active" : ""}`}
                type="button"
                role="tab"
                aria-selected={value === period}
                onClick={() => setPeriod(value)}
              >
                {PERIOD_LABEL[value]}
              </button>
            ))}
          </div>
          <button className="button small" type="button" onClick={reload}>
            Refresh
          </button>
        </div>
      </div>

      {error !== undefined && <PanelError error={error} />}

      <div className="score-strip" aria-label="Usage summary">
        <div className="score">
          <div className="score-label">Total requests</div>
          <div className="score-value" data-testid="score-requests">
            {formatCount(summary?.totalRequests)}
          </div>
          <div className="score-note">
            {summary === undefined
              ? "\u2014"
              : `${formatCount(summary.okRequests)} ok / ${formatCount(summary.failedRequests)} failed`}
          </div>
        </div>
        <div className="score">
          <div className="score-label">Input tokens</div>
          <div className="score-value" data-testid="score-input">
            {tokenValue(summary?.promptTokens)}
          </div>
          <div className="score-note">{tokenNote}</div>
        </div>
        <div className="score">
          <div className="score-label">Output tokens</div>
          <div className="score-value" data-testid="score-output">
            {tokenValue(summary?.completionTokens)}
          </div>
          <div className="score-note">{tokenNote}</div>
        </div>
        <div className="score">
          <div className="score-label">Cached tokens</div>
          <div className="score-value" data-testid="score-cached">
            {tokenValue(summary?.cachedTokens)}
          </div>
          <div className="score-note">{tokenNote}</div>
        </div>
        <div className="score">
          <div className="score-label">Avg latency</div>
          <div className="score-value" data-testid="score-latency">
            {formatLatency(summary?.averageLatencyMs)}
          </div>
          {/*
            The cost slot from the approved preview, answered honestly: there is no
            pricing table, so the server's reason is printed rather than a figure.
          */}
          <div className="score-note" data-testid="score-cost">
            {summary === undefined
              ? "\u2014"
              : `Cost ${summary.costAvailable ? "" : "unavailable / "}${summary.costReason}`}
          </div>
        </div>
      </div>

      <div className="usage-grid">
        {/* The relay stage. Under the Flux Core V2 visual lock; driven here by the live model. */}
        <FluxCoreSlot {...(model === undefined ? {} : { model })} />

        <section className="panel" aria-labelledby="recent-title">
          <div className="panel-head">
            <div>
              <h2 id="recent-title">Recent requests</h2>
              <div className="panel-meta" data-testid="recent-meta">
                {data === undefined
                  ? loading
                    ? "Loading router telemetry"
                    : "No telemetry available"
                  : `${data.requests.length} rows / retained ${formatCount(
                      data.summary.retention.requests,
                    )}`}
              </div>
            </div>
          </div>

          {data !== undefined && data.requests.length > 0 ? (
            <div className="table-wrap">
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Route</th>
                    <th>In / Out</th>
                    <th>Status</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {data.requests.map((row) => {
                    const status = requestStatus(row);
                    return (
                      <tr key={row.requestId} data-testid={`request-${row.requestId}`}>
                        {/* Every cell is untrusted API text rendered as a React text node. */}
                        <td className="mono wrap">{row.model}</td>
                        <td className="mono wrap">{row.providerId ?? UNKNOWN_VALUE}</td>
                        <td className="mono">
                          {formatTokenPair(row.promptTokens, row.completionTokens)}
                        </td>
                        <td>
                          {status.failed || status.retried ? (
                            <span>
                              <span className="state-hatch" />
                              {status.word}
                              {row.failureCategory !== null && ` / ${row.failureCategory}`}
                            </span>
                          ) : (
                            <span className="status">{status.word}</span>
                          )}
                        </td>
                        <td className="mono">{formatAge(row.occurredAt, now)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty-note" data-testid="recent-empty">
              {loading
                ? "Loading router telemetry…"
                : "No requests recorded in this period. Route a request through the Core to populate this table."}
            </p>
          )}
        </section>
      </div>

      <section className="panel chart-panel" aria-labelledby="pace-title">
        <div className="panel-head">
          <div>
            <h2 id="pace-title">Token pace</h2>
            <div className="panel-meta">{`Selected period / ${PERIOD_LABEL[period]}`}</div>
          </div>
          <span className="tag">Input + output</span>
        </div>
        {linePath !== undefined || bars.length > 0 ? (
          <>
            <div className="chart-body">
              <svg
                className="chart-svg"
                viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
                preserveAspectRatio="none"
                role="img"
                aria-label={`Token pace over the selected period. ${formatCount(
                  pace?.counted,
                )} requests plotted.`}
              >
                <path
                  className="chart-grid"
                  d={`M0 40H${CHART_WIDTH}M0 100H${CHART_WIDTH}M0 160H${CHART_WIDTH}M0 220H${CHART_WIDTH}`}
                />
                {bars.map((bar) => (
                  <rect
                    key={`${bar.x}-${bar.y}`}
                    className="chart-bar"
                    x={bar.x}
                    y={bar.y}
                    width={bar.width}
                    height={bar.height}
                  />
                ))}
                {linePath !== undefined && <path className="chart-line" d={linePath} />}
              </svg>
            </div>
            <div className="chart-axis">
              <span>{`${formatCount(pace?.counted)} requests plotted`}</span>
              <span>
                {pace?.tokensKnown === true
                  ? `Peak ${formatCount(pace.maxTokens)} tokens per bucket`
                  : "Token counts not reported"}
              </span>
            </div>
          </>
        ) : (
          <p className="empty-note" data-testid="pace-empty">
            {loading
              ? "Loading router telemetry…"
              : "No requests in this period, so there is no pace to plot."}
          </p>
        )}
      </section>
    </section>
  );
}
