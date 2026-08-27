// Template registry. Templates are reusable algorithms: given any photo set
// they decide sequence, crops, motion, pacing and typography themselves.

import type { TemplateId } from '../../types';
import type { Timeline } from '../types';
import type { SequencePhoto } from '../sequence';
import type { TemplateContext } from './shared';
import { buildSignatureEnergy } from './signatureEnergy';
import { buildCinematicStory } from './cinematicStory';
import { buildQuickCut } from './quickCut';
import { buildEditorialMinimal } from './editorialMinimal';
import { buildPhotoStory } from './photoStory';

export interface TemplateDefinition {
  id: TemplateId;
  name: string;
  description: string;
  pace: string;
  idealFor: string;
  build: (photos: SequencePhoto[], ctx: TemplateContext) => Timeline;
}

export const TEMPLATES: TemplateDefinition[] = [
  {
    id: 'signature-energy',
    name: 'Signature Energy',
    description: 'Fast, upbeat and polished — your photography stays the hero.',
    pace: '~1.5–2s per photo',
    idealFor: 'Family, senior and beach sessions; general marketing',
    build: buildSignatureEnergy,
  },
  {
    id: 'cinematic-story',
    name: 'Cinematic Story',
    description: 'Slower and more emotional, with soft transitions and room for a sentence.',
    pace: '~2.5–3s per photo',
    idealFor: 'Storytelling posts, milestones, nostalgia',
    build: buildCinematicStory,
  },
  {
    id: 'quick-cut',
    name: 'Quick Cut',
    description: 'Rapid, beat-driven cuts with occasional stacked compositions.',
    pace: '~1s per photo',
    idealFor: 'Events, photo dumps, behind-the-scenes',
    build: buildQuickCut,
  },
  {
    id: 'editorial-minimal',
    name: 'Editorial Minimal',
    description: 'Clean and deliberate, with gallery framing and elegant type.',
    pace: '~2–2.5s per photo',
    idealFor: 'High-end family work, seniors, branding',
    build: buildEditorialMinimal,
  },
  {
    id: 'photo-story',
    name: 'Photo Story',
    description: 'Arranges your set into a little narrative, from opening scene to final embrace.',
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

  if (n >= 12) return 'quick-cut'; // big sets thrive on pace
  if (roles.size >= 4) return 'photo-story'; // rich narrative variety
  if (withFaces / Math.max(1, n) < 0.4) return 'editorial-minimal'; // scenic/detail sets
  if (horizontals / Math.max(1, n) > 0.7 && n <= 7) return 'cinematic-story';
  // Default, with a seeded coin-flip between the two energetic options.
  return seed % 5 === 0 ? 'photo-story' : 'signature-energy';
}
