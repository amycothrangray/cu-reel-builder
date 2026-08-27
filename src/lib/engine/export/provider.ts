// Video generation provider abstraction.
//
// The default implementation assembles the reel deterministically in the
// browser (WebCodecs + MP4 muxing) — photographs are presented, never
// reinterpreted, and nothing leaves the device. The interface exists so a
// server-side or external rendering service can be plugged in later without
// touching the UI: implement these four methods and register the provider.

import type { PhotoRecord, BrandConfig } from '../../types';
import type { Timeline } from '../types';

export interface RenderJobInput {
  timeline: Timeline;
  photos: PhotoRecord[];
  brand: BrandConfig;
}

export interface RenderProgress {
  /** 0..1 real progress — never fabricated. */
  fraction: number;
  stage: string;
}

export interface RenderJob {
  id: string;
  status: 'queued' | 'rendering' | 'done' | 'error' | 'canceled';
  progress: RenderProgress;
  error?: string;
}

export interface RenderOutput {
  blob: Blob;
  mimeType: string;
  fileExtension: string;
}

export interface VideoGenerationProvider {
  readonly name: string;
  /** Whether this provider can run in the current environment. */
  isAvailable(): Promise<boolean>;
  createJob(input: RenderJobInput, onProgress: (p: RenderProgress) => void): Promise<RenderJob>;
  checkStatus(jobId: string): Promise<RenderJob>;
  retrieveOutput(jobId: string): Promise<RenderOutput>;
  cancel(jobId: string): Promise<void>;
}
