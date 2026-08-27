// The editorial planner: understand what the reel is trying to accomplish,
// understand what is in the photographs, and build an intentional sequence.
//
// Output is an ordered list of PlanSlots (single photos, stacked pairs, or
// rapid burst micro-sequences) with roles and relative durations — the
// timeline realizer turns slots into clips per style.
//
// Editorial law: user intent outranks algorithmic taste.
// - required photos are never dropped, whatever their technical quality
// - a manual order is never resequenced
// - within those boundaries, the planner edits as intelligently as it can.
// Capacity is a maximum, not a target: a tight 22-photo reel beats a padded
// 35-photo reel.

import { mulberry32, type SequencePhoto } from '../engine/sequence';
import { canStackPair } from '../engine/layout';
import { phashDistance } from '../imaging/similarity';
import { clusterIdentities, type IdentityIndex } from './identity';
import { buildProfiles, type EditorialProfile } from './profile';
import { bestOfGroup, detectSimilarityGroups } from './sequences';

export type EditorialPurpose = 'photography' | 'school';

export interface StyleTraits {
  minSlideMs: number;
  idealPerSecond: number;
  /** 0 = use everything eligible (Rapid Fire); 1 = highly curated. */
  selectivity: number;
  allowStacks: boolean;
  allowBursts: boolean;
  /** Duration multiplier for hero holds — not every photo gets equal time. */
  heroHoldBoost: number;
  maxBurstFrames: number;
}

export type SlotRole =
  | 'hook'
  | 'establish'
  | 'build'
  | 'variety'
  | 'moment'
  | 'breath'
  | 'payoff'
  | 'close';

export interface PlanSlot {
  kind: 'single' | 'stack' | 'burst';
  photos: SequencePhoto[];
  role: SlotRole;
  weight: number;
  hero: boolean;
}

export interface PlanContext {
  purpose: EditorialPurpose;
  durationMs: number;
  seed: number;
  /** True when the user manually ordered photos — order is sacred. */
  fixedOrder: boolean;
  /** Music energy curve (0..1 per 500ms window); empty without music. */
  intensity: number[];
  /** Physical capacity for this style + duration. */
  capacity: number;
}

export interface EditorialPlan {
  slots: PlanSlot[];
  profiles: Map<string, EditorialProfile>;
  identities: IdentityIndex;
}

const heroOf = (slot: PlanSlot, profiles: Map<string, EditorialProfile>): number =>
  Math.max(...slot.photos.map((p) => profiles.get(p.id)?.hero ?? 0));

export const slotProfile = (
  slot: PlanSlot,
  profiles: Map<string, EditorialProfile>,
): EditorialProfile => profiles.get(slot.photos[0].id)!;

// ---------------------------------------------------------------------------
// Selection

interface Prepared {
  profiles: Map<string, EditorialProfile>;
  identities: IdentityIndex;
  /** photoId → burst group members (ordered) it belongs to. */
  burstOf: Map<string, string[]>;
  /** Photos shadowed by a better near-identical take (never required ones). */
  shadowed: Set<string>;
}

function prepare(photos: SequencePhoto[], purpose: EditorialPurpose): Prepared {
  const identities = clusterIdentities(photos);
  const profiles = buildProfiles(photos, identities, purpose);
  const photosById = new Map(photos.map((p) => [p.id, p]));
  const groups = detectSimilarityGroups(photos);

  const burstOf = new Map<string, string[]>();
  const shadowed = new Set<string>();
  for (const group of groups) {
    if (group.kind === 'redundant') {
      const best = bestOfGroup(group, photosById);
      for (const id of group.photoIds) {
        if (id !== best && !photosById.get(id)?.required) shadowed.add(id);
      }
    } else {
      for (const id of group.photoIds) burstOf.set(id, group.photoIds);
    }
  }
  return { profiles, identities, burstOf, shadowed };
}

