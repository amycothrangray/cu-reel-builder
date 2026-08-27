// Client for the optional serverless vision analysis. Sends small (≤512px)
// JPEG previews only — never originals, never restricted-child data. All
// failures degrade silently to local heuristics.

import { blobKey, db, getBlob, trackUsage } from '../db';
import { scaleToCanvas, canvasToBlob } from '../imaging/decode';
import type { AiInsight, PhotoRecord } from '../types';

const AI_EDGE = 512;

interface WireJudgment {
  id: string;
  storyRole?: AiInsight['storyRole'];
  subjectRect?: { x: number; y: number; w: number; h: number };
  appeal?: number;
  notes?: string;
}

let aiKnownUnavailable = false;

export const resetAiAvailability = (): void => {
  aiKnownUnavailable = false;
};

/**
 * Enrich the photos of a reel with AI insight. Results are written into each
 * photo's cached analysis (keyed by content hash), so a photo is only ever
 * analyzed once per content — reuse is free.
 */
export async function enrichWithAi(reelId: string): Promise<boolean> {
  if (aiKnownUnavailable) return false;
  const photos = await db.photos.where('reelId').equals(reelId).toArray();
  const pending = photos.filter((p) => p.status === 'ready' && p.analysis && !p.analysis.ai);
  if (pending.length === 0) return false;

  const payload: { id: string; data: string }[] = [];
  for (const photo of pending) {
    const preview = await getBlob(blobKey.preview(photo.id));
    if (!preview) continue;
    try {
      const bitmap = await createImageBitmap(preview);
      const canvas = scaleToCanvas(bitmap, AI_EDGE);
      bitmap.close();
      const jpeg = await canvasToBlob(canvas, 'image/jpeg', 0.8);
      payload.push({ id: photo.id, data: await blobToBase64(jpeg) });
    } catch {
      // skip undecodable photo
    }
  }
  if (payload.length === 0) return false;

  try {
    const res = await fetch('/api/analyze-photos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ images: payload }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { enabled: boolean; results: WireJudgment[] };
    if (!data.enabled) {
      aiKnownUnavailable = true;
      return false;
    }
    await trackUsage('ai-call', `${payload.length} photos`);
    let applied = false;
    for (const judgment of data.results ?? []) {
      const photo = pending.find((p) => p.id === judgment.id);
      if (!photo?.analysis) continue;
      const ai: AiInsight = {
        storyRole: judgment.storyRole,
        subjectRect: judgment.subjectRect,
        appeal: judgment.appeal,
        notes: judgment.notes,
      };
      const analysis = { ...photo.analysis, ai };
      await db.photos.update(photo.id, { analysis });
      await db.analysisCache.put({ hash: photo.hash, analysis });
      applied = true;
    }
    return applied;
  } catch {
    return false;
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export type { PhotoRecord };
