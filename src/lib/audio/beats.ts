// Local beat detection — deterministic Web Audio analysis, no AI, no network.
//
// Approach: decode → mono energy envelope → onset detection via spectral-flux
// style energy differences → pick peaks with a minimum spacing. Good enough
// to make cuts feel musical; templates snap only when a beat is close, so a
// missed beat never breaks pacing.

export interface BeatAnalysis {
  beats: number[]; // ms timestamps
  /** The most emphatic onsets — where hero moments want to land. */
  strongBeats: number[];
  /**
   * Normalized energy 0..1 sampled every INTENSITY_STEP_MS. Lets the
   * planner feel builds, drops and quiet passages without full MIR.
   */
  intensity: number[];
  durationMs: number;
}

export const INTENSITY_STEP_MS = 500;

/** Intensity at a timestamp (0.5 when no music/curve available). */
export function intensityAt(analysis: Pick<BeatAnalysis, 'intensity'>, tMs: number): number {
  if (analysis.intensity.length === 0) return 0.5;
  const i = Math.min(
    analysis.intensity.length - 1,
    Math.max(0, Math.floor(tMs / INTENSITY_STEP_MS)),
  );
  return analysis.intensity[i];
}

const beatCache = new Map<string, BeatAnalysis>();

export async function analyzeBeats(key: string, blob: Blob): Promise<BeatAnalysis> {
  const cached = beatCache.get(key);
  if (cached) return cached;

  const arrayBuffer = await blob.arrayBuffer();
  const decodeCtx = new OfflineAudioContext(1, 1, 44100);
  const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
  const analysis = detectBeats(audioBuffer.getChannelData(0), audioBuffer.sampleRate);
  beatCache.set(key, analysis);
  return analysis;
}

/** Pure detector — exported for tests. */
export function detectBeats(samples: Float32Array, sampleRate: number): BeatAnalysis {
  const durationMs = (samples.length / sampleRate) * 1000;

  // Energy envelope over ~23ms hops.
  const hop = 1024;
  const frames = Math.floor(samples.length / hop);
  const energy = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const off = f * hop;
    for (let i = 0; i < hop; i++) {
      const s = samples[off + i];
      sum += s * s;
    }
    energy[f] = sum / hop;
  }

  // Onset strength: positive energy increase vs. a local average.
  const windowFrames = 43; // ≈1s of context
  const onsets: { frame: number; strength: number }[] = [];
  for (let f = 1; f < frames; f++) {
    const start = Math.max(0, f - windowFrames);
    let localAvg = 0;
    for (let i = start; i < f; i++) localAvg += energy[i];
    localAvg /= Math.max(1, f - start);
    const rise = energy[f] - energy[f - 1];
    if (energy[f] > localAvg * 1.4 && rise > 0) {
      onsets.push({ frame: f, strength: energy[f] / (localAvg + 1e-9) });
    }
  }

  // Peak-pick with minimum spacing (~280ms → max ~214bpm).
  const minSpacingFrames = Math.round((0.28 * sampleRate) / hop);
  const sorted = [...onsets].sort((a, b) => b.strength - a.strength);
  const chosen: { frame: number; strength: number }[] = [];
  for (const o of sorted) {
    if (chosen.every((c) => Math.abs(c.frame - o.frame) >= minSpacingFrames)) {
      chosen.push(o);
    }
  }
  chosen.sort((a, b) => a.frame - b.frame);

  const toMs = (f: number) => (f * hop * 1000) / sampleRate;
  const beats = chosen.map((c) => toMs(c.frame));

  // Strong beats: the top third by onset strength, spaced ≥ 1s apart.
  const strongSpacingFrames = Math.round(sampleRate / hop);
  const byStrength = [...chosen].sort((a, b) => b.strength - a.strength);
  const strongCount = Math.max(1, Math.floor(chosen.length / 3));
  const strong: { frame: number; strength: number }[] = [];
  for (const c of byStrength) {
    if (strong.length >= strongCount) break;
    if (strong.every((s) => Math.abs(s.frame - c.frame) >= strongSpacingFrames)) {
      strong.push(c);
    }
  }
  const strongBeats = strong.map((s) => toMs(s.frame)).sort((a, b) => a - b);

  // Intensity envelope: mean energy per window, normalized to its own peak.
  const framesPerWindow = Math.max(1, Math.round((INTENSITY_STEP_MS / 1000) * sampleRate) / hop);
  const windows = Math.ceil(durationMs / INTENSITY_STEP_MS);
  const intensity = new Array<number>(windows).fill(0);
  for (let w = 0; w < windows; w++) {
    const start = Math.floor(w * framesPerWindow);
    const end = Math.min(frames, Math.ceil((w + 1) * framesPerWindow));
    let sum = 0;
    for (let f = start; f < end; f++) sum += energy[f];
    intensity[w] = end > start ? sum / (end - start) : 0;
  }
  const peak = Math.max(...intensity, 1e-9);
  for (let w = 0; w < windows; w++) {
    intensity[w] = Math.sqrt(intensity[w] / peak); // sqrt: perceptual-ish
  }

  return { beats, strongBeats, intensity, durationMs };
}

/** Decode an audio blob to an AudioBuffer at export sample rate. */
export async function decodeAudio(blob: Blob, sampleRate = 48000): Promise<AudioBuffer> {
  const arrayBuffer = await blob.arrayBuffer();
  const probe = new OfflineAudioContext(2, 1, sampleRate);
  return probe.decodeAudioData(arrayBuffer);
}

/**
 * Render the reel's audio track: trimmed to duration, with a gentle fade-out
 * at the end. Deterministic offline rendering.
 */
export async function renderReelAudio(
  blob: Blob,
  durationMs: number,
  { gain = 1, fadeOutMs = 900, sampleRate = 48000 } = {},
): Promise<AudioBuffer> {
  const source = await decodeAudio(blob, sampleRate);
  const frames = Math.ceil((durationMs / 1000) * sampleRate);
  const offline = new OfflineAudioContext(2, frames, sampleRate);
  const node = offline.createBufferSource();
  node.buffer = source;
  const gainNode = offline.createGain();
  gainNode.gain.setValueAtTime(gain, 0);
  const fadeStart = Math.max(0, durationMs - fadeOutMs) / 1000;
  gainNode.gain.setValueAtTime(gain, fadeStart);
  gainNode.gain.linearRampToValueAtTime(0.0001, durationMs / 1000);
  node.connect(gainNode);
  gainNode.connect(offline.destination);
  node.start(0);
  return offline.startRendering();
}
