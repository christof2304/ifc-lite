/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { uploadToCesiumIon, type S3PutRequest } from './cesium-ion-upload';

const BASE_INPUT = {
  token: 'ion-write-token',
  name: 'bridge.ifc',
  position: [8.5417, 47.3769, 412.3] as [number, number, number],
  fileBytes: new Uint8Array([1, 2, 3]),
  fileName: 'bridge.ifc',
};

const CREATE_RESPONSE = {
  assetMetadata: { id: 42 },
  uploadLocation: {
    bucket: 'assets.cesium.com',
    prefix: 'sources/42/',
    accessKey: 'AKIA...',
    secretAccessKey: 'secret',
    sessionToken: 'token',
  },
};

function fakeFetch(responses: Record<string, Response>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const key = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    const res = responses[key];
    if (!res) throw new Error(`unexpected fetch to ${key}`);
    return res;
  }) as typeof fetch;
}

const okS3Put = async (_req: S3PutRequest) => {};

it('happy path: create asset, upload to S3, complete', async () => {
  const fetchImpl = fakeFetch({
    'https://api.cesium.com/v1/assets': new Response(JSON.stringify(CREATE_RESPONSE), { status: 200 }),
    'https://api.cesium.com/v1/assets/42/uploadComplete': new Response(null, { status: 200 }),
  });
  const result = await uploadToCesiumIon(BASE_INPUT, { fetchImpl, s3Put: okS3Put });
  assert.deepEqual(result, { assetId: 42, assetUrl: 'https://ion.cesium.com/assets/42' });
});

it('surfaces a non-2xx create-asset response verbatim', async () => {
  const fetchImpl = fakeFetch({
    'https://api.cesium.com/v1/assets': new Response('{"message":"invalid options.sourceType"}', {
      status: 400,
      statusText: 'Bad Request',
    }),
  });
  const result = await uploadToCesiumIon(BASE_INPUT, { fetchImpl, s3Put: okS3Put });
  assert.deepEqual(result, {
    error: 'create-asset-failed',
    detail: '400 Bad Request: {"message":"invalid options.sourceType"}',
  });
});

it('reports an S3 upload failure without calling uploadComplete', async () => {
  let completeCalled = false;
  const fetchImpl = fakeFetch({
    'https://api.cesium.com/v1/assets': new Response(JSON.stringify(CREATE_RESPONSE), { status: 200 }),
    'https://api.cesium.com/v1/assets/42/uploadComplete': new Response(null, { status: 200 }),
  });
  const completingFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/uploadComplete')) completeCalled = true;
    return fetchImpl(url, init);
  }) as typeof fetch;
  const failingS3 = async () => { throw new Error('Access Denied'); };
  const result = await uploadToCesiumIon(BASE_INPUT, { fetchImpl: completingFetch, s3Put: failingS3 });
  assert.deepEqual(result, { error: 'upload-failed', detail: 'asset 42, S3 upload: Access Denied' });
  // uploadComplete must not fire after a failed upload.
  assert.equal(completeCalled, false);
});

it('reports an uploadComplete failure', async () => {
  const fetchImpl = fakeFetch({
    'https://api.cesium.com/v1/assets': new Response(JSON.stringify(CREATE_RESPONSE), { status: 200 }),
    'https://api.cesium.com/v1/assets/42/uploadComplete': new Response('gone', { status: 410, statusText: 'Gone' }),
  });
  const result = await uploadToCesiumIon(BASE_INPUT, { fetchImpl, s3Put: okS3Put });
  assert.deepEqual(result, { error: 'complete-failed', detail: '410 Gone: gone' });
});

it('omits the heading field entirely when none is given', async () => {
  let createAssetBody: string | undefined;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (url === 'https://api.cesium.com/v1/assets') createAssetBody = init?.body as string;
    return new Response(JSON.stringify(CREATE_RESPONSE), { status: 200 });
  }) as typeof fetch;
  await uploadToCesiumIon(BASE_INPUT, { fetchImpl, s3Put: okS3Put });
  const parsed = JSON.parse(createAssetBody!);
  assert.equal('heading' in parsed.options, false);
});

it('puts to the path-style key Ion hands back', async () => {
  let put: S3PutRequest | undefined;
  const fetchImpl = fakeFetch({
    'https://api.cesium.com/v1/assets': new Response(JSON.stringify(CREATE_RESPONSE), { status: 200 }),
    'https://api.cesium.com/v1/assets/42/uploadComplete': new Response(null, { status: 200 }),
  });
  await uploadToCesiumIon(BASE_INPUT, { fetchImpl, s3Put: async (req) => { put = req; } });
  assert.equal(put?.bucket, 'assets.cesium.com');
  assert.equal(put?.key, 'sources/42/bridge.ifc');
  assert.equal(put?.credentials.sessionToken, 'token');
});

it('names the failing step when a request never gets a response ("Failed to fetch")', async () => {
  const fetchImpl = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
  const result = await uploadToCesiumIon(BASE_INPUT, { fetchImpl, s3Put: okS3Put });
  assert.deepEqual(result, { error: 'create-asset-failed', detail: 'api.cesium.com unreachable: Failed to fetch' });
});