/** How many photos this reel editorially WANTS (capacity merely caps it). */
export function editorialTarget(
  photos: SequencePhoto[],
  prep: Prepared,
  traits: StyleTraits,
  ctx: PlanContext,
): number {
  const requiredCount = photos.filter((p) => p.required).length;
  const available = photos.filter((p) => !prep.shadowed.has(p.id)).length;
  if (traits.selectivity <= 0.05) {
    // Rapid styles show the whole set.
    return Math.min(ctx.capacity, available);
  }
  const ideal = Math.round((ctx.durationMs / 1000) * traits.idealPerSecond);
  if (ctx.purpose === 'photography') {
    // Selective: only photos that genuinely earn a slot. A hero bar scaled
    // by style selectivity keeps Cinematic/Editorial tight.
    const bar = 0.42 + traits.selectivity * 0.1;
    const strong = photos.filter(
      (p) => !prep.shadowed.has(p.id) && !p.required && (prep.profiles.get(p.id)?.hero ?? 0) >= bar,
    ).length;
    return Math.max(3, Math.min(ctx.capacity, ideal, requiredCount + strong));
  }
  // School: breadth-leaning — more moments, more faces — but still an edit.
  return Math.max(3, Math.min(ctx.capacity, Math.round(ideal * 1.15), available));
}

function selectPhotos(
  photos: SequencePhoto[],
  prep: Prepared,
  traits: StyleTraits,
  ctx: PlanContext,
): SequencePhoto[] {
  const target = editorialTarget(photos, prep, traits, ctx);
  const { profiles, identities } = prep;

  const picked: SequencePhoto[] = photos.filter((p) => p.required);
  const pickedIds = new Set(picked.map((p) => p.id));
  const coveredIdentities = new Set(picked.flatMap((p) => profiles.get(p.id)?.identities ?? []));

  const candidates = photos.filter((p) => !p.required && !prep.shadowed.has(p.id));

  // Everything fits (e.g. Rapid Fire): skip the O(n²) greedy scoring.
  if (picked.length + candidates.length <= target) {
    return [...picked, ...candidates];
  }

  while (picked.length < target && candidates.length > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (pickedIds.has(c.id)) continue;
      const profile = profiles.get(c.id)!;
      let score = profile.hero;

      // Breadth: in school mode, a new face is worth a lot — parents keep
      // watching because someone they know might appear next.
      if (ctx.purpose === 'school') {
        const fresh = profile.identities.filter((id) => !coveredIdentities.has(id));
        score += fresh.length > 0 ? 0.3 : 0;
        // Penalize piling more shots of already well-covered people.
        const repeats = profile.identities.filter((id) => coveredIdentities.has(id)).length;
        if (fresh.length === 0 && repeats > 0 && identities.identityCount > 3) {
          score -= 0.12;
        }
      }

      // Visual variety vs. what's already picked.
      let minDist = 64;
      for (const p of picked) {
        minDist = Math.min(minDist, phashDistance(p.phash, c.phash));
      }
      score += Math.min(minDist, 20) / 100; // up to +0.2 for genuinely new material
      if (minDist <= 6) score -= 0.4; // near-dupe of something picked

      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    const chosen = candidates.splice(bestIdx, 1)[0];
    picked.push(chosen);
    pickedIds.add(chosen.id);
    for (const id of profiles.get(chosen.id)?.identities ?? []) coveredIdentities.add(id);
  }
  return picked;
}

// ---------------------------------------------------------------------------
// Slot formation (bursts + stacks)

