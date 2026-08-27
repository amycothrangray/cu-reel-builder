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
import { detectFaces, detectFacesWithDescriptors } from './faces';
import { scorePhoto } from './score';
import { bestDistance, isPossibleMatch } from '../restricted/matching';
import { loadActiveReferenceSets } from '../restricted/store';
import type { PhotoAnalysis, PhotoRecord, RestrictedFlag } from '../types';

export const ANALYSIS_VERSION = 1;

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

  // Load restricted references once per batch.
  const referenceSets = await loadActiveReferenceSets().catch(() => []);

  let index = 0;
  const queue = files.map((file, i) => ({ file, order: existingCount + i }));
  const ingestedIds: string[] = [];

  const worker = async () => {
    while (index < queue.length) {
      const item = queue[index++];
      try {
        const id = await ingestOne(reelId, item.file, item.order, referenceSets);
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

    if (cached && cached.analysis.version === ANALYSIS_VERSION) {
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
      const faces = await detectFaces(previewCanvas);
      const score = scorePhoto({ stats, faces, width: record.width, height: record.height });
      analysis = {
        stats,
        faces,
        phash,
        classification,
        score,
        analyzedAt: Date.now(),
        version: ANALYSIS_VERSION,
      };
      await db.analysisCache.put({ hash: record.hash, analysis });
    }
    record.analysis = analysis;

    // 4. Restricted-child matching — always fresh, never cached.
    if (referenceSets.length > 0) {
      record.restrictedFlags = await matchRestricted(previewCanvas, referenceSets);
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

async function matchRestricted(
  previewCanvas: HTMLCanvasElement,
  referenceSets: Awaited<ReturnType<typeof loadActiveReferenceSets>>,
): Promise<RestrictedFlag[]> {
  try {
    const faces = await detectFacesWithDescriptors(previewCanvas);
    const flags: RestrictedFlag[] = [];
    for (const face of faces) {
      for (const { profile, embeddings } of referenceSets) {
        const distance = bestDistance(face.descriptor, embeddings);
        if (isPossibleMatch(distance)) {
          flags.push({
            profileId: profile.id,
            profileLabel: profile.label,
            face: face.box,
            distance,
            status: 'pending',
          });
        }
      }
    }
    return flags;
  } catch (err) {
    console.warn('Restricted matching failed for one photo:', err);
    return [];
  }
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
    const previewBlob = await db.blobs.get(blobKey.preview(photo.id));
    if (!previewBlob) continue;
    const bitmap = await createImageBitmap(previewBlob.blob);
    const canvas = scaleToCanvas(bitmap, 1600);
    bitmap.close();
    const fresh =
      referenceSets.length > 0 ? await matchRestricted(canvas, referenceSets) : [];
    // Preserve prior review decisions for the same profile.
    const merged = fresh.map((f) => {
      const prior = photo.restrictedFlags.find((p) => p.profileId === f.profileId);
      return prior && prior.status !== 'pending' ? { ...f, status: prior.status, reviewedAt: prior.reviewedAt, reviewedBy: prior.reviewedBy } : f;
    });
    if (merged.length > 0) flagged++;
    await db.photos.update(photo.id, { restrictedFlags: merged });
  }
  return flagged;
}
