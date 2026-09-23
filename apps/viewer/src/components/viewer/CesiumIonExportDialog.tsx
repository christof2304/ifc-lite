/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Push the model to Cesium Ion as IFC, positioned from its effective
 * IfcMapConversion/IfcProjectedCRS so Ion's BIM/CAD tiler places it
 * correctly. The uploaded file is re-serialized with the user's pending edits
 * (stage tags, property/georef changes) baked in — see
 * `lib/geo/cesium-ion-source.ts`. See `lib/geo/cesium-ion-upload.ts` for the
 * upload mechanics and the still-unverified `heading` field. Requires a
 * georeferenced model, same precondition as `KmzExportDialog`.
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { CloudUpload, AlertCircle, Check, Loader2, Eye, EyeOff, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useViewerStore } from '@/store';
import { resolveExportVisibility } from '@/store/exportVisibility';
import { posthog } from '@/lib/analytics';
import { toast } from '@/components/ui/toast';
import { getEffectiveGeoreference } from '@/lib/geo/effective-georef';
import { hasUsableMapGeoref, type MapGeoreference } from '@/lib/geo/pick-to-geo';
import { reprojectPointToLatLon } from '@/lib/geo/reproject';
import { computeKmzAltitude } from '@/lib/geo/kmz-export';
import { headingDegreesFromAxis } from '@/lib/geo/heading';
import { uploadToCesiumIon, type IonUploadError } from '@/lib/geo/cesium-ion-upload';
import { buildIonSourceIfc, isIonUploadableSchema } from '@/lib/geo/cesium-ion-source';
import { sanitizeFilename } from '@/lib/export/download';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';

interface CesiumIonExportDialogProps {
  trigger?: React.ReactNode;
}

const ERROR_MESSAGE: Record<IonUploadError, string> = {
  'create-asset-failed': 'Cesium Ion rejected the asset request',
  'upload-failed': 'Uploading the file to Cesium Ion failed',
  'complete-failed': 'Cesium Ion did not accept the finished upload',
};

interface GeoSummary {
  lon: number;
  lat: number;
  heightMeters: number;
  headingDegrees: number | null;
  crsName: string;
}

