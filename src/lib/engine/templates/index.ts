// Template registry. Templates are reusable algorithms: given any photo set
// they decide sequence, crops, motion, pacing and typography themselves.

import type { TemplateId } from '../../types';
import type { Timeline } from '../types';
import type { SequencePhoto } from '../sequence';
import type { TemplateContext } from './shared';
import { buildSignatureEnergy } from './signatureEnergy';
import { buildCinematicStory } from './cinematicStory';
import { buildQuickCut } from './quickCut';
import { buildRapidFire, rapidFireCapacity } from './rapidFire';
import { buildEditorialMinimal } from './editorialMinimal';
import { buildPhotoStory } from './photoStory';

export interface TemplateDefinition {
  id: TemplateId;
  name: string;
  description: string;
  pace: string;
  idealFor: string;
  /** Shortest slide this style allows — the absolute physical floor. */
  minSlideMs: number;
  /**
   * The pace this style actually promises. The engine never crams photos
   * faster than this on its own — extra photos wait for a longer reel or a
   * faster style rather than everything speeding up.
   */
  comfortableSlideMs: number;
  /** Typical photos the style chooses on its own, per second of reel. */
  idealPerSecond: number;
  build: (photos: SequencePhoto[], ctx: TemplateContext) => Timeline;
}

/** Absolute maximum photos that physically fit (may feel rushed). */
export function templateCapacity(template: TemplateDefinition, durationMs: number): number {
  if (template.id === 'rapid-fire') return rapidFireCapacity(durationMs);
  return Math.max(3, Math.floor(durationMs / template.minSlideMs));
}

/** Photos that fit at this style's promised pace — the number that matters. */
export function templateComfortableCapacity(
  template: TemplateDefinition,
  durationMs: number,
): number {
  if (template.id === 'rapid-fire') return rapidFireCapacity(durationMs);
  return Math.max(3, Math.floor(durationMs / template.comfortableSlideMs));
}

export interface PacingReport {
  photoCount: number;
  perPhotoMs: number;
  comfortableCapacity: number;
  physicalCapacity: number;
  /** True when the reel is running faster than the style promises. */
  rushed: boolean;
  /** Shortest whole-second reel length that would hold this many comfortably. */
  neededSec: number | null;
}

/**
 * The reel length (whole seconds) this many photos would naturally fill at
 * the style's comfortable pace — the answer to "how long would this be?".
 * Clamped to the app's allowed duration range; null when even the maximum
 * can't comfortably hold that many (Rapid Fire aside, which always can).
 */
export function estimateDurationSec(
  template: TemplateDefinition,
  photoCount: number,
  maxSec = 60,
): number | null {
  const n = Math.max(3, photoCount);
  for (let sec = 5; sec <= maxSec; sec++) {
    if (templateComfortableCapacity(template, sec * 1000) >= n) return sec;
  }
  return null;
}

/**
 * The shortest reel that can hold this many photos AT ALL, at the style's
 * hard floor. This is the number to offer when photos she added didn't fit:
 * it is the length that makes room for every one of them, even if the result
 * runs faster than the style's promised pace.
 */
export function lengthThatFitsSec(
  template: TemplateDefinition,
  photoCount: number,
  maxSec = 60,
): number | null {
  const n = Math.max(1, photoCount);
  for (let sec = 5; sec <= maxSec; sec++) {
    if (templateCapacity(template, sec * 1000) >= n) return sec;
  }
  return null;
}

/**
 * The calmest style that can still hold this many photos in a reel of this
 * length — the honest answer to "which style would fit them all?". Prefers a
 * style that fits them at its promised pace; falls back to the roomiest one.
 */
export function styleThatFits(
  photoCount: number,
  durationMs: number,
  exclude?: TemplateId,
): TemplateDefinition | null {
  const options = TEMPLATES.filter((t) => t.id !== exclude);
  const comfortable = options
    .filter((t) => templateComfortableCapacity(t, durationMs) >= photoCount)
    .sort((a, b) => b.comfortableSlideMs - a.comfortableSlideMs);
  if (comfortable.length > 0) return comfortable[0];
  const anyFit = options
    .filter((t) => templateCapacity(t, durationMs) >= photoCount)
    .sort((a, b) => b.comfortableSlideMs - a.comfortableSlideMs);
  return anyFit[0] ?? null;
}

