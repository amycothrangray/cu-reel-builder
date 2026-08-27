// Similarity understanding: several similar photographs are NOT
// automatically redundant. Three versions of one portrait → pick the best.
// Three frames of a jump → an intentional rapid micro-sequence that makes
// still photography feel alive. This module tells those apart.

import { phashDistance } from '../imaging/similarity';
import type { SequencePhoto } from '../engine/sequence';

/** ≤ this: essentially the same frame — redundant. */
const REDUNDANT_DISTANCE = 3;
/** Similar-but-evolving range that can read as sequential frames. */
const SEQUENCE_MIN = 4;
const SEQUENCE_MAX = 18;
/** Frames captured within this window can be one moment unfolding. */
const BURST_GAP_MS = 5000;

export interface SimilarityGroup {
  kind: 'redundant' | 'burst';
  photoIds: string[];
}

const sameOrientation = (a: SequencePhoto, b: SequencePhoto): boolean =>
  a.width > a.height === b.width > b.height;

/**
 * Scan capture-order neighbours and group them.
 *
 * - REDUNDANT: near-identical frames (alternate takes of one pose) — the
 *   edit should use the best one.
 * - BURST: similar frames evolving over seconds (running, jumping,
 *   laughing, the play, the award) — usable as a rapid sequence.
 *
 * Capture time drives burst detection; without EXIF times, upload order
 * plus 3+ consecutive similar frames is accepted as weaker evidence.
 */
export function detectSimilarityGroups(photos: SequencePhoto[]): SimilarityGroup[] {
  // Total order: capture time when known; untimed photos sort after, by
  // upload order (keeps timed neighbours adjacent in mixed sets).
  const sortKey = (p: SequencePhoto): number =>
    p.takenAt !== undefined ? p.takenAt : Number.MAX_SAFE_INTEGER / 2 + (p.uploadOrder ?? 0);
  const ordered = [...photos].sort((a, b) => sortKey(a) - sortKey(b));

  const groups: SimilarityGroup[] = [];
  let current: SequencePhoto[] = [];
  let currentKind: 'redundant' | 'burst' | null = null;

  const flush = () => {
    if (current.length >= 2 && currentKind) {
      // Weak-evidence bursts (no timestamps) need 3+ frames.
      const hasTime = current.every((p) => p.takenAt !== undefined);
      if (currentKind === 'burst' && !hasTime && current.length < 3) {
        groups.push({ kind: 'redundant', photoIds: current.map((p) => p.id) });
      } else {
        groups.push({ kind: currentKind, photoIds: current.map((p) => p.id) });
      }
    }
    current = [];
    currentKind = null;
  };

  for (let i = 0; i < ordered.length; i++) {
    const photo = ordered[i];
    const prev = current[current.length - 1];
    if (!prev) {
      current = [photo];
      continue;
    }
    const dist = phashDistance(prev.phash, photo.phash);
    const gapOk =
      prev.takenAt !== undefined && photo.takenAt !== undefined
        ? photo.takenAt - prev.takenAt <= BURST_GAP_MS
        : Math.abs((photo.uploadOrder ?? 0) - (prev.uploadOrder ?? 0)) <= 1;

    let kind: 'redundant' | 'burst' | null = null;
    if (gapOk && sameOrientation(prev, photo)) {
      if (dist <= REDUNDANT_DISTANCE) kind = 'redundant';
      else if (dist >= SEQUENCE_MIN && dist <= SEQUENCE_MAX) kind = 'burst';
    }

    if (kind && (currentKind === null || currentKind === kind)) {
      currentKind = kind;
      current.push(photo);
    } else if (kind && currentKind !== kind) {
      // A redundant pair inside a burst window (or vice versa): close the
      // group and start fresh from the previous photo.
      flush();
      current = [prev, photo];
      currentKind = kind;
    } else {
      flush();
      current = [photo];
    }
  }
  flush();
  return groups;
}

/** Best single frame from a redundant group. */
export function bestOfGroup(
  group: SimilarityGroup,
  photosById: Map<string, SequencePhoto>,
): string {
  let bestId = group.photoIds[0];
  let bestScore = -1;
  for (const id of group.photoIds) {
    const p = photosById.get(id);
    const score = (p?.score ?? 0) + (p?.required ? 10 : 0); // required always wins
    if (score > bestScore) {
      bestScore = score;
      bestId = id;
    }
  }
  return bestId;
}