export function CesiumIonExportDialog({ trigger }: CesiumIonExportDialogProps) {
  const models = useViewerStore((s) => s.models);
  const georefMutations = useViewerStore((s) => s.georefMutations);
  const legacyDataStore = useViewerStore((s) => s.ifcDataStore);
  const legacyGeometryResult = useViewerStore((s) => s.geometryResult);
  const writeToken = useViewerStore((s) => s.cesiumIonWriteToken);
  const setWriteToken = useViewerStore((s) => s.setCesiumIonWriteToken);
  const getMutationView = useViewerStore((s) => s.getMutationView);
  // Subscribed only so the pending-edits count below re-renders after edits.
  const mutationVersion = useViewerStore((s) => s.mutationVersion);

  const [open, setOpen] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibleOnly, setVisibleOnly] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<
    { success: boolean; message: string; assetUrl?: string } | null
  >(null);

  // Same modelList shape/fallback as KmzExportDialog/GLBExportDialog, minus
  // the mesh-only fields (instancedModelRange) this dialog never needs — it
  // uploads re-serialized IFC, not a re-meshed export. IFC5 models are left
  // out: Ion's BIM/CAD tiler only reads STEP IFC.
  const modelList = useMemo(() => {
    const list: { id: string; name: string; geometryResult: GeometryResult | null; dataStore: IfcDataStore }[] =
      Array.from(models.values())
        .filter((m) => m.ifcDataStore && isIonUploadableSchema(m.ifcDataStore.schemaVersion))
        .map((m) => ({ id: m.id, name: m.name, geometryResult: m.geometryResult, dataStore: m.ifcDataStore! }));
    if (list.length === 0 && legacyDataStore && isIonUploadableSchema(legacyDataStore.schemaVersion)) {
      list.push({ id: '__legacy__', name: 'Current Model', geometryResult: legacyGeometryResult, dataStore: legacyDataStore });
    }
    return list;
  }, [models, legacyDataStore, legacyGeometryResult]);

  useEffect(() => {
    if (modelList.length === 0) return;
    if (!selectedModelId || !modelList.some((m) => m.id === selectedModelId)) {
      setSelectedModelId(modelList[0].id);
    }
  }, [modelList, selectedModelId]);

  const selectedModel = useMemo(
    () => modelList.find((m) => m.id === selectedModelId) ?? modelList[0],
    [modelList, selectedModelId],
  );

  // Seed the asset name from the model's filename whenever the selection
  // changes, but only while the user hasn't typed their own (an empty box
  // still means "use the default" on submit, so this is a convenience, not
  // the source of truth).
  useEffect(() => {
    if (selectedModel) setName(selectedModel.name.replace(/\.[^.]+$/, ''));
  }, [selectedModel]);

  const eff: MapGeoreference | null = useMemo(() => {
    if (!selectedModel) return null;
    const mutations = selectedModel.id === '__legacy__' ? undefined : georefMutations.get(selectedModel.id);
    const raw = getEffectiveGeoreference(selectedModel.dataStore, selectedModel.geometryResult?.coordinateInfo ?? undefined, mutations);
    return hasUsableMapGeoref(raw) ? raw : null;
  }, [selectedModel, georefMutations]);

  const [geo, setGeo] = useState<GeoSummary | null>(null);
  const [geoUnprojectable, setGeoUnprojectable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setGeo(null);
    setGeoUnprojectable(false);
    if (!eff) return;
    (async () => {
      const latLon = await reprojectPointToLatLon(
        eff.mapConversion.eastings,
        eff.mapConversion.northings,
        eff.projectedCRS,
        eff.lengthUnitScale,
      );
      if (cancelled) return;
      if (!latLon) {
        setGeoUnprojectable(true);
        return;
      }
      setGeo({
        lon: latLon.lon,
        lat: latLon.lat,
        heightMeters: computeKmzAltitude(eff.mapConversion.orthogonalHeight, eff.projectedCRS, eff.lengthUnitScale, eff.coordinateInfo),
        headingDegrees: headingDegreesFromAxis(eff.mapConversion.xAxisAbscissa, eff.mapConversion.xAxisOrdinate),
        crsName: eff.projectedCRS.name,
      });
    })();
    return () => { cancelled = true; };
  }, [eff]);

  const pendingEditCount = useMemo(() => {
    if (!selectedModel) return 0;
    let count = getMutationView(selectedModel.id)?.getModifiedEntityCount() ?? 0;
    const gm = georefMutations.get(selectedModel.id);
    if (gm && (Object.keys(gm.projectedCRS ?? {}).length > 0 || Object.keys(gm.mapConversion ?? {}).length > 0)) count += 1;
    return count;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModel, getMutationView, georefMutations, mutationVersion]);

  const canUpload = Boolean(selectedModel && geo && writeToken.trim().length > 0 && !isUploading);

  const handleUpload = useCallback(async () => {
    if (!selectedModel || !geo) return;
    setIsUploading(true);
    setUploadResult(null);
    try {
      const baseName = sanitizeFilename(name.trim() || selectedModel.name.replace(/\.[^.]+$/, ''), { fallback: 'model' });
      const fileName = `${baseName}.ifc`;
      // Read the store at click time (like ExportDialog) so the upload sees
      // the latest edits/visibility, not a stale render.
      const state = useViewerStore.getState();
      const modelId = selectedModel.id;
      const visibility = visibleOnly ? resolveExportVisibility(state, modelId) : null;
      const source = await buildIonSourceIfc({
        modelId,
        dataStore: selectedModel.dataStore,
        mutationView: state.getMutationView(modelId) ?? undefined,
        georefMutations: modelId === '__legacy__' ? undefined : state.georefMutations.get(modelId),
        visibleOnly,
        hiddenEntityIds: visibility?.hiddenLocalIds,
        isolatedEntityIds: visibility?.isolatedLocalIds,
        scheduleState: {
          scheduleData: state.scheduleData ?? null,
          scheduleIsEdited: state.scheduleIsEdited === true,
          scheduleSourceModelId: state.scheduleSourceModelId ?? null,
        },
      });
      const result = await uploadToCesiumIon({
        token: writeToken.trim(),
        name: baseName,
        description: description.trim() || undefined,
        position: [geo.lon, geo.lat, geo.heightMeters],
        headingDegrees: geo.headingDegrees ?? undefined,
        fileBytes: source.bytes,
        fileName,
      });

      if ('error' in result) {
        const msg = `${ERROR_MESSAGE[result.error]}: ${result.detail}`;
        setUploadResult({ success: false, message: msg });
        toast.error('Cesium Ion upload failed');
        return;
      }

      const msg = `Uploaded to Cesium Ion as asset ${result.assetId}. Tiling runs in the background — check the Ion dashboard for progress.`;
      setUploadResult({ success: true, message: msg, assetUrl: result.assetUrl });
      toast.success('Uploaded to Cesium Ion');
      // Never send the token, S3 credentials, or any file content — only the
      // asset id (a number) and format tag, matching the BYOK telemetry
      // convention (analytics-scrub.ts does not redact token-shaped keys,
      // so the raw value must simply never reach capture()).
      posthog.capture('export_completed', { format: 'cesium-ion', asset_id: result.assetId });
    } catch (err) {
      console.error('Cesium Ion upload failed:', err);
      const errMsg = `Cesium Ion upload failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
      setUploadResult({ success: false, message: errMsg });
      toast.error(errMsg);
    } finally {
      setIsUploading(false);
    }
  }, [selectedModel, geo, name, description, writeToken, visibleOnly]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm">
            <CloudUpload className="h-4 w-4 mr-2" />
            Push to Cesium Ion
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CloudUpload className="h-5 w-5" />
            Push to Cesium Ion
          </DialogTitle>
          <DialogDescription>
            Uploads the model as IFC, including your pending edits, to Cesium Ion, positioned from
            its georeferencing.
            Ion&apos;s own BIM/CAD tiler converts it to 3D Tiles — this can take a while and does
            not run in this browser.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4 max-h-[70vh] overflow-y-auto">
          {modelList.length > 1 && (
            <div className="flex items-center gap-4">
              <Label className="w-32">Model</Label>
              <Select value={selectedModelId} onValueChange={setSelectedModelId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select model" />
                </SelectTrigger>
                <SelectContent>
                  {modelList.map((m) => {
                    const displayName = m.name.length > 24 ? m.name.slice(0, 24) + '…' : m.name;
                    return (
                      <SelectItem key={m.id} value={m.id} title={m.name}>
                        {displayName}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="ion-write-token">Ion access token (asset-write)</Label>
            <div className="relative">
              <Input
                id="ion-write-token"
                type={showToken ? 'text' : 'password'}
                value={writeToken}
                onChange={(e) => setWriteToken(e.target.value)}
                placeholder="Paste a token with the assets:write scope"
                autoComplete="off"
                spellCheck={false}
                className="pr-8 font-mono"
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showToken ? 'Hide token' : 'Show token'}
              >
                {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Stays in this browser and goes straight to api.cesium.com and AWS S3 — never sent
              anywhere else. This is a different, higher-privilege token than the one used to view
              terrain/imagery; create one under Access Tokens in your Ion account with the{' '}
              <code className="font-mono">assets:write</code> scope.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ion-asset-name">Asset name</Label>
            <Input id="ion-asset-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ion-asset-description">
              Description <span className="font-normal text-muted-foreground">— optional</span>
            </Label>
            <Input id="ion-asset-description" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="ion-visible-only">Upload visible only</Label>
              <p className="text-xs text-muted-foreground">Leave out entities hidden or filtered in the 3D view</p>
            </div>
            <Switch id="ion-visible-only" checked={visibleOnly} onCheckedChange={setVisibleOnly} />
          </div>

          <p className="text-xs text-muted-foreground">
            {pendingEditCount > 0
              ? `${pendingEditCount} pending edit${pendingEditCount === 1 ? '' : 's'} (e.g. stage tags, georeferencing) will be included in the upload.`
              : 'No pending edits — the model is uploaded as loaded.'}
          </p>

          {!eff && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Not georeferenced</AlertTitle>
              <AlertDescription>
                This model has no georeferencing (IfcMapConversion / projected CRS), so it has no
                real-world location to place in Cesium Ion. Add one in the Georeferencing section
                of the Properties panel first.
              </AlertDescription>
            </Alert>
          )}
          {eff && geoUnprojectable && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Could not project to WGS84</AlertTitle>
              <AlertDescription>
                The model is georeferenced but its coordinate system could not be resolved.
              </AlertDescription>
            </Alert>
          )}
          {geo && (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs font-mono bg-muted/50 rounded px-3 py-2">
              <span className="text-muted-foreground">CRS</span>
              <span>{geo.crsName}</span>
              <span className="text-muted-foreground">Lon / Lat</span>
              <span>{geo.lon.toFixed(6)}°, {geo.lat.toFixed(6)}°</span>
              <span className="text-muted-foreground">Height</span>
              <span>{geo.heightMeters.toFixed(2)} m</span>
              <span className="text-muted-foreground">Heading</span>
              <span>{geo.headingDegrees !== null ? `${geo.headingDegrees.toFixed(1)}°` : '— (none authored)'}</span>
            </div>
          )}

          {uploadResult && (
            <Alert variant={uploadResult.success ? 'default' : 'destructive'}>
              {uploadResult.success ? <Check className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
              <AlertTitle>{uploadResult.success ? 'Uploaded' : 'Error'}</AlertTitle>
              <AlertDescription>
                {uploadResult.message}
                {uploadResult.assetUrl && (
                  <a
                    href={uploadResult.assetUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 flex items-center gap-1 underline underline-offset-2"
                  >
                    Open in Cesium Ion <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleUpload} disabled={!canUpload}>
            {isUploading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Uploading...
              </>
            ) : (
              <>
                <CloudUpload className="h-4 w-4 mr-2" />
                Upload
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