function formSlots(
  picked: SequencePhoto[],
  prep: Prepared,
  traits: StyleTraits,
  rand: () => number,
): PlanSlot[] {
  const slots: PlanSlot[] = [];
  const used = new Set<string>();
  const pickedIds = new Set(picked.map((p) => p.id));
  const byId = new Map(picked.map((p) => [p.id, p]));

  // Bursts: sequential frames of one unfolding moment become one rapid slot.
  if (traits.allowBursts) {
    for (const photo of picked) {
      if (used.has(photo.id)) continue;
      const group = prep.burstOf.get(photo.id);
      if (!group) continue;
      const members = group
        .filter((id) => pickedIds.has(id) && !used.has(id))
        .slice(0, traits.maxBurstFrames)
        .map((id) => byId.get(id)!)
        .filter(Boolean);
      if (members.length >= 2) {
        for (const m of members) used.add(m.id);
        slots.push({
          kind: 'burst',
          photos: members, // capture order — the moment unfolds
          role: 'build',
          weight: 0.55 * members.length,
          hero: false,
        });
      }
    }
  }

  // Stacks: complementary horizontal supporting photos share a frame.
  if (traits.allowStacks) {
    const horizontals = picked.filter(
      (p) =>
        !used.has(p.id) &&
        p.width > p.height &&
        (prep.profiles.get(p.id)?.hero ?? 0) < 0.6, // heroes get the full frame
    );
    for (let i = 0; i + 1 < horizontals.length; i += 2) {
      const [a, b] = [horizontals[i], horizontals[i + 1]];
      if (used.has(a.id) || used.has(b.id)) continue;
      if (canStackPair(a, b) && rand() < 0.5) {
        used.add(a.id);
        used.add(b.id);
        slots.push({ kind: 'stack', photos: [a, b], role: 'variety', weight: 1.25, hero: false });
      }
    }
  }

  for (const photo of picked) {
    if (used.has(photo.id)) continue;
    used.add(photo.id);
    const profile = prep.profiles.get(photo.id)!;
    slots.push({
      kind: 'single',
      photos: [photo],
      role: 'variety',
      weight: 1,
      hero: profile.hero >= 0.62,
    });
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Ordering: build an actual arc, not a ranked gallery.

function intensityAtFraction(intensity: number[], frac: number): number {
  if (intensity.length === 0) {
    // No music: assume a gentle build toward the end.
    return 0.4 + frac * 0.4;
  }
  const i = Math.min(intensity.length - 1, Math.max(0, Math.floor(frac * intensity.length)));
  return intensity[i];
}

function orderSlots(
  slots: PlanSlot[],
  prep: Prepared,
  ctx: PlanContext,
  rand: () => number,
): PlanSlot[] {
  if (slots.length <= 2) return slots;
  const { profiles } = prep;
  const remaining = [...slots];

  const take = (predicate: (s: PlanSlot) => number): PlanSlot => {
    let bestIdx = 0;
    let best = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const v = predicate(remaining[i]);
      if (v > best) {
        best = v;
        bestIdx = i;
      }
    }
    return remaining.splice(bestIdx, 1)[0];
  };

  // HOOK: the strongest face-forward moment. Something must happen in the
  // first second.
  const hook = take((s) => {
    const p = slotProfile(s, profiles);
    return (
      heroOf(s, profiles) +
      (p.peopleCount > 0 ? 0.2 : -0.15) +
      (p.orientation === 'portrait' ? 0.08 : 0) +
      (s.kind === 'single' ? 0.1 : 0)
    );
  });
  hook.role = 'hook';

  // CLOSE: emotional payoff, distinct from the hook.
  const close = take((s) => {
    const p = slotProfile(s, profiles);
    const emotional = s.photos.some(
      (ph) => ph.ai?.storyRole === 'emotional' || ph.ai?.storyRole === 'closing',
    )
      ? 0.25
      : 0;
    return heroOf(s, profiles) + emotional + (p.peopleCount > 0 ? 0.1 : 0) - phashDistance(hook.photos[0].phash, s.photos[0].phash) / 640;
  });
  close.role = 'close';

  // ESTABLISH: a scene-setting image early, when one exists.
  let establish: PlanSlot | null = null;
  if (remaining.length >= 3) {
    const contextIdx = remaining.findIndex((s) => slotProfile(s, profiles).isContext);
    if (contextIdx >= 0) {
      establish = remaining.splice(contextIdx, 1)[0];
      establish.role = 'establish';
    }
  }

  // MIDDLE: greedy variety walk that follows the music's energy and spreads
  // people out (the parent test: don't spend everyone in the first 5s).
  const middle: PlanSlot[] = [];
  const total = slots.length;
  const recentIdentities: string[][] = [];
  let prev = establish ?? hook;
  while (remaining.length > 0) {
    const position = (middle.length + (establish ? 2 : 1)) / (total - 1);
    const desiredEnergy = intensityAtFraction(ctx.intensity, position);
    let bestIdx = 0;
    let best = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const s = remaining[i];
      const p = slotProfile(s, profiles);
      const prevP = slotProfile(prev, profiles);
      let score = 0;
      // Visual variety vs. the previous slot.
      if (p.shotScale !== prevP.shotScale) score += 0.2;
      if (p.grouping !== prevP.grouping) score += 0.1;
      if (p.orientation !== prevP.orientation) score += 0.08;
      const dist = phashDistance(s.photos[0].phash, prev.photos[0].phash);
      score += Math.min(dist, 24) / 120;
      if (dist <= 8) score -= 0.5; // near-identical neighbours
      // Brightness whiplash.
      if (Math.abs(p.brightness - prevP.brightness) > 0.45) score -= 0.3;
      // Energy should follow the music.
      score -= Math.abs(p.energy - desiredEnergy) * 0.25;
      // Heroes land where the music peaks.
      if (s.hero) score += (desiredEnergy - 0.5) * 0.5;
      // People spread: repeating someone seen in the last two slots hurts —
      // strongly in school mode.
      const recent = recentIdentities.flat();
      const repeats = p.identities.filter((id) => recent.includes(id)).length;
      score -= repeats * (ctx.purpose === 'school' ? 0.35 : 0.12);
      score += rand() * 0.04;
      if (score > best) {
        best = score;
        bestIdx = i;
      }
    }
    const chosen = remaining.splice(bestIdx, 1)[0];
    middle.push(chosen);
    recentIdentities.push(slotProfile(chosen, profiles).identities);
    if (recentIdentities.length > 2) recentIdentities.shift();
    prev = chosen;
  }

  // Assign narrative roles through the middle.
  for (let i = 0; i < middle.length; i++) {
    const s = middle[i];
    if (s.role !== 'variety') continue; // bursts keep 'build'
    const p = slotProfile(s, profiles);
    if (s.hero) s.role = 'moment';
    else if (i > 0 && p.energy < 0.35 && slotProfile(middle[i - 1], profiles).energy > 0.55) {
      s.role = 'breath';
    }
  }
  if (middle.length > 0) {
    const last = middle[middle.length - 1];
    if (last.hero || slotProfile(last, profiles).energy > 0.55) last.role = 'payoff';
  }

  return establish ? [hook, establish, ...middle, close] : [hook, ...middle, close];
}

