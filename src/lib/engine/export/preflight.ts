// Preflight — the checks that run before export is allowed. Pure and
// testable: every check receives plain data and returns findings.

import type { BrandConfig, PhotoRecord, ReelRecord } from '../../types';
import type { Timeline } from '../types';
import { exportBlockers } from '../../restricted/matching';

export interface PreflightFinding {
  id: string;
  level: 'block' | 'warn' | 'ok';
  message: string;
}

export interface PreflightInput {
  reel: ReelRecord;
  timeline: Timeline;
  photos: PhotoRecord[];
  brand: BrandConfig;
  /** photoIds that have a decodable image available. */
  availablePhotoIds: Set<string>;
  audioAvailable: boolean;
  fontsAvailable: boolean;
  logoAvailable: boolean;
}

export function runPreflight(input: PreflightInput): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  const { reel, timeline, photos, brand } = input;

  // 1. Restricted-child review must be complete — hard block.
  const blockers = exportBlockers(photos);
  if (blockers.pendingReview > 0) {
    findings.push({
      id: 'restricted-pending',
      level: 'block',
      message: `${blockers.pendingReview} photo${blockers.pendingReview > 1 ? 's need' : ' needs'} restricted-child review before export.`,
    });
  } else if (blockers.blocked > 0) {
    findings.push({
      id: 'restricted-blocked',
      level: 'block',
      message: `${blockers.blocked} blocked photo${blockers.blocked > 1 ? 's are' : ' is'} still marked as included. Remove or exclude ${blockers.blocked > 1 ? 'them' : 'it'}.`,
    });
  } else if (blockers.unscreened > 0) {
    findings.push({
      id: 'restricted-unscreened',
      level: 'block',
      message: `${blockers.unscreened} photo${blockers.unscreened > 1 ? 's' : ''} couldn’t be checked against your restricted profiles — the face model didn’t load. Re-scan from Photo Restrictions, or review ${blockers.unscreened > 1 ? 'them' : 'it'} yourself before exporting.`,
    });
  } else {
    findings.push({ id: 'restricted-ok', level: 'ok', message: 'Photo safety review complete.' });
  }

  // 2. Every photo the timeline references must exist and be loadable.
  const usedIds = new Set<string>();
  for (const clip of timeline.clips) {
    for (const layer of clip.layers) usedIds.add(layer.photoId);
  }
  const missing = [...usedIds].filter((id) => !input.availablePhotoIds.has(id));
  if (usedIds.size === 0) {
    findings.push({ id: 'no-photos', level: 'block', message: 'This reel has no photos yet.' });
  } else if (missing.length > 0) {
    findings.push({
      id: 'missing-images',
      level: 'block',
      message: `${missing.length} photo${missing.length > 1 ? 's are' : ' is'} missing or failed to load.`,
    });
  } else {
    findings.push({ id: 'photos-ok', level: 'ok', message: `${usedIds.size} photos ready.` });
  }

  // 3. Text inside safe bounds.
  const outOfBounds = timeline.overlays.filter(
    (o) => o.kind !== 'logo' && (o.pos.y < 0.045 || o.pos.y > 0.94 || o.pos.x < 0.05 || o.pos.x > 0.95),
  );
  findings.push(
    outOfBounds.length > 0
      ? {
          id: 'text-bounds',
          level: 'warn',
          message: 'Some text sits close to the edge and may be covered by app chrome.',
        }
      : { id: 'text-ok', level: 'ok', message: 'Text is inside safe bounds.' },
  );

  // 4. Resolution.
  findings.push(
    timeline.width === 1080 && timeline.height === 1920
      ? { id: 'res-ok', level: 'ok', message: '1080 × 1920 vertical.' }
      : {
          id: 'res-bad',
          level: 'block',
          message: `Unexpected resolution ${timeline.width}×${timeline.height}.`,
        },
  );

  // 5. Audio present when selected.
  if (reel.instagramAudio) {
    // Instagram Audio: a silent export is the correct output by design.
    findings.push({
      id: 'audio-instagram',
      level: 'ok',
      message: `Silent export by design — add “${reel.instagramAudio.songTitle}${reel.instagramAudio.artist ? ` — ${reel.instagramAudio.artist}` : ''}” on Instagram.`,
    });
  } else if (reel.musicAssetKey) {
    findings.push(
      input.audioAvailable
        ? { id: 'audio-ok', level: 'ok', message: `Music: ${reel.musicName ?? 'selected track'}.` }
        : {
            id: 'audio-missing',
            level: 'block',
            message: 'The selected music track could not be loaded.',
          },
    );
  } else {
    findings.push({ id: 'audio-none', level: 'ok', message: 'No music (silent reel).' });
  }

  // 6. Brand assets used by the timeline.
  const usesBrandFont = timeline.overlays.some((o) => o.kind !== 'logo');
  if (usesBrandFont && (brand.primaryFont || brand.secondaryFont)) {
    findings.push(
      input.fontsAvailable
        ? { id: 'fonts-ok', level: 'ok', message: 'Brand fonts loaded.' }
        : { id: 'fonts-missing', level: 'warn', message: 'Brand fonts could not be loaded — falling back to standard type.' },
    );
  }
  const usesLogo = timeline.overlays.some((o) => o.kind === 'logo');
  if (usesLogo) {
    findings.push(
      input.logoAvailable
        ? { id: 'logo-ok', level: 'ok', message: 'Logo ready.' }
        : { id: 'logo-missing', level: 'warn', message: 'Logo could not be loaded and will be omitted.' },
    );
  }

  return findings;
}

export const preflightPasses = (findings: PreflightFinding[]): boolean =>
  findings.every((f) => f.level !== 'block');

/** Very rough H.264 size estimate for the export screen. */
export function estimateFileSizeBytes(timeline: Timeline): number {
  const videoBitrate = 9_000_000; // QUALITY_HIGH at 1080×1920 ≈ 8–10 Mbps
  const audioBitrate = timeline.audio ? 192_000 : 0;
  return Math.round(((videoBitrate + audioBitrate) / 8) * (timeline.durationMs / 1000));
}
