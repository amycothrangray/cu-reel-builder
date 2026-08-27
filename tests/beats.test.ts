import { describe, expect, it } from 'vitest';
import { detectBeats } from '../src/lib/audio/beats';

/** Synthesize a click track: sharp bursts at a fixed BPM over quiet noise. */
function clickTrack(bpm: number, seconds: number, sampleRate = 44100): Float32Array {
  const samples = new Float32Array(sampleRate * seconds);
  // Quiet noise floor.
  for (let i = 0; i < samples.length; i++) {
    samples[i] = (Math.sin(i * 12.9898) * 43758.5453) % 1 * 0.01;
  }
  const interval = (60 / bpm) * sampleRate;
  for (let beat = 0; beat * interval < samples.length; beat++) {
    const start = Math.floor(beat * interval);
    for (let i = 0; i < 2000 && start + i < samples.length; i++) {
      samples[start + i] += Math.sin(i * 0.35) * Math.exp(-i / 500) * 0.8;
    }
  }
  return samples;
}

describe('beat detection', () => {
  it('finds beats near the clicks of a 120bpm track', () => {
    const sr = 44100;
    const { beats, durationMs } = detectBeats(clickTrack(120, 8, sr), sr);
    expect(durationMs).toBeCloseTo(8000, -1);
    expect(beats.length).toBeGreaterThanOrEqual(8);
    // Most detected beats should sit within 90ms of a true 500ms grid point.
    const aligned = beats.filter((b) => {
      const nearest = Math.round(b / 500) * 500;
      return Math.abs(b - nearest) < 90;
    });
    expect(aligned.length / beats.length).toBeGreaterThan(0.7);
  });

  it('returns few or no beats for near-silence', () => {
    const sr = 44100;
    const silence = new Float32Array(sr * 4).fill(0.0001);
    const { beats } = detectBeats(silence, sr);
    expect(beats.length).toBeLessThan(4);
  });

  it('respects minimum beat spacing', () => {
    const sr = 44100;
    const { beats } = detectBeats(clickTrack(200, 6, sr), sr);
    for (let i = 1; i < beats.length; i++) {
      expect(beats[i] - beats[i - 1]).toBeGreaterThanOrEqual(270);
    }
  });
});
