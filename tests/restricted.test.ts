import { describe, expect, it } from 'vitest';
import {
  bestDistance,
  euclideanDistance,
  exportBlockers,
  isPossibleMatch,
  matchConfidenceLabel,
  MATCH_THRESHOLD,
} from '../src/lib/restricted/matching';

describe('restricted-child matching', () => {
  it('computes euclidean distance', () => {
    expect(euclideanDistance([0, 0], [3, 4])).toBe(5);
  });

  it('takes the best distance across all references of a profile', () => {
    const refs = [
      [1, 0, 0],
      [0.1, 0, 0],
    ];
    expect(bestDistance([0, 0, 0], refs)).toBeCloseTo(0.1);
  });

  it('threshold favors false positives over false negatives', () => {
    // Distances just past the standard "same person" cutoff still flag.
    expect(isPossibleMatch(0.6)).toBe(true);
    expect(MATCH_THRESHOLD).toBeGreaterThan(0.6);
    expect(isPossibleMatch(0.8)).toBe(false);
  });

  it('never claims certainty in human wording', () => {
    for (const d of [0.3, 0.55, 0.62]) {
      const label = matchConfidenceLabel(d).toLowerCase();
      expect(label).not.toContain('definitely');
      expect(label).not.toContain('certain');
      expect(label).toContain('similarity');
    }
  });
});

describe('restricted-image export blocking', () => {
  const photo = (
    included: boolean,
    statuses: ('pending' | 'safe' | 'blocked' | 'removed')[],
  ) => ({ included, restrictedFlags: statuses.map((status) => ({ status })) });

  it('blocks export while any included photo awaits review', () => {
    const result = exportBlockers([photo(true, ['pending']), photo(true, [])]);
    expect(result.ok).toBe(false);
    expect(result.pendingReview).toBe(1);
  });

  it('blocks export when a blocked photo is still marked included', () => {
    const result = exportBlockers([photo(true, ['blocked'])]);
    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(1);
  });

  it('excluded photos do not block export', () => {
    const result = exportBlockers([photo(false, ['pending']), photo(false, ['blocked'])]);
    expect(result.ok).toBe(true);
  });

  it('reviewed-safe photos export normally', () => {
    const result = exportBlockers([photo(true, ['safe'])]);
    expect(result.ok).toBe(true);
  });

  it('blocks export when a photo could not be checked at all', () => {
    // No flags — but only because the recognition model never ran. Silence
    // from a check that did not happen must not read as approval.
    const result = exportBlockers([{ included: true, restrictedFlags: [], unscreened: true }]);
    expect(result.ok).toBe(false);
    expect(result.unscreened).toBe(1);
    expect(result.pendingReview).toBe(0);
  });

  it('an unchecked photo she took out of the reel does not block export', () => {
    const result = exportBlockers([{ included: false, restrictedFlags: [], unscreened: true }]);
    expect(result.ok).toBe(true);
  });
});
