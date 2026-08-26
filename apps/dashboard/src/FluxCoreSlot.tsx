import { FluxCore } from "./flux/FluxCore";
import type { FluxCoreViewModel } from "./flux/types";

export type FluxCoreSlotProps = {
  /**
   * Display-safe usage view model. When omitted, Flux Core runs the approved
   * simulation and labels itself `SIM` on screen rather than presenting invented
   * numbers as measured telemetry.
   */
  model?: FluxCoreViewModel;
};

/**
 * Mount point for the approved BAYZ Flux Core V2 motion system.
 *
 * The wrapper is kept as the integration boundary — `data-bayz-flux-core-slot`
 * remains the anchor the rest of the dashboard and its tests rely on — while the
 * approved visualization now renders inside it.
 */
export function FluxCoreSlot({ model }: FluxCoreSlotProps) {
  return (
    <div className="bayz-flux-core-slot" data-bayz-flux-core-slot="">
      <FluxCore {...(model === undefined ? {} : { model })} />
    </div>
  );
}
