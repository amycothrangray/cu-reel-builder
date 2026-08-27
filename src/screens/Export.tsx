import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, useParams } from 'react-router-dom';
import { blobKey, db, getBlob, putBlob, trackUsage } from '../lib/db';
import { getBrand, touchReel } from '../lib/reels';
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
              <h3 style={{ color: 'var(--ok)', marginBottom: 8 }}>Your reel is ready</h3>
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
              {progress ? 'Rendering…' : 'Export Reel'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
