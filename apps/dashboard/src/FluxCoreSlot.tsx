/**
 * Integration boundary for the approved BAYZ Flux Core V2 motion system.
 *
 * This is intentionally an empty, non-visual mount point. The Flux Core source is
 * supplied separately and is LOCKED: recreating, approximating, or standing in for
 * it from memory would produce a different animation wearing its name, which is
 * worse than an empty slot.
 *
 * To integrate, render the approved component inside this element. Nothing else in
 * the dashboard needs to change.
 */
export function FluxCoreSlot() {
  return <div className="bayz-flux-core-slot" data-bayz-flux-core-slot="" aria-hidden="true" />;
}
