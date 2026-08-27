import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { blobKey, db } from '../lib/db';
import {
  getBrand,
  generateVersion,
  rebuildActiveVersion,
  removePhotosFromArrangement,
  touchReel,
  addMusicTrack,
} from '../lib/reels';
import { loadResources, type LoadedResources } from '../lib/engine/resources';
import { ReelPlayer } from '../lib/engine/preview';
import { TEMPLATES, getTemplate, templateCapacity } from '../lib/engine/templates';
import { useBlobUrl } from '../components/hooks';
import { useToasts } from '../components/toast';
import type { ReelDuration, ReelRecord, TemplateId } from '../lib/types';
import type { Timeline } from '../lib/engine/types';

function StripThumb({
  photoId,
  index,
  count,
  onMove,
  onRemove,
}: {
  photoId: string;
  index: number;
  count: number;
  onMove: (from: number, to: number) => void;
  onRemove: () => void;
}) {
  const url = useBlobUrl(blobKey.thumb(photoId));
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/plain', String(index))}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData('text/plain'));
        if (!Number.isNaN(from) && from !== index) onMove(from, index);
      }}
      style={{
        position: 'relative',
        width: 72,
        flexShrink: 0,
        borderRadius: 8,
        overflow: 'hidden',
        aspectRatio: '9 / 16',
        background: 'var(--paper-sunken)',
        cursor: 'grab',
      }}
    >
      {url && <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'space-between',
          background: 'linear-gradient(transparent, rgba(0,0,0,0.55))',
          padding: '10px 2px 2px',
        }}
      >
        <button
          aria-label="Move earlier"
          style={{ color: '#fff', padding: '2px 6px', fontSize: 14 }}
          disabled={index === 0}
          onClick={() => onMove(index, index - 1)}
        >
          ‹
        </button>
        <button
          aria-label="Remove"
          style={{ color: '#fff', padding: '2px 4px', fontSize: 12 }}
          onClick={onRemove}
        >
          ✕
        </button>
        <button
          aria-label="Move later"
          style={{ color: '#fff', padding: '2px 6px', fontSize: 14 }}
          disabled={index === count - 1}
          onClick={() => onMove(index, index + 1)}
        >
          ›
        </button>
      </div>
    </div>
  );
}

