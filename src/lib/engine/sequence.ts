// Photo sequencing: which photo opens, which closes, what order the rest
// take, and how many the reel needs. Pure — testable in Node.

import { phashDistance, DUPLICATE_THRESHOLD } from '../imaging/similarity';
import type { AiInsight, FaceBox, ImageStats, NRect } from '../types';

export interface SequencePhoto {
  id: string;
  width: number;
  height: number;
  score: number;
  phash: string;
  faces: FaceBox[];
  stats: ImageStats;
  ai?: AiInsight;
  aiSubject?: NRect;
}

/** Deterministic PRNG so a given seed reproduces the same arrangement. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isPortrait = (p: SequencePhoto) => p.height >= p.width;
const hasFace = (p: SequencePhoto) => p.faces.length > 0;

/** Strong opener: sharp, subject-forward, ideally portrait with a face. */
export function pickOpening(photos: SequencePhoto[]): SequencePhoto {
  const ranked = [...photos].sort(
    (a, b) =>
      b.score +
      (hasFace(b) ? 0.15 : 0) +
      (isPortrait(b) ? 0.08 : 0) -
      (a.score + (hasFace(a) ? 0.15 : 0) + (isPortrait(a) ? 0.08 : 0)),
  );
  return ranked[0];
}

/** Closer: emotional/portrait image distinct from the opener. */
export function pickClosing(photos: SequencePhoto[], openingId: string): SequencePhoto {
  const candidates = photos.filter((p) => p.id !== openingId);
  if (candidates.length === 0) return photos[0];
  const ranked = [...candidates].sort(
    (a, b) =>
      b.score +
      (b.ai?.storyRole === 'closing' || b.ai?.storyRole === 'emotional' ? 0.2 : 0) +
      (hasFace(b) ? 0.1 : 0) -
      (a.score + (a.ai?.storyRole === 'closing' || a.ai?.storyRole === 'emotional' ? 0.2 : 0) + (hasFace(a) ? 0.1 : 0)),
  );
  return ranked[0];
}

/**
 * Order the middle so adjacent photos aren't near-duplicates and the visual
 * texture alternates (faces / no faces, portrait / landscape) when possible.
 * Greedy: from the current photo, prefer the most *different* good photo.
 */
export function orderMiddle(
  photos: SequencePhoto[],
  after: SequencePhoto,
  rand: () => number,
): SequencePhoto[] {
  const remaining = [...photos];
  const ordered: SequencePhoto[] = [];
  let current = after;
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      const dist = phashDistance(current.phash, cand.phash);
      const dupePenalty = dist <= DUPLICATE_THRESHOLD ? -1.5 : 0;
      const variety =
        (hasFace(cand) !== hasFace(current) ? 0.2 : 0) +
        (isPortrait(cand) !== isPortrait(current) ? 0.12 : 0) +
        Math.min(dist / 64, 0.4);
      const score = cand.score * 0.6 + variety + dupePenalty + rand() * 0.05;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    current = remaining.splice(bestIdx, 1)[0];
    ordered.push(current);
  }
  return ordered;
}

/** Standard arrangement: opener → varied middle → closer. */
export function arrangePhotos(
  photos: SequencePhoto[],
  count: number,
  seed: number,
): SequencePhoto[] {
  if (photos.length === 0) return [];
  const rand = mulberry32(seed);
  const n = Math.min(count, photos.length);
  const opening = pickOpening(photos);
  const closing = n >= 2 ? pickClosing(photos, opening.id) : null;
  const middlePool = photos.filter((p) => p.id !== opening.id && p.id !== closing?.id);
  const middle = orderMiddle(middlePool, opening, rand).slice(0, Math.max(0, n - (closing ? 2 : 1)));
  return closing ? [opening, ...middle, closing] : [opening, ...middle];
}

// ---------------------------------------------------------------------------
// Photo Story: arrange by narrative role.

const STORY_ORDER: NonNullable<AiInsight['storyRole']>[] = [
  'establishing',
  'interaction',
  'movement',
  'closeup',
  'detail',
  'portrait',
  'emotional',
  'closing',
];

/**
 * Infer a story role deterministically when AI hasn't provided one, from
 * measurable proxies: wide scenes establish, big faces are closeups, small
 * or no faces are details, multiple faces are interactions.
 */
export function inferStoryRole(p: SequencePhoto): NonNullable<AiInsight['storyRole']> {
  if (p.ai?.storyRole) return p.ai.storyRole;
  const biggestFace = p.faces.length > 0 ? Math.max(...p.faces.map((f) => f.w * f.h)) : 0;
  if (p.faces.length === 0) {
    return p.width > p.height ? 'establishing' : 'detail';
  }
  if (p.faces.length >= 2) return 'interaction';
  if (biggestFace > 0.06) return 'closeup';
  if (biggestFace < 0.01) return 'establishing';
  return 'portrait';
}

/** Order photos as a micro-story: establish → interact → close in → resolve. */
export function arrangeStory(photos: SequencePhoto[], count: number, seed: number): SequencePhoto[] {
  const rand = mulberry32(seed);
  const n = Math.min(count, photos.length);
  const byRole = new Map<string, SequencePhoto[]>();
  for (const p of photos) {
    const role = inferStoryRole(p);
    const list = byRole.get(role) ?? [];
    list.push(p);
    byRole.set(role, list);
  }
  for (const list of byRole.values()) {
    list.sort((a, b) => b.score - a.score + (rand() - 0.5) * 0.02);
  }
  const ordered: SequencePhoto[] = [];
  // Walk the narrative arc repeatedly until we have enough photos.
  let pass = 0;
  while (ordered.length < n && pass < 8) {
    for (const role of STORY_ORDER) {
      if (ordered.length >= n) break;
      const list = byRole.get(role);
      if (list && list.length > 0) {
        ordered.push(list.shift()!);
      }
    }
    pass++;
  }
  // Backfill from whatever remains, best first.
  if (ordered.length < n) {
    const used = new Set(ordered.map((p) => p.id));
    const rest = photos.filter((p) => !used.has(p.id)).sort((a, b) => b.score - a.score);
    ordered.push(...rest.slice(0, n - ordered.length));
  }
  // The strongest emotional/closing image should end the reel.
  const closingIdx = ordered.findIndex(
    (p) => inferStoryRole(p) === 'closing' || inferStoryRole(p) === 'emotional',
  );
  if (closingIdx >= 0 && closingIdx !== ordered.length - 1) {
    const [c] = ordered.splice(closingIdx, 1);
    ordered.push(c);
  }
  return ordered.slice(0, n);
}
