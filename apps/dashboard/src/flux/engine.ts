import type { FluxProviderState, FluxTempo } from "./types";
import type { Viewport } from "./viewport";

/**
 * BAYZ RELAY TRACK / FLUX CORE V2 — canvas engine.
 *
 * Ported verbatim from the approved standalone source: monochrome, additive,
 * zero-allocation loop. Geometry, topology, particle behavior, timing constants,
 * provider positions, adaptive-quality thresholds, and Calm/Live/Surge semantics
 * are unchanged. The only structural difference is that the engine no longer
 * queries or mutates the document itself — the React layer owns the DOM and passes
 * elements in, and state changes are reported through callbacks instead of being
 * written directly into elements. That keeps per-frame work outside React while
 * making lifecycle cleanup possible.
 */

/* ---------- utils ---------- */
const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const smooth = (c: number, t: number, dt: number, tau: number): number =>
  c + (t - c) * (1 - Math.exp(-dt / tau));

/** Quantized alpha-string cache: no per-frame string garbage. */
const AC: string[] = [];
const al = (a: number): string => {
  a = a < 0 ? 0 : a > 1 ? 1 : a;
  const i = (a * 80) | 0;
  return AC[i] ?? (AC[i] = "rgba(255,255,255," + (i / 80).toFixed(3) + ")");
};

/* ---------- config ---------- */
export const FLUX_NAMES = ["OPENROUTER", "GEMINI", "CODEX", "TABITOKEN", "CUSTOM"] as const;
export const FLUX_SHARE = [31, 18, 27, 24, 16] as const;
const TEMPO: Record<FluxTempo, { sp: number; en: number; den: number }> = {
  calm: { sp: 0.5, en: 0.36, den: 0.55 },
  live: { sp: 1.0, en: 0.74, den: 0.95 },
  surge: { sp: 1.62, en: 1.15, den: 1.0 },
};

/* ---------- point shells: typed arrays, allocated once ---------- */
type Shell = {
  ux: Float32Array;
  uy: Float32Array;
  uz: Float32Array;
  sd: Float32Array;
};

function shell(n: number): Shell {
  const ux = new Float32Array(n);
  const uy = new Float32Array(n);
  const uz = new Float32Array(n);
  const sd = new Float32Array(n);
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i += 1) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = ga * i;
    ux[i] = Math.cos(th) * r;
    uy[i] = y;
    uz[i] = Math.sin(th) * r;
    sd[i] = (i * 0.61803398875) % 1;
  }
  return { ux, uy, uz, sd };
}

/** Module-level so a remount reuses them rather than reallocating. */
const SH_OUT = shell(720);
const SH_IN = shell(280);

/* reactor heart: dense deterministic nucleus */
const HN = 110;
const HX = new Float32Array(HN);
const HY = new Float32Array(HN);
const HZ = new Float32Array(HN);
{
  let s = 42;
  const rnd = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < HN; i += 1) {
    const z = rnd() * 2 - 1;
    const a = rnd() * TAU;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const rad = Math.cbrt(rnd());
    HX[i] = r * Math.cos(a) * rad;
    HY[i] = z * rad;
    HZ[i] = r * Math.sin(a) * rad;
  }
}

export type FluxEngineOptions = {
  canvas: HTMLCanvasElement;
  wrap: HTMLElement;
  /**
   * The approved five chip elements, used only when no anchors are supplied.
   * Retained so the original DOM-measured layout stays available and tested.
   */
  chips?: HTMLElement[];
  /**
   * Provider anchors in world-percent coordinates, one per provider.
   *
   * Supplied instead of DOM elements so the engine scales past the five approved
   * chips without measuring N elements every layout, and so a 40-provider field
   * costs no extra DOM reads.
   */
  anchors?: FluxAnchor[];
  /** Current pan/zoom, read each frame without going through React state. */
  viewport?: () => Viewport;
  reducedMotion?: boolean;
  /** Reported when a packet reaches the core or a provider state changes. */
  onSync?: (snapshot: FluxSyncSnapshot) => void;
  onChipState?: (index: number, state: FluxProviderState) => void;
  onActivity?: (label: string, message: string) => void;
  onDrillEnd?: () => void;
};

/** One provider's position in the constellation, in world-percent units. */
export type FluxAnchor = {
  id: string;
  xPct: number;
  yPct: number;
  /** Ingress angle at the core rim; shared by every provider in a trunk. */
  ingressAngle: number;
  active: boolean;
  /** 0..1 traffic weight, scaling filament intensity. */
  weight: number;
};

export type FluxSyncSnapshot = {
  activeCount: number;
  routedRequests: number;
  loadPercent: number;
  tempo: FluxTempo;
  drilling: boolean;
  shares: number[];
};

