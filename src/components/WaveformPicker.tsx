// Visual song-section picker: shows the reference waveform, lets the user
// drag a reel-length window (or tap a suggested section), auditions the
// selection, and displays the critical Instagram start timestamp prominently.

import { useEffect, useMemo, useRef, useState } from 'react';
import { analyzeBeats, decodeAudio, type BeatAnalysis } from '../lib/audio/beats';
import { formatTimestamp, suggestSections } from '../lib/audio/segments';

interface Props {
  blob: Blob;
  assetKey: string;
  reelDurationMs: number;
  startMs: number;
  onChange: (startMs: number) => void;
}

export function WaveformPicker({ blob, assetKey, reelDurationMs, startMs, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopTimer = useRef<number>(0);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [analysis, setAnalysis] = useState<BeatAnalysis | null>(null);
  const [auditioning, setAuditioning] = useState(false);
  const dragRef = useRef<{ px: number; start: number } | null>(null);

  // Decode once: waveform peaks + timing analysis + audition element.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const buffer = await decodeAudio(blob, 22050);
        if (!alive) return;
        setDurationMs(buffer.duration * 1000);
        const data = buffer.getChannelData(0);
        const buckets = 600;
        const out = new Float32Array(buckets);
        const per = Math.floor(data.length / buckets);
        for (let b = 0; b < buckets; b++) {
          let max = 0;
          for (let i = b * per; i < (b + 1) * per; i += 8) {
            const v = Math.abs(data[i]);
            if (v > max) max = v;
          }
          out[b] = max;
        }
        setPeaks(out);
        const a = await analyzeBeats(assetKey, blob);
        if (alive) setAnalysis(a);
      } catch (err) {
        console.warn('Could not decode reference audio', err);
      }
    })();
    const url = URL.createObjectURL(blob);
    audioRef.current = new Audio(url);
    return () => {
      alive = false;
      audioRef.current?.pause();
      URL.revokeObjectURL(url);
      window.clearTimeout(stopTimer.current);
    };
  }, [blob, assetKey]);

  const suggestions = useMemo(
    () => (analysis ? suggestSections(analysis, reelDurationMs) : []),
    [analysis, reelDurationMs],
  );

  const maxStart = Math.max(0, durationMs - reelDurationMs);
  const clampStart = (v: number) => Math.max(0, Math.min(maxStart, v));

  // Draw waveform + selection.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const selX = durationMs > 0 ? (startMs / durationMs) * w : 0;
    const selW = durationMs > 0 ? (reelDurationMs / durationMs) * w : 0;

    for (let i = 0; i < peaks.length; i++) {
      const x = (i / peaks.length) * w;
      const inSelection = x >= selX && x <= selX + selW;
      const amp = Math.max(0.04, peaks[i]) * (h / 2) * 0.92;
      ctx.fillStyle = inSelection ? '#8a6f52' : '#d3cabd';
      ctx.fillRect(x, h / 2 - amp, Math.max(1, w / peaks.length - 0.5), amp * 2);
    }
    // Selection frame.
    ctx.strokeStyle = '#211d18';
    ctx.lineWidth = 2;
    ctx.strokeRect(selX, 1, selW, h - 2);
  }, [peaks, startMs, reelDurationMs, durationMs]);

  const posFromEvent = (clientX: number): number => {
    const rect = trackRef.current!.getBoundingClientRect();
    const frac = (clientX - rect.left) / rect.width;
    return clampStart(frac * durationMs - reelDurationMs / 2);
  };

  const audition = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (auditioning) {
      audio.pause();
      window.clearTimeout(stopTimer.current);
      setAuditioning(false);
      return;
    }
    audio.currentTime = startMs / 1000;
    void audio.play().catch(() => undefined);
    setAuditioning(true);
    window.clearTimeout(stopTimer.current);
    stopTimer.current = window.setTimeout(() => {
      audio.pause();
      setAuditioning(false);
    }, reelDurationMs);
  };

  if (!peaks) {
    return (
      <div className="row" style={{ padding: 20 }}>
        <span className="spinner" />
        <span className="muted">Reading the song…</span>
      </div>
    );
  }

  return (
    <div>
      {suggestions.length > 0 && (
        <div className="row wrap" style={{ marginBottom: 10, gap: 8 }}>
          {suggestions.map((s) => (
            <button
              key={s.label}
              className={`btn btn-sm ${Math.abs(s.startMs - startMs) < 400 ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => onChange(clampStart(s.startMs))}
              title={s.reason}
            >
              {s.label} · {formatTimestamp(s.startMs / 1000)}
            </button>
          ))}
        </div>
      )}

      <div
        ref={trackRef}
        style={{ position: 'relative', touchAction: 'none', cursor: 'grab', userSelect: 'none' }}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          dragRef.current = { px: e.clientX, start: startMs };
          onChange(posFromEvent(e.clientX));
        }}
        onPointerMove={(e) => {
          if (dragRef.current) onChange(posFromEvent(e.clientX));
        }}
        onPointerUp={() => (dragRef.current = null)}
        onPointerCancel={() => (dragRef.current = null)}
      >
        <canvas ref={canvasRef} style={{ width: '100%', height: 88, display: 'block' }} />
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 26 }}>
            {formatTimestamp(startMs / 1000)}
          </div>
          <div className="faint">
            song start · section {formatTimestamp(startMs / 1000)} →{' '}
            {formatTimestamp((startMs + reelDurationMs) / 1000)}
          </div>
        </div>
        <div className="spacer" />
        <button className="btn btn-secondary btn-sm" onClick={audition}>
          {auditioning ? '◼ Stop' : '▶ Play this section'}
        </button>
      </div>
    </div>
  );
}
