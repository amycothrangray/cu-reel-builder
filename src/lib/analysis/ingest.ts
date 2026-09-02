// Ingestion + analysis pipeline.
//
// Flow per file: store original → hash → decode (HEIC-aware) → derivatives
// (preview + thumb) → EXIF → measurements → classification → faces →
// restricted-child matching → optional restrained correction → score.
//
// Analysis is cached by content hash so re-using a photo is free. Restricted
// matching always re-runs against the *current* profile set — a cached "no
// match" from before a profile existed must never suppress a warning.

import { blobKey, db, putBlob, trackUsage } from '../db';
import { uid } from '../ids';
import { hashBlob } from '../hash';
import { readExif } from '../exif';
import { decodeImageFile, makeDerivatives } from '../imaging/decode';
import { computeStats } from '../imaging/stats';
import { computePhash } from '../imaging/similarity';
import { classifyPhoto, correctionDefault } from '../classify/classify';
import { renderCorrected } from '../imaging/correction';
import { canvasToBlob, scaleToCanvas } from '../imaging/decode';
import { detectFaces, detectFacesWithDescriptors, type FaceWithDescriptor } from './faces';
import { scorePhoto } from './score';
import { bestDistance, isPossibleMatch } from '../restricted/matching';
import { loadActiveReferenceSets } from '../restricted/store';
import type { PhotoAnalysis, PhotoRecord, RestrictedFlag } from '../types';

// v2: face descriptors stored with analysis (identity spread + restricted
// matching share one detection pass).
export const ANALYSIS_VERSION = 2;

/** Mobile Safari struggles beyond a couple of simultaneous full-res decodes. */
const CONCURRENCY = 2;

export interface IngestProgress {
  total: number;
  done: number;
  failed: number;
  stage: string;
}

type ProgressCb = (p: IngestProgress) => void;

