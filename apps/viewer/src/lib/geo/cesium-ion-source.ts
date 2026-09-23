/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Build the IFC bytes pushed to Cesium Ion: the model re-serialized through
 * `StepExporter` with the user's pending edits baked in — NOT the raw
 * `dataStore.source`. Uploading the untouched source silently dropped every
 * in-viewer edit, most visibly the `CESIUM.Stage` tags written by
 * `SetStagePanel` (the whole point of the stage → Ion → StageTwin flow) and
 * georeferencing added/edited in the Properties panel.
 *
 * Mirrors the single-model STEP branch of `ExportDialog` (collab room
 * portable source, appearance cleanup, georef mutations, visibility filter,
 * schedule splice) so the Ion upload and a manual "Export IFC" of the same
 * model are the same file.
 *
 * Appearance image resources are NOT packaged: `ExportDialog` zips them into
 * an IFCZIP, which Ion's BIM/CAD tiler is not known to accept. The STEP text
 * itself is still complete; only authored texture images are left out.
 */

import { StepExporter } from '@ifc-lite/export';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { GeorefMutationData } from '@/store/slices/mutationSlice';
import { spliceScheduleIntoExport, type ExportScheduleState } from '@/sdk/adapters/export-schedule-splice';
import { prepareAppearanceSerialization } from '@/lib/appearance/serialization.js';
import { roomStepExportSource } from '@/lib/collab/room-step-export';
import { mapStepSchema } from '@/lib/export/artifact-naming.js';

export interface IonSourceInput {
  modelId: string;
  dataStore: IfcDataStore;
  mutationView?: MutablePropertyView;
  georefMutations?: GeorefMutationData;
  /** Drop hidden / non-isolated entities, like ExportDialog's "visible only". */
  visibleOnly: boolean;
  /** Local (per-model) ids; only read when `visibleOnly`. */
  hiddenEntityIds?: Set<number>;
  /** Local (per-model) allowlist, `null` = no isolation; only read when `visibleOnly`. */
  isolatedEntityIds?: Set<number> | null;
  /** Pass the store's schedule state; the splice itself decides whether this model owns it. */
  scheduleState: ExportScheduleState | null;
}

export interface IonSource {
  bytes: Uint8Array;
  entityCount: number;
  modifiedEntityCount: number;
}

/** Ion's BIM/CAD tiler ingests STEP IFC only — IFC5 (IFCX JSON) can't be pushed. */
export function isIonUploadableSchema(schemaVersion: string | undefined): boolean {
  return schemaVersion !== 'IFC5';
}

export async function buildIonSourceIfc(input: IonSourceInput): Promise<IonSource> {
  if (!isIonUploadableSchema(input.dataStore.schemaVersion)) {
    throw new Error('IFC5 (IFCX) models cannot be uploaded to Cesium Ion — its BIM/CAD tiler only reads STEP IFC.');
  }

  const portable = roomStepExportSource(input.dataStore, input.mutationView, input.modelId);
  const dataStore = portable?.dataStore ?? input.dataStore;
  const view = portable ? portable.mutationView : input.mutationView;
  const serialized = prepareAppearanceSerialization(input.modelId, dataStore, view);

  const hidden = input.visibleOnly ? input.hiddenEntityIds : undefined;
  const isolated = input.visibleOnly ? input.isolatedEntityIds : undefined;

  const result = await new StepExporter(dataStore, serialized.view).exportAsync({
    // Keep the source schema — Ion reads all three, so no conversion.
    schema: mapStepSchema(dataStore.schemaVersion ?? ''),
    includeGeometry: true,
    applyMutations: true,
    visibleOnly: input.visibleOnly,
    hiddenEntityIds: portable ? portable.toSourceIds(hidden) ?? undefined : hidden,
    isolatedEntityIds: portable ? portable.toSourceIds(isolated) : isolated,
    georefMutations: input.georefMutations,
    description: 'Exported from ifc-lite for Cesium Ion',
    application: 'ifc-lite',
  });

  const content = input.scheduleState
    ? spliceScheduleIntoExport(result, input.modelId, dataStore, input.scheduleState).content
    : result.content;

  return {
    bytes: typeof content === 'string' ? new TextEncoder().encode(content) : content,
    entityCount: result.stats.entityCount,
    modifiedEntityCount: result.stats.modifiedEntityCount,
  };
}
