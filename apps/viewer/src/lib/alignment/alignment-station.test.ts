/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { alignmentPathLength, sampleAlignmentStation } from './alignment-station';

// A 3-segment line-list: (0,0,0)->(10,0,0)->(10,0,10)->(20,0,10). Straight
// legs so the expected tangent/point at any station is easy to hand-check.
// prettier-ignore
const LSHAPE = new Float32Array([
  0, 0, 0,   10, 0, 0,
  10, 0, 0,  10, 0, 10,
  10, 0, 10, 20, 0, 10,
]);

it('returns null for an empty buffer', () => {
  assert.equal(sampleAlignmentStation(new Float32Array(0), 5), null);
});

it('returns null for a degenerate (zero-length) buffer', () => {
  const zero = new Float32Array([1, 2, 3, 1, 2, 3]);
  assert.equal(alignmentPathLength(zero), 0);
  assert.equal(sampleAlignmentStation(zero, 0), null);
});

it('sums chord lengths across segments', () => {
  assert.equal(alignmentPathLength(LSHAPE), 30);
});

it('samples the start and end of the path', () => {
  const start = sampleAlignmentStation(LSHAPE, 0)!;
  assert.deepEqual(start.point, [0, 0, 0]);
  assert.deepEqual(start.tangent, [1, 0, 0]);

  const end = sampleAlignmentStation(LSHAPE, 30)!;
  assert.deepEqual(end.point, [20, 0, 10]);
  assert.deepEqual(end.tangent, [1, 0, 0]);
});

it('interpolates within a segment and picks up the new tangent after a corner', () => {
  const mid = sampleAlignmentStation(LSHAPE, 5)!;
  assert.deepEqual(mid.point, [5, 0, 0]);
  assert.deepEqual(mid.tangent, [1, 0, 0]);

  const afterCorner = sampleAlignmentStation(LSHAPE, 15)!;
  assert.deepEqual(afterCorner.point, [10, 0, 5]);
  assert.deepEqual(afterCorner.tangent, [0, 0, 1]);
});

it('clamps distance outside [0, length] instead of extrapolating', () => {
  const before = sampleAlignmentStation(LSHAPE, -5)!;
  assert.deepEqual(before.point, [0, 0, 0]);

  const after = sampleAlignmentStation(LSHAPE, 1000)!;
  assert.deepEqual(after.point, [20, 0, 10]);
});
