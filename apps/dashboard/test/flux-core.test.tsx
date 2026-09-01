import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FluxCoreSlot } from "../src/FluxCoreSlot";
import { FluxCore } from "../src/flux/FluxCore";
import { createFluxEngine } from "../src/flux/engine";
import type { FluxCoreViewModel } from "../src/flux/types";

/**
 * Flux Core V2 integration tests.
 *
 * jsdom has no Canvas 2D implementation and no ResizeObserver, so both are stubbed
 * here. That is deliberate: the engine must tolerate a hostile or absent host
 * environment, and the stubs let the React lifecycle be asserted without pulling in
 * the native `canvas` package as a new dependency.
 */

type ContextCall = { method: string };

let contextCalls: ContextCall[] = [];
let getContextSpy: ReturnType<typeof vi.spyOn>;
let rafSpy: ReturnType<typeof vi.spyOn>;
let cafSpy: ReturnType<typeof vi.spyOn>;
let observed: number;
let disconnected: number;
let mediaListeners: number;
let mediaRemoved: number;
let reducedMotion = false;

function stubContext(): CanvasRenderingContext2D {
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      contextCalls.push({ method });
      void args;
      return undefined;
    };
  return {
    setTransform: record("setTransform"),
    fillRect: record("fillRect"),
    beginPath: record("beginPath"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    bezierCurveTo: record("bezierCurveTo"),
    arc: record("arc"),
    fill: record("fill"),
    stroke: record("stroke"),
    save: record("save"),
    restore: record("restore"),
    translate: record("translate"),
    rotate: record("rotate"),
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
  contextCalls = [];
  observed = 0;
  disconnected = 0;
  mediaListeners = 0;
  mediaRemoved = 0;
  reducedMotion = false;

  getContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(() => stubContext() as never);

  class StubResizeObserver {
    observe(): void {
      observed += 1;
    }
    disconnect(): void {
      disconnected += 1;
    }
    unobserve(): void {}
  }
  vi.stubGlobal("ResizeObserver", StubResizeObserver);

  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("reduced-motion") ? reducedMotion : false,
    media: query,
    addEventListener: () => {
      mediaListeners += 1;
    },
    removeEventListener: () => {
      mediaRemoved += 1;
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  }));

  rafSpy = vi
    .spyOn(globalThis, "requestAnimationFrame")
    .mockImplementation(() => 1 as never);
  cafSpy = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() => {
  getContextSpy.mockRestore();
  rafSpy.mockRestore();
  cafSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe("FluxCoreSlot", () => {
  it("no longer renders empty", () => {
    const { container } = render(<FluxCoreSlot />);
    const slot = container.querySelector("[data-bayz-flux-core-slot]");
    expect(slot).not.toBeNull();
    expect(slot!.childElementCount).toBeGreaterThan(0);
  });

  it("mounts the approved relay canvas", () => {
    const { container } = render(<FluxCoreSlot />);
    expect(container.querySelector("canvas")).not.toBeNull();
    expect(container.querySelector(".relay-wrap")).not.toBeNull();
    expect(container.querySelector(".flux-vignette")).not.toBeNull();
  });

  it("keeps the approved core caption and drops the decorative legend", () => {
    render(<FluxCoreSlot />);
    /*
     * The caption is the routing mode plus real counts, which is what the approved core
     * copy carried once the branding was removed: it used to read `BAYZ` over
     * `COMBO ROUTING` over `5 PROVIDERS / ROUTED n`.
     *
     * The legend went with it — `01 / SOURCE`, `02 / HANDOFF`, `03 / IMPACT` over
     * "Provider route", "Braided traffic", "Packet into core" were numbered captions
     * naming parts of an animation, which is decoration explaining decoration. Its absence
     * is asserted here rather than only in the copy contract, so the two agree.
     */
    expect(screen.getByText("Combo")).toBeInTheDocument();
    expect(screen.getByText(/routing \/ \d+ requests/)).toBeInTheDocument();
    expect(screen.queryByText(/01 \/ SOURCE/)).toBeNull();
    expect(screen.queryByText(/02 \/ HANDOFF/)).toBeNull();
    expect(screen.queryByText(/03 \/ IMPACT/)).toBeNull();
    expect(screen.queryByText("BAYZ")).toBeNull();
  });
});

describe("Flux Core structure preserved from the approved source", () => {
  it("keeps the five provider chips at their approved positions", () => {
    const { container } = render(<FluxCore />);
    for (const cls of ["p1", "p2", "p3", "p4", "p5"]) {
      expect(container.querySelector(`.provider.${cls}`)).not.toBeNull();
    }
    expect(container.querySelectorAll(".provider")).toHaveLength(5);
  });

  it("keeps the approved default provider labels and shares", () => {
    render(<FluxCore />);
    for (const name of ["OPENROUTER", "GEMINI", "CODEX", "TABITOKEN", "CUSTOM"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
  });

  it("keeps the Calm / Live / Surge tempo semantics with Live default", () => {
    render(<FluxCore />);
    const calm = screen.getByRole("button", { name: "Calm" });
    const live = screen.getByRole("button", { name: "Live" });
    const surge = screen.getByRole("button", { name: "Surge" });
    expect(live).toHaveAttribute("aria-pressed", "true");
    expect(calm).toHaveAttribute("aria-pressed", "false");
    expect(surge).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(surge);
    expect(surge).toHaveAttribute("aria-pressed", "true");
    expect(live).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps the failover drill and pause controls", () => {
    render(<FluxCore />);
    expect(screen.getByRole("button", { name: /failover drill/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();
  });
});

describe("provider count control", () => {
  it("offers exactly the approved 1..5 buttons", () => {
    render(<FluxCore />);
    for (const n of ["1", "2", "3", "4", "5"]) {
      expect(screen.getByRole("button", { name: n })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "0" })).toBeNull();
    expect(screen.queryByRole("button", { name: "6" })).toBeNull();
  });

  it("stays bounded between 1 and 5 active providers", () => {
    const { container } = render(<FluxCore />);
    const activeCount = (): number =>
      container.querySelectorAll('.provider[data-state="active"]').length;

    expect(activeCount()).toBe(5);

    fireEvent.click(screen.getByRole("button", { name: "1" }));
    expect(activeCount()).toBe(1);

    // Disabling the last remaining provider must be refused, never reaching zero.
    const remaining = container.querySelector('.provider[data-state="active"]');
    fireEvent.click(remaining!);
    expect(activeCount()).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "5" }));
    expect(activeCount()).toBe(5);
  });

  it("switches the routing mode word with the active count", async () => {
    render(<FluxCore />);
    // Sentence case since the copy pass: the mode is real state, the shouting was not.
    expect(await screen.findByText("Combo")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "1" }));
    await waitFor(() => expect(screen.getByText("Direct")).toBeInTheDocument());
  });
});

