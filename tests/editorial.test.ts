import { describe, expect, it } from 'vitest';
import { clusterIdentities } from '../src/lib/editorial/identity';
import { detectSimilarityGroups } from '../src/lib/editorial/sequences';
import { planSequence, type PlanContext, type StyleTraits } from '../src/lib/editorial/plan';
import { critiquePlan, refinePlan } from '../src/lib/editorial/critic';
import { inferPurpose, heroScoreOf } from '../src/lib/editorial/profile';
import { face, makePhoto } from './helpers';
import type { SequencePhoto } from '../src/lib/engine/sequence';

// Deterministic 128-d descriptor; same base → same person (+tiny noise).
const vec = (base: number, noise = 0): number[] => {
  const v: number[] = [];
  for (let i = 0; i < 128; i++) {
    v.push(Math.sin(base * 37 + i) * 0.5 + Math.sin((base + noise) * 91 + i * 3) * 0.02);
  }
  return v;
};

/** Hex phash with the first `bits` bits set — distance to '0…0' = bits. */
const phashBits = (bits: number): string =>
  ((1n << BigInt(bits)) - 1n).toString(16).padStart(16, '0');

const personPhoto = (person: number, over: Partial<SequencePhoto> = {}): SequencePhoto =>
  makePhoto({
    faces: [face(0.35, 0.25, 0.15, 0.2)],
    descriptors: [vec(person, Math.random() * 0.01)],
    ...over,
  });

const TRAITS: StyleTraits = {
  minSlideMs: 900,
  idealPerSecond: 0.59,
  selectivity: 0.5,
  allowStacks: false,
  allowBursts: true,
  heroHoldBoost: 1.35,
  maxBurstFrames: 3,
};

const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  purpose: 'photography',
  durationMs: 12000,
  seed: 7,
  fixedOrder: false,
  intensity: [],
  capacity: 13,
  ...over,
});

describe('identity clustering', () => {
  it('groups repeated people and separates different ones', () => {
    const photos = [
      personPhoto(1),
      personPhoto(1),
      personPhoto(1),
      personPhoto(2),
      personPhoto(3),
    ];
    const idx = clusterIdentities(photos);
    expect(idx.identityCount).toBe(3);
    const first = idx.byPhoto.get(photos[0].id)![0];
    expect(idx.byPhoto.get(photos[1].id)![0]).toBe(first);
    expect(idx.byPhoto.get(photos[3].id)![0]).not.toBe(first);
  });

  it('ignores photos without descriptors gracefully', () => {
    const photos = [makePhoto({}), makePhoto({ faces: [face(0.3, 0.3, 0.2, 0.2)] })];
    const idx = clusterIdentities(photos);
    expect(idx.identityCount).toBe(0);
  });
});

describe('burst vs redundant similarity', () => {
  it('near-identical timed frames are redundant; evolving frames are a burst', () => {
    const t0 = 1_700_000_000_000;
    const redundantPair = [
      makePhoto({ phash: phashBits(0), takenAt: t0, uploadOrder: 0 }),
      makePhoto({ phash: phashBits(2), takenAt: t0 + 800, uploadOrder: 1 }),
    ];
    const burstTrio = [
      makePhoto({ phash: phashBits(20), takenAt: t0 + 60000, uploadOrder: 2 }),
      makePhoto({ phash: phashBits(28), takenAt: t0 + 61000, uploadOrder: 3 }),
      makePhoto({ phash: phashBits(36), takenAt: t0 + 62000, uploadOrder: 4 }),
    ];
    const far = makePhoto({ phash: 'ffff00000000ffff', takenAt: t0 + 120000, uploadOrder: 5 });
    const groups = detectSimilarityGroups([...redundantPair, ...burstTrio, far]);
    const kinds = groups.map((g) => g.kind).sort();
    expect(kinds).toContain('redundant');
    expect(kinds).toContain('burst');
    const burst = groups.find((g) => g.kind === 'burst')!;
    expect(burst.photoIds).toEqual(burstTrio.map((p) => p.id));
  });

  it('without timestamps, two similar frames collapse to redundant (no invented bursts)', () => {
    const pair = [
      makePhoto({ phash: phashBits(0), uploadOrder: 0 }),
      makePhoto({ phash: phashBits(8), uploadOrder: 1 }),
    ];
    const groups = detectSimilarityGroups(pair);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('redundant');
  });
});