/** How this many photos actually paces in a reel of this length. */
export function pacingFor(
  template: TemplateDefinition,
  durationMs: number,
  photoCount: number,
): PacingReport {
  const comfortableCapacity = templateComfortableCapacity(template, durationMs);
  const physicalCapacity = templateCapacity(template, durationMs);
  const perPhotoMs = photoCount > 0 ? durationMs / photoCount : durationMs;
  const rushed = photoCount > comfortableCapacity;
  const neededSec = rushed ? estimateDurationSec(template, photoCount) : null;
  return { photoCount, perPhotoMs, comfortableCapacity, physicalCapacity, rushed, neededSec };
}

export const TEMPLATES: TemplateDefinition[] = [
  {
    id: 'signature-energy',
    comfortableSlideMs: 1500,
    minSlideMs: 900,
    idealPerSecond: 0.59,
    name: 'Signature Energy',
    description: 'Fast, lively and polished — loves a larger set, photography stays the hero.',
    pace: '~1.5–2s per photo',
    idealFor: 'Family, senior and beach sessions; general marketing',
    build: buildSignatureEnergy,
  },
  {
    id: 'cinematic-story',
    comfortableSlideMs: 2500,
    minSlideMs: 1600,
    idealPerSecond: 0.38,
    name: 'Cinematic Story',
    description: 'Longer holds and emotional pacing. Best with a selective set — it breathes.',
    pace: '~2.5–3s per photo',
    idealFor: 'Storytelling posts, milestones, nostalgia',
    build: buildCinematicStory,
  },
  {
    id: 'quick-cut',
    comfortableSlideMs: 850,
    minSlideMs: 450,
    idealPerSecond: 0.95,
    name: 'Quick Cut',
    description: 'High-energy rapid sequencing with stacks and bursts — great for lots of moments and action.',
    pace: '~1s per photo',
    idealFor: 'Events, photo dumps, behind-the-scenes',
    build: buildQuickCut,
  },
  {
    id: 'rapid-fire',
    comfortableSlideMs: 120,
    minSlideMs: 120,
    idealPerSecond: 5.0,
    name: 'Rapid Fire',
    description: 'Blink-and-you-miss-it — your whole set in quick hits, under half a second each.',
    pace: '~0.15–0.5s per photo',
    idealFor: 'Big sets (50–100+ photos), events, year-in-review, photo dumps',
    build: buildRapidFire,
  },
  {
    id: 'editorial-minimal',
    comfortableSlideMs: 2100,
    minSlideMs: 1400,
    idealPerSecond: 0.45,
    name: 'Editorial Minimal',
    description: 'Lets exceptional photographs simply sit there. Best with a small curated set — restraint is the style.',
    pace: '~2–2.5s per photo',
    idealFor: 'High-end family work, seniors, branding',
    build: buildEditorialMinimal,
  },
  {
    id: 'photo-story',
    comfortableSlideMs: 1800,
    minSlideMs: 900,
    idealPerSecond: 0.53,
    name: 'Photo Story',
    description: 'Feels like experiencing the session or event — an arc from opening scene to emotional close.',
    pace: '~2s per photo',
    idealFor: 'Session recaps, destination shoots, BTS + finals',
    build: buildPhotoStory,
  },
];

export const getTemplate = (id: TemplateId): TemplateDefinition =>
  TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];

/**
 * "Surprise Me": choose a template from the character of the photo set.
 * Deterministic given the same photos + seed.
 */
export function surpriseMe(photos: SequencePhoto[], seed: number): TemplateId {
  const n = photos.length;
  const horizontals = photos.filter((p) => p.width > p.height).length;
  const withFaces = photos.filter((p) => p.faces.length > 0).length;
  const roles = new Set(photos.map((p) => (p.ai?.storyRole ? p.ai.storyRole : null)).filter(Boolean));

  if (n >= 30) return 'rapid-fire'; // huge sets want the flash treatment
  if (n >= 12) return 'quick-cut'; // big sets thrive on pace
  if (roles.size >= 4) return 'photo-story'; // rich narrative variety
  if (withFaces / Math.max(1, n) < 0.4) return 'editorial-minimal'; // scenic/detail sets
  if (horizontals / Math.max(1, n) > 0.7 && n <= 7) return 'cinematic-story';
  // Default, with a seeded coin-flip between the two energetic options.
  return seed % 5 === 0 ? 'photo-story' : 'signature-energy';
}