describe("lifecycle cleanup", () => {
  it("cancels the animation frame and disconnects the observer on unmount", () => {
    const { unmount } = render(<FluxCore />);
    expect(observed).toBe(1);
    expect(rafSpy).toHaveBeenCalled();

    unmount();
    expect(cafSpy).toHaveBeenCalled();
    expect(disconnected).toBe(1);
  });

  it("removes the matchMedia listener on unmount", () => {
    const { unmount } = render(<FluxCore />);
    expect(mediaListeners).toBeGreaterThanOrEqual(1);
    unmount();
    expect(mediaRemoved).toBe(mediaListeners);
  });

  it("removes the visibility listener on unmount", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const { unmount } = render(<FluxCore />);
    const added = add.mock.calls.filter(([type]) => type === "visibilitychange").length;
    expect(added).toBe(1);

    unmount();
    const removed = remove.mock.calls.filter(([type]) => type === "visibilitychange").length;
    expect(removed).toBe(1);
    add.mockRestore();
    remove.mockRestore();
  });

  it("clears every timer on unmount", () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const { unmount } = render(<FluxCore />);

    // Start a drill so its staged timers exist at unmount time.
    fireEvent.click(screen.getByRole("button", { name: /failover drill/i }));
    unmount();

    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  it("does not duplicate loops or listeners across remount", () => {
    const first = render(<FluxCore />);
    first.unmount();
    expect(disconnected).toBe(1);

    const second = render(<FluxCore />);
    expect(observed).toBe(2);
    second.unmount();
    expect(disconnected).toBe(2);
  });
});

describe("pause and resume", () => {
  it("halts and restarts the loop through the pause control", () => {
    render(<FluxCore />);
    const button = screen.getByRole("button", { name: /pause/i });
    expect(button).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(button);
    expect(screen.getByRole("button", { name: /resume/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(cafSpy).toHaveBeenCalled();

    const before = rafSpy.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /resume/i }));
    expect(rafSpy.mock.calls.length).toBeGreaterThan(before);
  });
});

describe("reduced motion", () => {
  it("renders a still frame and disables pause when motion is reduced", () => {
    reducedMotion = true;
    render(<FluxCore />);

    // A still frame is painted, but no animation loop is scheduled.
    expect(contextCalls.some((call) => call.method === "fillRect")).toBe(true);
    expect(rafSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /pause/i })).toBeDisabled();
  });
});

