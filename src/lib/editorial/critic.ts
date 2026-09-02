// The Reel Critic: a second editorial pass that evaluates the constructed
// plan before it ever becomes Version 1, and revises it when it falls short.
//
// The Critic respects user locks absolutely:
// - order-locked plans: no reordering, no substitution (timing/treatment
//   remain the realizer's job)
// - required photos: never removed — problems around them are solved with
//   placement, not deletion.
//
// Deterministic on purpose: the Critic guards quality; it is not a place
// for probabilistic surprises.

import { phashDistance } from '../imaging/similarity';
import type { EditorialPlan, EditorialPurpose, PlanSlot } from './plan';
import { slotProfile } from './plan';
import type { EditorialProfile } from './profile';

export interface CritiqueScores {
  opener: number;
  ending: number;
  variety: number;
  brightnessFlow: number;
  redundancy: number;
  peopleSpread: number;
  heroEmphasis: number;
  overall: number;
}

export interface CritiqueOptions {
  purpose: EditorialPurpose;
  fixedOrder: boolean;
}

const heroOf = (slot: PlanSlot, profiles: Map<string, EditorialProfile>): number =>
  Math.max(...slot.photos.map((p) => profiles.get(p.id)?.hero ?? 0));

export function critiquePlan(plan: EditorialPlan, opts: CritiqueOptions): CritiqueScores {
  const { slots, profiles } = plan;
  const n = slots.length;
  if (n === 0) {
    return {
      opener: 0, ending: 0, variety: 0, brightnessFlow: 0,
      redundancy: 0, peopleSpread: 0, heroEmphasis: 0, overall: 0,
    };
  }

  const maxHero = Math.max(...slots.map((s) => heroOf(s, profiles)), 0.01);
  const opener = heroOf(slots[0], profiles) / maxHero;
  const ending = Math.max(0.3, heroOf(slots[n - 1], profiles) / maxHero);

  let varietyViolations = 0;
  let jolts = 0;
  let adjacentDupes = 0;
  for (let i = 1; i < n; i++) {
    const a = slotProfile(slots[i - 1], profiles);
    const b = slotProfile(slots[i], profiles);
    const dist = phashDistance(slots[i - 1].photos[0].phash, slots[i].photos[0].phash);
    if (a.shotScale === b.shotScale && a.grouping === b.grouping && dist < 14) {
      varietyViolations++;
    }
    if (Math.abs(a.brightness - b.brightness) > 0.45) jolts++;
    if (dist <= 6 && slots[i].kind !== 'burst' && slots[i - 1].kind !== 'burst') {
      adjacentDupes++;
    }
  }
  const variety = 1 - varietyViolations / Math.max(1, n - 1);
  const brightnessFlow = 1 - jolts / Math.max(1, n - 1);
  const redundancy = 1 - adjacentDupes / Math.max(1, n - 1);

  // People spread (matters most in school mode): how dominated is the reel
  // by its most-shown person, relative to a fair share?
  let peopleSpread = 1;
  const identitySlots = new Map<string, number>();
  let slotsWithPeople = 0;
  for (const slot of slots) {
    const ids = slotProfile(slot, profiles).identities;
    if (ids.length > 0) slotsWithPeople++;
    for (const id of ids) identitySlots.set(id, (identitySlots.get(id) ?? 0) + 1);
  }
  if (identitySlots.size >= 3 && slotsWithPeople >= 4) {
    const maxShare = Math.max(...identitySlots.values()) / slotsWithPeople;
    const fairShare = Math.min(1, 2 / identitySlots.size + 0.15);
    peopleSpread = maxShare <= fairShare ? 1 : Math.max(0, 1 - (maxShare - fairShare) * 2);
  }

  // Hero emphasis: heroes should hold longer than the median slot.
  const weights = slots.map((s) => s.weight).sort((a, b) => a - b);
  const median = weights[Math.floor(weights.length / 2)];
  const heroes = slots.filter((s) => s.hero);
  const heroEmphasis =
    heroes.length === 0
      ? 1
      : heroes.filter((s) => s.weight > median * 1.05).length / heroes.length;

  const schoolWeights = { opener: 1.2, ending: 1, variety: 1, brightnessFlow: 0.8, redundancy: 1.2, peopleSpread: 2, heroEmphasis: 0.6 };
  const photoWeights = { opener: 1.4, ending: 1.2, variety: 1.1, brightnessFlow: 0.8, redundancy: 1.3, peopleSpread: 0.5, heroEmphasis: 1 };
  const w = opts.purpose === 'school' ? schoolWeights : photoWeights;
  const totalW = Object.values(w).reduce((a, b) => a + b, 0);
  const overall =
    (opener * w.opener + ending * w.ending + variety * w.variety +
      brightnessFlow * w.brightnessFlow + redundancy * w.redundancy +
      peopleSpread * w.peopleSpread + heroEmphasis * w.heroEmphasis) / totalW;

  return { opener, ending, variety, brightnessFlow, redundancy, peopleSpread, heroEmphasis, overall };
}

