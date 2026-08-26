import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FLUX_NAMES,
  FLUX_SHARE,
  createFluxEngine,
  type FluxEngine,
  type FluxSyncSnapshot,
} from "./engine";
import {
  FLUX_MAX_PROVIDERS,
  type FluxActivityEvent,
  type FluxCoreViewModel,
  type FluxProviderState,
  type FluxTempo,
} from "./types";
import "./flux.css";

/**
 * BAYZ Relay Usage Track / Flux Core V2.
 *
 * The canvas engine owns all per-frame work and lives outside React state. React
 * owns the DOM, the controls, and the throttled labels — the engine reports a
 * snapshot roughly three times a second, never per frame.
 *
 * Every dynamic string rendered here is treated as untrusted: it goes through a
 * React text node, so there is no `innerHTML` path anywhere in this integration
 * (the standalone preview used one for its activity feed).
 */

const CHIP_CLASS = ["p1", "p2", "p3", "p4", "p5"] as const;
const TEMPO_LABEL: Record<FluxTempo, string> = {
  calm: "Calm",
  live: "Live",
  surge: "Surge",
};

function stateWord(state: FluxProviderState): string {
  return state === "degraded"
    ? "DEGRADED"
    : state === "off"
      ? "OFF"
      : state === "wake"
        ? "ONLINE"
        : "ACTIVE";
}

/** Clamp a share for display without trusting the supplied number. */
function displayShare(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
}

const AMBIENT: ReadonlyArray<readonly [string, string]> = [
  ["OPENROUTER", "stream accepted"],
  ["GEMINI", "route selected"],
  ["CODEX", "request completed"],
  ["TABITOKEN", "latency nominal"],
  ["CUSTOM", "combo branch active"],
  ["CORE", "checkpoint synced"],
];

export type FluxCoreProps = {
  /**
   * Display-safe usage data. When omitted, the approved simulation drives the
   * view and the panel says so, rather than presenting invented telemetry as
   * measurement.
   */
  model?: FluxCoreViewModel;
};

