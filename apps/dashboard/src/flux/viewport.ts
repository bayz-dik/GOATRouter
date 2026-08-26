/**
 * Viewport for the zoomable, pannable provider field.
 *
 * Pure functions over a plain `{ zoom, x, y }` record so the maths is testable
 * without a DOM, and so the animation loop can read the current viewport without
 * going through React state.
 *
 * Every operation clamps. The stated requirement is that an operator can never
 * permanently lose the Flux Core off-screen, so an invalid or absurd viewport is
 * repaired rather than propagated.
 */

export const ZOOM_MIN = 0.45;
export const ZOOM_MAX = 4;
/** Pan limit in device pixels, generous enough to explore, bounded enough to recover. */
export const PAN_LIMIT = 2000;

export type Viewport = {
  zoom: number;
  x: number;
  y: number;
};

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function createViewport(): Viewport {
  return { zoom: 1, x: 0, y: 0 };
}

export function resetViewport(): Viewport {
  return createViewport();
}

/** Repair any viewport into a usable one. */
export function clampViewport(viewport: Viewport): Viewport {
  const zoom = clamp(finite(viewport.zoom, 1), ZOOM_MIN, ZOOM_MAX);
  return {
    zoom,
    x: clamp(finite(viewport.x, 0), -PAN_LIMIT, PAN_LIMIT),
    y: clamp(finite(viewport.y, 0), -PAN_LIMIT, PAN_LIMIT),
  };
}

export function panBy(viewport: Viewport, dx: number, dy: number): Viewport {
  return clampViewport({
    zoom: viewport.zoom,
    x: viewport.x + finite(dx, 0),
    y: viewport.y + finite(dy, 0),
  });
}

/**
 * Zoom about a focal point, in viewport-local pixels relative to the centre.
 *
 * The focal point stays put, so a wheel zoom over a provider keeps that provider
 * under the cursor rather than sliding it away and forcing a corrective pan.
 */
export function zoomAt(
  viewport: Viewport,
  factor: number,
  focalX: number,
  focalY: number,
): Viewport {
  const safeFactor = finite(factor, 1);
  if (safeFactor <= 0) {
    return clampViewport(viewport);
  }
  const current = clampViewport(viewport);
  const next = clamp(current.zoom * safeFactor, ZOOM_MIN, ZOOM_MAX);
  const ratio = next / current.zoom;
  const fx = finite(focalX, 0);
  const fy = finite(focalY, 0);
  return clampViewport({
    zoom: next,
    x: fx - (fx - current.x) * ratio,
    y: fy - (fy - current.y) * ratio,
  });
}

/** Centre the viewport on a world point at the given zoom. */
export function focusOn(
  viewport: Viewport,
  worldX: number,
  worldY: number,
  zoom = 2.2,
): Viewport {
  const target = clamp(finite(zoom, 2.2), ZOOM_MIN, ZOOM_MAX);
  return clampViewport({
    zoom: target,
    x: -finite(worldX, 0) * target,
    y: -finite(worldY, 0) * target,
  });
}
