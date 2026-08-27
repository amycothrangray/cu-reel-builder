// Live preview player: renders the timeline to a canvas with rAF, keeping
// music in sync. Same renderFrame as the exporter, so what you see is what
// you export.

import { getBlob } from '../db';
import { renderFrame } from './renderFrame';
import type { RenderResources, Timeline } from './types';

export class ReelPlayer {
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private startedAt = 0;
  private pausedAt = 0;
  private _playing = false;
  private audioEl: HTMLAudioElement | null = null;
  private audioUrl: string | null = null;
  onTime: ((tMs: number) => void) | null = null;
  /** Fired once when the reel reaches its end (it does not loop). */
  onEnded: (() => void) | null = null;
  private _ended = false;

  constructor(
    canvas: HTMLCanvasElement,
    private timeline: Timeline,
    private resources: RenderResources,
  ) {
    canvas.width = timeline.width;
    canvas.height = timeline.height;
    this.ctx = canvas.getContext('2d')!;
    this.renderAt(0);
  }

  private audioOffsetSec = 0;

  async loadAudio(): Promise<void> {
    if (!this.timeline.audio) return;
    this.audioOffsetSec = this.timeline.audio.offsetSec ?? 0;
    const blob = await getBlob(this.timeline.audio.assetKey);
    if (!blob) return;
    this.audioUrl = URL.createObjectURL(blob);
    this.audioEl = new Audio(this.audioUrl);
    this.audioEl.preload = 'auto';
  }

  get playing(): boolean {
    return this._playing;
  }

  get currentTime(): number {
    return this._playing ? performance.now() - this.startedAt : this.pausedAt;
  }

  /** True once playback has reached the end and stopped. */
  get ended(): boolean {
    return this._ended;
  }

  play(): void {
    if (this._playing) return;
    // Replaying after the end starts over from the top.
    if (this._ended || this.pausedAt >= this.timeline.durationMs - 30) {
      this.pausedAt = 0;
    }
    this._ended = false;
    this._playing = true;
    this.startedAt = performance.now() - this.pausedAt;
    if (this.audioEl) {
      this.audioEl.currentTime = this.audioOffsetSec + this.pausedAt / 1000;
      void this.audioEl.play().catch(() => undefined);
    }
    const tick = () => {
      if (!this._playing) return;
      const t = performance.now() - this.startedAt;
      if (t >= this.timeline.durationMs) {
        // The reel ends — it never loops, so you always know it's over.
        this.renderAt(this.timeline.durationMs - 1);
        this.onTime?.(this.timeline.durationMs);
        this.pausedAt = this.timeline.durationMs;
        this._playing = false;
        this._ended = true;
        this.audioEl?.pause();
        cancelAnimationFrame(this.raf);
        this.onEnded?.();
        return;
      }
      this.renderAt(t);
      this.onTime?.(t);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause(): void {
    if (!this._playing) return;
    this.pausedAt = performance.now() - this.startedAt;
    this._playing = false;
    cancelAnimationFrame(this.raf);
    this.audioEl?.pause();
  }

  seek(tMs: number): void {
    const t = Math.max(0, Math.min(tMs, this.timeline.durationMs - 1));
    this.pausedAt = t;
    this._ended = false;
    if (this._playing) {
      this.startedAt = performance.now() - t;
      if (this.audioEl) this.audioEl.currentTime = this.audioOffsetSec + t / 1000;
    } else {
      this.renderAt(t);
      this.onTime?.(t);
    }
  }

  renderAt(tMs: number): void {
    renderFrame(this.ctx, this.timeline, tMs, this.resources);
  }

  destroy(): void {
    this._playing = false;
    cancelAnimationFrame(this.raf);
    this.audioEl?.pause();
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
    this.audioEl = null;
  }
}
