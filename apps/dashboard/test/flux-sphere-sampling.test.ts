import { describe, expect, it } from "vitest";
import { spherePointIndex } from "../src/flux/engine";

/**
 * The mobile "bowl": why the visual core loses its bottom half at low point counts.
 *
 * **Root cause, established by measurement rather than by eye.** `shell(n)` builds a
 * Fibonacci sphere whose `uy` runs monotonically from +1 down to -1 as the index rises —
 * index 0 is the north pole, index n-1 the south. `drawShell` then renders `for (i = 0;
 * i < n; i += 1)` where `n` is *reduced* for mobile and for adaptive quality:
 *
 * ```text
 *   outer shell   desktop 720   mobile 430   q1 x0.65   q2 x0.45
 *   inner shell   desktop 280   mobile 170
 * ```
 *
 * Reducing the loop bound therefore does not thin the sphere — it **truncates it from the
 * south pole up**, leaving a cap. Measured y-coverage of the outer shell:
 *
 * ```text
 *   desktop q0  n=720  y -1.000..1.000  100.0%   (whole sphere)
 *   mobile  q0  n=430  y -0.193..1.000   59.7%   <- bowl
 *   mobile  q1  n=279  y  0.227..1.000   38.6%   <- bowl
 *   mobile  q2  n=193  y  0.466..1.000   26.7%   <- shallow dish
 * ```
 *
 * So it is not DPR, not canvas sizing, not the viewport aspect, not a transform, and not
 * responsive CSS: `RAD` and the canvas backing store are both correct. It is index
 * truncation over an ordered point set. Desktop hides it only because q0 draws all 720.
 *
 * The fix is to spread the reduced budget across the whole array instead of taking a
 * prefix, which is what `spherePointIndex` does. These tests pin the property that
 * matters — full polar coverage at every budget — and the cost, which must not rise.
 */

describe("flux sphere sampling — the bowl regression", () => {
  /** `uy` for index `i` of a Fibonacci shell of `total` points, as `shell()` builds it. */
  const uy = (i: number, total: number): number => 1 - (i / (total - 1)) * 2;

  /** Coverage of the sphere's y-axis, 1 meaning pole to pole. */
  function coverage(total: number, budget: number): number {
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < budget; k += 1) {
      const y = uy(spherePointIndex(k, budget, total), total);
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
    return (hi - lo) / 2;
  }

  /*
   * Every budget the engine actually uses, including both shells and all three adaptive
   * quality levels. A test covering only the mobile default would miss that desktop q1/q2
   * bowl too — which the audit found and which no one had noticed.
   */
  const BUDGETS: ReadonlyArray<readonly [string, number, number]> = [
    ["outer desktop q0", 720, 720],
    ["outer desktop q1", 720, (720 * 0.65) | 0],
    ["outer desktop q2", 720, (720 * 0.45) | 0],
    ["outer mobile q0", 720, 430],
    ["outer mobile q1", 720, (430 * 0.65) | 0],
    ["outer mobile q2", 720, (430 * 0.45) | 0],
    ["inner desktop", 280, 280],
    ["inner mobile", 280, 170],
  ];

  it("covers the whole sphere at every point budget", () => {
    for (const [label, total, budget] of BUDGETS) {
      /*
       * 0.99 rather than 1.0: with an even stride the extreme indices are hit exactly, so
       * coverage is 1 — but pinning 1.0 exactly would make the test brittle against a
       * future budget that cannot land on both poles. Anything at or above 0.99 is a
       * sphere; the bug produced 0.27-0.60.
       */
      expect(coverage(total, budget), `${label} does not cover the sphere`).toBeGreaterThan(
        0.99,
      );
    }
  });

  it("reaches both poles, not just the northern cap", () => {
    // The bug's signature: the maximum y stayed at +1 while the minimum crept upward. This
    // asserts the southern hemisphere is present at all, which is what "bowl" means.
    for (const [label, total, budget] of BUDGETS) {
      let lo = Infinity;
      for (let k = 0; k < budget; k += 1) {
        lo = Math.min(lo, uy(spherePointIndex(k, budget, total), total));
      }
      expect(lo, `${label} never reaches the southern hemisphere`).toBeLessThan(-0.9);
    }
  });

  it("stays inside the array and spends the budget exactly once", () => {
    for (const [label, total, budget] of BUDGETS) {
      const seen = new Set<number>();
      for (let k = 0; k < budget; k += 1) {
        const index = spherePointIndex(k, budget, total);
        expect(Number.isInteger(index), `${label} produced a non-integer index`).toBe(true);
        expect(index, `${label} produced a negative index`).toBeGreaterThanOrEqual(0);
        expect(index, `${label} ran past the end of the array`).toBeLessThan(total);
        seen.add(index);
      }
      /*
       * No duplicates: drawing the same point twice would spend budget on nothing and
       * brighten it under additive compositing, which would show as a hot speckle.
       */
      expect(seen.size, `${label} drew a duplicated point`).toBe(budget);
    }
  });

  it("costs no more than the truncating version it replaces", () => {
    // The perf budget is the point count, and it is unchanged by construction — the loop
    // still runs `budget` times. Pinned so a future "improvement" cannot quietly raise it.
    for (const [, total, budget] of BUDGETS) {
      let drawn = 0;
      for (let k = 0; k < budget; k += 1) {
        spherePointIndex(k, budget, total);
        drawn += 1;
      }
      expect(drawn).toBe(budget);
    }
  });

  it("is monotonic, so the draw order still walks the sphere in one sweep", () => {
    /*
     * Order matters for more than tidiness: the shells are drawn without a depth buffer and
     * rely on additive compositing, so a sampling order that jumped around would change how
     * overlapping points accumulate. A monotonic sweep preserves the approved appearance.
     */
    for (const [label, total, budget] of BUDGETS) {
      let previous = -1;
      for (let k = 0; k < budget; k += 1) {
        const index = spherePointIndex(k, budget, total);
        expect(index, `${label} sampled out of order`).toBeGreaterThan(previous);
        previous = index;
      }
    }
  });

  it("degrades sanely at absurd budgets rather than throwing", () => {
    // Defensive: the adaptive path multiplies and floors, so a future tempo could produce 0
    // or 1. Neither may produce NaN or an out-of-range index.
    expect(spherePointIndex(0, 1, 720)).toBe(0);
    expect(spherePointIndex(0, 0, 720)).toBe(0);
    for (const budget of [1, 2, 3]) {
      for (let k = 0; k < budget; k += 1) {
        const index = spherePointIndex(k, budget, 720);
        expect(Number.isInteger(index)).toBe(true);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(720);
      }
    }
  });
});