// ---------------------------------------------------------------------------
// Revision: try targeted fixes, keep the best-scoring plan.

const ACCEPT_THRESHOLD = 0.72;
const MAX_REVISIONS = 5;

type Fix = (slots: PlanSlot[]) => PlanSlot[] | null;

function swap(slots: PlanSlot[], i: number, j: number): PlanSlot[] {
  const next = [...slots];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

function candidateFixes(plan: EditorialPlan, opts: CritiqueOptions): Fix[] {
  if (opts.fixedOrder) return []; // the user's order is not ours to fix
  // Nothing to rearrange below two slots — and with none at all the fixes
  // below would reach past the end of the list.
  if (plan.slots.length < 2) return [];
  const { profiles } = plan;
  const fixes: Fix[] = [];

  // Weak opener → lead with the strongest face-forward slot instead.
  fixes.push((slots) => {
    const maxHero = Math.max(...slots.map((s) => heroOf(s, profiles)));
    if (heroOf(slots[0], profiles) >= maxHero * 0.85) return null;
    const bestIdx = slots.findIndex((s) => heroOf(s, profiles) >= maxHero * 0.999);
    if (bestIdx <= 0 || bestIdx === slots.length - 1) return null;
    const next = swap(slots, 0, bestIdx);
    next[0] = { ...next[0], role: 'hook' };
    next[bestIdx] = { ...next[bestIdx], role: 'moment' };
    return next;
  });

  // Adjacent near-duplicates or same-person runs → separate them.
  fixes.push((slots) => {
    for (let i = 1; i < slots.length; i++) {
      const dist = phashDistance(slots[i - 1].photos[0].phash, slots[i].photos[0].phash);
      const sharedPerson =
        opts.purpose === 'school' &&
        slotProfile(slots[i], profiles).identities.some((id) =>
          slotProfile(slots[i - 1], profiles).identities.includes(id),
        );
      if (dist <= 6 || sharedPerson) {
        // Swap slot i with the farthest later slot that breaks the clash.
        for (let j = slots.length - 2; j > i; j--) {
          const jDistPrev = phashDistance(slots[i - 1].photos[0].phash, slots[j].photos[0].phash);
          const jShares =
            opts.purpose === 'school' &&
            slotProfile(slots[j], profiles).identities.some((id) =>
              slotProfile(slots[i - 1], profiles).identities.includes(id),
            );
          if (jDistPrev > 8 && !jShares) return swap(slots, i, j);
        }
      }
    }
    return null;
  });

  // Brightness whiplash → find a gentler neighbour.
  fixes.push((slots) => {
    for (let i = 1; i < slots.length - 1; i++) {
      const a = slotProfile(slots[i - 1], profiles);
      const b = slotProfile(slots[i], profiles);
      if (Math.abs(a.brightness - b.brightness) > 0.45) {
        for (let j = i + 1; j < slots.length - 1; j++) {
          const c = slotProfile(slots[j], profiles);
          if (Math.abs(a.brightness - c.brightness) <= 0.35) return swap(slots, i, j);
        }
      }
    }
    return null;
  });

  // Flat hero emphasis → give heroes their hold.
  fixes.push((slots) => {
    const weights = slots.map((s) => s.weight).sort((x, y) => x - y);
    const median = weights[Math.floor(weights.length / 2)];
    const flat = slots.filter((s) => s.hero && s.weight <= median * 1.05);
    if (flat.length === 0) return null;
    return slots.map((s) =>
      s.hero && s.weight <= median * 1.05 ? { ...s, weight: s.weight * 1.3 } : s,
    );
  });

  return fixes;
}

export interface CritiqueResult {
  plan: EditorialPlan;
  scores: CritiqueScores;
  revisions: number;
}

/** Critique → revise → re-critique until the plan is worth presenting. */
export function refinePlan(plan: EditorialPlan, opts: CritiqueOptions): CritiqueResult {
  // An empty plan is a real state (every photo excluded, or all blocked by a
  // restricted-child review). It is the screen's job to explain that, not
  // ours to crash on.
  if (plan.slots.length === 0) {
    return { plan, scores: critiquePlan(plan, opts), revisions: 0 };
  }
  let best = plan;
  let bestScores = critiquePlan(plan, opts);
  let revisions = 0;

  for (let round = 0; round < MAX_REVISIONS; round++) {
    if (bestScores.overall >= ACCEPT_THRESHOLD && round > 0) break;
    let improved = false;
    for (const fix of candidateFixes(best, opts)) {
      const nextSlots = fix(best.slots);
      if (!nextSlots) continue;
      const candidate: EditorialPlan = { ...best, slots: nextSlots };
      const scores = critiquePlan(candidate, opts);
      if (scores.overall > bestScores.overall + 0.005) {
        best = candidate;
        bestScores = scores;
        revisions++;
        improved = true;
      }
    }
    if (!improved) break;
  }
  return { plan: best, scores: bestScores, revisions };
}
