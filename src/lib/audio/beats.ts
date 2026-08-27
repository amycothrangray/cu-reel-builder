// Local beat detection — deterministic Web Audio analysis, no AI, no network.
//
// Approach: decode → mono energy envelope → onset detection via spectral-flux
// style energy differences → pick peaks with a minimum spacing. Good enough
// to make cuts feel musical; templates snap only when a beat is close, so a
// missed beat never breaks pacing.

export interface BeatAnalysis {
  beats: number[]; // ms timestamps
  durationMs: number;
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
  const chosen: number[] = [];
  for (const o of sorted) {
    if (chosen.every((c) => Math.abs(c - o.frame) >= minSpacingFrames)) {
      chosen.push(o.frame);
    }
  }
  chosen.sort((a, b) => a - b);

  const beats = chosen.map((f) => (f * hop * 1000) / sampleRate);
  return { beats, durationMs };
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
