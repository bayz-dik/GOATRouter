import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FLUX_NAMES,
  FLUX_SHARE,
  createFluxEngine,
  type FluxAnchor,
  type FluxEngine,
  type FluxSyncSnapshot,
} from "./engine";
import {
  buildConstellation,
  ingressGroups,
  trunkFor,
  type ConstellationNode,
} from "./constellation";
import { providerIdentity, type ProviderIdentity } from "./identity";
import { ProviderMark } from "./ProviderMark";
import { DETAIL_NEAR, resolveLabels } from "./lod";
import {
  ZOOM_MAX,
  ZOOM_MIN,
  clampViewport,
  createViewport,
  focusOn,
  panBy,
  resetViewport,
  zoomAt,
  type Viewport,
} from "./viewport";
import {
  FLUX_APPROVED_PROVIDERS,
  type FluxActivityEvent,
  type FluxCoreViewModel,
  type FluxProvider,
  type FluxProviderState,
  type FluxRouteParticipation,
  type FluxTempo,
} from "./types";
import "./flux.css";

/**
 * BAYZ Relay Usage Track / Flux Core V2 + scalable provider constellation.
 *
 * The canvas engine owns all per-frame work and lives outside React state; it
 * reports a snapshot roughly three times a second, never per frame. React owns the
 * DOM, the controls, the viewport, and the throttled labels.
 *
 * Every dynamic string rendered here is untrusted and passes through a React text
 * node. There is no `innerHTML` path anywhere in this integration — the standalone
 * preview used one for its activity feed, and it is not carried over.
 */

/** Approved position classes; applied only at the approved counts. */
const APPROVED_CHIP_CLASS = ["p1", "p2", "p3", "p4", "p5"] as const;

const TEMPO_LABEL: Record<FluxTempo, string> = {
  calm: "Calm",
  live: "Live",
  surge: "Surge",
};

/** Spoken form of route participation, used in accessible names. */
const ROUTE_WORD: Record<FluxRouteParticipation, string> = {
  primary: "primary route",
  combo: "combo member",
  reserve: "reserve",
  none: "no active traffic",
};

const STATE_WORD: Record<FluxProviderState, string> = {
  active: "ACTIVE",
  degraded: "DEGRADED",
  failed: "FAILED",
  recovering: "RECOVERING",
  standby: "STANDBY",
  off: "OFF",
};

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

/**
 * The approved demo adapter, kept isolated from any live model.
 *
 * Shares come from the approved constant table rather than from the live engine
 * snapshot, so the provider set is structurally stable and cannot feed back into
 * the animation loop.
 */
function simulationProviders(states: FluxProviderState[]): FluxProvider[] {
  return FLUX_NAMES.map((name, index) => ({
    id: `sim-${name.toLowerCase()}`,
    displayName: name,
    iconKey: name.toLowerCase(),
    state: states[index] ?? "active",
    sharePercent: FLUX_SHARE[index] ?? 0,
  }));
}

export type FluxCoreProps = {
  /**
   * Display-safe usage data. When omitted, the approved simulation drives the
   * view and the panel is labelled `SIM`, rather than presenting invented
   * telemetry as measurement.
   */
  model?: FluxCoreViewModel;
};

