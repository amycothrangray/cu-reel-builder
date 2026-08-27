import type { ClassificationResult, ExifSummary, ImageStats } from '../types';

// Camera makes that indicate dedicated / interchangeable-lens cameras.
const PRO_MAKES = [
  'canon', 'nikon', 'sony', 'fujifilm', 'fuji', 'leica', 'hasselblad',
  'olympus', 'om digital', 'panasonic', 'pentax', 'ricoh', 'sigma', 'phase one',
];

// Phone makers. Note Sony/Samsung also make cameras — model refines this.
const PHONE_MAKES = ['apple', 'google', 'samsung', 'xiaomi', 'oneplus', 'huawei', 'motorola', 'oppo', 'vivo'];

const PHONE_MODEL_HINTS = ['iphone', 'ipad', 'pixel', 'galaxy', 'sm-', 'moto', 'redmi', 'oneplus'];

const PRO_SOFTWARE_HINTS = ['lightroom', 'capture one', 'photoshop', 'darktable', 'dxo', 'luminar'];

/**
 * Classifies a photo as professional-camera vs mobile/casual.
 *
 * EXIF is the strongest signal but may have been stripped on export, so
 * image measurements act as a fallback. When confidence is low we return
 * 'uncertain' — and uncertain photos are never auto-corrected.
 */
export function classifyPhoto(
  exif: ExifSummary,
  stats: ImageStats,
  opts: { width: number; height: number; mimeType: string },
): ClassificationResult {
  const reasons: string[] = [];
  const make = (exif.make ?? '').toLowerCase();
  const model = (exif.model ?? '').toLowerCase();
  const software = (exif.software ?? '').toLowerCase();

  // --- Hard EXIF signals -------------------------------------------------
  const phoneByModel = PHONE_MODEL_HINTS.some((h) => model.includes(h));
  if (phoneByModel || make === 'apple' || make === 'google') {
    reasons.push(`Camera reports as a phone (${exif.make ?? ''} ${exif.model ?? ''})`.trim());
    return { label: 'mobile', confidence: 0.95, reasons };
  }

  const proByMake = PRO_MAKES.some((m) => make.includes(m));
  if (proByMake && !PHONE_MAKES.some((m) => make === m && phoneByModel)) {
    reasons.push(`Shot on a dedicated camera (${exif.make} ${exif.model ?? ''})`.trim());
    // Lens metadata or wide apertures reinforce it.
    if (exif.lensModel || (exif.fNumber !== undefined && exif.fNumber <= 2.8)) {
      reasons.push('Interchangeable-lens metadata present');
    }
    return { label: 'pro', confidence: 0.95, reasons };
  }

  if (PHONE_MAKES.some((m) => make.includes(m))) {
    reasons.push(`Camera make suggests a phone (${exif.make})`);
    return { label: 'mobile', confidence: 0.8, reasons };
  }

  // --- Soft signals (EXIF stripped or inconclusive) ----------------------
  let proScore = 0;
  let mobileScore = 0;

  if (PRO_SOFTWARE_HINTS.some((s) => software.includes(s))) {
    proScore += 2;
    reasons.push(`Edited in professional software (${exif.software})`);
  }

  if (opts.mimeType === 'image/heic' || opts.mimeType === 'image/heif') {
    mobileScore += 2;
    reasons.push('HEIC format (typical of phone captures)');
  }

  const megapixels = (opts.width * opts.height) / 1e6;
  if (megapixels >= 30) {
    proScore += 1;
    reasons.push(`High resolution (${megapixels.toFixed(0)} MP)`);
  }

  // Phone processing fingerprints: heavy contrast + saturation + clipping.
  const punchiness =
    (stats.contrast > 0.26 ? 1 : 0) +
    (stats.saturation > 0.42 ? 1 : 0) +
    (stats.highlightClip > 0.02 ? 1 : 0) +
    (stats.skinWarmthExcess > 0.04 && stats.skinFraction > 0.04 ? 1 : 0);
  if (punchiness >= 3) {
    mobileScore += 2;
    reasons.push('Processing signature typical of phone HDR (high contrast, saturation, clipping)');
  } else if (punchiness === 2) {
    mobileScore += 1;
    reasons.push('Somewhat punchy processing');
  }

  // Professional edits tend to hold highlights and moderate saturation.
  if (stats.highlightClip < 0.004 && stats.saturation < 0.38 && stats.contrast < 0.26) {
    proScore += 1;
    reasons.push('Restrained tonality consistent with a professional edit');
  }

  // A single weak signal isn't enough to claim a label — uncertain photos
  // are preserved untouched, which is the safe default.
  if (proScore >= 2 && proScore > mobileScore) {
    return { label: 'pro', confidence: Math.min(0.75, 0.5 + proScore * 0.1), reasons };
  }
  if (mobileScore >= 2 && mobileScore > proScore) {
    return { label: 'mobile', confidence: Math.min(0.7, 0.45 + mobileScore * 0.1), reasons };
  }

  reasons.push('No reliable camera metadata; measurements inconclusive');
  return { label: 'uncertain', confidence: 0.35, reasons };
}

/**
 * Whether the restrained correction should default ON for a newly analyzed
 * photo. Manual choices always take precedence later; uncertain photos are
 * left untouched by design.
 */
export function correctionDefault(c: ClassificationResult, stats: ImageStats): boolean {
  if (c.label !== 'mobile') return false;
  // Only correct when the image actually shows the issues we correct for.
  return (
    stats.contrast > 0.24 ||
    stats.highlightClip > 0.015 ||
    stats.skinWarmthExcess > 0.03 ||
    stats.warmth > 0.09 ||
    stats.saturation > 0.42
  );
}
