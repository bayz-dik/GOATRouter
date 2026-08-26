import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

// Vitest is not run with `globals: true`, so Testing Library's automatic
// afterEach cleanup is never registered. Without this, DOM from one test leaks
// into the next and role queries start matching duplicated elements.
afterEach(() => {
  cleanup();
});

/*
 * jsdom implements neither ResizeObserver nor Canvas 2D. Flux Core needs both, and
 * pulling in the native `canvas` package would add a dependency with a compiler
 * requirement that the Termux/ARM64 baseline explicitly rules out. These are
 * inert defaults so any test that renders the dashboard shell works; the Flux Core
 * suite installs its own recording stubs on top when it needs to observe calls.
 */
if (typeof globalThis.ResizeObserver === "undefined") {
  class NoopResizeObserver implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
}

if (typeof HTMLCanvasElement !== "undefined") {
  const noop = (): void => {};
  const stub2d = (): CanvasRenderingContext2D =>
    ({
      setTransform: noop,
      fillRect: noop,
      beginPath: noop,
      moveTo: noop,
      lineTo: noop,
      bezierCurveTo: noop,
      arc: noop,
      fill: noop,
      stroke: noop,
      save: noop,
      restore: noop,
      translate: noop,
      rotate: noop,
      fillStyle: "#000",
      strokeStyle: "#000",
      lineWidth: 1,
      globalCompositeOperation: "source-over",
    }) as unknown as CanvasRenderingContext2D;

  HTMLCanvasElement.prototype.getContext = function getContext(
    this: HTMLCanvasElement,
    contextId: string,
  ): RenderingContext | null {
    return contextId === "2d" ? stub2d() : null;
  } as HTMLCanvasElement["getContext"];
}
