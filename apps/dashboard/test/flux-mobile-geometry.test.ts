import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFluxEngine } from "../src/flux/engine";

/**
 * The mobile core geometry, measured through the real engine.
 *
 * `flux-sphere-sampling.test.ts` proves the *sampler* covers the sphere. That is necessary
 * and not sufficient: it exercises `spherePointIndex` in isolation, so it would still pass
 * if `drawShell` stopped calling it, if `layout()` computed the wrong radius on a narrow
 * viewport, or if the mobile branch picked a budget the sampler was never given. Every one
 * of those reproduces the reported bowl with a green sampler suite.
 *
 * So this drives `createFluxEngine` at a real phone-sized viewport, records the actual
 * `arc()` coordinates the engine asks the canvas for, and measures the point cloud that
 * comes out. It is the closest thing to looking at the picture that a host with no Canvas
 * 2D implementation can do.
 *
 * What it cannot do: judge how it *looks*. Point coverage is a geometric property; whether
 * the sphere reads as a sphere at 360px is a question for the device.
 */

type Arc = { x: number; y: number };

let arcs: Arc[] = [];
let getContextSpy: ReturnType<typeof vi.spyOn>;
let rafSpy: ReturnType<typeof vi.spyOn>;

/** A 2D context that records the geometry of every `arc()` and ignores the rest. */
function recordingContext(): CanvasRenderingContext2D {
  const noop = () => undefined;
  return {
    setTransform: noop,
    fillRect: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    bezierCurveTo: noop,
    arc: (x: number, y: number) => {
      arcs.push({ x, y });
    },
    fill: noop,
    stroke: noop,
    save: noop,
    restore: noop,
    translate: noop,
    rotate: noop,
    set fillStyle(_value: string) {},
    get fillStyle() {
      return "#000";
    },
    set strokeStyle(_value: string) {},
    get strokeStyle() {
      return "#000";
    },
    set lineWidth(_value: number) {},
    get lineWidth() {
      return 1;
    },
    set globalCompositeOperation(_value: string) {},
    get globalCompositeOperation() {
      return "source-over";
    },
  } as unknown as CanvasRenderingContext2D;
}

beforeEach(() => {
  arcs = [];
  getContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(() => recordingContext() as never);
  // The engine must never be left running between cases; each case renders exactly once.
  rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
});

afterEach(() => {
  getContextSpy.mockRestore();
  rafSpy.mockRestore();
  vi.restoreAllMocks();
});

/**
 * Render one still frame at a given viewport and return what was drawn.
 *
 * `reducedMotion: true` is what makes this deterministic: `start()` then takes the
 * `renderStill()` path — one `render()` call, no animation frames, no timers — rather than
 * entering the rAF loop. The geometry under test is the same in both paths; only the clock
 * differs.
 */
function renderAt(width: number, height: number): { arcs: Arc[]; cx: number; cy: number; rad: number } {
  const canvas = document.createElement("canvas");
  const wrap = document.createElement("div");
  // jsdom performs no layout, so the engine's only source of size is this rect.
  wrap.getBoundingClientRect = () =>
    ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0 }) as DOMRect;
  document.body.append(wrap, canvas);

  const engine = createFluxEngine({ canvas, wrap, chips: [], reducedMotion: true });
  engine.layout();
  engine.start();
  engine.destroy();

  const mobile = width < 640;
  return {
    arcs,
    cx: width / 2,
    cy: height / 2,
    // Mirrors `layout()`: the approved radius factors, 0.235 on mobile and 0.245 above it.
    rad: Math.min(width, height) * (mobile ? 0.235 : 0.245),
  };
}

/**
 * The **outer** shell's points only.
 *
 * The frame also draws a 110-point nucleus at `RAD * 0.17`, an inner shell at `RAD * 0.58`,
 * two rings beyond `RAD * 1.1`, a brush through the centre, and sparks. Selecting a tight
 * annulus around `RAD` isolates the outer Fibonacci shell, which is the surface that was
 * truncating.
 *
 * **The width of this annulus is load-bearing, and a mutation proved it.** The first version
 * accepted `0.45 * RAD` upward, which swept in the inner shell — and with the truncation
 * bug reintroduced, the inner shell's own points supplied the hemisphere the outer shell had
 * lost, so the extent assertion passed on a visibly bowl-shaped core. Only the symmetry
 * assertion caught it. Measuring one surface at a time is what makes both assertions mean
 * what they say.
 */
function shellPoints(frame: ReturnType<typeof renderAt>): Arc[] {
  return frame.arcs.filter((arc) => {
    const distance = Math.hypot(arc.x - frame.cx, arc.y - frame.cy);
    return distance > frame.rad * 0.82 && distance < frame.rad * 1.06;
  });
}

