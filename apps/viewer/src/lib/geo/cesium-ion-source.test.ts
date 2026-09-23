/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Ion upload must carry the user's pending edits: drives the REAL
 * StepExporter + MutablePropertyView with a `CESIUM.Stage` tag exactly as
 * `SetStagePanel` writes it, and checks it lands in the uploaded bytes.
 */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { IfcDataStore } from '@ifc-lite/parser';
import { PropertyValueType } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { buildIonSourceIfc, isIonUploadableSchema } from './cesium-ion-source';

type Entry = [number, string, string];

/** Minimal real IfcDataStore from STEP lines (mirrors changed-model-export.integration.test.ts). */
function buildDataStore(entries: Entry[], schemaVersion = 'IFC4'): IfcDataStore {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const byId = new Map<number, { expressId: number; type: string; byteOffset: number; byteLength: number; lineNumber: number }>();
  const byType = new Map<string, number[]>();
  let offset = 0;
  for (const [id, type, text] of entries) {
    const encoded = encoder.encode(text);
    const upper = type.toUpperCase();
    byId.set(id, { expressId: id, type: upper, byteOffset: offset, byteLength: encoded.byteLength, lineNumber: 0 });
    if (!byType.has(upper)) byType.set(upper, []);
    byType.get(upper)!.push(id);
    parts.push(encoded);
    offset += encoded.byteLength;
  }
  const source = new Uint8Array(offset);
  let pos = 0;
  for (const p of parts) {
    source.set(p, pos);
    pos += p.byteLength;
  }
  return {
    fileSize: offset,
    schemaVersion,
    entityCount: entries.length,
    parseTime: 0,
    source,
    entityIndex: { byId, byType },
  } as unknown as IfcDataStore;
}

const TWO_WALLS: Entry[] = [
  [1, 'IFCWALL', "#1=IFCWALL('gid1',$,'Wall 1',$,$,$,$,$);"],
  [2, 'IFCWALL', "#2=IFCWALL('gid2',$,'Wall 2',$,$,$,$,$);"],
];

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

it('bakes a CESIUM.Stage tag written as a mutation into the uploaded IFC', async () => {
  const dataStore = buildDataStore(TWO_WALLS);
  const view = new MutablePropertyView(null, 'm');
  view.setProperty(1, 'CESIUM', 'Stage', 3, PropertyValueType.Integer);

  const out = await buildIonSourceIfc({
    modelId: 'm', dataStore, mutationView: view, visibleOnly: false, scheduleState: null,
  });
  const text = decode(out.bytes);

  assert.match(text, /IFCPROPERTYSET\([^;]*'CESIUM'/);
  assert.match(text, /IFCPROPERTYSINGLEVALUE\('Stage',\$,IFCINTEGER\(3\)/);
  assert.match(text, /IFCRELDEFINESBYPROPERTIES\([^;]*\(#1\)/);
  assert.ok(out.modifiedEntityCount >= 1);
});

it('uploads the model unchanged (still both walls) when there are no edits', async () => {
  const out = await buildIonSourceIfc({
    modelId: 'm', dataStore: buildDataStore(TWO_WALLS), visibleOnly: false, scheduleState: null,
  });
  const text = decode(out.bytes);
  assert.match(text, /IFCWALL\('gid1'/);
  assert.match(text, /IFCWALL\('gid2'/);
  assert.doesNotMatch(text, /'CESIUM'/);
});

it('drops hidden entities only when visibleOnly is set', async () => {
  const hidden = new Set([2]);
  const all = await buildIonSourceIfc({
    modelId: 'm', dataStore: buildDataStore(TWO_WALLS), visibleOnly: false, hiddenEntityIds: hidden, scheduleState: null,
  });
  assert.match(decode(all.bytes), /IFCWALL\('gid2'/);

  const visible = await buildIonSourceIfc({
    modelId: 'm', dataStore: buildDataStore(TWO_WALLS), visibleOnly: true, hiddenEntityIds: hidden, scheduleState: null,
  });
  assert.match(decode(visible.bytes), /IFCWALL\('gid1'/);
  assert.doesNotMatch(decode(visible.bytes), /IFCWALL\('gid2'/);
});

it('refuses IFC5 models', async () => {
  assert.equal(isIonUploadableSchema('IFC5'), false);
  assert.equal(isIonUploadableSchema('IFC4X3'), true);
  await assert.rejects(
    buildIonSourceIfc({ modelId: 'm', dataStore: buildDataStore(TWO_WALLS, 'IFC5'), visibleOnly: false, scheduleState: null }),
    /IFC5/,
  );
});