export function EditorScreen() {
  const { reelId } = useParams<{ reelId: string }>();
  const navigate = useNavigate();
  const show = useToasts((s) => s.show);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<ReelPlayer | null>(null);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const musicInputRef = useRef<HTMLInputElement>(null);

  const reel = useLiveQuery(() => (reelId ? db.reels.get(reelId) : undefined), [reelId]);
  const photos = useLiveQuery(
    () => (reelId ? db.photos.where('reelId').equals(reelId).toArray() : []),
    [reelId],
  );
  const music = useLiveQuery(() => db.music.orderBy('addedAt').reverse().toArray(), []);

  const activeVersion = reel?.versions.find((v) => v.id === reel.activeVersionId) ?? null;
  const timeline = activeVersion?.timeline ?? null;

  // Photo order as the timeline plays it (stacked pairs flattened in order).
  const stripPhotoIds = useMemo(() => {
    if (!timeline) return [];
    const ids: string[] = [];
    for (const clip of timeline.clips) {
      for (const layer of clip.layers) {
        if (!ids.includes(layer.photoId)) ids.push(layer.photoId);
      }
    }
    return ids;
  }, [timeline]);

  // (Re)create the player whenever the active timeline changes.
  useEffect(() => {
    let disposed = false;
    let localPlayer: ReelPlayer | null = null;
    let localRes: LoadedResources | null = null;
    const canvas = canvasRef.current;
    if (!canvas || !timeline || !photos) return;
    void (async () => {
      const brand = await getBrand();
      const res = await loadResources(timeline as Timeline, photos, brand);
      if (disposed) {
        res.dispose();
        return;
      }
      localRes = res;
      localPlayer = new ReelPlayer(canvas, timeline as Timeline, res);
      await localPlayer.loadAudio();
      if (disposed) {
        localPlayer.destroy();
        return;
      }
      playerRef.current = localPlayer;
      setPlaying(false);
    })();
    return () => {
      disposed = true;
      localPlayer?.destroy();
      localRes?.dispose();
      if (playerRef.current === localPlayer) playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline, photos?.length, photos?.map((p) => `${p.correctionEnabled}${p.included}`).join('')]);

  if (!reel || !photos) return null;
  if (!activeVersion) {
    return (
      <div className="empty-state panel">
        <h2>This reel doesn’t have an arrangement yet</h2>
        <Link to={`/reel/${reel.id}/template`} className="btn btn-primary" style={{ marginTop: 14 }}>
          Choose a style
        </Link>
      </div>
    );
  }

  const patchAndRebuild = async (patch: Partial<ReelRecord>) => {
    await touchReel(reel.id, patch);
    await rebuildActiveVersion(reel.id);
  };

  const movePhoto = (from: number, to: number) => {
    const order = [...stripPhotoIds];
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    void patchAndRebuild({ manualOrder: order });
  };

  const tryAnotherEdit = async () => {
    if (!reel.templateId) return;
    setBusy(true);
    try {
      // A fresh arrangement drops any manual order and rolls a new seed.
      await touchReel(reel.id, { manualOrder: null });
      await generateVersion(reel.id, reel.templateId, Date.now() % 100_000);
      show('New arrangement created — your earlier versions are saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <input
          value={reel.name}
          onChange={(e) => void touchReel(reel.id, { name: e.target.value })}
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 24,
            fontWeight: 500,
            border: 'none',
            background: 'transparent',
            width: 'min(60vw, 380px)',
          }}
        />
        <div className="spacer" />
        <Link to={`/reel/${reel.id}/review`} className="btn btn-ghost">
          Photos
        </Link>
        <button className="btn btn-primary btn-lg" onClick={() => navigate(`/reel/${reel.id}/export`)}>
          Export
        </button>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 340px) minmax(0, 1fr)',
          gap: 28,
          alignItems: 'start',
        }}
        className="editor-grid"
      >
        <style>{`
          @media (max-width: 759px) {
            .editor-grid { grid-template-columns: 1fr !important; }
            .editor-grid .reel-frame { max-width: 300px; margin: 0 auto; }
          }
        `}</style>

        {/* Preview */}
        <div>
          <div className="reel-frame" onClick={() => {
            const p = playerRef.current;
            if (!p) return;
            if (p.playing) {
              p.pause();
              setPlaying(false);
            } else {
              p.play();
              setPlaying(true);
            }
          }}>
            <canvas ref={canvasRef} />
            {!playing && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'grid',
                  placeItems: 'center',
                  background: 'rgba(0,0,0,0.18)',
                  color: '#fff',
                  fontSize: 48,
                  pointerEvents: 'none',
                }}
              >
                ▶
              </div>
            )}
          </div>

          {/* Versions */}
          <div className="row wrap" style={{ marginTop: 14 }}>
            {reel.versions.map((v) => (
              <button
                key={v.id}
                className={`btn btn-sm ${v.id === reel.activeVersionId ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => void touchReel(reel.id, { activeVersionId: v.id })}
              >
                {v.label}
              </button>
            ))}
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void tryAnotherEdit()}>
              {busy ? <span className="spinner" /> : '↻'} Try Another Edit
            </button>
          </div>
        </div>

        {/* Controls */}
        <div className="stack-v">
          {/* Photo strip */}
          <div className="panel">
            <h3 style={{ marginBottom: 10 }}>Photo order</h3>
            <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 6 }}>
              {stripPhotoIds.map((id, i) => (
                <StripThumb
                  key={id}
                  photoId={id}
                  index={i}
                  count={stripPhotoIds.length}
                  onMove={movePhoto}
                  onRemove={() => {
                    void removePhotosFromArrangement(reel.id, [id]);
                  }}
                />
              ))}
              <Link
                to={`/reel/${reel.id}/review`}
                style={{
                  width: 72,
                  flexShrink: 0,
                  aspectRatio: '9 / 16',
                  borderRadius: 8,
                  border: '2px dashed var(--line-strong)',
                  display: 'grid',
                  placeItems: 'center',
                  color: 'var(--ink-faint)',
                  fontSize: 24,
                }}
              >
                +
              </Link>
            </div>
            <p className="faint" style={{ marginTop: 6 }}>
              Drag (or use ‹ ›) to reorder. The style keeps handling crops and motion.
            </p>
          </div>

          {/* Text */}
          <div className="panel">
            <h3 style={{ marginBottom: 12 }}>Words</h3>
            <div className="field">
              <label>Title (optional)</label>
              <input
                type="text"
                placeholder="The Andersons · Coronado Beach"
                defaultValue={reel.text.title}
                onBlur={(e) => void patchAndRebuild({ text: { ...reel.text, title: e.target.value } })}
              />
            </div>
            <div className="field">
              <label>Caption (optional)</label>
              <input
                type="text"
                placeholder="golden hour, big laughs"
                defaultValue={reel.text.caption}
                onBlur={(e) => void patchAndRebuild({ text: { ...reel.text, caption: e.target.value } })}
              />
            </div>
            <div className="field">
              <label>Call to action</label>
              <input
                type="text"
                defaultValue={reel.text.cta}
                onBlur={(e) => void patchAndRebuild({ text: { ...reel.text, cta: e.target.value } })}
              />
            </div>
            <label className="row" style={{ gap: 6, fontSize: 14 }}>
              <input
                type="checkbox"
                checked={reel.text.showHandle}
                onChange={(e) => void patchAndRebuild({ text: { ...reel.text, showHandle: e.target.checked } })}
              />
              Show website / Instagram handle at the end
            </label>
          </div>

          {/* Style, duration, music */}
          <div className="panel">
            <h3 style={{ marginBottom: 12 }}>Style & pacing</h3>
            <div className="field">
              <label>Style</label>
              <select
                value={reel.templateId ?? ''}
                onChange={(e) => {
                  void touchReel(reel.id, { templateId: e.target.value as TemplateId }).then(() =>
                    rebuildActiveVersion(reel.id),
                  );
                }}
              >
                {TEMPLATES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Length</label>
              <div className="row">
                {([9, 12, 15] as ReelDuration[]).map((d) => (
                  <button
                    key={d}
                    className={`btn btn-sm ${reel.durationSec === d ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => void patchAndRebuild({ durationSec: d })}
                  >
                    {d}s
                  </button>
                ))}
              </div>
              {reel.templateId && (
                <span className="hint">
                  {(() => {
                    const cap = templateCapacity(getTemplate(reel.templateId), reel.durationSec * 1000);
                    const wanted = reel.manualOrder
                      ? reel.manualOrder.length
                      : stripPhotoIds.length;
                    const cut = Math.max(0, Math.min(wanted, photos.filter((p) => p.included).length) - stripPhotoIds.length);
                    return (
                      `Showing ${stripPhotoIds.length} photos — this style fits up to ${cap} at ${reel.durationSec}s.` +
                      (cut > 0
                        ? ` ${cut} more don’t fit; pick a longer length or a faster style like Rapid Fire.`
                        : '')
                    );
                  })()}
                </span>
              )}
            </div>
            <div className="field">
              <label>Music</label>
              <select
                value={reel.musicAssetKey ?? ''}
                onChange={(e) => {
                  const track = music?.find((m) => m.assetKey === e.target.value);
                  void patchAndRebuild({
                    musicAssetKey: track?.assetKey ?? null,
                    musicName: track?.name ?? null,
                  });
                }}
              >
                <option value="">No music</option>
                {music?.map((m) => (
                  <option key={m.id} value={m.assetKey}>
                    {m.name} ({Math.round(m.durationSec)}s)
                  </option>
                ))}
              </select>
              <button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => musicInputRef.current?.click()}>
                Upload a track
              </button>
              <span className="hint">
                Use music you’re licensed to post. Cuts sync to the beat automatically.
              </span>
              <input
                ref={musicInputRef}
                type="file"
                accept="audio/*"
                hidden
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  await addMusicTrack(file);
                  const added = await db.music.orderBy('addedAt').reverse().first();
                  if (added) {
                    await patchAndRebuild({ musicAssetKey: added.assetKey, musicName: added.name });
                  }
                  show('Track added');
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
