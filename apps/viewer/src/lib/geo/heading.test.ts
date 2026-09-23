/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { headingDegreesFromAxis } from './heading';

it('returns null when no axis rotation is authored', () => {
  assert.equal(headingDegreesFromAxis(undefined, undefined), null);
});

it('local X pointing map East is a 90° compass bearing', () => {
  assert.equal(headingDegreesFromAxis(1, 0), 90);
});

it('local X pointing map North is a 0° compass bearing', () => {
  assert.equal(headingDegreesFromAxis(0, 1), 0);
});

it('local X pointing map West is a 270° compass bearing', () => {
  assert.equal(headingDegreesFromAxis(-1, 0), 270);
});

it('local X pointing map South is a 180° compass bearing', () => {
  assert.equal(headingDegreesFromAxis(0, -1), 180);
});
