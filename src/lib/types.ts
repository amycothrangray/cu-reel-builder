// Core data model. Everything persisted lives in IndexedDB (see db.ts) —
// photos and reels never leave the device unless the optional AI analysis
// route is enabled, and even then only downscaled previews are sent.

export type Classification = 'pro' | 'mobile' | 'uncertain';

export interface ClassificationResult {
  label: Classification;
  confidence: number; // 0..1
  reasons: string[];
}

/** Normalized rectangle: all values 0..1 relative to image dimensions. */
export interface NRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FaceBox extends NRect {
  score: number;
}

export interface ExifSummary {
  make?: string;
  model?: string;
  lensModel?: string;
  focalLength?: number;
  fNumber?: number;
  iso?: number;
  software?: string;
  dateTaken?: string;
}

/** Deterministic per-image measurements computed locally from a preview. */
export interface ImageStats {
  sharpness: number;        // Laplacian variance, normalized-ish
  contrast: number;         // 0..1 luma std-dev
  saturation: number;       // 0..1 mean
  warmth: number;           // R-B balance, ~0 neutral, positive = warm
  highlightClip: number;    // fraction of near-white pixels
  shadowCrush: number;      // fraction of near-black pixels
  meanLuma: number;         // 0..1
  skinWarmthExcess: number; // how orange detected skin-tone pixels skew
  skinFraction: number;     // fraction of pixels that look like skin
}

/** Optional AI enrichment (from the Netlify vision function, if configured). */
export interface AiInsight {
  storyRole?:
    | 'establishing'
    | 'interaction'
    | 'closeup'
    | 'detail'
    | 'movement'
    | 'portrait'
    | 'emotional'
    | 'closing';
  subjectRect?: NRect;
  appeal?: number; // 0..1
  notes?: string;
}

export interface PhotoAnalysis {
  stats: ImageStats;
  faces: FaceBox[];
  /**
   * 128-d face descriptors parallel to `faces`, computed locally. Used only
   * to recognize *recurring* people within this uploaded set (so a school
   * reel shows many students, not the same three) and for restricted-child
   * matching. Never used for demographic inference; never leaves the device.
   */
  descriptors?: number[][];
  /**
   * True when faces were found but the recognition model could not produce
   * descriptors for them — so this photo was NOT screened against restricted
   * profiles. A failed check must never look like a clean one: the photo is
   * held for human review and the result is never cached.
   */
  screeningIncomplete?: boolean;
  phash: string; // 64-bit perceptual hash as hex
  classification: ClassificationResult;
  /** Composite quality score 0..1 used for auto-selection. */
  score: number;
  ai?: AiInsight;
  analyzedAt: number;
  version: number; // bump to invalidate cached analyses
}

export type RestrictedFlagStatus = 'pending' | 'safe' | 'blocked' | 'removed';

export interface RestrictedFlag {
  profileId: string;
  profileLabel: string;
  face: FaceBox;
  /** Euclidean distance between embeddings — lower is more similar. */
  distance: number;
  status: RestrictedFlagStatus;
  reviewedAt?: number;
  reviewedBy?: string;
}

export interface PhotoRecord {
  id: string;
  reelId: string;
  hash: string;
  fileName: string;
  mimeType: string;
  bytes: number;
  width: number;
  height: number;
  addedAt: number;
  order: number;
  exif: ExifSummary;
  analysis?: PhotoAnalysis;
  /** Manual override always wins over automatic classification. */
  overrideClassification?: 'pro' | 'mobile';
  /** Whether the restrained mobile correction is applied. */
  correctionEnabled: boolean;
  /** True once a corrected render exists in the blob store. */
  hasCorrected: boolean;
  /**
   * User-set 9:16 crop (normalized source rect). Overrides the automatic
   * framing wherever the photo appears full-frame. Presentation-only.
   */
  customCrop?: NRect;
  included: boolean;
  restrictedFlags: RestrictedFlag[];
  /**
   * Restricted profiles were active but this photo could not actually be
   * checked against them (the recognition model was unavailable). Unknown is
   * not the same as safe: it holds up export until a person has looked.
   */
  unscreened?: boolean;
  status: 'ingesting' | 'analyzing' | 'ready' | 'error';
  error?: string;
}

export const effectiveClassification = (p: PhotoRecord): Classification =>
  p.overrideClassification ?? p.analysis?.classification.label ?? 'uncertain';

/** Correction may only ever apply to photos treated as mobile/casual. */
export const correctionAllowed = (p: PhotoRecord): boolean =>
  effectiveClassification(p) === 'mobile';

// ---------------------------------------------------------------------------
// Reels

export type TemplateId =
  | 'signature-energy'
  | 'cinematic-story'
  | 'quick-cut'
  | 'rapid-fire'
  | 'editorial-minimal'
  | 'photo-story';

/**
 * Reel length in whole seconds. 9 / 12 / 15 are the quick-pick defaults, but
 * any whole number within MIN/MAX_REEL_DURATION_SEC is valid — the user can
 * type their own.
 */