export type FluxEngine = {
  layout(): void;
  start(): void;
  stop(): void;
  destroy(): void;
  setTempo(tempo: FluxTempo): void;
  tempo(): FluxTempo;
  setActiveCount(n: number): void;
  toggleProvider(index: number): "enabled" | "disabled" | "denied";
  isActive(index: number): boolean;
  activeCount(): number;
  setPaused(paused: boolean): void;
  paused(): boolean;
  setReducedMotion(reduced: boolean): void;
  reducedMotion(): boolean;
  startDrill(): boolean;
  drilling(): boolean;
  routedRequests(): number;
  shareOf(index: number): number;
  /** Replace the provider field; safe to call whenever the view model changes. */
  setAnchors(anchors: FluxAnchor[]): void;
  providerCount(): number;
  poolSizes(): {
    waves: number;
    dents: number;
    flashes: number;
    packetsPerFilament: number;
  };
};

export function createFluxEngine(options: FluxEngineOptions): FluxEngine {
  const { canvas, wrap } = options;
  const chips: HTMLElement[] = options.chips ?? [];
  const viewportOf = options.viewport ?? (() => ({ zoom: 1, x: 0, y: 0 }));
  const ctx = canvas.getContext("2d", { alpha: false });

  /* ---------- state ---------- */
  const S = {
    tempo: "live" as FluxTempo,
    reduced: options.reducedMotion ?? false,
    speed: 1,
    energy: 0.74,
    kick: 0,
    surge: 0,
    act: [true, true, true, true, true] as boolean[],
    tgt: [1, 1, 1, 1, 1] as number[],
    tint: [1, 1, 1, 1, 1] as number[],
    drill: null as { prim: number; alt: number; altWasOff: boolean } | null,
    req: 128,
    beat: 0,
  };

  /* ---------- geometry ---------- */
  let W = 0;
  let H = 0;
  let dpr = 1;
  let mobile = false;
  let cxr = 0;
  let cyr = 0;
  let RAD = 100;

  /* fx pools — bounded, reused forever */
  const WAVES = Array.from({ length: 8 }, () => ({
    on: false,
    q: 9,
    amp: 0,
    x: 0,
    y: 1,
    z: 0,
  }));
  const DENTS = Array.from({ length: 6 }, () => ({ age: 99, amp: 0, x: 0, y: 1, z: 0 }));
  const FLASH = Array.from({ length: 6 }, () => ({ on: false, age: 0, x: 0, y: 0 }));
  let wCur = 0;

  function fireWave(x: number, y: number, z: number, amp: number): void {
    const w = WAVES[wCur]!;
    wCur = (wCur + 1) % WAVES.length;
    w.on = true;
    w.q = 0;
    w.amp = amp;
    w.x = x;
    w.y = y;
    w.z = z;
  }
  function fireDent(x: number, y: number, z: number, amp: number): void {
    let bi = 0;
    let ba = -1;
    for (let k = 0; k < DENTS.length; k += 1) {
      if (DENTS[k]!.age > ba) {
        ba = DENTS[k]!.age;
        bi = k;
      }
    }
    const d = DENTS[bi]!;
    d.age = 0;
    d.amp = amp;
    d.x = x;
    d.y = y;
    d.z = z;
  }

  /* per-provider filament record */
  type Filament = {
    i: number;
    ex: number;
    ey: number;
    ax: number;
    ay: number;
    dx: number;
    dy: number;
    wx: number;
    wy: number;
    wz: number;
    bend: number;
    ph: number;
    pk: Array<{ u: number; w: number; on: boolean; delay: number }>;
  };
  function makeFilament(i: number): Filament {
    return {
      i,
      ex: 0,
      ey: 0,
      ax: 0,
      ay: 0,
      dx: 0,
      dy: 1,
      wx: 0,
      wy: 0,
      wz: 1,
      bend: i % 2 ? -1 : 1,
      ph: i * 1.7,
      pk: [
        { u: 0, w: 1, on: false, delay: 0 },
        { u: 0, w: 1, on: false, delay: 0 },
        { u: 0, w: 1, on: false, delay: 0 },
      ],
    };
  }

  /**
   * One filament per provider, grown on demand and reused across view-model
   * changes so a 40-provider field allocates once rather than per frame.
   */
  const FIL: Filament[] = FLUX_NAMES.map((_unused, i) => makeFilament(i));

  /** Live provider anchors; empty means fall back to the approved chip layout. */
  let ANCHORS: FluxAnchor[] = options.anchors ?? [];

  /** The authoritative provider count, driving every bounded loop. */
  function count(): number {
    return ANCHORS.length > 0 ? ANCHORS.length : FLUX_NAMES.length;
  }

  function ensureCapacity(n: number): void {
    while (FIL.length < n) {
      FIL.push(makeFilament(FIL.length));
    }
    while (S.act.length < n) {
      S.act.push(true);
      S.tgt.push(1);
      S.tint.push(1);
    }
  }

  function activeCount(): number {
    let n = 0;
    for (let i = 0; i < count(); i += 1) {
      if (S.act[i]) {
        n += 1;
      }
    }
    return n;
  }
  /** Weight used for share maths: anchor weight when supplied, approved table otherwise. */
  function weightOf(i: number): number {
    const anchor = ANCHORS[i];
    if (anchor !== undefined) {
      return Number.isFinite(anchor.weight) ? Math.max(0, anchor.weight) : 0;
    }
    return FLUX_SHARE[i] ?? 0;
  }

  function shareOf(i: number): number {
    let tot = 0;
    for (let k = 0; k < count(); k += 1) {
      if (S.act[k]) {
        tot += weightOf(k);
      }
    }
    return tot ? Math.round((weightOf(i) / tot) * 100) : 0;
  }

  function layout(): void {
    const rc = wrap.getBoundingClientRect();
    W = Math.max(1, rc.width);
    H = Math.max(1, rc.height);
    mobile = W < 640;
    dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    cxr = W / 2;
    cyr = H / 2;
    RAD = Math.min(W, H) * (mobile ? 0.235 : 0.245);

    /**
     * Aim one filament from a source point at the core rim.
     *
     * Shared by both layout paths so the approved impact geometry — the 48px pull
     * back from the source, the 0.985 rim landing, the front-biased 0.42 z
     * component — is identical however the source position was obtained.
     */
    const aim = (f: Filament, ecx: number, ecy: number, ingressAngle?: number): void => {
      let vx = ecx - cxr;
      let vy = ecy - cyr;
      const vl = Math.hypot(vx, vy) || 1;
      vx /= vl;
      vy /= vl;
      const pull = mobile ? 36 : 48;
      f.ex = ecx - vx * pull;
      f.ey = ecy - vy * pull;
      if (ingressAngle === undefined) {
        f.ax = cxr + vx * RAD * 0.985;
        f.ay = cyr + vy * RAD * 0.985;
      } else {
        // Bundled trunks converge on a shared ingress point, which is what turns
        // forty independent cables into a handful of braided trunks.
        f.ax = cxr + Math.cos(ingressAngle) * RAD * 0.985;
        f.ay = cyr + Math.sin(ingressAngle) * RAD * 0.985;
      }
      const dx = f.ax - f.ex;
      const dy = f.ay - f.ey;
      const dl = Math.hypot(dx, dy) || 1;
      f.dx = dx / dl;
      f.dy = dy / dl;
      // 3D impact direction (front-biased)
      const nl = Math.sqrt(vx * vx + vy * vy + 0.42 * 0.42);
      f.wx = vx / nl;
      f.wy = vy / nl;
      f.wz = 0.42 / nl;
    };

    if (ANCHORS.length > 0) {
      ensureCapacity(ANCHORS.length);
      const vp = clampViewportLike(viewportOf());
      for (let i = 0; i < ANCHORS.length; i += 1) {
        const anchor = ANCHORS[i]!;
        const f = FIL[i]!;
        // World percent -> stage pixels, through the current pan/zoom. No DOM is
        // measured, so provider count costs nothing at layout time.
        const wx = ((anchor.xPct - 50) / 100) * Math.min(W, H) * 1.35;
        const wy = ((anchor.yPct - 50) / 100) * Math.min(W, H) * 1.35;
        aim(f, cxr + wx * vp.zoom + vp.x, cyr + wy * vp.zoom + vp.y, anchor.ingressAngle);
        S.act[i] = anchor.active;
        S.tgt[i] = anchor.active ? 1 : 0;
      }
    } else {
      chips.forEach((el: HTMLElement, i: number) => {
        const f = FIL[i];
        if (f === undefined) {
          return;
        }
        const r = el.getBoundingClientRect();
        aim(f, r.left - rc.left + r.width / 2, r.top - rc.top + r.height / 2);
      });
    }
    poke();
  }

  /** Defensive clamp: an invalid viewport must not warp the stage. */
  function clampViewportLike(v: Viewport): Viewport {
    const zoom = Number.isFinite(v.zoom) ? clamp(v.zoom, 0.45, 4) : 1;
    return {
      zoom,
      x: Number.isFinite(v.x) ? clamp(v.x, -2000, 2000) : 0,
      y: Number.isFinite(v.y) ? clamp(v.y, -2000, 2000) : 0,
    };
  }

  /* ---------- bezier helpers ---------- */
  function bezP(a: number, c1: number, c2: number, b: number, u: number): number {
    const v = 1 - u;
    return v * v * v * a + 3 * v * v * u * c1 + 3 * v * u * u * c2 + u * u * u * b;
  }
  const TK = { nx: 0, ny: 0 };
  function tanAt(
    ax: number,
    ay: number,
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    bx: number,
    by: number,
    u: number,
  ): void {
    const v = 1 - u;
    const dx = 3 * v * v * (c1x - ax) + 6 * v * u * (c2x - c1x) + 3 * u * u * (bx - c2x);
    const dy = 3 * v * v * (c1y - ay) + 6 * v * u * (c2y - c1y) + 3 * u * u * (by - c2y);
    const dl = Math.hypot(dx, dy) || 1;
    TK.nx = -dy / dl;
    TK.ny = dx / dl;
  }

  /* ============================================================
     SIMULATION STEP
     ============================================================ */
  function step(dt: number): void {
    const T = TEMPO[S.tempo];
    S.surge = Math.max(0, S.surge - dt * 0.45);
    S.kick = Math.max(0, S.kick - dt * 1.4);
    S.speed = smooth(S.speed, T.sp, dt, 0.5);
    S.energy = smooth(S.energy, clamp(T.en + S.surge * 0.4 + S.kick, 0.2, 1.5), dt, 0.6);

    for (let i = 0; i < count(); i += 1) {
      S.tint[i] = smooth(S.tint[i]!, S.act[i] ? S.tgt[i]! : 0, dt, 0.45);
    }

    for (let k = 0; k < WAVES.length; k += 1) {
      const w = WAVES[k]!;
      if (!w.on) {
        continue;
      }
      w.q += dt * S.speed * 1.55;
      if (w.q > 2.35) {
        w.on = false;
      }
    }
    for (let k = 0; k < DENTS.length; k += 1) {
      DENTS[k]!.age += dt;
    }
    for (let k = 0; k < FLASH.length; k += 1) {
      const f = FLASH[k]!;
      if (!f.on) {
        continue;
      }
      f.age += dt;
      if (f.age > 0.5) {
        f.on = false;
      }
    }

    /* shared beat — combo coordination comes from this one clock */
    S.beat += dt * S.speed;
    if (S.beat >= 1.45) {
      S.beat -= 1.45;
      onBeat();
    }

    /* packet physics: accelerate toward the core */
    for (let i = 0; i < count(); i += 1) {
      const f = FIL[i]!;
      const ti = S.tint[i]!;
      for (let k = 0; k < 3; k += 1) {
        const p = f.pk[k]!;
        if (!p.on) {
          continue;
        }
        if (p.delay > 0) {
          p.delay -= dt;
          continue;
        }
        p.u += dt * S.speed * (0.16 + 0.6 * p.u * p.u) * (0.55 + 0.65 * ti);
        if (p.u >= 1) {
          p.on = false;
          arrive(f, p);
        }
      }
    }
  }

  function onBeat(): void {
    const den = TEMPO[S.tempo].den;
    for (let i = 0; i < count(); i += 1) {
      if (!S.act[i] || S.tgt[i]! < 0.2) {
        continue;
      }
      if (Math.random() < den * (0.55 + 0.5 * S.tgt[i]!)) {
        spawn(FIL[i]!, i * 0.04, 0.7 + Math.random() * 0.6);
      }
    }
  }
  function spawn(f: Filament, delay: number, w: number): void {
    for (let k = 0; k < 3; k += 1) {
      const p = f.pk[k]!;
      if (!p.on) {
        p.on = true;
        p.u = 0;
        p.w = w;
        p.delay = delay;
        return;
      }
    }
  }
  function arrive(f: Filament, p: { w: number }): void {
    const combo = 1 + 0.05 * (activeCount() - 1);
    fireWave(f.wx, f.wy, f.wz, (0.35 + p.w * 0.55) * combo);
    fireDent(f.wx, f.wy, f.wz, 0.4 + p.w * 0.5);
    for (let k = 0; k < FLASH.length; k += 1) {
      const fl = FLASH[k]!;
      if (!fl.on) {
        fl.on = true;
        fl.age = 0;
        fl.x = f.ax;
        fl.y = f.ay;
        break;
      }
    }
    S.kick = Math.min(0.6, S.kick + 0.07 * p.w);
    S.req += 1;
  }

  /* ============================================================
     RENDER SUBSYSTEMS
     ============================================================ */
  const P1 = { x: 0, y: 0 };
  const P2 = { x: 0, y: 0 };
  function ptOnRing(
    ph: number,
    rad: number,
    cS: number,
    sS: number,
    cT: number,
    sT: number,
    o: { x: number; y: number },
  ): void {
    const x = Math.cos(ph) * rad;
    const z = Math.sin(ph) * rad;
    o.x = cxr + (x * cS + z * sS);
    o.y = cyr + -(-x * sS + z * cS) * sT; /* rotY then rotX on (x,0,z) */
  }

  function ring(
    rad: number,
    tilt: number,
    spin: number,
    alpha: number,
    ticks: boolean,
  ): void {
    if (!ctx) {
      return;
    }
    const cT = Math.cos(tilt);
    const sT = Math.sin(tilt);
    const cS = Math.cos(spin);
    const sS = Math.sin(spin);
    ctx.strokeStyle = al(alpha);
    ctx.lineWidth = 1;
    ctx.beginPath();
    const SEG = 64;
    for (let i = 0; i <= SEG; i += 1) {
      ptOnRing((i / SEG) * TAU, rad, cS, sS, cT, sT, P1);
      if (i) {
        ctx.lineTo(P1.x, P1.y);
      } else {
        ctx.moveTo(P1.x, P1.y);
      }
    }
    ctx.stroke();
    if (ticks) {
      ctx.strokeStyle = al(alpha + 0.05);
      ctx.beginPath();
      for (let k = 0; k < 48; k += 1) {
        const ph = (k / 48) * TAU;
        const len = k % 4 === 0 ? rad * 0.035 : rad * 0.016;
        ptOnRing(ph, rad, cS, sS, cT, sT, P1);
        ptOnRing(ph, rad + len, cS, sS, cT, sT, P2);
        ctx.moveTo(P1.x, P1.y);
        ctx.lineTo(P2.x, P2.y);
      }
      ctx.stroke();
    }
  }

  function drawShell(
    sh: Shell,
    n: number,
    ry: number,
    tilt: number,
    rad: number,
    aMul: number,
    en: number,
    isMain: boolean,
  ): void {
    if (!ctx) {
      return;
    }
    const cR = Math.cos(ry);
    const sR = Math.sin(ry);
    const cT = Math.cos(tilt);
    const sT = Math.sin(tilt);
    const wobA = 0.02 + en * 0.022;
    const breath = 0.01 + en * 0.008;
    const bw = performance.now() * 0.0011 * S.speed;
    for (let i = 0; i < n; i += 1) {
      const x = sh.ux[i]!;
      const y = sh.uy[i]!;
      const z = sh.uz[i]!;
      const sd = sh.sd[i]!;
      const xr = x * cR + z * sR;
      const zr = -x * sR + z * cR; /* rotY */
      const yr = y * cT - zr * sT;
      const z2 = y * sT + zr * cT; /* rotX */
      const wob =
        Math.sin(yr * 8.5 + bw * 4.5 + sd * 6.283) * Math.cos(xr * 6.4 - bw * 3.0) * wobA;
      let rr = 1 + Math.sin(bw + sd * TAU) * breath + wob;
      let glow = 0;
      let push = 0;
      if (isMain) {
        for (let k = 0; k < 8; k += 1) {
          const w = WAVES[k]!;
          if (!w.on) {
            continue;
          }
          const d = 1 - (xr * w.x + yr * w.y + z2 * w.z);
          const g = Math.exp(-(d - w.q) * (d - w.q) * 38);
          if (g > 0.02) {
            push += g * w.amp * 0.1;
            glow += g * w.amp * 0.5;
          }
        }
        for (let k = 0; k < 6; k += 1) {
          const dn = DENTS[k]!;
          if (dn.age > 2) {
            continue;
          }
          const dd = 1 - (xr * dn.x + yr * dn.y + z2 * dn.z);
          const g = Math.exp(-dd * dd * 60) * Math.exp(-dn.age * 2.2);
          if (g > 0.02) {
            push -= g * dn.amp * 0.14;
            glow += g * dn.amp * 0.3;
          }
        }
      }
      rr *= 1 + push;
      const z01 = (z2 + 1) * 0.5;
      let rb = false;
      if (isMain) {
        const rA = Math.abs(yr - 0.22 * Math.sin(xr * 3.2 + bw * 4));
        const rB = Math.abs(xr + 0.34 * Math.sin(yr * 3.8 - bw * 2.9));
        rb = rA < 0.055 || rB < 0.045;
      }
      const a = (0.1 + z01 * 0.64) * aMul * (rb ? 1.35 : 0.78) + glow * 0.35 + (rb ? en * 0.1 : 0);
      const sz = (rb ? 1.6 : 0.85) + z01 * 1.1 + en * 0.25 + glow * 0.8;
      ctx.fillStyle = al(a);
      ctx.beginPath();
      ctx.arc(cxr + xr * rr * rad, cyr + yr * rr * rad, sz, 0, TAU);
      ctx.fill();
    }
  }

  function drawHeart(t: number, en: number): void {
    if (!ctx) {
      return;
    }
    const pul = 1 + 0.05 * Math.sin(t * 0.003) + S.kick * 0.08;
    const rad = RAD * 0.17 * pul;
    const ry = t * 0.0005 * S.speed;
    const cR = Math.cos(ry);
    const sR = Math.sin(ry);
    for (let i = 0; i < HN; i += 1) {
      const x = HX[i]!;
      const z = HZ[i]!;
      const xr = x * cR + z * sR;
      const zr = -x * sR + z * cR;
      const z01 = (zr + 1) * 0.5;
      ctx.fillStyle = al(0.08 + z01 * 0.2 + en * 0.06);
      ctx.beginPath();
      ctx.arc(cxr + xr * rad, cyr + HY[i]! * rad, 0.7 + z01 * 0.9, 0, TAU);
      ctx.fill();
    }
  }

  function drawBrush(t: number, en: number, combo: boolean): void {
    if (!ctx) {
      return;
    }
    ctx.save();
    ctx.translate(cxr, cyr);
    const rot = Math.sin(t * 0.00035 * S.speed) * 0.18;
    ctx.rotate(rot);
    ctx.strokeStyle = al(0.14 + en * 0.2);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = -28; i <= 28; i += 1) {
      const x = (i / 28) * RAD * 0.88;
      const y = Math.sin(i * 0.56 + t * 0.0038 * S.speed) * 3.4 * (1 - Math.abs(i) / 34);
      if (i === -28) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    if (combo) {
      ctx.rotate(-rot * 2);
      ctx.strokeStyle = al(0.07 + en * 0.1);
      ctx.beginPath();
      for (let i = -24; i <= 24; i += 1) {
        const x = (i / 24) * RAD * 0.8;
        const y = Math.cos(i * 0.63 - t * 0.0031 * S.speed) * 2.6 * (1 - Math.abs(i) / 30);
        if (i === -24) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawCluster(
    f: Filament,
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    head: number,
    w: number,
    t: number,
  ): void {
    if (!ctx) {
      return;
    }
    const inten = S.tint[f.i]!;
    const en = S.energy;
    for (let k = 0; k < 9; k += 1) {
      const uu = head - (0.05 + 0.05 * w) * (k / 8);
      if (uu <= 0) {
        break;
      }
      const fade = 1 - k / 8;
      const bx = bezP(f.ex, c1x, c2x, f.ax, uu);
      const by = bezP(f.ey, c1y, c2y, f.ay, uu);
      tanAt(f.ex, f.ey, c1x, c1y, c2x, c2y, f.ax, f.ay, uu);
      const wig = Math.sin(uu * 22 + t * 0.006 + f.ph) * 1.6 * inten;
      const px = bx + TK.nx * wig;
      const py = by + TK.ny * wig;
      const sz = Math.max(0.4, (0.8 + fade * 1.5 + w * 0.5) * inten + en * 0.3);
      const a = Math.min(1, fade * (0.2 + 0.45 * inten) * w);
      if (k === 0 && q < 1) {
        /* soft halo — replaces shadowBlur */
        ctx.fillStyle = al(a * 0.22);
        ctx.beginPath();
        ctx.arc(px, py, sz * 2.6, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = al(a);
      ctx.beginPath();
      ctx.arc(px, py, sz, 0, TAU);
      ctx.fill();
    }
  }

  /**
   * Filament draw budget.
   *
   * Braided strands are the most expensive per-provider work, so past the approved
   * count the strand detail drops before anything else does. Every provider still
   * gets a filament and a packet: only the residue braiding thins out.
   */
  function braidBudget(): number {
    const n = count();
    if (n <= 5) {
      return 3;
    }
    if (n <= 12) {
      return 2;
    }
    return 1;
  }

  function drawFilaments(t: number, still: boolean): void {
    if (!ctx) {
      return;
    }
    for (let i = 0; i < count(); i += 1) {
      const f = FIL[i]!;
      const inten = S.tint[i]!;
      const on = S.act[i]!;
      const L = Math.hypot(f.ax - f.ex, f.ay - f.ey) || 1;
      const bend =
        f.bend * (12 + i * 3) * (1 + 0.18 * Math.sin(t * 0.0004 + f.ph)) * (0.6 + inten * 0.6);
      const nx = -f.dy;
      const ny = f.dx;
      const c1x = f.ex + f.dx * L * 0.4 + nx * bend;
      const c1y = f.ey + f.dy * L * 0.4 + ny * bend;
      const c2x = f.ax - f.dx * L * 0.34 - nx * bend * 0.55;
      const c2y = f.ay - f.dy * L * 0.34 - ny * bend * 0.55;

      /* ghost route */
      ctx.strokeStyle = al(on ? 0.045 + inten * 0.075 : 0.03);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(f.ex, f.ey);
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, f.ax, f.ay);
      ctx.stroke();

      if (on && inten > 0.02 && q < 2) {
        /* braided residue strands */
        const strands = Math.min(braidBudget(), q >= 1 ? 2 : 3);
        const SEG = 16;
        for (let s = 0; s < strands; s += 1) {
          const off = (s - (strands - 1) / 2) * 2.5;
          ctx.strokeStyle = al((s === 1 ? 0.1 : 0.055) * inten);
          ctx.beginPath();
          for (let k = 0; k <= SEG; k += 1) {
            const u = k / SEG;
            const bx = bezP(f.ex, c1x, c2x, f.ax, u);
            const by = bezP(f.ey, c1y, c2y, f.ay, u);
            tanAt(f.ex, f.ey, c1x, c1y, c2x, c2y, f.ax, f.ay, u);
            const spr = off * (0.35 + 0.65 * Math.sin(Math.PI * u));
            const brd =
              Math.sin(u * 16 + t * 0.004 * S.speed + f.ph + s * 2.1) *
              (2.6 * inten + S.energy * 1.5);
            const px = bx + TK.nx * (spr + brd);
            const py = by + TK.ny * (spr + brd);
            if (k) {
              ctx.lineTo(px, py);
            } else {
              ctx.moveTo(px, py);
            }
          }
          ctx.stroke();
        }
      }

      if (still) {
        if (on && S.tgt[i]! > 0.5) {
          drawCluster(f, c1x, c1y, c2x, c2y, 0.34, 1.0, t);
          drawCluster(f, c1x, c1y, c2x, c2y, 0.7, 0.75, t);
        }
      } else {
        for (let k = 0; k < 3; k += 1) {
          const p = f.pk[k]!;
          if (p.on && p.delay <= 0) {
            drawCluster(f, c1x, c1y, c2x, c2y, p.u, p.w, t);
          }
        }
      }
    }
    /* rim flashes on impact */
    for (let k = 0; k < FLASH.length; k += 1) {
      const fl = FLASH[k]!;
      if (!fl.on) {
        continue;
      }
      ctx.strokeStyle = al(0.4 * (1 - fl.age * 2));
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(fl.x, fl.y, 4 + fl.age * 90, 0, TAU);
      ctx.stroke();
    }
  }

  function drawSparks(t: number, en: number): void {
    if (!ctx) {
      return;
    }
    let n = Math.min(8, Math.floor(4 + en * 4));
    if (q >= 2) {
      n = 3;
    }
    for (let s = 0; s < n; s += 1) {
      const a = t * 0.0005 * (s % 2 ? 1 : -1) + s * 1.43;
      const rr = RAD * (1.03 + Math.sin(t * 0.002 + s) * 0.02);
      ctx.fillStyle = al(0.2 + en * 0.18);
      ctx.beginPath();
      ctx.arc(cxr + Math.cos(a) * rr, cyr + Math.sin(a) * rr * 0.98, 1 + (s % 3) * 0.3, 0, TAU);
      ctx.fill();
    }
  }

  /* ---------- adaptive quality ---------- */
  let q = 0;
  let heat = 0;
  let cold = 0;
  let ema = 16;
  function adapt(dtMs: number): void {
    ema = ema * 0.95 + dtMs * 0.05;
    if (ema > 27) {
      heat += 1;
      cold = 0;
      if (heat > 45 && q < 2) {
        q += 1;
        heat = 0;
      }
    } else if (ema < 15) {
      cold += 1;
      heat = 0;
      if (cold > 600 && q > 0) {
        q -= 1;
        cold = 0;
      }
    } else {
      heat = 0;
      cold = 0;
    }
  }

  /* ---------- frame ---------- */
  function render(now: number, still: boolean): void {
    if (!ctx) {
      return;
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#040404";
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter";

    const t = now;
    const en = S.energy;
    const sp = S.speed;
    const combo = activeCount() >= 2;

    ring(RAD * 1.1, 0.42 + 0.1 * Math.sin(t * 0.00007), t * 0.00011 * sp, 0.12 + en * 0.05, true);
    ring(RAD * 1.21, -0.3 + 0.08 * Math.cos(t * 0.00006), -t * 0.00008 * sp, 0.08 + en * 0.04, false);

    let nIn = mobile ? 170 : 280;
    if (q >= 2) {
      nIn = 0;
    }
    if (nIn) {
      drawShell(SH_IN, nIn, -t * 0.00021 * sp, -0.16 + 0.05 * Math.sin(t * 0.00017), RAD * 0.58, 0.55, en, false);
    }

    drawHeart(t, en);

    let nOut = mobile ? 430 : 720;
    if (q === 1) {
      nOut = (nOut * 0.65) | 0;
    }
    if (q >= 2) {
      nOut = (nOut * 0.45) | 0;
    }
    drawShell(SH_OUT, nOut, t * 0.0003 * sp, 0.22 * Math.sin(t * 0.00013), RAD, 1, en, true);

    drawBrush(t, en, combo);
    drawFilaments(t, still);
    drawSparks(t, en);
  }

  let rafId = 0;
  let lastT = performance.now();
  let lastDom = 0;
  let effPaused = false;
  let destroyed = false;

  function loop(now: number): void {
    if (destroyed) {
      return;
    }
    rafId = requestAnimationFrame(loop);
    let dt = (now - lastT) / 1000;
    lastT = now;
    if (dt > 0.1) {
      dt = 0.1;
    }
    adapt(dt * 1000);
    step(clamp(dt, 0.001, 0.1));
    render(now, false);
    // Throttled: state leaves the engine roughly three times a second, never per frame.
    if (now - lastDom > 320) {
      lastDom = now;
      emitSync();
    }
  }
  function halt(): void {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }
  function run(): void {
    if (destroyed || S.reduced || effPaused) {
      return;
    }
    halt();
    lastT = performance.now();
    rafId = requestAnimationFrame(loop);
  }
  function renderStill(): void {
    if (W) {
      render(21000, true);
    }
  }
  function poke(): void {
    if (S.reduced) {
      renderStill();
      emitSync();
    }
  }

  function emitSync(): void {
    const n = activeCount();
    const load = Math.round(clamp(16 + S.energy * 55 + n * 4 + S.surge * 10, 8, 97));
    const shares: number[] = [];
    for (let i = 0; i < count(); i += 1) {
      shares.push(shareOf(i));
    }
    options.onSync?.({
      activeCount: n,
      routedRequests: S.req,
      loadPercent: load,
      tempo: S.tempo,
      drilling: S.drill !== null,
      shares,
    });
  }

  /* ---------- drill timers, tracked so they can be cleared ---------- */
  const timers = new Set<ReturnType<typeof setTimeout>>();
  function later(fn: () => void, ms: number): void {
    const id = setTimeout(() => {
      timers.delete(id);
      if (!destroyed) {
        fn();
      }
    }, ms);
    timers.add(id);
  }

  function setChip(i: number, state: FluxProviderState): void {
    options.onChipState?.(i, state);
    poke();
  }

  function firstActive(): number {
    for (let i = 0; i < count(); i += 1) {
      if (S.act[i] && S.tgt[i]! > 0.5) {
        return i;
      }
    }
    return -1;
  }
  function pickAlt(prim: number): number {
    for (let k = 1; k <= 4; k += 1) {
      const j = (prim + k) % count();
      if (S.act[j] && S.tgt[j]! > 0.5) {
        return j;
      }
    }
    for (let k = 1; k <= 4; k += 1) {
      const j = (prim + k) % count();
      if (j !== prim) {
        return j;
      }
    }
    return -1;
  }

  const engine: FluxEngine = {
    layout,

    start(): void {
      if (S.reduced) {
        renderStill();
        emitSync();
        return;
      }
      run();
    },

    stop(): void {
      halt();
    },

    destroy(): void {
      destroyed = true;
      halt();
      for (const id of timers) {
        clearTimeout(id);
      }
      timers.clear();
    },

    setTempo(tempo: FluxTempo): void {
      S.tempo = tempo;
      if (tempo === "surge") {
        S.surge = Math.max(S.surge, 0.8);
      }
      emitSync();
      poke();
    },
    tempo: () => S.tempo,

    setActiveCount(n: number): void {
      // Bounded 1..5 by construction: the visualization has five positions and a
      // relay with zero providers is not a state the approved design expresses.
      const target = clamp(Math.round(n), 1, count());
      for (let i = 0; i < count(); i += 1) {
        const on = i < target;
        if (S.act[i] !== on) {
          S.act[i] = on;
          S.tgt[i] = on ? 1 : 0;
          setChip(i, on ? "active" : "off");
          if (!on) {
            options.onActivity?.(FLUX_NAMES[i]!, "provider disabled");
          }
        }
      }
      emitSync();
      poke();
    },

    toggleProvider(index: number): "enabled" | "disabled" | "denied" {
      if (index < 0 || index >= count()) {
        return "denied";
      }
      if (!S.act[index]) {
        S.act[index] = true;
        S.tgt[index] = 1;
        setChip(index, "recovering");
        options.onActivity?.(FLUX_NAMES[index]!, "provider enabled");
        emitSync();
        return "enabled";
      }
      if (activeCount() <= 1) {
        // The last active provider cannot be removed: the count stays >= 1.
        return "denied";
      }
      S.act[index] = false;
      S.tgt[index] = 0;
      setChip(index, "off");
      options.onActivity?.(FLUX_NAMES[index]!, "provider disabled / route draining");
      emitSync();
      return "disabled";
    },

    isActive: (index: number) => S.act[index] ?? false,
    activeCount,

    setPaused(paused: boolean): void {
      effPaused = paused;
      if (paused) {
        halt();
      } else {
        run();
      }
    },
    paused: () => effPaused,

    setReducedMotion(reduced: boolean): void {
      S.reduced = reduced;
      if (reduced) {
        halt();
        renderStill();
        emitSync();
      } else {
        run();
      }
    },
    reducedMotion: () => S.reduced,

    startDrill(): boolean {
      if (S.drill) {
        return false;
      }
      const prim = firstActive();
      if (prim < 0) {
        return false;
      }
      S.drill = { prim, alt: -1, altWasOff: false };
      S.tgt[prim] = 0.12;
      setChip(prim, "degraded");
      S.surge = Math.max(S.surge, 0.7);
      options.onActivity?.(FLUX_NAMES[prim]!, "route degraded / failover armed");
      emitSync();

      later(() => {
        if (!S.drill) {
          return;
        }
        const alt = pickAlt(prim);
        S.drill.alt = alt;
        S.drill.altWasOff = !S.act[alt];
        S.act[alt] = true;
        S.tgt[alt] = 1;
        setChip(alt, "recovering");
        options.onActivity?.(FLUX_NAMES[alt]!, "traffic rerouted / route active");
        emitSync();
      }, 900);

      later(() => {
        if (!S.drill) {
          return;
        }
        S.tgt[S.drill.prim] = 1;
        setChip(S.drill.prim, "active");
        options.onActivity?.(FLUX_NAMES[S.drill.prim]!, "recovered / restored to rotation");
        S.surge = Math.max(S.surge, 0.5);
        emitSync();
      }, 4300);

      later(() => {
        if (!S.drill) {
          return;
        }
        const alt = S.drill.alt;
        const wasOff = S.drill.altWasOff;
        if (wasOff && alt >= 0) {
          S.act[alt] = false;
          S.tgt[alt] = 0;
          setChip(alt, "off");
          options.onActivity?.(FLUX_NAMES[alt]!, "standby / reserve released");
        }
        S.drill = null;
        options.onDrillEnd?.();
        emitSync();
        poke();
      }, 7600);

      return true;
    },
    drilling: () => S.drill !== null,
    routedRequests: () => S.req,
    shareOf,

    setAnchors(anchors: FluxAnchor[]): void {
      ANCHORS = anchors;
      ensureCapacity(anchors.length);
      // Re-aim immediately so a view-model change is visible on the next frame
      // rather than waiting for a resize.
      layout();
      emitSync();
    },
    providerCount: count,

    poolSizes: () => ({
      waves: WAVES.length,
      dents: DENTS.length,
      flashes: FLASH.length,
      packetsPerFilament: 3,
    }),
  };

  return engine;
}
