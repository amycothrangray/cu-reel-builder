// Local deterministic renderer: draws every frame with renderFrame and
// encodes H.264/AAC MP4 entirely in the browser via WebCodecs + Mediabunny.
// Falls back to realtime MediaRecorder capture on browsers without WebCodecs.

import {
  BufferTarget,
  CanvasSource,
  AudioBufferSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  canEncodeVideo,
  getFirstEncodableAudioCodec,
  type AudioCodec,
} from 'mediabunny';
import { getBlob } from '../../db';
import { uid } from '../../ids';
import { renderReelAudio } from '../../audio/beats';
import { loadResources } from '../resources';
import { renderFrame } from '../renderFrame';
import type {
  RenderJob,
  RenderJobInput,
  RenderOutput,
  RenderProgress,
  VideoGenerationProvider,
} from './provider';

interface JobState {
  job: RenderJob;
  output?: RenderOutput;
  canceled: boolean;
}

const STAGES = {
  preparing: 'Looking through your photos',
  audio: 'Matching the music',
  rendering: 'Building your reel',
  finishing: 'Finishing your video',
};

export class LocalRenderProvider implements VideoGenerationProvider {
  readonly name = 'In-browser renderer';
  private jobs = new Map<string, JobState>();

  async isAvailable(): Promise<boolean> {
    if (typeof VideoEncoder === 'undefined') return false;
    try {
      return await canEncodeVideo('avc', { width: 1080, height: 1920 });
    } catch {
      return false;
    }
  }

  async createJob(
    input: RenderJobInput,
    onProgress: (p: RenderProgress) => void,
  ): Promise<RenderJob> {
    const state: JobState = {
      job: {
        id: uid(),
        status: 'rendering',
        progress: { fraction: 0, stage: STAGES.preparing },
      },
      canceled: false,
    };
    this.jobs.set(state.job.id, state);

    // Render asynchronously; caller polls checkStatus or awaits via progress.
    void this.run(state, input, onProgress).catch((err) => {
      state.job.status = 'error';
      state.job.error = err instanceof Error ? err.message : String(err);
    });
    return state.job;
  }

  private async run(
    state: JobState,
    input: RenderJobInput,
    onProgress: (p: RenderProgress) => void,
  ): Promise<void> {
    const { timeline } = input;
    const report = (fraction: number, stage: string) => {
      state.job.progress = { fraction, stage };
      onProgress(state.job.progress);
    };

    report(0.02, STAGES.preparing);
    const resources = await loadResources(timeline, input.photos, input.brand);

    try {
      const canvas = document.createElement('canvas');
      canvas.width = timeline.width;
      canvas.height = timeline.height;
      const ctx = canvas.getContext('2d')!;

      const output = new Output({
        format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
        target: new BufferTarget(),
      });

      const videoSource = new CanvasSource(canvas, {
        codec: 'avc',
        quality: QUALITY_HIGH,
      });
      output.addVideoTrack(videoSource, { frameRate: timeline.fps });

      // Audio track (best-effort: a reel must still export if audio encoding
      // is unsupported on this browser).
      let audioSource: AudioBufferSource | null = null;
      let audioBuffer: AudioBuffer | null = null;
      if (timeline.audio) {
        report(0.05, STAGES.audio);
        try {
          const blob = await getBlob(timeline.audio.assetKey);
          if (blob) {
            const codec = (await getFirstEncodableAudioCodec(
              ['aac', 'opus'] as AudioCodec[],
              { numberOfChannels: 2, sampleRate: 48000 },
            )) as AudioCodec | null;
            if (codec) {
              audioBuffer = await renderReelAudio(blob, timeline.durationMs, {
                gain: timeline.audio.gain,
                fadeOutMs: timeline.audio.fadeOutMs,
              });
              audioSource = new AudioBufferSource({
                codec,
                bitrate: 192_000,
              });
              output.addAudioTrack(audioSource);
            }
          }
        } catch (err) {
          console.warn('Continuing without audio track:', err);
          audioSource = null;
        }
      }

      await output.start();

      if (audioSource && audioBuffer) {
        await audioSource.add(audioBuffer);
        audioSource.close();
      }

      const frameDur = 1 / timeline.fps;
      const totalFrames = Math.ceil((timeline.durationMs / 1000) * timeline.fps);
      for (let f = 0; f < totalFrames; f++) {
        if (state.canceled) {
          await output.cancel();
          state.job.status = 'canceled';
          return;
        }
        const tMs = (f / timeline.fps) * 1000;
        renderFrame(ctx, timeline, tMs, resources);
        await videoSource.add(f * frameDur, frameDur);
        if (f % 5 === 0) {
          report(0.08 + 0.84 * (f / totalFrames), STAGES.rendering);
        }
      }
      videoSource.close();

      report(0.95, STAGES.finishing);
      await output.finalize();
      const buffer = (output.target as BufferTarget).buffer;
      if (!buffer) throw new Error('Encoder produced no output');

      state.output = {
        blob: new Blob([buffer], { type: 'video/mp4' }),
        mimeType: 'video/mp4',
        fileExtension: 'mp4',
      };
      state.job.status = 'done';
      report(1, STAGES.finishing);
    } finally {
      resources.dispose();
    }
  }