export type ReelDuration = number;
export const REEL_DURATION_PRESETS: ReelDuration[] = [9, 12, 15];
export const MIN_REEL_DURATION_SEC = 5;
export const MAX_REEL_DURATION_SEC = 60;

export const clampReelDuration = (sec: number): ReelDuration =>
  Math.min(MAX_REEL_DURATION_SEC, Math.max(MIN_REEL_DURATION_SEC, Math.round(sec)));

/**
 * What job the reel is doing. Purpose controls EDITORIAL PRIORITIES
 * (selection, breadth, emphasis); Style controls PRESENTATION CHARACTER.
 */
export type ReelPurpose = 'photography' | 'school' | 'auto';

/** Instagram Audio Reference — metadata the user needs to recreate sync. */
export interface InstagramAudioPlan {
  songTitle: string;
  artist: string;
  /** Temporary reference audio (timing/preview only, never exported). */
  referenceAssetKey: string | null;
  referenceName: string | null;
  /** Where in the official track the reel starts — the critical number. */
  startSec: number;
}

export interface ReelTextConfig {
  title: string;
  caption: string;
  cta: string;
  showHandle: boolean;
  /** Part of the sign-off; only ever rendered when branding is switched on. */
  showLogo?: boolean;
}

export interface ReelVersion {
  id: string;
  label: string; // "Version 1", …
  createdAt: number;
  timeline: import('./engine/types').Timeline;
}

export interface ReelRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  status: 'draft' | 'ready' | 'exported';
  templateId: TemplateId | null;
  durationSec: ReelDuration;
  text: ReelTextConfig;
  musicAssetKey: string | null;
  musicName: string | null;
  /**
   * Instagram Audio workflow: the reel is edited to a song the user will add
   * natively inside Instagram. A temporary reference track drives timing and
   * preview only — it is never embedded in an Instagram-targeted export.
   * Instagram remains the source of truth for what audio is available.
   */
  instagramAudio?: InstagramAudioPlan | null;
  versions: ReelVersion[];
  activeVersionId: string | null;
  /**
   * CONTENT lock: photos the user explicitly added. They must appear, but
   * the engine still chooses the strongest order — choosing content is not
   * volunteering to be the video editor.
   */
  requiredIds?: string[];
  /**
   * ORDER lock: set only by explicit manual reordering. When present, both
   * the photo set and its order are honored exactly.
   */
  manualOrder: string[] | null;
  purpose?: ReelPurpose;
  /**
   * Whether this reel ends with the brand sign-off — logo, handle and call to
   * action. OFF unless she turns it on: most reels are the work itself, not
   * an advertisement, and a saved brand kit is something to reach for rather
   * than something that stamps itself on everything. Absent means off.
   */
  branding?: boolean;
  exportedAt?: number;
}

// ---------------------------------------------------------------------------
// Brand

export interface BrandFont {
  assetKey: string;
  fileName: string;
  family: string; // registered FontFace family name
}

export interface BrandConfig {
  id: 'brand';
  primaryFont: BrandFont | null;
  secondaryFont: BrandFont | null;
  logoAssetKey: string | null;
  primaryColor: string;
  secondaryColor: string;
  cta: string;
  website: string;
  instagram: string;
  updatedAt: number;
}

export const defaultBrand = (): BrandConfig => ({
  id: 'brand',
  primaryFont: null,
  secondaryFont: null,
  logoAssetKey: null,
  primaryColor: '#211d18',
  secondaryColor: '#faf8f5',
  cta: 'Book your session',
  website: '',
  instagram: '',
  updatedAt: Date.now(),
});

// ---------------------------------------------------------------------------
// Restricted-child protection

export interface RestrictedProfile {
  id: string;
  label: string; // internal label only — no birth dates, schools, addresses
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
  referenceCount: number;
}

/** AES-GCM encrypted payload holding embeddings + tiny review thumbnails. */
export interface RestrictedProfileData {
  profileId: string;
  iv: ArrayBuffer;
  cipher: ArrayBuffer;
}

export interface RestrictedReference {
  embedding: number[]; // 128-d face descriptor, computed locally
  thumbDataUrl: string; // small jpeg for the review screen only
  addedAt: number;
}

export interface AuditEntry {
  id?: number;
  at: number;
  actor: string;
  action: string;
  details: string;
}

// ---------------------------------------------------------------------------
// Music library

export interface MusicTrack {
  id: string;
  name: string;
  assetKey: string;
  durationSec: number;
  addedAt: number;
}

// ---------------------------------------------------------------------------
// Usage tracking

export type UsageKind = 'reel-created' | 'export' | 'ai-call' | 'analysis';

export interface UsageEvent {
  id?: number;
  at: number;
  kind: UsageKind;
  meta?: string;
}

// ---------------------------------------------------------------------------
// Settings

export interface SettingRow {
  key: string;
  value: unknown;
}

export interface AdminPin {
  salt: string; // base64
  hash: string; // base64 PBKDF2-SHA256
  iterations: number;
}