export function FluxCore({ model }: FluxCoreProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<FluxEngine | null>(null);
  const feedIdRef = useRef(0);
  /** Read by the engine each frame; a ref so pan/zoom causes no re-render churn. */
  const viewportRef = useRef<Viewport>(createViewport());
  const dragRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const pinchRef = useRef<Map<number, { x: number; y: number }>>(new Map());

  const live = model !== undefined && model.source === "live";

  const [reduced, setReduced] = useState(false);
  const [tempo, setTempo] = useState<FluxTempo>("live");
  const [paused, setPaused] = useState(false);
  const [drilling, setDrilling] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [viewport, setViewport] = useState<Viewport>(createViewport());
  const [simStates, setSimStates] = useState<FluxProviderState[]>([
    "active",
    "active",
    "active",
    "active",
    "active",
  ]);
  const [snapshot, setSnapshot] = useState<FluxSyncSnapshot>({
    activeCount: FLUX_APPROVED_PROVIDERS,
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

  /* ---------- provider model ---------- */
  /**
   * The provider set. Deliberately independent of `snapshot`: the engine emits a
   * fresh snapshot roughly three times a second, and feeding that back into the
   * provider model would recompute anchors on every sync and re-enter the engine —
   * an unbounded loop. Live shares are read separately, at render time only.
   */
  const providers = useMemo(
    () => (model !== undefined ? model.providers : simulationProviders(simStates)),
    [model, simStates],
  );

  const identities = useMemo(() => {
    const map = new Map<string, ProviderIdentity>();
    for (const provider of providers) {
      map.set(provider.id, providerIdentity(provider, providers));
    }
    return map;
  }, [providers]);

  const nodes = useMemo(() => buildConstellation(providers), [providers]);
  const groups = useMemo(() => ingressGroups(nodes), [nodes]);

  /**
   * Label resolution runs on viewport/selection change, not per frame — collision
   * work is deliberately slower-cadence than the canvas physics loop.
   */
  const labels = useMemo(
    () => resolveLabels(nodes, { zoom: viewport.zoom, selectedId }),
    [nodes, selectedId, viewport.zoom],
  );
  const labelled = useMemo(() => new Set(labels.labelled), [labels.labelled]);

  /**
   * Share shown on a chip.
   *
   * Read at render time rather than folded into the provider model, so the live
   * engine value can be displayed in simulation mode without the snapshot feeding
   * back into anchor computation.
   */
  const shareFor = useCallback(
    (index: number, fallback: number): number =>
      live ? displayShare(fallback) : displayShare(snapshot.shares[index] ?? fallback),
    [live, snapshot.shares],
  );

  /** Anchors feed the engine; ingress angles come from the trunk assignment. */
  const anchors = useMemo<FluxAnchor[]>(
    () =>
      nodes.map((node) => {
        const trunk = trunkFor(groups, node.id);
        return {
          id: node.id,
          xPct: node.xPct,
          yPct: node.yPct,
          ingressAngle: trunk?.angle ?? node.angle,
          active: node.state === "active" || node.state === "recovering",
          weight: displayShare(node.sharePercent),
        };
      }),
    [groups, nodes],
  );

  /* ---------- engine lifecycle ---------- */
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (wrap === null || canvas === null) {
      return;
    }

    const media =
      typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    const initialReduced = media?.matches ?? false;
    setReduced(initialReduced);

    const engine = createFluxEngine({
      canvas,
      wrap,
      viewport: () => viewportRef.current,
      reducedMotion: initialReduced,
      onSync: (next) => {
        setSnapshot(next);
        setDrilling(next.drilling);
      },
      onChipState: (index, state) => {
        setSimStates((current) => {
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

  /** Push the provider field into the engine whenever it changes. */
  useEffect(() => {
    engineRef.current?.setAnchors(anchors);
  }, [anchors]);

  /* ---------- viewport interaction ---------- */
  const applyViewport = useCallback((next: Viewport) => {
    const safe = clampViewport(next);
    viewportRef.current = safe;
    setViewport(safe);
    engineRef.current?.layout();
  }, []);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (wrap === null) {
      return;
    }

    const localPoint = (clientX: number, clientY: number): { x: number; y: number } => {
      const rect = wrap.getBoundingClientRect();
      return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
    };

    const onWheel = (event: WheelEvent): void => {
      // Only claim the gesture when it is a zoom over the stage, so ordinary page
      // scrolling past the panel is never hijacked.
      if (event.deltaY === 0) {
        return;
      }
      event.preventDefault();
      const point = localPoint(event.clientX, event.clientY);
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      applyViewport(zoomAt(viewportRef.current, factor, point.x, point.y));
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (event.pointerType === "touch") {
        pinchRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pinchRef.current.size >= 2) {
          dragRef.current = null;
          return;
        }
      }
      if ((event.target as HTMLElement | null)?.closest("button") !== null) {
        // Let provider chips and HUD buttons receive their own clicks.
        return;
      }
      dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      wrap.setPointerCapture?.(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (event.pointerType === "touch" && pinchRef.current.size >= 2) {
        const previous = [...pinchRef.current.values()];
        pinchRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const next = [...pinchRef.current.values()];
        if (previous.length >= 2 && next.length >= 2) {
          const before = Math.hypot(
            previous[0]!.x - previous[1]!.x,
            previous[0]!.y - previous[1]!.y,
          );
          const after = Math.hypot(next[0]!.x - next[1]!.x, next[0]!.y - next[1]!.y);
          if (before > 0 && after > 0) {
            const mid = localPoint(
              (next[0]!.x + next[1]!.x) / 2,
              (next[0]!.y + next[1]!.y) / 2,
            );
            applyViewport(zoomAt(viewportRef.current, after / before, mid.x, mid.y));
          }
        }
        return;
      }
      const drag = dragRef.current;
      if (drag === null || drag.id !== event.pointerId) {
        return;
      }
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      dragRef.current = { id: drag.id, x: event.clientX, y: event.clientY };
      applyViewport(panBy(viewportRef.current, dx, dy));
    };

    const onPointerUp = (event: PointerEvent): void => {
      pinchRef.current.delete(event.pointerId);
      if (dragRef.current?.id === event.pointerId) {
        dragRef.current = null;
        wrap.releasePointerCapture?.(event.pointerId);
      }
    };

    wrap.addEventListener("wheel", onWheel, { passive: false });
    wrap.addEventListener("pointerdown", onPointerDown);
    wrap.addEventListener("pointermove", onPointerMove);
    wrap.addEventListener("pointerup", onPointerUp);
    wrap.addEventListener("pointercancel", onPointerUp);

    return () => {
      wrap.removeEventListener("wheel", onWheel);
      wrap.removeEventListener("pointerdown", onPointerDown);
      wrap.removeEventListener("pointermove", onPointerMove);
      wrap.removeEventListener("pointerup", onPointerUp);
      wrap.removeEventListener("pointercancel", onPointerUp);
      dragRef.current = null;
      pinchRef.current.clear();
    };
  }, [applyViewport]);

  /* ---------- controls ---------- */
  const onCount = useCallback((n: number) => {
    engineRef.current?.setActiveCount(n);
  }, []);

  const onTempo = useCallback((next: FluxTempo) => {
    setTempo(next);
    engineRef.current?.setTempo(next);
  }, []);

  const onSelect = useCallback(
    (id: string, index: number) => {
      setSelectedId((current) => (current === id ? undefined : id));
      if (!live) {
        engineRef.current?.toggleProvider(index);
      }
    },
    [live],
  );

  const onFocusProvider = useCallback(
    (id: string) => {
      const node = nodes.find((candidate) => candidate.id === id);
      if (node === undefined) {
        return;
      }
      setSelectedId(id);
      const wrap = wrapRef.current;
      const size = wrap === null ? 600 : Math.min(wrap.clientWidth, wrap.clientHeight);
      applyViewport(
        focusOn(viewportRef.current, ((node.xPct - 50) / 100) * size * 1.35, ((node.yPct - 50) / 100) * size * 1.35),
      );
    },
    [applyViewport, nodes],
  );

  const onResetView = useCallback(() => {
    applyViewport(resetViewport());
  }, [applyViewport]);

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
  const activeCount = providers.filter(
    (provider) => provider.state === "active" || provider.state === "recovering",
  ).length;
  const failedCount = providers.filter(
    (provider) => provider.state === "failed" || provider.state === "degraded",
  ).length;

  const mode = useMemo(() => {
    if (model?.routingMode === "failover" || (!live && drilling) || failedCount > 0) {
      return "FAILOVER SEQUENCE";
    }
    if (model?.routingMode === "direct") {
      return "DIRECT ROUTE";
    }
    if (model?.routingMode === "combo") {
      return "COMBO ROUTING";
    }
    return activeCount >= 2 ? "COMBO ROUTING" : "DIRECT ROUTE";
  }, [activeCount, drilling, failedCount, live, model?.routingMode]);

  const routed = model?.routedRequests ?? snapshot.routedRequests;
  const load = model?.loadPercent ?? snapshot.loadPercent;
  const feed = model?.activity ?? simFeed;
  const metaState = failedCount > 0 || drilling ? "FAILOVER" : activeCount >= 2 ? "COMBO" : "DIRECT";
  const sourceWord = live ? "LIVE" : "SIM";

  /**
   * Incidents that could not be labelled in place, plus any provider carrying a
   * failure reason. Never a "+N" abstraction: each row names its provider and can
   * focus it in the constellation.
   */
  const incidents = useMemo(() => {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const ids = new Set(labels.overflowIncidents);
    for (const node of nodes) {
      if (node.incidentReason !== undefined) {
        ids.add(node.id);
      }
    }
    return [...ids]
      .map((id) => ({ id, identity: identities.get(id), node: byId.get(id) }))
      .filter(
        (entry): entry is { id: string; identity: ProviderIdentity; node: ConstellationNode } =>
          entry.identity !== undefined && entry.node !== undefined,
      );
  }, [identities, labels.overflowIncidents, nodes]);

  const ariaLabel = `Bayz relay visualization. ${mode}. ${providers.length} provider${
    providers.length === 1 ? "" : "s"
  }, ${activeCount} active, ${failedCount} in incident. Tempo: ${tempo}. Routed requests: ${routed}.`;

  const stageSize = 1.35;
  /**
   * At 1..5 providers the approved `.p1`-`.p5` CSS positions drive layout exactly,
   * so the approved baseline is pixel-identical. The scalable field only engages
   * once the count exceeds what the approved source demonstrates.
   */
  const approvedLayout = providers.length <= FLUX_APPROVED_PROVIDERS;

  return (
    <section className="panel flux-panel" aria-labelledby="relay-title">
      <div className="panel-head">
        <div>
          <h2 id="relay-title">Relay usage track</h2>
          <div className="panel-meta">
            {`PROVIDER \u2192 BAYZ \u2192 MODEL / ${sourceWord} \u00b7 ${metaState} \u00b7 ${tempo.toUpperCase()} \u00b7 ${providers.length} NODES${
              model?.period === undefined ? "" : ` \u00b7 ${model.period}`
            }`}
          </div>
        </div>
        <div className="head-actions">
          <button className="button small" type="button" onClick={onResetView}>
            Reset view
          </button>
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

          {/*
            Provider constellation. Every node is rendered — density reduces label
            detail, never node count — and positioned through the shared viewport
            transform so pan/zoom moves nodes and canvas filaments together.
          */}
          <div
            className="flux-field"
            style={{
              transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
            }}
          >
            {labels.nodes.map((node, index) => {
              const identity = identities.get(node.id);
              const showLabel = labelled.has(node.id);
              const isSelected = node.id === selectedId;
              return (
                <button
                  key={node.id}
                  className={`provider${approvedLayout ? ` ${APPROVED_CHIP_CLASS[index] ?? ""}` : ""}${
                    showLabel ? " labelled" : ""
                  }${isSelected ? " selected" : ""} route-${node.routeParticipation}`}
                  type="button"
                  data-state={node.state}
                  data-route={node.routeParticipation}
                  data-provider-id={node.id}
                  aria-pressed={isSelected}
                  aria-label={`${identity?.uniqueLabel ?? node.displayName} — ${
                    STATE_WORD[node.state]
                  }, ${ROUTE_WORD[node.routeParticipation]}`}
                  style={
                    approvedLayout
                      ? undefined
                      : {
                          left: `calc(50% + ${((node.xPct - 50) / 100) * stageSize * 100}%)`,
                          top: `calc(50% + ${((node.yPct - 50) / 100) * stageSize * 100}%)`,
                        }
                  }
                  onClick={() => onSelect(node.id, index)}
                  onDoubleClick={() => onFocusProvider(node.id)}
                >
                  <ProviderMark
                    iconKey={identity?.iconKey ?? "generic"}
                    initials={identity?.initials ?? "PV"}
                  />
                  {showLabel && (
                    <span className="provider-label">
                      {/* Untrusted label: a React text node, never markup. */}
                      <b>
                        {labels.detail === DETAIL_NEAR
                          ? (identity?.uniqueLabel ?? node.displayName)
                          : (identity?.compactLabel ?? node.displayName)}
                      </b>
                      {labels.showState && (
                        <small>
                          <i className="pdot" />
                          <span>{shareFor(index, node.sharePercent)}%</span>
                          &nbsp;/&nbsp;
                          <span>{STATE_WORD[node.state]}</span>
                          {node.latencyMs !== undefined && (
                            <>
                              &nbsp;/&nbsp;
                              <span>{node.latencyMs} ms</span>
                            </>
                          )}
                        </small>
                      )}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

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
            <div className="hud-group" role="group" aria-label="Zoom">
              <span className="hud-label">Zoom</span>
              <button
                className="hud-btn"
                type="button"
                aria-label="Zoom out"
                onClick={() => applyViewport(zoomAt(viewportRef.current, 1 / 1.3, 0, 0))}
                disabled={viewport.zoom <= ZOOM_MIN + 0.001}
              >
                −
              </button>
              <button
                className="hud-btn"
                type="button"
                aria-label="Zoom in"
                onClick={() => applyViewport(zoomAt(viewportRef.current, 1.3, 0, 0))}
                disabled={viewport.zoom >= ZOOM_MAX - 0.001}
              >
                +
              </button>
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

      {incidents.length > 0 && (
        <div className="flux-incidents" aria-label="Provider incidents">
          <div className="panel-head flux-subhead">
            <div>
              <h3>Incidents</h3>
              <div className="panel-meta">
                {`${incidents.length} PROVIDER${incidents.length === 1 ? "" : "S"} NEED ATTENTION`}
              </div>
            </div>
          </div>
          {incidents.map((incident) => (
            <button
              key={incident.id}
              className="incident-row"
              type="button"
              onClick={() => onFocusProvider(incident.id)}
            >
              <ProviderMark
                iconKey={incident.identity.iconKey}
                initials={incident.identity.initials}
              />
              <span className="incident-body">
                <b>{incident.identity.uniqueLabel}</b>
                {/* Untrusted operator-facing text; React escapes it. */}
                {incident.node.incidentReason !== undefined && (
                  <span className="incident-detail">{incident.node.incidentReason}</span>
                )}
              </span>
              <span>{incident.identity.shortId}</span>
            </button>
          ))}
        </div>
      )}

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