describe("untrusted display data", () => {
  // Short enough to survive the compact-label cap, so this test measures
  // inertness rather than truncation. A dedicated test covers truncation.
  const HOSTILE = "<img src=x onerror=z>";

  const model: FluxCoreViewModel = {
    source: "live",
    providers: [
      { id: "p1", displayName: HOSTILE, state: "active", sharePercent: 40 },
      { id: "p2", displayName: "<script>x=1</script>", state: "degraded", sharePercent: 60 },
    ],
    routedRequests: 7,
    activity: [
      { id: "a1", label: HOSTILE, message: HOSTILE },
      { id: "a2", label: "CORE", message: "<b>bold</b>" },
    ],
  };

  it("renders a hostile provider label as inert text", async () => {
    const { container } = render(<FluxCore model={model} />);
    await screen.findAllByText(HOSTILE);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect((window as unknown as Record<string, unknown>).__fluxXss).toBeUndefined();
  });

  it("renders a hostile activity event as inert text", async () => {
    const { container } = render(<FluxCore model={model} />);
    await screen.findAllByText(HOSTILE);
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect((window as unknown as Record<string, unknown>).__fluxXss).toBeUndefined();
  });

  it("renders every provider rather than capping the list", () => {
    const many: FluxCoreViewModel = {
      source: "live",
      providers: Array.from({ length: 12 }, (_unused, index) => ({
        id: `p${index}`,
        displayName: `PROVIDER-${index}`,
        state: "active" as const,
        sharePercent: 8,
      })),
    };
    const { container } = render(<FluxCore model={many} />);
    // Scalability requirement: nodes are never truncated, only labels reduce.
    expect(container.querySelectorAll(".provider")).toHaveLength(12);
  });

  it("tolerates an empty provider list without crashing", () => {
    const { container } = render(
      <FluxCore model={{ source: "live", providers: [] }} />,
    );
    expect(container.querySelector("canvas")).not.toBeNull();
  });

  it("marks a simulated view model explicitly", () => {
    const { container } = render(<FluxCore />);
    /*
     * `Simulated`, not `SIM`. The badge is the one thing on this panel that must not be
     * softened away — a simulation presented as measurement is the only dishonesty the
     * visualization could commit — but the shouted three-letter form was jargon, and the
     * copy contract bans it.
     *
     * Asserted on the panel head's own meta line rather than by text search: the activity
     * subhead legitimately says `Simulated events` too, so a document-wide query matches
     * twice and cannot tell which one is the source badge.
     */
    const meta = container.querySelector(".panel-head .panel-meta");
    expect(meta?.textContent).toBe("Simulated");
    expect(screen.queryByText(/\bSIM\b/)).toBeNull();
  });
});

describe("engine contract", () => {
  it("tolerates a host with no 2D context rather than throwing", () => {
    getContextSpy.mockImplementation(() => null as never);
    const canvas = document.createElement("canvas");
    const wrap = document.createElement("div");
    const engine = createFluxEngine({ canvas, wrap, chips: [] });
    expect(() => engine.start()).not.toThrow();
    expect(() => engine.destroy()).not.toThrow();
  });

  it("caps the device pixel ratio at 2", () => {
    const original = window.devicePixelRatio;
    Object.defineProperty(window, "devicePixelRatio", { value: 8, configurable: true });
    const canvas = document.createElement("canvas");
    const wrap = document.createElement("div");
    Object.defineProperty(wrap, "getBoundingClientRect", {
      value: () => ({ width: 100, height: 100, left: 0, top: 0, right: 100, bottom: 100 }),
    });
    const engine = createFluxEngine({ canvas, wrap, chips: [] });
    engine.layout();
    expect(canvas.width).toBeLessThanOrEqual(200);
    engine.destroy();
    Object.defineProperty(window, "devicePixelRatio", {
      value: original,
      configurable: true,
    });
  });

  it("keeps the approved bounded pool sizes", () => {
    const canvas = document.createElement("canvas");
    const wrap = document.createElement("div");
    const engine = createFluxEngine({ canvas, wrap, chips: [] });
    const pools = engine.poolSizes();
    expect(pools).toEqual({ waves: 8, dents: 6, flashes: 6, packetsPerFilament: 3 });
    engine.destroy();
  });

  it("never lets the active provider count leave 1..5", () => {
    const canvas = document.createElement("canvas");
    const wrap = document.createElement("div");
    const engine = createFluxEngine({ canvas, wrap, chips: [] });

    engine.setActiveCount(0);
    expect(engine.activeCount()).toBe(1);
    engine.setActiveCount(99);
    expect(engine.activeCount()).toBe(5);
    engine.setActiveCount(3);
    expect(engine.activeCount()).toBe(3);
    engine.destroy();
  });
});
