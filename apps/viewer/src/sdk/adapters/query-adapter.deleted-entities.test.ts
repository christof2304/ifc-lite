/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.query(...).execute()`/`.count()` in the viewer must not return
 * entities the user deleted this session. `queryEntities` enumerates
 * `entityIndex.byType` directly and, before #5205, never consulted the
 * mutation view's tombstones — unlike `entityData()` (point lookup), which
 * already checked `isDeleted`. Mirrors the guard already present in
 * `packages/cli/src/headless-backend.ts` and `packages/mcp/src/backend-query.ts`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcParser } from '@ifc-lite/parser';
import { createQueryAdapter } from './query-adapter.js';
import type { StoreApi } from './types.js';

const MODEL = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('m','2026',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;#1=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,$,$);
#50=IFCWALL('0000000000000000000050',$,'W1',$,$,$,$,$,$);
#51=IFCWALL('0000000000000000000051',$,'W2',$,$,$,$,$,$);ENDSEC;END-ISO-10303-21;`;

async function harness() {
  const dataStore = await new IfcParser().parseColumnar(new TextEncoder().encode(MODEL).buffer as ArrayBuffer);
  const view = new MutablePropertyView(dataStore.properties, 'm');
  const state = {
    models: new Map([['m', { id: 'm', ifcDataStore: dataStore }]]),
    activeModelId: 'm',
    ifcDataStore: dataStore,
    mutationViews: new Map([['m', view]]),
    getMutationView: (id: string) => (id === 'm' ? view : null),
  };
  const store = { getState: () => state, subscribe: () => () => {} } as unknown as StoreApi;
  return { adapter: createQueryAdapter(store), view };
}

test('queryEntities excludes an entity deleted this session (#5205)', async () => {
  const { adapter, view } = await harness();

  // Sanity: both walls present before delete.
  const before = adapter.entities({ types: ['IfcWall'] });
  assert.deepEqual(before.map(e => e.ref.expressId).sort(), [50, 51]);

  view.deleteEntity(50);
  assert.equal(view.isDeleted(50), true, 'sanity: view reports the tombstone');

  // Point lookup already guarded (pin: fix must not regress this).
  assert.equal(adapter.entityData({ modelId: 'm', expressId: 50 }), null, 'deleted entity point lookup stays null');
  assert.notEqual(adapter.entityData({ modelId: 'm', expressId: 51 }), null, 'live entity point lookup unaffected');

  const after = adapter.entities({ types: ['IfcWall'] });
  assert.deepEqual(after.map(e => e.ref.expressId), [51], 'deleted wall must not be enumerated');
});

test('queryEntities count() agrees with execute() row count after a delete (#5205)', async () => {
  const { adapter, view } = await harness();
  view.deleteEntity(50);

  const rows = adapter.entities({ types: ['IfcWall'] });
  assert.equal(rows.length, 1, 'execute()-equivalent row count reflects the delete');
  // `count()` in packages/sdk/src/namespaces/query.ts is literally
  // `backend.query.entities(descriptor).length` — assert the same call
  // used for `.count()` returns a count that agrees with the rows, not a
  // separately-computed, unfiltered number.
  const countEquivalent = adapter.entities({ types: ['IfcWall'] }).length;
  assert.equal(countEquivalent, rows.length);
  assert.equal(countEquivalent, 1);
});

test('a live (non-deleted) entity is still returned by queryEntities (#5205 pin)', async () => {
  const { adapter } = await harness();
  const rows = adapter.entities({ types: ['IfcWall'] });
  assert.deepEqual(rows.map(e => e.ref.expressId).sort(), [50, 51], 'no deletions — both walls present');
});
