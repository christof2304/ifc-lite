/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Colors every element carrying a Pset "CESIUM" / property "Stage" value —
 * one distinct color per distinct stage number, ascending — so a construction
 * stage tagged via `SetStagePanel` is visible immediately, without opening
 * the Lens panel.
 *
 * Reads property values through each model's live `MutablePropertyView` when
 * one exists, not `@/lib/lens/adapter`'s `createLensDataProvider`: that
 * provider reads only `ifcDataStore` and never sees an in-session mutation,
 * so a Stage value `SetStagePanel` just wrote (session-only until exported)
 * would be invisible to it until the file round-trips through export/import.
 * `MutablePropertyView.getPropertyValue` merges mutations over the base
 * table, so it sees both freshly-tagged and previously-exported values.
 *
 * Registers a standing layer in the P4 overlay-layer registry
 * (`overlaySlice.ts`) rather than writing the renderer channel directly:
 * `useOverlayCompositor` is mounted once by `ViewerLayout` for the whole
 * session and reconciles `overlayLayers` into the renderer on every change,
 * so a one-shot `registerOverlayLayer` call here keeps painting until the
 * layer is replaced or removed — no dedicated mount/subscription needed.
 */

import { useViewerStore, toGlobalIdFromModels } from '@/store';
import type { RGBA } from '@/store/slices/overlaySlice';
import { uniqueColor, hexToRgba } from '@ifc-lite/lens';

export const STAGE_COLOR_LAYER_ID = 'stage-colors';
/**
 * Same tier as the reserved 'lens' slot (background classification) — see
 * the priority convention documented on `OverlayLayer` in overlaySlice.ts.
 * Below animation (100) / gantt selection (200) / user isolation (300), so
 * a live 4D playback or an explicit isolation still wins on collision.
 */
const STAGE_COLOR_PRIORITY = 50;

const PSET_NAME = 'CESIUM';
const PROP_NAME = 'Stage';

/**
 * Recompute the stage → color map across every loaded model and (re)publish
 * it as an overlay layer. Call after any mutation that could change a
 * Stage value (currently: `SetStagePanel`'s Apply). Removes the layer
 * entirely when no element carries a Stage value, so an undo back to zero
 * doesn't leave a stale, empty layer registered.
 */
export function applyStageColorOverlay(): void {
  const store = useViewerStore.getState();
  const models = store.models;

  const stagesByModel: Array<{ modelId: string; stageByExpressId: Map<number, number> }> = [];
  const distinctStages = new Set<number>();

  for (const [modelId, model] of models) {
    const dataStore = model.ifcDataStore;
    if (!dataStore || !dataStore.entities) continue;
    const entities = dataStore.entities;

    const mutationView = store.getMutationView(modelId);
    const stageByExpressId = new Map<number, number>();

    for (let i = 0; i < entities.count; i++) {
      const expressId = entities.expressId[i];
      const raw = mutationView
        ? mutationView.getPropertyValue(expressId, PSET_NAME, PROP_NAME)
        : (dataStore.properties?.getPropertyValue(expressId, PSET_NAME, PROP_NAME) ?? null);
      if (raw === null || raw === undefined) continue;
      const stage = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
      if (Number.isNaN(stage)) continue;
      stageByExpressId.set(expressId, stage);
      distinctStages.add(stage);
    }

    if (stageByExpressId.size > 0) stagesByModel.push({ modelId, stageByExpressId });
  }

  if (distinctStages.size === 0) {
    store.removeOverlayLayer(STAGE_COLOR_LAYER_ID);
    return;
  }

  // Ascending stage number -> ascending color rank, so the assignment reads
  // as a progression rather than an arbitrary per-value hash.
  const sortedStages = Array.from(distinctStages).sort((a, b) => a - b);
  const colorByStage = new Map<number, RGBA>();
  sortedStages.forEach((stage, rank) => {
    colorByStage.set(stage, hexToRgba(uniqueColor(rank), 1) as RGBA);
  });

  const colorOverrides = new Map<number, RGBA>();
  for (const { modelId, stageByExpressId } of stagesByModel) {
    for (const [expressId, stage] of stageByExpressId) {
      const globalId = toGlobalIdFromModels(models, modelId, expressId);
      colorOverrides.set(globalId, colorByStage.get(stage)!);
    }
  }

  store.registerOverlayLayer({
    id: STAGE_COLOR_LAYER_ID,
    priority: STAGE_COLOR_PRIORITY,
    hiddenIds: null,
    colorOverrides,
  });
}
