/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Push a raw IFC source file to Cesium Ion, positioned so Ion's own BIM/CAD
 * ("Design") tiler converts it to 3D Tiles server-side — we upload the
 * original file, never a locally-exported mesh/GLB.
 *
 * `sourceType: 'BIM_CAD'` (not `3D_MODEL`) is deliberate: community reports
 * (Cesium-staff-confirmed as of mid-2026) show `3D_MODEL` + `position`
 * stalling tiling at ~9%, with `BIM_CAD` as the working alternative — and
 * since the input here genuinely is a CAD/BIM file, BIM_CAD is also the
 * *documented* source type for it, not a workaround.
 *
 * The create → S3 PutObject → uploadComplete sequence deliberately mirrors
 * lab.geobim.app's `uploadToIon` (georef.js), which has been uploading to Ion
 * from the browser reliably: the official `@aws-sdk/client-s3` client pointed
 * at `uploadLocation.endpoint` with `forcePathStyle` (Ion's bucket name
 * `assets.ion.cesium.com` contains dots, which breaks TLS under
 * virtual-hosted-style URLs), then a bare POST to `uploadComplete`.
 *
 * Still unverified: whether the `heading` field is actually a documented,
 * honored BIM_CAD option or a silently-ignored extra key — asset creation
 * succeeding either way doesn't distinguish the two. Sent best-effort; every
 * failure surfaces Ion's own response body (or, for a network-level failure,
 * which step failed) so a wrong guess is diagnosable on the first attempt.
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const ION_API_BASE = 'https://api.cesium.com/v1';

export interface IonUploadInput {
  /** Cesium Ion personal access token with the `assets:write` scope. Never logged or sent to analytics. */
  token: string;
  name: string;
  description?: string;
  /** [longitude, latitude, height] in degrees/degrees/metres — the model's local (0,0,0) origin. */
  position: [number, number, number];
  /** Compass bearing, degrees clockwise from North. Best-effort — see file header. */
  headingDegrees?: number;
  fileBytes: Uint8Array;
  /** Original filename, e.g. "bridge.ifc". */
  fileName: string;
}

export type IonUploadError = 'create-asset-failed' | 'upload-failed' | 'complete-failed';

export interface IonUploadFailure {
  error: IonUploadError;
  /** Ion's own error text (or a network/HTTP summary) — surfaced verbatim to the user. */
  detail: string;
}

export interface IonUploadResult {
  assetId: number;
  assetUrl: string;
}

interface IonUploadLocation {
  bucket: string;
  prefix: string;
  accessKey: string;
  secretAccessKey: string;
  sessionToken: string;
  endpoint?: string;
}

interface IonCreateAssetResponse {
  assetMetadata: { id: number };
  uploadLocation: IonUploadLocation;
}

/** What the S3 step needs — the default implementation is `putObjectWithAwsSdk`. */
export interface S3PutRequest {
  endpoint?: string;
  bucket: string;
  key: string;
  body: Uint8Array;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
}

export interface UploadToCesiumIonDeps {
  fetchImpl?: typeof fetch;
  /** Resolves on success, throws on failure. */
  s3Put?: (req: S3PutRequest) => Promise<void>;
}

/** Same client setup as lab.geobim.app's working browser upload. */
async function putObjectWithAwsSdk(req: S3PutRequest): Promise<void> {
  const s3 = new S3Client({
    region: 'us-east-1',
    endpoint: req.endpoint,
    credentials: req.credentials,
    forcePathStyle: true,
  });
  await s3.send(new PutObjectCommand({
    Bucket: req.bucket,
    Key: req.key,
    Body: req.body,
    ContentType: 'application/octet-stream',
  }));
}

function thrownDetail(step: string, err: unknown): string {
  return `${step}: ${err instanceof Error ? err.message : String(err)}`;
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const body = await res.text();
    return body ? `${res.status} ${res.statusText}: ${body}` : `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

export async function uploadToCesiumIon(
  input: IonUploadInput,
  deps: UploadToCesiumIonDeps = {},
): Promise<IonUploadResult | IonUploadFailure> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const s3Put = deps.s3Put ?? putObjectWithAwsSdk;

  const [lon, lat, height] = input.position;
  let createRes: Response;
  try {
    createRes = await fetchImpl(`${ION_API_BASE}/assets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: input.name,
        description: input.description,
        type: '3DTILES',
        options: {
          sourceType: 'BIM_CAD',
          position: [lon, lat, height],
          // Field name unconfirmed against Ion's BIM_CAD options — best effort,
          // see file header. Omitted entirely when we have no heading rather
          // than sending a guessable-wrong value.
          ...(input.headingDegrees !== undefined ? { heading: input.headingDegrees } : {}),
        },
      }),
    });
  } catch (err) {
    return { error: 'create-asset-failed', detail: thrownDetail('api.cesium.com unreachable', err) };
  }
  if (!createRes.ok) {
    return { error: 'create-asset-failed', detail: await errorDetail(createRes) };
  }
  const { uploadLocation, assetMetadata } = await createRes.json() as IonCreateAssetResponse;
  const assetId = assetMetadata.id;

  try {
    await s3Put({
      endpoint: uploadLocation.endpoint,
      bucket: uploadLocation.bucket,
      key: `${uploadLocation.prefix}${input.fileName}`,
      body: input.fileBytes,
      credentials: {
        accessKeyId: uploadLocation.accessKey,
        secretAccessKey: uploadLocation.secretAccessKey,
        sessionToken: uploadLocation.sessionToken,
      },
    });
  } catch (err) {
    return { error: 'upload-failed', detail: thrownDetail(`asset ${assetId}, S3 upload`, err) };
  }

  let completeRes: Response;
  try {
    completeRes = await fetchImpl(`${ION_API_BASE}/assets/${assetId}/uploadComplete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.token}` },
    });
  } catch (err) {
    return { error: 'complete-failed', detail: thrownDetail(`asset ${assetId}, uploadComplete`, err) };
  }
  if (!completeRes.ok) {
    return { error: 'complete-failed', detail: await errorDetail(completeRes) };
  }

  return {
    assetId,
    assetUrl: `https://ion.cesium.com/assets/${assetId}`,
  };
}