// ---------------------------------------------------------------------------
// Weights: timing is an editorial decision.

function applyWeights(
  slots: PlanSlot[],
  prep: Prepared,
  traits: StyleTraits,
  rand: () => number,
): void {
  for (const slot of slots) {
    if (slot.kind === 'burst') continue; // burst weight set at formation
    let w = slot.weight;
    switch (slot.role) {
      case 'hook':
        w *= 1.25;
        break;
      case 'establish':
        w *= 1.1;
        break;
      case 'close':
        w *= 1.3;
        break;
      case 'breath':
        w *= 1.15;
        break;
      default:
        break;
    }
    if (slot.hero) w *= traits.heroHoldBoost;
    // A required-but-technically-weak photo still belongs — it just moves a
    // touch quicker so the edit carries it.
    const p = slotProfile(slot, prep.profiles);
    if (p.required && p.visual < 0.35 && !slot.hero && slot.role !== 'hook' && slot.role !== 'close') {
      w *= 0.85;
    }
    slot.weight = w * (0.97 + rand() * 0.06);
  }
}

// ---------------------------------------------------------------------------

export function planSequence(
  photos: SequencePhoto[],
  traits: StyleTraits,
  ctx: PlanContext,
): EditorialPlan {
  const rand = mulberry32(ctx.seed);
  const prep = prepare(photos, ctx.purpose);

  if (ctx.fixedOrder) {
    // Order lock: the user's list and order, exactly, capped by physics.
    const capped = photos.slice(0, Math.min(photos.length, ctx.capacity));
    const slots: PlanSlot[] = capped.map((photo, i) => ({
      kind: 'single' as const,
      photos: [photo],
      role: i === 0 ? ('hook' as const) : i === capped.length - 1 ? ('close' as const) : ('variety' as const),
      weight: 1,
      hero: (prep.profiles.get(photo.id)?.hero ?? 0) >= 0.62,
    }));
    for (const s of slots) {
      if (s.hero && s.role === 'variety') s.role = 'moment';
    }
    applyWeights(slots, prep, traits, rand);
    return { slots, profiles: prep.profiles, identities: prep.identities };
  }

  const picked = selectPhotos(photos, prep, traits, ctx);
  const formed = formSlots(picked, prep, traits, rand);
  const ordered = orderSlots(formed, prep, ctx, rand);
  applyWeights(ordered, prep, traits, rand);
  return { slots: ordered, profiles: prep.profiles, identities: prep.identities };
}
