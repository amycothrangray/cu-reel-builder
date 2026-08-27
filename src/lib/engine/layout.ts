// Crop and motion planning. Pure geometry — testable in Node.
//
// Invariants enforced here:
// - crops never extend outside the source image
// - the subject (face cluster or AI-detected subject) is contained in the
//   crop whenever it can physically fit; faces are never sliced through
// - pans end on the subject, never away from it

import type { FaceBox, NRect } from '../types';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Union of face boxes with margin, or a sensible center-weighted default. */
export function subjectRect(faces: FaceBox[], aiSubject?: NRect): NRect {
  if (faces.length > 0) {
    let x0 = 1;
    let y0 = 1;
    let x1 = 0;
    let y1 = 0;
    for (const f of faces) {
      x0 = Math.min(x0, f.x);
      y0 = Math.min(y0, f.y);
      x1 = Math.max(x1, f.x + f.w);
      y1 = Math.max(y1, f.y + f.h);
    }
    // Faces need headroom above and body context below.
    const mx = (x1 - x0) * 0.18;
    const myTop = (y1 - y0) * 0.45;
    const myBottom = (y1 - y0) * 0.8;
    return {
      x: clamp(x0 - mx, 0, 1),
      y: clamp(y0 - myTop, 0, 1),
      w: clamp(x1 - x0 + mx * 2, 0, 1 - clamp(x0 - mx, 0, 1)),
      h: clamp(y1 - y0 + myTop + myBottom, 0, 1 - clamp(y0 - myTop, 0, 1)),
    };
  }
  if (aiSubject) return aiSubject;
  // Rule-of-thirds center block.
  return { x: 0.2, y: 0.18, w: 0.6, h: 0.64 };
}

/**
 * Largest crop of `imageAspect` (w/h of the source) matching `targetAspect`
 * (w/h of the destination), positioned to keep `focus` inside — centered on
 * it when the focus fits, clamped to image bounds always.
 *
 * All rects are normalized to the source image.
 */
export function coverCrop(
  imageWidth: number,
  imageHeight: number,
  targetAspect: number,
  focus: NRect,
  zoom = 1,
): NRect {
  const imageAspect = imageWidth / imageHeight;
  // Crop dims in normalized source coords for the largest target-aspect crop.
  let cw: number;
  let ch: number;
  if (imageAspect > targetAspect) {
    ch = 1;
    cw = targetAspect / imageAspect;
  } else {
    cw = 1;
    ch = imageAspect / targetAspect;
  }
  cw /= zoom;
  ch /= zoom;

  const focusCx = focus.x + focus.w / 2;
  const focusCy = focus.y + focus.h / 2;

  let x = focusCx - cw / 2;
  let y = focusCy - ch / 2;

  // If the focus is taller/wider than the crop, prioritize its top (faces).
  if (focus.h > ch) y = focus.y - ch * 0.08;
  if (focus.w > cw) x = focusCx - cw / 2;

  x = clamp(x, 0, 1 - cw);
  y = clamp(y, 0, 1 - ch);
  return { x, y, w: cw, h: ch };
}

/** Does `inner` sit fully inside `outer` (with tolerance)? */
export function contains(outer: NRect, inner: NRect, tol = 0.005): boolean {
  return (
    inner.x >= outer.x - tol &&
    inner.y >= outer.y - tol &&
    inner.x + inner.w <= outer.x + outer.w + tol &&
    inner.y + inner.h <= outer.y + outer.h + tol
  );
}

/** Fraction of `a` covered by `b`. */
export function overlapFraction(a: NRect, b: NRect): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const area = a.w * a.h;
  return area > 0 ? (ix * iy) / area : 0;
}

/**
 * Would this crop slice through a face? A face is fine fully inside or fully
 * outside; partial overlap between ~15% and ~85% reads as a cut-off head.
 */
export function cropSlicesFace(crop: NRect, faces: FaceBox[]): boolean {
  return faces.some((f) => {
    const frac = overlapFraction(f, crop);
    return frac > 0.15 && frac < 0.85;
  });
}