/** Returns the ids of successfully ingested photos (duplicates skipped). */
export async function ingestFiles(
  reelId: string,
  files: File[],
  onProgress?: ProgressCb,
): Promise<string[]> {
  const existingCount = await db.photos.where('reelId').equals(reelId).count();
  const progress: IngestProgress = {
    total: files.length,
    done: 0,
    failed: 0,
    stage: 'Looking through your photos',
  };
  onProgress?.(progress);

  // Load restricted references once per batch. If profiles exist but their
  // references cannot be read, we must not quietly screen against nothing —
  // every photo with a face is held for review instead.
  let referenceSets: Awaited<ReturnType<typeof loadActiveReferenceSets>> = [];
  let screeningUnavailable = false;
  try {
    referenceSets = await loadActiveReferenceSets();
  } catch (err) {
    console.error('Could not read restricted-child references:', err);
    screeningUnavailable = (await db.restrictedProfiles.filter((p) => !p.disabled).count()) > 0;
  }

  let index = 0;
  const queue = files.map((file, i) => ({ file, order: existingCount + i }));
  const ingestedIds: string[] = [];

  const worker = async () => {
    while (index < queue.length) {
      const item = queue[index++];
      try {
        const id = await ingestOne(
          reelId,
          item.file,
          item.order,
          referenceSets,
          screeningUnavailable,
        );
        if (id) ingestedIds.push(id);
      } catch (err) {
        progress.failed++;
        console.error('Failed to ingest', item.file.name, err);
      }
      progress.done++;
      onProgress?.({ ...progress });
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  await trackUsage('analysis', `${files.length} photos`);
  return ingestedIds;
}

async function ingestOne(
  reelId: string,
  file: File,
  order: number,
  referenceSets: Awaited<ReturnType<typeof loadActiveReferenceSets>>,
  screeningUnavailable = false,
): Promise<string | null> {
  const id = uid();
  const record: PhotoRecord = {
    id,
    reelId,
    hash: '',
    fileName: file.name,
    mimeType: file.type || 'image/jpeg',
    bytes: file.size,
    width: 0,
    height: 0,
    addedAt: Date.now(),
    order,
    exif: {},
    correctionEnabled: false,
    hasCorrected: false,
    included: true,
    restrictedFlags: [],
    status: 'ingesting',
  };
  await db.photos.add(record);

  try {
    // 1. Preserve the original untouched.
    await putBlob(blobKey.original(id), file);
    record.hash = await hashBlob(file);

    // Skip exact duplicates already in this reel.
    const twin = await db.photos
      .where('hash')
      .equals(record.hash)
      .filter((p) => p.reelId === reelId && p.id !== id && p.status !== 'error')
      .first();
    if (twin) {
      await db.photos.delete(id);
      await db.blobs.delete(blobKey.original(id));
      return null;
    }

    // 2. Decode + derivatives.
    const bitmap = await decodeImageFile(file);
    const derivatives = await makeDerivatives(bitmap);
    record.width = derivatives.width;
    record.height = derivatives.height;
    await putBlob(blobKey.preview(id), derivatives.preview);
    await putBlob(blobKey.thumb(id), derivatives.thumb);
    record.status = 'analyzing';
    await db.photos.put({ ...record });

    // 3. EXIF + measurements.
    record.exif = await readExif(file);
    const previewCanvas = derivatives.previewCanvas;

    const cached = await db.analysisCache.get(record.hash);
    let analysis: PhotoAnalysis;

    // A cached analysis whose face scan failed is not an answer — redo it, or
    // the one bad moment (model still loading, offline) would follow these
    // exact bytes into every future reel.
    if (cached && cached.analysis.version === ANALYSIS_VERSION && !cached.analysis.screeningIncomplete) {
      analysis = cached.analysis;
    } else {
      // Measure on an analysis-sized copy to keep pixel passes fast.
      const analysisCanvas = scaleToCanvas(bitmap, 800);
      const ctx = analysisCanvas.getContext('2d', { willReadFrequently: true })!;
      const imageData = ctx.getImageData(0, 0, analysisCanvas.width, analysisCanvas.height);
      const pixelBuf = {
        data: imageData.data,
        width: analysisCanvas.width,
        height: analysisCanvas.height,
      };
      const stats = computeStats(pixelBuf);
      const phash = computePhash(pixelBuf);
      const classification = classifyPhoto(record.exif, stats, {
        width: record.width,
        height: record.height,
        mimeType: record.mimeType,
      });
      // One detection pass serves crop planning, within-set identity
      // recognition AND restricted-child matching.
      const { detected, degraded } = await detectWithDescriptorsSafe(previewCanvas);
      const faces = detected.map((d) => d.box);
      const score = scorePhoto({ stats, faces, width: record.width, height: record.height });
      analysis = {
        stats,
        faces,
        // Leave descriptors off entirely when the scan was degraded, so a
        // later re-scan can tell "not checked" from "checked, nobody there".
        descriptors: degraded ? undefined : detected.map((d) => Array.from(d.descriptor)),
        screeningIncomplete: degraded || undefined,
        phash,
        classification,
        score,
        analyzedAt: Date.now(),
        version: ANALYSIS_VERSION,
      };
      // Never cache a degraded scan — it would make the failure permanent.
      if (!degraded) await db.analysisCache.put({ hash: record.hash, analysis });
    }
    record.analysis = analysis;

    // 4. Restricted-child matching — always fresh, never cached.
    if (referenceSets.length > 0) {
      record.restrictedFlags = matchRestrictedFromAnalysis(
        analysis.faces,
        analysis.descriptors ?? [],
        referenceSets,
      );
      // Profiles are active but this photo's faces could not be identified,
      // so "no flags" here means "we don't know", not "nobody matched".
      record.unscreened = analysis.screeningIncomplete ? true : undefined;
    } else if (screeningUnavailable && analysis.faces.length > 0) {
      // Profiles exist but could not be read at all this batch.
      record.unscreened = true;
    }

    // 5. Restrained correction for mobile photos that need it.
    if (correctionDefault(analysis.classification, analysis.stats)) {
      const { canvas, changed } = renderCorrected(previewCanvas, analysis.stats);
      if (changed) {
        await putBlob(blobKey.corrected(id), await canvasToBlob(canvas, 'image/jpeg', 0.92));
        record.hasCorrected = true;
        record.correctionEnabled = true;
      }
    }

    bitmap.close();
    record.status = 'ready';
    await db.photos.put({ ...record });
    return id;
  } catch (err) {
    record.status = 'error';
    record.error = err instanceof Error ? err.message : String(err);
    await db.photos.put({ ...record });
    throw err;
  }
}

/**
 * Faces + descriptors, degrading gracefully to detection-only.
 *
 * `degraded` is the important part: it means we found faces we could not
 * identify. Crop planning is happy with boxes alone, but restricted-child
 * screening is not — an unscreened photo must never be mistaken for a
 * cleared one, so callers hold it for review and refuse to cache the result.
 */
async function detectWithDescriptorsSafe(
  canvas: HTMLCanvasElement,
): Promise<{ detected: FaceWithDescriptor[]; degraded: boolean }> {
  try {
    return { detected: await detectFacesWithDescriptors(canvas), degraded: false };
  } catch (err) {
    console.warn('Descriptor computation unavailable, using detection only:', err);
    try {
      const boxes = await detectFaces(canvas);
      return {
        detected: boxes.map((box) => ({ box, descriptor: new Float32Array(0) })),
        // Only a photo with faces is at risk; a landscape with none is fine.
        degraded: boxes.length > 0,
      };
    } catch {
      return { detected: [], degraded: true };
    }
  }
}

function matchRestrictedFromAnalysis(
  faces: RestrictedFlag['face'][],
  descriptors: number[][],
  referenceSets: Awaited<ReturnType<typeof loadActiveReferenceSets>>,
): RestrictedFlag[] {
  const flags: RestrictedFlag[] = [];
  for (let i = 0; i < faces.length; i++) {
    const descriptor = descriptors[i];
    if (!descriptor || descriptor.length === 0) continue;
    for (const { profile, embeddings } of referenceSets) {
      const distance = bestDistance(descriptor, embeddings);
      if (isPossibleMatch(distance)) {
        flags.push({
          profileId: profile.id,
          profileLabel: profile.label,
          face: faces[i],
          distance,
          status: 'pending',
        });
      }
    }
  }
  return flags;
}

/**
 * Re-run restricted matching for every photo in a reel (used after profiles
 * change, so existing uploads are re-checked against new references).
 */
export async function rescanReelForRestricted(reelId: string): Promise<number> {
  const referenceSets = await loadActiveReferenceSets();
  const photos = await db.photos.where('reelId').equals(reelId).toArray();
  let flagged = 0;
  for (const photo of photos) {
    if (photo.status !== 'ready') continue;
    // Prefer descriptors stored with the analysis; older records without
    // them get one fresh detection pass.
    let faces = photo.analysis?.faces ?? [];
    let descriptors = photo.analysis?.descriptors ?? [];
    // Re-detect when we have faces but no usable identity for them — that
    // covers older records, and photos whose first scan failed. This is the
    // repair path: without it a photo that failed once stays unchecked.
    const missingDescriptors =
      faces.length > 0 &&
      (descriptors.length !== faces.length || descriptors.some((d) => d.length === 0));
    let stillIncomplete = missingDescriptors;
    if (missingDescriptors) {
      const previewBlob = await db.blobs.get(blobKey.preview(photo.id));
      if (previewBlob) {
        const bitmap = await createImageBitmap(previewBlob.blob);
        const canvas = scaleToCanvas(bitmap, 1600);
        bitmap.close();
        const { detected, degraded } = await detectWithDescriptorsSafe(canvas);
        faces = detected.map((d) => d.box);
        descriptors = degraded ? [] : detected.map((d) => Array.from(d.descriptor));
        stillIncomplete = degraded;
        if (!degraded && photo.analysis) {
          // Repaired — remember it so the next reel doesn't redo the work.
          const repaired = { ...photo.analysis, faces, descriptors, screeningIncomplete: undefined };
          await db.photos.update(photo.id, { analysis: repaired });
          await db.analysisCache.put({ hash: photo.hash, analysis: repaired });
        }
      }
    }
    const fresh =
      referenceSets.length > 0
        ? matchRestrictedFromAnalysis(faces, descriptors, referenceSets)
        : [];
    // Preserve prior review decisions for the same profile.
    const merged = fresh.map((f) => {
      const prior = photo.restrictedFlags.find((p) => p.profileId === f.profileId);
      return prior && prior.status !== 'pending' ? { ...f, status: prior.status, reviewedAt: prior.reviewedAt, reviewedBy: prior.reviewedBy } : f;
    });
    if (merged.length > 0) flagged++;
    await db.photos.update(photo.id, {
      restrictedFlags: merged,
      unscreened: referenceSets.length > 0 && stillIncomplete ? true : undefined,
    });
  }
  return flagged;
}