describe("mobile core geometry — the bowl, measured through the engine", () => {
  it("draws the southern hemisphere at a phone viewport", () => {
    /*
     * 360x420 is the shape the Usage panel's stage takes on a phone. Before the fix the
     * mobile branch drew a 430-point *prefix* of a 720-point pole-to-pole array, so the
     * lowest point rendered sat at y = -0.193 of the radius — above the equator. The core
     * was a cap, and on screen it read as a bowl.
     */
    const frame = renderAt(360, 420);
    const points = shellPoints(frame);
    expect(points.length, "no shell points were drawn at all").toBeGreaterThan(200);

    const lowest = Math.max(...points.map((p) => p.y));
    const highest = Math.min(...points.map((p) => p.y));
    // Both hemispheres, to within the wobble the approved animation applies (±0.02 rad plus
    // breathing) and the tilt the shell is drawn at.
    expect(
      lowest - frame.cy,
      "nothing was drawn below the equator: the core is still a cap",
    ).toBeGreaterThan(frame.rad * 0.75);
    expect(
      frame.cy - highest,
      "nothing was drawn above the equator",
    ).toBeGreaterThan(frame.rad * 0.75);
  });

  it("is vertically symmetric about the centre, not weighted to the top", () => {
    const frame = renderAt(360, 420);
    const points = shellPoints(frame);
    const above = points.filter((p) => p.y < frame.cy).length;
    const below = points.filter((p) => p.y > frame.cy).length;

    /*
     * The count, not just the extent. A truncation that left a handful of southern points
     * would satisfy the extent assertion above while still looking like a bowl, so the two
     * halves are required to be within 15% of each other. Measured before the fix: 100% / 0%
     * at the lowest quality level.
     */
    expect(below).toBeGreaterThan(0);
    const ratio = Math.min(above, below) / Math.max(above, below);
    expect(ratio, `${above} points above the equator, ${below} below`).toBeGreaterThan(0.85);
  });

  it("fills the same fraction of its viewport on a phone as on a desktop", () => {
    /*
     * The other half of "mobile core geometry": the sphere must not merely be whole, it must
     * occupy the stage. `RAD` is `min(W, H) * 0.235` on mobile against `0.245` above 640px —
     * so the *relative* size is within 5%, and a regression that shrank the mobile core into
     * a dot in a large box would show up here rather than being mistaken for the bowl.
     */
    const phone = renderAt(360, 420);
    const desktop = renderAt(1280, 720);

    const spread = (frame: ReturnType<typeof renderAt>): number => {
      const points = shellPoints(frame);
      const height = Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y));
      return height / frame.rad;
    };

    // Both should span very nearly the full diameter of their own radius.
    expect(spread(phone)).toBeGreaterThan(1.7);
    expect(spread(desktop)).toBeGreaterThan(1.7);
    expect(Math.abs(spread(phone) - spread(desktop))).toBeLessThan(0.25);
  });

  it("keeps every point inside the canvas at the narrowest supported width", () => {
    // 320px is the floor `body { min-width }` declares. A core that overflows it would give
    // the Usage screen a horizontal scrollbar on the smallest phone.
    const frame = renderAt(320, 380);
    const points = shellPoints(frame);
    expect(points.length).toBeGreaterThan(200);
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(320);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(380);
    }
  });

  it("draws the sphere through the sampler at every budget the engine uses", () => {
    /*
     * The lowest adaptive quality level was the worst case — a 193-point prefix, 26.7%
     * y-coverage, a shallow dish. Quality is chosen internally from a frame-time EMA, which
     * a single still frame cannot drive, so the budgets are pinned here against the ones
     * `render()` actually passes:
     *
     *   inner  mobile 170 / desktop 280, dropped entirely at q2
     *   outer  mobile 430 / desktop 720, x0.65 at q1, x0.45 at q2
     *
     * `flux-sphere-sampling.test.ts` enumerates exactly this list and proves the sampler
     * covers the sphere for each. This case is the join between the two: read from the
     * engine source, so changing a budget without updating the sampler's table fails here
     * rather than shipping an unmeasured quality level.
     */
    const engineSource = readFileSync(
      join(process.cwd(), existsSync(join(process.cwd(), "src")) ? "src" : "apps/dashboard/src", "flux", "engine.ts"),
      "utf8",
    );
    expect(engineSource).toContain("let nIn = mobile ? 170 : 280;");
    expect(engineSource).toContain("let nOut = mobile ? 430 : 720;");
    expect(engineSource).toContain("nOut = (nOut * 0.65) | 0;");
    expect(engineSource).toContain("nOut = (nOut * 0.45) | 0;");
    // And `drawShell` reaches its points through the sampler, never by the loop counter —
    // which is what makes every one of those budgets safe rather than only the default.
    expect(engineSource).toContain("const i = spherePointIndex(k, n, sh.ux.length);");
    expect(engineSource).not.toMatch(/const i = k;/);
  });
});
