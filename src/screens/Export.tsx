import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, useParams } from 'react-router-dom';
import { blobKey, db, getBlob, putBlob, trackUsage } from '../lib/db';
import { getBrand, musicAnalysisForReel, touchReel } from '../lib/reels';
import { formatTimestamp, syncCue, type SyncCue } from '../lib/audio/segments';
import { useBlobUrl } from '../components/hooks';
import { loadResources } from '../lib/engine/resources';
import { renderFrame } from '../lib/engine/renderFrame';
import { selectProvider } from '../lib/engine/export/localProvider';
import {
  estimateFileSizeBytes,
  preflightPasses,
  runPreflight,
  type PreflightFinding,
} from '../lib/engine/export/preflight';
import type { RenderProgress } from '../lib/engine/export/provider';
import { useToasts } from '../components/toast';
import type { BrandConfig } from '../lib/types';

export function ExportScreen() {
  const { reelId } = useParams<{ reelId: string }>();
  const show = useToasts((s) => s.show);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [brand, setBrand] = useState<BrandConfig | null>(null);
  const [findings, setFindings] = useState<PreflightFinding[] | null>(null);
  const [progress, setProgress] = useState<RenderProgress | null>(null);
  const [result, setResult] = useState<{ url: string; ext: string } | null>(null);
  const [cue, setCue] = useState<SyncCue | null>(null);

  const reel = useLiveQuery(() => (reelId ? db.reels.get(reelId) : undefined), [reelId]);
  const photos = useLiveQuery(
    () => (reelId ? db.photos.where('reelId').equals(reelId).toArray() : []),
    [reelId],
  );
  const activeVersion = reel?.versions.find((v) => v.id === reel.activeVersionId) ?? null;
  const timeline = activeVersion?.timeline ?? null;

  // Static poster frame + preflight.
  useEffect(() => {
    let alive = true;
    if (!timeline || !photos || !reel) return;
    void (async () => {
      const b = await getBrand();
      if (!alive) return;
      setBrand(b);

      const availablePhotoIds = new Set<string>();
      for (const p of photos) {
        if ((await getBlob(blobKey.preview(p.id))) !== undefined) availablePhotoIds.add(p.id);
      }
      const audioAvailable = reel.musicAssetKey
        ? (await getBlob(reel.musicAssetKey)) !== undefined
        : false;
      const logoAvailable = b.logoAssetKey ? (await getBlob(b.logoAssetKey)) !== undefined : false;

      const res = await loadResources(timeline, photos, b);
      const fontsAvailable = !b.primaryFont || res.fontPrimary.includes(b.primaryFont.family);
      if (!alive) {
        res.dispose();
        return;
      }
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = timeline.width;
        canvas.height = timeline.height;
        renderFrame(canvas.getContext('2d')!, timeline, Math.min(1200, timeline.durationMs / 3), res);
      }
      res.dispose();

      setFindings(
        runPreflight({
          reel,
          timeline,
          photos,
          brand: b,
          availablePhotoIds,
          audioAvailable,
          fontsAvailable,
          logoAvailable,
        }),
      );

      // Instagram sync marker: which photo the first big musical hit lands on.
      if (reel.instagramAudio?.referenceAssetKey) {
        const music = await musicAnalysisForReel(reel);
        if (alive) setCue(syncCue(timeline, music.strongBeats));
      } else {
        setCue(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [timeline, photos, reel]);

  const estimatedSize = useMemo(
    () => (timeline ? estimateFileSizeBytes(timeline) : 0),
    [timeline],
  );

  if (!reel || !photos || !timeline) {
    return (
      <div className="empty-state panel">
        <h2>Nothing to export yet</h2>
        {reel && (
          <Link to={`/reel/${reel.id}/template`} className="btn btn-primary" style={{ marginTop: 14 }}>
            Choose a style first
          </Link>
        )}
      </div>
    );
  }

  const canExport = findings !== null && preflightPasses(findings) && !progress;

  const doExport = async () => {
    if (!brand || !activeVersion) return;
    setResult(null);
    setProgress({ fraction: 0, stage: 'Looking through your photos' });
    try {
      const provider = await selectProvider();
      const job = await provider.createJob({ timeline, photos, brand }, setProgress);
      // Wait for completion.
      let status = await provider.checkStatus(job.id);
      while (status.status === 'rendering' || status.status === 'queued') {
        await new Promise((r) => setTimeout(r, 300));
        status = await provider.checkStatus(job.id);
      }
      if (status.status !== 'done') {
        throw new Error(status.error ?? 'Rendering did not finish');
      }
      const output = await provider.retrieveOutput(job.id);
      await putBlob(blobKey.export(reel.id, activeVersion.id), output.blob);
      await touchReel(reel.id, { status: 'exported', exportedAt: Date.now() });
      await trackUsage('export', `${timeline.durationMs}ms ${output.fileExtension}`);
      setResult({ url: URL.createObjectURL(output.blob), ext: output.fileExtension });
      setProgress(null);
    } catch (err) {
      setProgress(null);
      show(
        'We couldn’t finish this reel. Your photos are safe — try exporting again.',
        'error',
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  const fileName = `${reel.name.replace(/[^\w\- ]+/g, '').trim() || 'reel'}.${result?.ext ?? 'mp4'}`;

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <div className="page-header">
        <h1>Export</h1>
        <div className="spacer" />
        <Link to={`/reel/${reel.id}/edit`} className="btn btn-ghost">
          Back to editor
        </Link>
      </div>

      <div
        style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 280px) minmax(0, 1fr)', gap: 28 }}
        className="export-grid"
      >
        <style>{`@media (max-width: 759px) { .export-grid { grid-template-columns: 1fr !important; } .export-grid .reel-frame { max-width: 260px; margin: 0 auto; } }`}</style>
        <div className="reel-frame">
          <canvas ref={canvasRef} />
        </div>

        <div className="stack-v">
          <div className="panel">
            <h3 style={{ marginBottom: 10 }}>Final video</h3>
            <p className="muted" style={{ fontSize: 14.5 }}>
              {reel.durationSec} seconds · 1080 × 1920 · MP4 · about{' '}
              {(estimatedSize / 1024 / 1024).toFixed(0)} MB
            </p>
          </div>

          <div className="panel">
            <h3 style={{ marginBottom: 10 }}>Preflight</h3>
            {!findings && (
              <div className="row">
                <span className="spinner" />
                <span className="muted">Checking everything…</span>
              </div>
            )}
            {findings?.map((f) => (
              <div key={f.id} className="row" style={{ marginBottom: 6, alignItems: 'flex-start' }}>
                <span
                  style={{
                    color:
                      f.level === 'block'
                        ? 'var(--danger)'
                        : f.level === 'warn'
                          ? 'var(--warn)'
                          : 'var(--ok)',
                    fontSize: 14,
                    lineHeight: '20px',
                  }}
                >
                  {f.level === 'block' ? '✕' : f.level === 'warn' ? '!' : '✓'}
                </span>
                <span style={{ fontSize: 14 }}>{f.message}</span>
              </div>
            ))}
            {findings?.some((f) => f.id === 'restricted-pending') && (
              <Link to={`/reel/${reel.id}/review`} className="btn btn-secondary btn-sm" style={{ marginTop: 8 }}>
                Review flagged photos
              </Link>
            )}
          </div>

          {progress && (
            <div className="panel">
              <div className="row" style={{ marginBottom: 10 }}>
                <span className="spinner" />
                <strong>{progress.stage}</strong>
              </div>
              <div className="progressbar">
                <div style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
              </div>
            </div>
          )}

          {result ? (
            <div className="panel" style={{ background: 'var(--ok-soft)', borderColor: 'var(--ok)' }}>
              <h3 style={{ color: 'var(--ok)', marginBottom: 8 }}>
                {reel.instagramAudio ? 'Your silent reel is ready' : 'Your reel is ready'}
              </h3>
              <div className="row wrap">
                <a className="btn btn-primary" href={result.url} download={fileName}>
                  Download {fileName}
                </a>
                <video
                  src={result.url}
                  controls
                  playsInline
                  style={{ width: '100%', borderRadius: 10, marginTop: 10 }}
                />
              </div>
            </div>
          ) : (
            <button className="btn btn-primary btn-lg" disabled={!canExport} onClick={() => void doExport()}>
              {progress
                ? 'Rendering…'
                : reel.instagramAudio
                  ? 'Export for Instagram'
                  : 'Export Reel'}
            </button>
          )}

          {reel.instagramAudio && (
            <InstagramPostingCard
              songTitle={reel.instagramAudio.songTitle}
              artist={reel.instagramAudio.artist}
              startSec={reel.instagramAudio.startSec}
              durationSec={reel.durationSec}
              cue={cue}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The Instagram posting card: everything needed to recreate the intended
 * synchronization inside Instagram. This stays with the reel permanently.
 */
function InstagramPostingCard({
  songTitle,
  artist,
  startSec,
  durationSec,
  cue,
}: {
  songTitle: string;
  artist: string;
  startSec: number;
  durationSec: number;
  cue: SyncCue | null;
}) {
  const cueThumbUrl = useBlobUrl(cue ? blobKey.thumb(cue.photoId) : null);
  const search = artist ? `${songTitle} — ${artist}` : songTitle;
  return (
    <div className="panel" style={{ borderColor: 'var(--accent)', borderWidth: 2 }}>
      <h3 style={{ marginBottom: 4 }}>Add this audio on Instagram</h3>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 20 }}>
        🎵 {songTitle}
        {artist ? <span style={{ color: 'var(--ink-soft)' }}> · {artist}</span> : null}
      </div>
      <div className="row wrap" style={{ margin: '10px 0 14px', gap: 18 }}>
        <div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 26 }}>
            {formatTimestamp(startSec)}
          </div>
          <div className="faint">start the song here</div>
        </div>
        <div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 26 }}>{durationSec}s</div>
          <div className="faint">reel length</div>
        </div>
        {cue && (
          <div className="row" style={{ gap: 10 }}>
            {cueThumbUrl && (
              <img
                src={cueThumbUrl}
                alt=""
                style={{ width: 44, height: 44, borderRadius: 8, objectFit: 'cover' }}
              />
            )}
            <div>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>Sync check</div>
              <div className="faint" style={{ maxWidth: 220 }}>
                The first big musical hit lands as photo {cue.photoNumber} appears (
                {formatTimestamp(cue.tMs / 1000)} in). Off by a beat? Nudge Instagram’s slider.
              </div>
            </div>
          </div>
        )}
      </div>
      <ol className="muted" style={{ fontSize: 13.5, paddingLeft: 18, margin: 0, lineHeight: 1.7 }}>
        <li>Upload this reel to Instagram</li>
        <li>Tap <strong>Add audio</strong> and search “{search}”</li>
        <li>Move the song to <strong>{formatTimestamp(startSec)}</strong></li>
        <li>Preview — confirm the first cut lines up{cue ? ` on photo ${cue.photoNumber}` : ''}</li>
        <li>Post</li>
      </ol>
      <p className="faint" style={{ marginTop: 10 }}>
        Instagram is the source of truth for which audio is available to your
        account. This card stays saved with the reel.
      </p>
    </div>
  );
}
