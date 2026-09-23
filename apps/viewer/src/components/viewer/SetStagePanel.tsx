/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Quick action: tag the current 3D selection with Pset "CESIUM" / property
 * "Stage" = <value>. UI counterpart to `scripts/tag-cesium-stage.js` — same
 * Pset/property convention, but scoped to a hand-picked selection instead of
 * every IfcElement, so it also covers the "assign per stage" step (select a
 * subset, set the stage number for that subset).
 */

import { useState, useCallback, useMemo } from 'react';
import { Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import { roleCanEdit } from '@/store/slices/collabSlice';
import { useIfc } from '@/hooks/useIfc';
import { configureMutationView } from '@/utils/configureMutationView';
import { fromGlobalIdFromModels } from '@/store/globalId';
import { PropertyValueType } from '@ifc-lite/data';
import { BulkQueryEngine, MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { applyStageColorOverlay } from './stageColorOverlay';

const PSET_NAME = 'CESIUM';
const PROP_NAME = 'Stage';

interface SetStagePanelProps {
  trigger?: React.ReactNode;
}

export function SetStagePanel({ trigger }: SetStagePanelProps) {
  const { models } = useIfc();
  // `selectedEntities` (EntityRef[]) is NOT the live click/box-select
  // selection — that's `selectedEntityIds` (legacy numeric global ids, see
  // useMouseControls.ts's rect-select and the raycast click handler). Resolve
  // each global id back to its owning model via the same helper the
  // renderer's own id<->model conversion uses.
  const selectedEntityIds = useViewerStore((s) => s.selectedEntityIds);
  // A plain single click (3D view OR Model Tree) sets only `selectedEntityId`
  // (singular) — `selectedEntityIds` (the Set) is populated exclusively by
  // rect/box-select. Both can be the live selection depending on how the
  // user picked, so both are read and unioned below.
  const selectedEntityId = useViewerStore((s) => s.selectedEntityId);
  const getMutationView = useViewerStore((s) => s.getMutationView);
  const registerMutationView = useViewerStore((s) => s.registerMutationView);
  const bumpMutationVersion = useViewerStore((s) => s.bumpMutationVersion);
  const collabEditRole = useViewerStore((s) => s.collabRole);
  const canEditInSession = roleCanEdit(collabEditRole);
  // BulkQueryEngine wants a MutationGuard (`() => boolean`), not the plain
  // boolean above — that one only gates this dialog's own Apply button.
  const canCollabEdit = useViewerStore((s) => s.canCollabEdit);

  const [open, setOpen] = useState(false);
  const [stageValue, setStageValue] = useState('1');
  const [isApplying, setIsApplying] = useState(false);

  // Union both selection channels into one set of global ids before
  // resolving to model-aware refs.
  const allSelectedGlobalIds = useMemo(() => {
    const ids = new Set(selectedEntityIds);
    if (selectedEntityId !== null) ids.add(selectedEntityId);
    return ids;
  }, [selectedEntityIds, selectedEntityId]);

  // Group the current selection by model — a selection is normally within
  // one model, but federation makes multi-model selections possible.
  const byModel = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const globalId of allSelectedGlobalIds) {
      const ref = fromGlobalIdFromModels(models, globalId);
      if (!ref) continue;
      const modelId = ref.modelId === 'legacy' ? '__legacy__' : ref.modelId;
      const list = map.get(modelId) ?? [];
      list.push(ref.expressId);
      map.set(modelId, list);
    }
    return map;
  }, [allSelectedGlobalIds, models]);

  const selectionCount = allSelectedGlobalIds.size;

  const handleApply = useCallback(() => {
    const stageNum = parseInt(stageValue, 10);
    if (Number.isNaN(stageNum)) {
      toast.error(`"${stageValue}" ist keine gültige Zahl`);
      return;
    }
    if (byModel.size === 0) {
      toast.error('Keine Elemente ausgewählt');
      return;
    }

    setIsApplying(true);
    try {
      let totalAffected = 0;
      const allErrors: string[] = [];

      for (const [modelId, expressIds] of byModel) {
        const model = models.get(modelId);
        const dataStore = model?.ifcDataStore as IfcDataStore | undefined;
        if (!dataStore) continue;

        // Reuse an existing mutation view for this model, or create one —
        // same pattern PropertiesPanel/BulkPropertyEditor use.
        let mutationView = getMutationView(modelId);
        if (!mutationView) {
          mutationView = new MutablePropertyView(dataStore.properties || null, modelId);
          configureMutationView(mutationView, dataStore);
          registerMutationView(modelId, mutationView);
        }

        const engine = new BulkQueryEngine(
          dataStore.entities,
          mutationView,
          dataStore.spatialHierarchy || null,
          dataStore.properties || null,
          dataStore.strings || null,
          canCollabEdit,
        );

        const result = engine.execute({
          select: { expressIds },
          action: {
            type: 'SET_PROPERTY',
            psetName: PSET_NAME,
            propName: PROP_NAME,
            value: stageNum,
            valueType: PropertyValueType.Integer,
          },
        });

        totalAffected += result.affectedEntityCount;
        if (result.errors) allErrors.push(...result.errors);
      }

      bumpMutationVersion();
      applyStageColorOverlay();

      // `totalAffected` can be lower than `selectionCount` with NO entry in
      // `allErrors`: `BulkQueryEngine.select({ expressIds })` silently drops
      // any id that isn't in that model's own entity table (no exception,
      // just filtered out of the candidate list) — e.g. a 3D-picked id that
      // resolved to the wrong model in a federated session. Surfacing only
      // `allErrors` would miss exactly that case, so compare counts too.
      if (allErrors.length > 0) {
        toast.error(
          `${PSET_NAME}.${PROP_NAME} auf ${totalAffected}/${selectionCount} Element(e) gesetzt — ${allErrors.length} fehlgeschlagen: ${allErrors[0]}${allErrors.length > 1 ? ` (+${allErrors.length - 1} weitere)` : ''}`
        );
      } else if (totalAffected < selectionCount) {
        toast.error(
          `${PSET_NAME}.${PROP_NAME} nur auf ${totalAffected} von ${selectionCount} ausgewählten Element(en) gesetzt — ${selectionCount - totalAffected} wurden nicht gefunden (evtl. falsches Modell bei Federation)`
        );
      } else {
        toast.success(`${PSET_NAME}.${PROP_NAME} = ${stageNum} auf ${totalAffected} Element(e) gesetzt`);
      }
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Stage setzen fehlgeschlagen');
    } finally {
      setIsApplying(false);
    }
  }, [stageValue, byModel, models, getMutationView, registerMutationView, canCollabEdit, bumpMutationVersion, selectionCount]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm">
            <Layers className="h-4 w-4 mr-2" />
            Stage setzen
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="h-4 w-4" />
            Stage setzen
          </DialogTitle>
          <DialogDescription>
            Setzt {PSET_NAME}.{PROP_NAME} auf die aktuelle 3D-Auswahl.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="text-sm text-muted-foreground">
            {selectionCount} Element{selectionCount === 1 ? '' : 'e'} ausgewählt
          </div>
          <div className="space-y-2">
            <Label htmlFor="stage-value" className="text-xs text-muted-foreground">
              Stage-Wert
            </Label>
            <Input
              id="stage-value"
              type="number"
              value={stageValue}
              onChange={(e) => setStageValue(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            onClick={handleApply}
            disabled={isApplying || selectionCount === 0 || !canEditInSession}
          >
            {isApplying ? 'Wird angewendet…' : 'Anwenden'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