export function FluxCore({ model }: FluxCoreProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([null, null, null, null, null]);
  const engineRef = useRef<FluxEngine | null>(null);
  const feedIdRef = useRef(0);

  const live = model !== undefined && model.source === "live";

  const [reduced, setReduced] = useState(false);
  const [tempo, setTempo] = useState<FluxTempo>("live");
  const [paused, setPaused] = useState(false);
  const [drilling, setDrilling] = useState(false);
  const [chipStates, setChipStates] = useState<FluxProviderState[]>([
    "active",
    "active",
    "active",
    "active",
    "active",
  ]);
  const [snapshot, setSnapshot] = useState<FluxSyncSnapshot>({
    activeCount: FLUX_MAX_PROVIDERS,
    routedRequests: 128,
    loadPercent: 61,
    tempo: "live",
    drilling: false,
    shares: [...FLUX_SHARE],
  });
  const [simFeed, setSimFeed] = useState<FluxActivityEvent[]>([]);

  const pushFeed = useCallback((label: string, message: string) => {
    feedIdRef.current += 1;
    const entry: FluxActivityEvent = { id: `sim-${feedIdRef.current}`, label, message };
    // Bounded to six rows, matching the approved feed length.
    setSimFeed((current) => [entry, ...current].slice(0, 6));
  }, []);

  /* ---------- engine lifecycle ---------- */
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (wrap === null || canvas === null) {
      return;
    }

    const media =
      typeof matchMedia === "function"
        ? matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    const initialReduced = media?.matches ?? false;
    setReduced(initialReduced);

    const engine = createFluxEngine({
      canvas,
      wrap,
      chips: chipRefs.current.filter((el): el is HTMLButtonElement => el !== null),
      reducedMotion: initialReduced,
      onSync: (next) => {
        setSnapshot(next);
        setDrilling(next.drilling);
      },
      onChipState: (index, state) => {
        setChipStates((current) => {
          if (current[index] === state) {
            return current;
          }
          const next = [...current];
          next[index] = state;
          return next;
        });
      },
      onActivity: pushFeed,
      onDrillEnd: () => setDrilling(false),
    });
    engineRef.current = engine;

    engine.layout();
    engine.start();

    let queued = false;
    const observer = new ResizeObserver(() => {
      if (queued) {
        return;
      }
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        engineRef.current?.layout();
      });
    });
    observer.observe(wrap);

    const onVisibility = (): void => {
      if (document.hidden) {
        engine.stop();
      } else {
        engine.start();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    const onMediaChange = (event: MediaQueryListEvent): void => {
      setReduced(event.matches);
      engine.setReducedMotion(event.matches);
    };
    media?.addEventListener("change", onMediaChange);

    const ambient = setInterval(
      () => {
        if (engine.paused() || document.hidden) {
          return;
        }
        const pick = AMBIENT[(Math.random() * AMBIENT.length) | 0]!;
        pushFeed(pick[0], pick[1]);
      },
      initialReduced ? 6500 : 3400,
    );

    for (let i = 0; i < 4; i += 1) {
      const pick = AMBIENT[(Math.random() * AMBIENT.length) | 0]!;
      pushFeed(pick[0], pick[1]);
    }

    return () => {
      // Every resource acquired above is released here, so a remount cannot
      // duplicate a loop, an observer, a listener, or a timer.
      clearInterval(ambient);
      media?.removeEventListener("change", onMediaChange);
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
      engine.destroy();
      engineRef.current = null;
    };
  }, [pushFeed]);

  /* ---------- controls ---------- */
  const onCount = useCallback((n: number) => {
    engineRef.current?.setActiveCount(n);
  }, []);

  const onTempo = useCallback((next: FluxTempo) => {
    setTempo(next);
    engineRef.current?.setTempo(next);
  }, []);

  const onToggleChip = useCallback(
    (index: number) => {
      const result = engineRef.current?.toggleProvider(index);
      if (result === "denied") {
        const el = chipRefs.current[index];
        if (el !== null && el !== undefined) {
          el.classList.remove("deny");
          void el.offsetWidth;
          el.classList.add("deny");
        }
      }
    },
    [],
  );

  const onPause = useCallback(() => {
    if (reduced) {
      return;
    }
    setPaused((current) => {
      const next = !current;
      engineRef.current?.setPaused(next);
      return next;
    });
  }, [reduced]);

  const onDrill = useCallback(() => {
    if (engineRef.current?.startDrill() === true) {
      setDrilling(true);
    }
  }, []);

  /* ---------- derived display data ---------- */
  const providers = useMemo(() => {
    if (model !== undefined) {
      // Capped at the approved five positions; extra providers are not displayed.
      return model.providers.slice(0, FLUX_MAX_PROVIDERS).map((provider, index) => ({
        key: provider.id,
        label: provider.label,
        state: provider.state,
        share: displayShare(provider.sharePercent),
        index,
      }));
    }
    return FLUX_NAMES.map((name, index) => ({
      key: `sim-${name}`,
      label: name,
      state: chipStates[index] ?? "active",
      share: snapshot.shares[index] ?? 0,
      index,
    }));
  }, [chipStates, model, snapshot.shares]);

  const activeCount = live
    ? providers.filter((provider) => provider.state !== "off").length
    : snapshot.activeCount;

  const mode = useMemo(() => {
    if (model?.routingMode === "failover" || (!live && drilling)) {
      return "FAILOVER SEQUENCE";
    }
    if (model?.routingMode === "direct") {
      return "DIRECT ROUTE";
    }
    if (model?.routingMode === "combo") {
      return "COMBO ROUTING";
    }
    return activeCount >= 2 ? "COMBO ROUTING" : "DIRECT ROUTE";
  }, [activeCount, drilling, live, model?.routingMode]);

  const routed = model?.routedRequests ?? snapshot.routedRequests;
  const load = model?.loadPercent ?? snapshot.loadPercent;
  const feed = model?.activity ?? simFeed;

  const metaState = drilling ? "FAILOVER" : activeCount >= 2 ? "COMBO" : "DIRECT";
  const sourceWord = live ? "LIVE" : "SIM";

  const ariaLabel = `Bayz relay visualization. ${mode}. Active providers: ${
    providers
      .filter((provider) => provider.state !== "off")
      .map((provider) => provider.label)
      .join(", ") || "none"
  }. Tempo: ${tempo}. Routed requests: ${routed}.`;

  return (
    <section className="panel flux-panel" aria-labelledby="relay-title">
      <div className="panel-head">
        <div>
          <h2 id="relay-title">Relay usage track</h2>
          <div className="panel-meta">
            {`PROVIDER \u2192 BAYZ \u2192 MODEL / ${sourceWord} \u00b7 ${metaState} \u00b7 ${tempo.toUpperCase()}`}
          </div>
        </div>
        <div className="head-actions">
          <button
            className="button small"
            type="button"
            onClick={onDrill}
            disabled={drilling || live}
          >
            {drilling ? "DRILL ACTIVE" : "Failover drill"}
          </button>
          <button
            className="button small"
            type="button"
            aria-pressed={paused}
            onClick={onPause}
            disabled={reduced}
            title={reduced ? "Motion is already minimized (reduced motion)" : ""}
          >
            {paused ? "RESUME" : "Pause"}
          </button>
        </div>
      </div>

      <div className="stage-zone">
        <div className="relay-wrap" ref={wrapRef} role="img" aria-label={ariaLabel}>
          <canvas ref={canvasRef} className="flux-canvas" />
          <div className="flux-vignette" aria-hidden="true" />

          <div className="core-copy" aria-hidden="true">
            <strong>BAYZ</strong>
            <span>{mode}</span>
            <em />
            <small>
              {`${activeCount} PROVIDER${activeCount === 1 ? "" : "S"} / ROUTED ${routed}`}
            </small>
          </div>

          {providers.map((provider) => (
            <button
              key={provider.key}
              ref={(el) => {
                chipRefs.current[provider.index] = el;
              }}
              className={`provider ${CHIP_CLASS[provider.index] ?? "p1"}`}
              type="button"
              data-state={provider.state}
              aria-pressed={provider.state !== "off"}
              onClick={() => onToggleChip(provider.index)}
              disabled={live}
            >
              {/* Untrusted label: rendered as a text node, never as markup. */}
              <b>{provider.label}</b>
              <small>
                <i className="pdot" />
                <span>{provider.share}%</span>
                &nbsp;/&nbsp;
                <span>{stateWord(provider.state)}</span>
              </small>
            </button>
          ))}

          <div className="stage-hud">
            <div className="hud-group" role="group" aria-label="Active provider count">
              <span className="hud-label">Providers</span>
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  className={`hud-btn${!live && activeCount === n ? " active" : ""}`}
                  type="button"
                  aria-pressed={!live && activeCount === n}
                  onClick={() => onCount(n)}
                  disabled={live}
                >
                  {n}
                </button>
              ))}
            </div>
            <div className="hud-group" role="group" aria-label="Animation tempo">
              <span className="hud-label">Tempo</span>
              {(["calm", "live", "surge"] as FluxTempo[]).map((value) => (
                <button
                  key={value}
                  className={`hud-btn${tempo === value ? " active" : ""}`}
                  type="button"
                  aria-pressed={tempo === value}
                  onClick={() => onTempo(value)}
                >
                  {TEMPO_LABEL[value]}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="legend">
          <div>
            <b>01 / SOURCE</b>
            <span className="state-square" />
            Provider route
          </div>
          <div>
            <b>02 / HANDOFF</b>
            <span className="state-square" />
            Braided traffic
          </div>
          <div>
            <b>03 / IMPACT</b>
            <span className="state-square" />
            Packet into core
          </div>
        </div>
      </div>

      <div className="panel-head flux-subhead">
        <div>
          <h3>Live activity</h3>
          <div className="panel-meta">{live ? "Router events" : "Simulation events"}</div>
        </div>
      </div>
      <div className="live-activity">
        {feed.map((event) => (
          <div className="live-row" key={event.id}>
            <i className="live-dot" />
            {/* Both fields are untrusted text; React escapes them. */}
            <b>
              {event.label} / {event.message}
            </b>
            <span>NOW</span>
          </div>
        ))}
      </div>
      <div className="load-meter">
        <header>
          <span>NETWORK LOAD</span>
          <strong>{load}%</strong>
        </header>
        <div className="load-track">
          <div className="load-fill" style={{ width: `${load}%` }} />
        </div>
      </div>
    </section>
  );
}