/** Nudge a crop horizontally/vertically so no face is sliced, if possible. */
export function avoidFaceSlice(
  crop: NRect,
  faces: FaceBox[],
  maxNudge = 0.15,
): NRect {
  if (!cropSlicesFace(crop, faces)) return crop;
  const steps = 8;
  for (let s = 1; s <= steps; s++) {
    const d = (maxNudge * s) / steps;
    for (const [dx, dy] of [
      [d, 0],
      [-d, 0],
      [0, d],
      [0, -d],
    ]) {
      const moved: NRect = {
        x: clamp(crop.x + dx, 0, 1 - crop.w),
        y: clamp(crop.y + dy, 0, 1 - crop.h),
        w: crop.w,
        h: crop.h,
      };
      if (!cropSlicesFace(moved, faces)) return moved;
    }
  }
  return crop; // caller should fall back to a full-image treatment
}

export interface MotionPlan {
  crop: NRect;
  cropEnd: NRect;
  fill: 'cover' | 'contain-blur' | 'contain-brand';
}

/**
 * Pan across a horizontal image: a 9:16 slice travels toward the subject and
 * settles on it. Travel distance is restrained so motion stays gentle.
 */
export function planPan(
  imageWidth: number,
  imageHeight: number,
  targetAspect: number,
  faces: FaceBox[],
  aiSubject?: NRect,
): MotionPlan {
  const focus = subjectRect(faces, aiSubject);
  const end = avoidFaceSlice(
    coverCrop(imageWidth, imageHeight, targetAspect, focus),
    faces,
  );
  // Start offset toward whichever side has more room, capped for gentleness.
  const roomLeft = end.x;
  const roomRight = 1 - (end.x + end.w);
  const travel = Math.min(0.22, Math.max(roomLeft, roomRight));
  const dir = roomLeft >= roomRight ? -1 : 1;
  const start: NRect = {
    ...end,
    x: clamp(end.x + dir * travel, 0, 1 - end.w),
  };
  return { crop: start, cropEnd: end, fill: 'cover' };
}

/** Gentle push: settle from a slightly wider framing into the subject. */
export function planPush(
  imageWidth: number,
  imageHeight: number,
  targetAspect: number,
  faces: FaceBox[],
  aiSubject?: NRect,
  strength = 1.07,
): MotionPlan {
  const focus = subjectRect(faces, aiSubject);
  const wide = avoidFaceSlice(
    coverCrop(imageWidth, imageHeight, targetAspect, focus, 1),
    faces,
  );
  const tight = avoidFaceSlice(
    coverCrop(imageWidth, imageHeight, targetAspect, focus, strength),
    faces,
  );
  return { crop: wide, cropEnd: tight, fill: 'cover' };
}

/** Reverse push (settle outward) — used for closing images. */
export function planPull(
  imageWidth: number,
  imageHeight: number,
  targetAspect: number,
  faces: FaceBox[],
  aiSubject?: NRect,
  strength = 1.07,
): MotionPlan {
  const p = planPush(imageWidth, imageHeight, targetAspect, faces, aiSubject, strength);
  return { crop: p.cropEnd, cropEnd: p.crop, fill: 'cover' };
}

/** Full-image treatment over a blurred backdrop, with a barely-there drift. */
export function planFullImage(
  _imageWidth: number,
  _imageHeight: number,
  _faces: FaceBox[],
): MotionPlan {
  const full: NRect = { x: 0, y: 0, w: 1, h: 1 };
  return { crop: full, cropEnd: full, fill: 'contain-blur' };
}

export interface PhotoLike {
  id: string;
  width: number;
  height: number;
  faces: FaceBox[];
  aiSubject?: NRect;
  /** User-set crop — always wins over automatic framing. */
  customCrop?: NRect;
}

/** Center-shrink a rect by a zoom factor (result always stays inside). */
export function shrinkRect(rect: NRect, zoom: number): NRect {
  const w = rect.w / zoom;
  const h = rect.h / zoom;
  return {
    x: rect.x + (rect.w - w) / 2,
    y: rect.y + (rect.h - h) / 2,
    w,
    h,
  };
}

export type TreatmentKind = 'cover-push' | 'cover-pull' | 'pan' | 'full-blur' | 'static';

/**
 * Choose the right treatment for one photo in a 9:16 frame.
 *
 * - portrait / square → cover with a gentle push (composition survives)
 * - horizontal, subject fits a vertical slice → pan or push onto the subject
 * - horizontal, faces spread too wide for a vertical slice (groups, families)
 *   → full image over a blurred backdrop; never chop the family in half
 */