  async checkStatus(jobId: string): Promise<RenderJob> {
    const state = this.jobs.get(jobId);
    if (!state) throw new Error('Unknown render job');
    return state.job;
  }

  async retrieveOutput(jobId: string): Promise<RenderOutput> {
    const state = this.jobs.get(jobId);
    if (!state?.output) throw new Error('Render output not ready');
    return state.output;
  }

  async cancel(jobId: string): Promise<void> {
    const state = this.jobs.get(jobId);
    if (state) state.canceled = true;
  }
}

// ---------------------------------------------------------------------------
// Realtime fallback for browsers without WebCodecs (older Safari): captures
// the preview canvas + audio via MediaRecorder. Slower (runs in real time)
// and produces WebM on some browsers, but keeps the product usable.

export class MediaRecorderFallbackProvider implements VideoGenerationProvider {
  readonly name = 'Compatibility renderer';
  private jobs = new Map<string, JobState>();

  async isAvailable(): Promise<boolean> {
    return typeof MediaRecorder !== 'undefined';
  }

  async createJob(
    input: RenderJobInput,
    onProgress: (p: RenderProgress) => void,
  ): Promise<RenderJob> {
    const state: JobState = {
      job: { id: uid(), status: 'rendering', progress: { fraction: 0, stage: STAGES.preparing } },
      canceled: false,
    };
    this.jobs.set(state.job.id, state);
    void this.run(state, input, onProgress).catch((err) => {
      state.job.status = 'error';
      state.job.error = err instanceof Error ? err.message : String(err);
    });
    return state.job;
  }

  private async run(
    state: JobState,
    input: RenderJobInput,
    onProgress: (p: RenderProgress) => void,
  ): Promise<void> {
    const { timeline } = input;
    const resources = await loadResources(timeline, input.photos, input.brand);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = timeline.width;
      canvas.height = timeline.height;
      const ctx = canvas.getContext('2d')!;
      renderFrame(ctx, timeline, 0, resources);

      const stream = canvas.captureStream(timeline.fps);

      // Mix audio in via WebAudio when present.
      let audioCtx: AudioContext | null = null;
      if (timeline.audio) {
        const blob = await getBlob(timeline.audio.assetKey);
        if (blob) {
          audioCtx = new AudioContext();
          const buf = await audioCtx.decodeAudioData(await blob.arrayBuffer());
          const src = audioCtx.createBufferSource();
          src.buffer = buf;
          const dest = audioCtx.createMediaStreamDestination();
          const gain = audioCtx.createGain();
          const fadeStart = Math.max(0, timeline.durationMs - timeline.audio.fadeOutMs) / 1000;
          gain.gain.setValueAtTime(timeline.audio.gain, 0);
          gain.gain.setValueAtTime(timeline.audio.gain, fadeStart);
          gain.gain.linearRampToValueAtTime(0.0001, timeline.durationMs / 1000);
          src.connect(gain);
          gain.connect(dest);
          src.start();
          for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
        }
      }

      const mimeType =
        ['video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((t) =>
          MediaRecorder.isTypeSupported(t),
        ) ?? '';
      const recorder = new MediaRecorder(stream, {
        mimeType: mimeType || undefined,
        videoBitsPerSecond: 10_000_000,
      });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);

      const done = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });
      recorder.start(250);

      const startedAt = performance.now();
      await new Promise<void>((resolve) => {
        const tick = () => {
          const t = performance.now() - startedAt;
          if (state.canceled || t >= timeline.durationMs) {
            resolve();
            return;
          }
          renderFrame(ctx, timeline, t, resources);
          state.job.progress = {
            fraction: Math.min(0.95, t / timeline.durationMs),
            stage: STAGES.rendering,
          };
          onProgress(state.job.progress);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

      recorder.stop();
      await done;
      await audioCtx?.close();

      if (state.canceled) {
        state.job.status = 'canceled';
        return;
      }
      const type = mimeType.startsWith('video/mp4') ? 'video/mp4' : 'video/webm';
      state.output = {
        blob: new Blob(chunks, { type }),
        mimeType: type,
        fileExtension: type === 'video/mp4' ? 'mp4' : 'webm',
      };
      state.job.status = 'done';
      state.job.progress = { fraction: 1, stage: STAGES.finishing };
      onProgress(state.job.progress);
    } finally {
      resources.dispose();
    }
  }

  async checkStatus(jobId: string): Promise<RenderJob> {
    const state = this.jobs.get(jobId);
    if (!state) throw new Error('Unknown render job');
    return state.job;
  }

  async retrieveOutput(jobId: string): Promise<RenderOutput> {
    const state = this.jobs.get(jobId);
    if (!state?.output) throw new Error('Render output not ready');
    return state.output;
  }

  async cancel(jobId: string): Promise<void> {
    const state = this.jobs.get(jobId);
    if (state) state.canceled = true;
  }
}

/** Pick the best provider available on this device. */
export async function selectProvider(): Promise<VideoGenerationProvider> {
  const local = new LocalRenderProvider();
  if (await local.isAvailable()) return local;
  const fallback = new MediaRecorderFallbackProvider();
  if (await fallback.isAvailable()) return fallback;
  throw new Error(
    "This browser can't export video. Try the latest Safari or Chrome.",
  );
}
