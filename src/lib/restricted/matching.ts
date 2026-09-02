// Restricted-child matching logic. Pure math — testable in Node.

/**
 * Euclidean distance threshold for flagging. face-api's convention treats
 * ~0.6 as "same person"; we flag at 0.55 (likely) and keep flagging up to
 * 0.62 as "possible" because a false positive costs a quick human review,
 * while a false negative could publish a child who must not appear.
 */
export const MATCH_THRESHOLD = 0.62;
export const LIKELY_THRESHOLD = 0.5;

export function euclideanDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** Best (smallest) distance between a face and any reference of a profile. */
export function bestDistance(
  descriptor: ArrayLike<number>,
  references: ArrayLike<number>[],
): number {
  let best = Infinity;
  for (const ref of references) {
    const d = euclideanDistance(descriptor, ref);
    if (d < best) best = d;
  }
  return best;
}

export const isPossibleMatch = (distance: number): boolean => distance <= MATCH_THRESHOLD;

/** Human wording only — biometric matching is never presented as certain. */
export function matchConfidenceLabel(distance: number): string {
  if (distance <= LIKELY_THRESHOLD) return 'Strong similarity';
  if (distance <= 0.56) return 'Moderate similarity';
  return 'Possible similarity';
}

// ---------------------------------------------------------------------------
// Export gating

export interface FlagLike {
  status: 'pending' | 'safe' | 'blocked' | 'removed';
}

export interface PhotoFlagView {
  included: boolean;
  restrictedFlags: FlagLike[];
  /**
   * Faces were found but could not be checked against the restricted
   * profiles (the recognition model was unavailable). Unknown is not safe.
   */
  unscreened?: boolean;
}

/**
 * A reel may export only when every included photo has actually been checked
 * and nothing is left unreviewed or blocked. A photo the app could not screen
 * counts against export exactly like one awaiting review — the whole point of
 * this feature is that silence never reads as approval.
 */
export function exportBlockers(photos: PhotoFlagView[]): {
  pendingReview: number;
  blocked: number;
  unscreened: number;
  ok: boolean;
} {
  let pendingReview = 0;
  let blocked = 0;
  let unscreened = 0;
  for (const p of photos) {
    if (!p.included) continue;
    if (p.unscreened) unscreened++;
    for (const f of p.restrictedFlags) {
      if (f.status === 'pending') pendingReview++;
      if (f.status === 'blocked') blocked++;
    }
  }
  return {
    pendingReview,
    blocked,
    unscreened,
    ok: pendingReview === 0 && blocked === 0 && unscreened === 0,
  };
}