describe('editorial selection', () => {
  it('required photos are never dropped, whatever their quality', () => {
    const weakRequired = makePhoto({ score: 0.1, required: true });
    const strong = Array.from({ length: 15 }, () => makePhoto({ score: 0.85 }));
    const plan = planSequence([weakRequired, ...strong], TRAITS, ctx());
    const used = new Set(plan.slots.flatMap((s) => s.photos.map((p) => p.id)));
    expect(used.has(weakRequired.id)).toBe(true);
  });

  it('capacity is a maximum, not a target: weak sets produce tighter edits', () => {
    // 20 photos, only 4 strong → photography mode should not pad to capacity.
    const strong = Array.from({ length: 4 }, () => makePhoto({ score: 0.85 }));
    const weak = Array.from({ length: 16 }, () => makePhoto({ score: 0.2 }));
    const plan = planSequence([...strong, ...weak], TRAITS, ctx({ capacity: 13 }));
    const used = plan.slots.flatMap((s) => s.photos).length;
    expect(used).toBeLessThan(10);
    expect(used).toBeGreaterThanOrEqual(3);
  });

  it('school mode favors breadth of people over more shots of the same student', () => {
    // Student A has six great shots; eight other students have one decent shot.
    const starShots = Array.from({ length: 6 }, () => personPhoto(1, { score: 0.9 }));
    const others = Array.from({ length: 8 }, (_, i) => personPhoto(10 + i, { score: 0.55 }));
    const plan = planSequence([...starShots, ...others], TRAITS, ctx({
      purpose: 'school',
      capacity: 13,
      durationMs: 15000,
    }));
    const usedIdentities = new Set<string>();
    let starCount = 0;
    for (const slot of plan.slots) {
      for (const photo of slot.photos) {
        const ids = plan.identities.byPhoto.get(photo.id) ?? [];
        for (const id of ids) usedIdentities.add(id);
        if (starShots.some((s) => s.id === photo.id)) starCount++;
      }
    }
    // Many different students appear; the star does not dominate.
    expect(usedIdentities.size).toBeGreaterThanOrEqual(6);
    expect(starCount).toBeLessThanOrEqual(3);
  });

  it('a manual order is honored exactly', () => {
    const photos = Array.from({ length: 6 }, () => makePhoto({}));
    const plan = planSequence(photos, TRAITS, ctx({ fixedOrder: true }));
    expect(plan.slots.map((s) => s.photos[0].id)).toEqual(photos.map((p) => p.id));
  });

  it('heroes hold longer than supporting photos', () => {
    const hero = makePhoto({ score: 0.95, faces: [face(0.3, 0.2, 0.25, 0.3)] });
    const support = Array.from({ length: 6 }, () => makePhoto({ score: 0.5 }));
    const plan = planSequence([hero, ...support], TRAITS, ctx());
    const heroSlot = plan.slots.find((s) => s.photos[0].id === hero.id)!;
    const weights = plan.slots.map((s) => s.weight).sort((a, b) => a - b);
    const median = weights[Math.floor(weights.length / 2)];
    expect(heroSlot.weight).toBeGreaterThan(median);
  });

  it('bursts survive selection as micro-sequences', () => {
    const t0 = 1_700_000_000_000;
    const burst = [
      makePhoto({ phash: phashBits(20), takenAt: t0, uploadOrder: 0, score: 0.7 }),
      makePhoto({ phash: phashBits(28), takenAt: t0 + 900, uploadOrder: 1, score: 0.7 }),
      makePhoto({ phash: phashBits(36), takenAt: t0 + 1800, uploadOrder: 2, score: 0.7 }),
    ];
    const others = Array.from({ length: 5 }, () => makePhoto({ score: 0.6 }));
    const plan = planSequence([...burst, ...others], TRAITS, ctx());
    const burstSlot = plan.slots.find((s) => s.kind === 'burst');
    expect(burstSlot).toBeDefined();
    expect(burstSlot!.photos.length).toBeGreaterThanOrEqual(2);
    // Frames stay in capture order — the moment unfolds.
    const times = burstSlot!.photos.map((p) => p.takenAt!);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe('the reel critic', () => {
  it('scores a strong plan higher than a degenerate one', () => {
    const varied = Array.from({ length: 8 }, (_, i) =>
      makePhoto({
        score: 0.5 + (i % 4) * 0.12,
        faces: i % 2 ? [face(0.35, 0.25, 0.15, 0.2)] : [],
        stats: undefined as never,
      }),
    ).map((p, i) => ({ ...p, stats: { ...p.stats, meanLuma: 0.4 + (i % 3) * 0.1 } }));
    const good = planSequence(varied, TRAITS, ctx());
    const goodScore = critiquePlan(good, { purpose: 'photography', fixedOrder: false });

    // Degenerate: same plan but sorted worst-first with dupes adjacent.
    const bad = {
      ...good,
      slots: [...good.slots].sort(
        (a, b) =>
          (good.profiles.get(a.photos[0].id)?.hero ?? 0) -
          (good.profiles.get(b.photos[0].id)?.hero ?? 0),
      ),
    };
    const badScore = critiquePlan(bad, { purpose: 'photography', fixedOrder: false });
    expect(goodScore.overall).toBeGreaterThanOrEqual(badScore.overall);
  });

  it('revises a weak opener when the order is not user-locked', () => {
    const weak = makePhoto({ score: 0.2 });
    const strongFace = makePhoto({ score: 0.95, faces: [face(0.3, 0.2, 0.25, 0.3)] });
    const mids = Array.from({ length: 4 }, () => makePhoto({ score: 0.5 }));
    const base = planSequence([weak, strongFace, ...mids], TRAITS, ctx());
    // Force the weak photo to the front to simulate a bad construction.
    const weakFirst = {
      ...base,
      slots: [
        ...base.slots.filter((s) => s.photos[0].id === weak.id),
        ...base.slots.filter((s) => s.photos[0].id !== weak.id),
      ],
    };
    const result = refinePlan(weakFirst, { purpose: 'photography', fixedOrder: false });
    expect(result.plan.slots[0].photos[0].id).not.toBe(weak.id);
    expect(result.scores.opener).toBeGreaterThan(0.8);
  });

  it('never reorders a user-locked order, even a bad one', () => {
    const weak = makePhoto({ score: 0.2 });
    const strong = makePhoto({ score: 0.95, faces: [face(0.3, 0.2, 0.25, 0.3)] });
    const photos = [weak, strong, makePhoto({}), makePhoto({})];
    const plan = planSequence(photos, TRAITS, ctx({ fixedOrder: true }));
    const result = refinePlan(plan, { purpose: 'photography', fixedOrder: true });
    expect(result.plan.slots.map((s) => s.photos[0].id)).toEqual(photos.map((p) => p.id));
  });
});

describe('purpose inference', () => {
  it('many recurring people reads as school; a pro-heavy set reads as photography', () => {
    const school = Array.from({ length: 10 }, (_, i) => personPhoto(i + 1));
    const schoolIdx = clusterIdentities(school);
    expect(inferPurpose(school, schoolIdx, 0.2)).toBe('school');

    const session = Array.from({ length: 8 }, () => personPhoto(1));
    const sessionIdx = clusterIdentities(session);
    expect(inferPurpose(session, sessionIdx, 0.9)).toBe('photography');
  });

  it('technical quality does not dominate school hero scores', () => {
    const sharpEmpty = makePhoto({ score: 0.9, faces: [] });
    const softMoment = makePhoto({
      score: 0.35,
      faces: [face(0.3, 0.2, 0.2, 0.28), face(0.55, 0.25, 0.18, 0.24)],
      ai: { storyRole: 'movement', appeal: 0.7 },
    });
    expect(heroScoreOf(softMoment, 'school')).toBeGreaterThan(heroScoreOf(sharpEmpty, 'school'));
    // …while photography mode still prefers the technically excellent frame.
    expect(heroScoreOf(sharpEmpty, 'photography')).toBeGreaterThan(0.4);
  });
});