export function planTreatment(
  photo: PhotoLike,
  targetAspect: number,
  prefer: TreatmentKind | 'auto' = 'auto',
): MotionPlan {
  const { width, height, faces, aiSubject } = photo;
  const aspect = width / height;

  // A user-set crop overrides all automatic framing. Motion happens inside
  // the chosen crop so nothing the user framed out ever appears.
  if (photo.customCrop) {
    const crop = photo.customCrop;
    if (prefer === 'static') return { crop, cropEnd: crop, fill: 'cover' };
    const tight = shrinkRect(crop, 1.06);
    if (prefer === 'cover-pull') return { crop: tight, cropEnd: crop, fill: 'cover' };
    return { crop, cropEnd: tight, fill: 'cover' };
  }

  if (prefer === 'full-blur') return planFullImage(width, height, faces);
  if (prefer === 'static') {
    const focus = subjectRect(faces, aiSubject);
    const crop = avoidFaceSlice(coverCrop(width, height, targetAspect, focus), faces);
    return { crop, cropEnd: crop, fill: 'cover' };
  }

  const isHorizontal = aspect > 1.05;
  if (isHorizontal) {
    // Can a vertical slice hold the whole face cluster? A group spread wider
    // than the slice would leave people out of frame — never chop a family
    // in half; show the whole photograph instead.
    const focus = subjectRect(faces, aiSubject);
    const slice = coverCrop(width, height, targetAspect, focus);
    const clusterTooWide =
      faces.length >= 2 && (focus.w > slice.w * 1.02 || focus.h > slice.h * 1.02);
    if (clusterTooWide) {
      return planFullImage(width, height, faces);
    }
    if (cropSlicesFace(slice, faces)) {
      const nudged = avoidFaceSlice(slice, faces);
      if (cropSlicesFace(nudged, faces)) {
        return planFullImage(width, height, faces);
      }
    }
    if (prefer === 'pan') return planPan(width, height, targetAspect, faces, aiSubject);
    if (prefer === 'cover-pull') return planPull(width, height, targetAspect, faces, aiSubject);
    // Default for horizontals: pan when there is room to travel, else push.
    const pan = planPan(width, height, targetAspect, faces, aiSubject);
    const travel = Math.abs(pan.crop.x - pan.cropEnd.x);
    return travel > 0.04 ? pan : planPush(width, height, targetAspect, faces, aiSubject);
  }

  if (prefer === 'cover-pull') return planPull(width, height, targetAspect, faces, aiSubject);
  if (prefer === 'pan') return planPan(width, height, targetAspect, faces, aiSubject);
  return planPush(width, height, targetAspect, faces, aiSubject);
}

/**
 * Can these two horizontal photos stack into one frame without slicing
 * faces? Each half is roughly 1080×960 (aspect 1.125).
 */
export function canStackPair(a: PhotoLike, b: PhotoLike): boolean {
  const halfAspect = 9 / 8;
  // A photo with a user-set 9:16 crop shouldn't be re-framed into a half slot.
  if (a.customCrop || b.customCrop) return false;
  for (const p of [a, b]) {
    if (p.width / p.height <= 1.05) return false; // stacking is for horizontals
    const focus = subjectRect(p.faces);
    const crop = avoidFaceSlice(coverCrop(p.width, p.height, halfAspect, focus), p.faces);
    if (cropSlicesFace(crop, p.faces)) return false;
  }
  return true;
}

export function stackedLayers(a: PhotoLike, b: PhotoLike): { photo: PhotoLike; dest: NRect; plan: MotionPlan }[] {
  const halfAspect = 9 / 8;
  return [a, b].map((photo, i) => {
    const focus = subjectRect(photo.faces, photo.aiSubject);
    const crop = avoidFaceSlice(
      coverCrop(photo.width, photo.height, halfAspect, focus),
      photo.faces,
    );
    // Opposing subtle drifts give the stack life without competing.
    const drift = 0.03 * (i === 0 ? 1 : -1);
    const cropEnd: NRect = {
      ...crop,
      x: clamp(crop.x + drift * crop.w, 0, 1 - crop.w),
    };
    return {
      photo,
      dest: { x: 0, y: i * 0.5, w: 1, h: 0.5 },
      plan: { crop, cropEnd, fill: 'cover' as const },
    };
  });
}
