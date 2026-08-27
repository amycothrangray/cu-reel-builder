// Instagram Audio section logic — pure and testable.
//
// The user edits to a specific section of a song they'll add natively inside
// Instagram. These helpers slice the full-track analysis down to the chosen
// section, suggest strong sections, format the critical start timestamp, and
// derive a human-checkable sync cue.

import { INTENSITY_STEP_MS, type BeatAnalysis } from './beats';
import type { Timeline } from '../engine/types';

/** Beats/intensity of one section, re-based so the section starts at 0. */
export function sliceMusicAnalysis(
  analysis: Pick<BeatAnalysis, 'beats' | 'strongBeats' | 'intensity'>,
  startMs: number,
  durationMs: number,
): { beats: number[]; strongBeats: number[]; intensity: number[] } {
  const endMs = startMs + durationMs;
  const inWindow = (t: number) => t >= startMs && t < endMs;
  const firstWindow = Math.floor(startMs / INTENSITY_STEP_MS);
  const lastWindow = Math.ceil(endMs / INTENSITY_STEP_MS);
  return {
    beats: analysis.beats.filter(inWindow).map((t) => t - startMs),
    strongBeats: analysis.strongBeats.filter(inWindow).map((t) => t - startMs),
    intensity: analysis.intensity.slice(firstWindow, lastWindow),
  };
}

export interface SectionSuggestion {
  startMs: number;
  label: string;
  reason: string;
}

const meanIn = (intensity: number[], fromWin: number, toWin: number): number => {
  let sum = 0;
  let n = 0;
  for (let i = Math.max(0, fromWin); i < Math.min(intensity.length, toWin); i++) {
    sum += intensity[i];
    n++;
  }
  return n > 0 ? sum / n : 0;
};

/**
 * Suggest 2–3 useful sections of the song for a reel of this length:
 * a recommended build-into-peak, the highest-energy stretch, and a softer
 * passage. Deterministic; the user can always scrub and pick their own.
 */
export function suggestSections(
  analysis: Pick<BeatAnalysis, 'strongBeats' | 'intensity' | 'durationMs'>,
  reelDurationMs: number,
): SectionSuggestion[] {
  const { intensity, durationMs } = analysis;
  const windowCount = Math.floor(reelDurationMs / INTENSITY_STEP_MS);
  const lastStart = durationMs - reelDurationMs;
  if (lastStart <= 0 || intensity.length <= windowCount) {
    return [{ startMs: 0, label: 'Full song', reason: 'The song is close to your reel length' }];
  }

  const stepMs = 1000; // evaluate candidate starts every second
  interface Candidate {
    startMs: number;
    energy: number;
    build: number;
    nearStrongBeat: boolean;
  }
  const candidates: Candidate[] = [];
  for (let startMs = 0; startMs <= lastStart; startMs += stepMs) {
    const w0 = Math.floor(startMs / INTENSITY_STEP_MS);
    const wEnd = w0 + windowCount;
    const energy = meanIn(intensity, w0, wEnd);
    const firstHalf = meanIn(intensity, w0, w0 + windowCount / 2);
    const secondHalf = meanIn(intensity, w0 + windowCount / 2, wEnd);
    const nearStrongBeat = analysis.strongBeats.some((b) => Math.abs(b - startMs) < 600);
    candidates.push({ startMs, energy, build: secondHalf - firstHalf, nearStrongBeat });
  }

  const pick = (score: (c: Candidate) => number): Candidate => {
    let best = candidates[0];
    let bestScore = -Infinity;
    for (const c of candidates) {
      const s = score(c);
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    return best;
  };

  const suggestions: SectionSuggestion[] = [];
  const used: number[] = [];
  const distinct = (c: Candidate) =>
    used.every((u) => Math.abs(u - c.startMs) > reelDurationMs * 0.6);

  // Recommended: builds into a peak, ideally landing on a strong beat.
  const recommended = pick(
    (c) => c.energy * 0.6 + c.build * 1.2 + (c.nearStrongBeat ? 0.15 : 0),
  );
  suggestions.push({
    startMs: recommended.startMs,
    label: 'Recommended',
    reason: recommended.build > 0.05 ? 'Strong build into a peak' : 'Strongest overall moment',
  });
  used.push(recommended.startMs);

  const highEnergy = pick((c) => (distinct(c) ? c.energy : -Infinity));
  if (distinct(highEnergy)) {
    suggestions.push({
      startMs: highEnergy.startMs,
      label: 'High energy',
      reason: 'The song’s most intense stretch',
    });
    used.push(highEnergy.startMs);
  }

  const softer = pick((c) =>
    distinct(c) ? -c.energy + Math.max(0, c.build) * 0.5 : -Infinity,
  );
  if (distinct(softer)) {
    suggestions.push({
      startMs: softer.startMs,
      label: 'Softer',
      reason: 'A quieter, more emotional passage',
    });
  }

  return suggestions;
}

/** "0:47.2" — the format users match inside Instagram's audio slider. */
export function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  const whole = Math.floor(s);
  const tenth = Math.round((s - whole) * 10);
  const carried = tenth === 10;
  const displayWhole = carried ? whole + 1 : whole;
  const displayTenth = carried ? 0 : tenth;
  if (displayWhole === 60) return `${m + 1}:00.0`;
  return `${m}:${String(displayWhole).padStart(2, '0')}.${displayTenth}`;
}

export interface SyncCue {
  /** Time within the reel of the first big musical hit. */
  tMs: number;
  /** Photo that appears at (or lands on) that hit. */
  photoId: string;
  /** 1-based position of that photo in the reel. */
  photoNumber: number;
}

/**
 * Human-checkable sync marker: which photo should be on screen when the
 * first big musical hit lands. If the song is off by half a second inside
 * Instagram, the user can see it and nudge the slider.
 */
export function syncCue(timeline: Timeline, sectionStrongBeats: number[]): SyncCue | null {
  const hit = sectionStrongBeats.find((b) => b >= 400 && b <= timeline.durationMs - 400);
  if (hit === undefined) return null;
  const seen: string[] = [];
  let activePhoto: string | null = null;
  for (const clip of timeline.clips) {
    for (const layer of clip.layers) {
      if (!seen.includes(layer.photoId)) seen.push(layer.photoId);
    }
    if (hit >= clip.startMs && hit < clip.endMs) {
      activePhoto = clip.layers[0].photoId;
    }
  }
  if (!activePhoto) return null;
  return {
    tMs: hit,
    photoId: activePhoto,
    photoNumber: seen.indexOf(activePhoto) + 1,
  };
}
