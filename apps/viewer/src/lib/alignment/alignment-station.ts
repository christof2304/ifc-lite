/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Station (chainage) sampling over the flat line-list buffer produced by
 * `useAlignmentLines3D` / `parseAlignmentLines` — `[x0,y0,z0, x1,y1,z1, …]`
 * pairs in renderer Y-up, RTC-subtracted, metres space (see
 * `rust/wasm-bindings/src/api/alignment_lines.rs`). Reusing that buffer
 * (already sampled at ~1 m steps) avoids a second WASM/Rust entry point
 * just to answer "where is the alignment at distance d" — the segment
 * chord IS the tangent at that resolution.
 *
 * When multiple `IfcAlignment`s or federated models are loaded, the hook
 * concatenates their buffers back-to-back with no boundary marker, so a
 * single station value scrubs across all of them as one path. Fine for the
 * common case (one bridge, one alignment); a multi-alignment model can jump
 * discontinuously at the seam.
 */

export interface AlignmentStationSample {
  point: [number, number, number];
  /** Unit vector along the direction of travel at this station. */
  tangent: [number, number, number];
}

function segmentLength(verts: Float32Array, i: number): number {
  const dx = verts[i + 3] - verts[i];
  const dy = verts[i + 4] - verts[i + 1];
  const dz = verts[i + 5] - verts[i + 2];
  return Math.hypot(dx, dy, dz);
}

/** Total length of a line-list buffer, summing every segment's chord length. */
export function alignmentPathLength(verts: Float32Array): number {
  let total = 0;
  for (let i = 0; i + 5 < verts.length; i += 6) {
    total += segmentLength(verts, i);
  }
  return total;
}

/**
 * Sample a point + unit tangent at `distance` metres along the path,
 * clamped to `[0, alignmentPathLength(verts)]`. Returns `null` for an
 * empty or degenerate (zero-length) buffer.
 */
export function sampleAlignmentStation(
  verts: Float32Array,
  distance: number,
): AlignmentStationSample | null {
  if (verts.length < 6) return null;
  const total = alignmentPathLength(verts);
  if (!(total > 1e-9)) return null;
  const d = Math.min(Math.max(distance, 0), total);

  let cum = 0;
  for (let i = 0; i + 5 < verts.length; i += 6) {
    const len = segmentLength(verts, i);
    if (len < 1e-9) continue;
    const isLastSegment = i + 6 >= verts.length;
    if (d <= cum + len + 1e-6 || isLastSegment) {
      const t = Math.min(1, Math.max(0, (d - cum) / len));
      const x0 = verts[i]; const y0 = verts[i + 1]; const z0 = verts[i + 2];
      const x1 = verts[i + 3]; const y1 = verts[i + 4]; const z1 = verts[i + 5];
      return {
        point: [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t],
        tangent: [(x1 - x0) / len, (y1 - y0) / len, (z1 - z0) / len],
      };
    }
    cum += len;
  }
  return null;
}
