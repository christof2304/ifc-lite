/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section cuts bound to an IfcAlignment centerline. Shared by the Section
 * panel (station slider, distance input) and the 3D drag gizmo, so every
 * control moves a bound cut ALONG the alignment and re-orients it to the
 * local tangent, rather than sliding the plane parallel to the tangent it
 * was first created with.
 */

import { useCallback, useMemo } from 'react';
import { useViewerStore } from '@/store';
import { alignmentPathLength, sampleAlignmentStation } from '@/lib/alignment/alignment-station';
import { useAlignmentLines3D } from './useAlignmentLines3D';

export interface AlignmentSection {
  hasAlignment: boolean;
  /** Total centerline length (metres). */
  length: number;
  /** Station of the bound cut, or `null` when the cut isn't bound. */
  station: number | null;
  /** Cut perpendicular to the alignment at `distance` (clamped); binds the cut. */
  goToStation: (distance: number) => void;
}

export function useAlignmentSection(): AlignmentSection {
  const verts = useAlignmentLines3D();
  const length = useMemo(() => alignmentPathLength(verts), [verts]);
  const station = useViewerStore((s) => s.sectionPlane.custom?.alignmentStation ?? null);
  const setFromAlignment = useViewerStore((s) => s.setSectionPlaneFromAlignment);

  const goToStation = useCallback((distance: number) => {
    if (!Number.isFinite(distance)) return;
    const clamped = Math.min(Math.max(distance, 0), length);
    const sample = sampleAlignmentStation(verts, clamped);
    if (!sample) return;
    setFromAlignment(sample.tangent, sample.point, clamped);
  }, [verts, length, setFromAlignment]);

  return { hasAlignment: length > 1e-6, length, station, goToStation };
}
