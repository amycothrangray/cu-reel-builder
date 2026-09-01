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
  clearInstagramAudio,
} from '../lib/reels';
import { formatTimestamp } from '../lib/audio/segments';
import { InstagramAudioModal } from '../components/InstagramAudioModal';
import { CropModal } from '../components/CropModal';
import { Modal } from '../components/Modal';
import { loadResources, type LoadedResources } from '../lib/engine/resources';
import { ReelPlayer } from '../lib/engine/preview';
import { TEMPLATES, getTemplate, pacingFor, estimateDurationSec } from '../lib/engine/templates';
import { useRebuildStatus } from '../lib/rebuildStatus';
import { useBlobUrl } from '../components/hooks';
import { useToasts } from '../components/toast';
import { clampReelDuration, MAX_REEL_DURATION_SEC, MIN_REEL_DURATION_SEC, REEL_DURATION_PRESETS } from '../lib/types';
import type { NRect, ReelPurpose, ReelRecord, TemplateId } from '../lib/types';
import type { Timeline } from '../lib/engine/types';

function StripThumb({
  photoId,
  index,
  count,
  crop,
  onMove,
  onRemove,
  onCrop,
}: {
  photoId: string;
  index: number;
  count: number;
  /** User-set framing, shown here so the strip matches the reel. */
  crop?: NRect;
  onMove: (from: number, to: number) => void;
  onRemove: () => void;
  onCrop: () => void;
}) {
  const url = useBlobUrl(blobKey.thumb(photoId));
  // With a custom crop, scale the thumbnail so the chosen region fills it.
  const cropStyle: React.CSSProperties = crop
    ? {
        position: 'absolute',
        width: `${100 / crop.w}%`,
        height: `${100 / crop.h}%`,
        left: `${(-crop.x / crop.w) * 100}%`,
        top: `${(-crop.y / crop.h) * 100}%`,
        objectFit: 'cover',
      }
    : { width: '100%', height: '100%', objectFit: 'cover' };
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
      {url && <img src={url} alt="" style={cropStyle} />}
      <button
        aria-label="Fix crop"
        title="Fix crop"
        onClick={(e) => {
          e.stopPropagation();
          onCrop();
        }}
        style={{
          position: 'absolute',
          top: 4,
          left: 4,
          width: 22,
          height: 22,
          borderRadius: 6,
          background: crop ? 'var(--accent)' : 'rgba(13,12,10,0.6)',
          color: '#fff',
          fontSize: 12,
          display: 'grid',
          placeItems: 'center',
          lineHeight: 1,
        }}
      >
        ⛶
      </button>
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
  const [ended, setEnded] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [igModalOpen, setIgModalOpen] = useState(false);
  const [styleChooserOpen, setStyleChooserOpen] = useState(false);
  const [cropPhotoId, setCropPhotoId] = useState<string | null>(null);
  const [durationInput, setDurationInput] = useState('');
  const musicInputRef = useRef<HTMLInputElement>(null);

  const reel = useLiveQuery(() => (reelId ? db.reels.get(reelId) : undefined), [reelId]);
  // Keep the custom-length field in sync with the reel unless it's being typed in.
  useEffect(() => {
    if (reel) setDurationInput(String(reel.durationSec));
  }, [reel?.durationSec]);
  const photos = useLiveQuery(
    () => (reelId ? db.photos.where('reelId').equals(reelId).toArray() : []),
    [reelId],
  );
  const music = useLiveQuery(() => db.music.orderBy('addedAt').reverse().toArray(), []);
  // Is the preview showing the current settings, or still catching up?
  const rebuilding = useRebuildStatus((s) => s.pending > 0);

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
      localPlayer.onTime = (t) => setElapsedMs(t);
      localPlayer.onEnded = () => {
        setPlaying(false);
        setEnded(true);
      };
      playerRef.current = localPlayer;
      setPlaying(false);
      setEnded(false);
      setElapsedMs(0);
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

  const tryAnotherEdit = async (templateId: TemplateId) => {
    setStyleChooserOpen(false);
    setBusy(true);
    try {
      // Lock-aware: photos the user added stay in; a manual order stays in
      // order (only pacing/treatment vary); otherwise the engine rethinks
      // the sequence with a fresh seed. Earlier versions are never lost.
      await generateVersion(reel.id, templateId, Date.now() % 100_000);
      show(
        reel.manualOrder
          ? 'New take created — your photo order is kept; pacing and motion vary.'
          : (reel.requiredIds?.length ?? 0) > 0
            ? 'New arrangement created — your added photos are all still in.'
            : 'New arrangement created — your earlier versions are saved.',
      );
    } finally {
      setBusy(false);
    }
  };

  const togglePlay = () => {
    const p = playerRef.current;
    if (!p) return;
    if (p.playing) {
      p.pause();
      setPlaying(false);
    } else {
      // Replaying from the end restarts at the top.
      if (p.ended) setElapsedMs(0);
      p.play();
      setPlaying(true);
      setEnded(false);
    }
  };

  const applyCustomDuration = () => {
    const parsed = Number(durationInput);
    if (!Number.isFinite(parsed)) {
      setDurationInput(String(reel.durationSec));
      return;
    }
    const clamped = clampReelDuration(parsed);
    setDurationInput(String(clamped));
    if (clamped !== reel.durationSec) void patchAndRebuild({ durationSec: clamped });
  };

  const includedCount = photos.filter((p) => p.included).length;

  const template = reel.templateId ? getTemplate(reel.templateId) : null;
  const pacing = template
    ? pacingFor(template, reel.durationSec * 1000, stripPhotoIds.length)
    : null;

  const previewStatus = rebuilding
    ? 'Updating preview…'
    : `${activeVersion.label} · up to date`;

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
        <div style={{ textAlign: 'right', marginRight: 4 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 19, lineHeight: 1.2 }}>
            {stripPhotoIds.length} photos · {reel.durationSec}.0s
          </div>
          <div className="faint">
            {pacing ? `~${(pacing.perPhotoMs / 1000).toFixed(1)}s each` : ''}
            {template ? ` · ${template.name}` : ''}
          </div>
        </div>
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
          <div className="reel-frame" onClick={togglePlay}>
            <canvas ref={canvasRef} />
            {!playing && !ended && (
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
            {ended && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'grid',
                  placeItems: 'center',
                  alignContent: 'center',
                  gap: 10,
                  background: 'rgba(13,12,10,0.72)',
                  color: '#fff',
                  pointerEvents: 'none',
                }}
              >
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 21 }}>
                  End of reel
                </div>
                <div style={{ fontSize: 13, opacity: 0.85 }}>
                  {stripPhotoIds.length} photos · {reel.durationSec}.0s
                </div>
                <div className="btn btn-secondary btn-sm" style={{ pointerEvents: 'none' }}>
                  ↺ Replay
                </div>
              </div>
            )}
          </div>

          {/* Playhead: always know where you are and when it's over. */}
          <div className="progressbar" style={{ marginTop: 8 }}>
            <div
              style={{
                width: `${Math.min(100, (elapsedMs / (reel.durationSec * 1000)) * 100)}%`,
                transition: playing ? 'none' : 'width 0.2s ease',
              }}
            />
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <span className="faint">
              {(Math.min(elapsedMs, reel.durationSec * 1000) / 1000).toFixed(1)}s /{' '}
              {reel.durationSec}.0s
            </span>
            <div className="spacer" />
            <span className="faint">{previewStatus}</span>
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
            <button
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => setStyleChooserOpen(true)}
            >
              {busy ? <span className="spinner" /> : '↻'} Try Another Edit
            </button>
          </div>
        </div>

        {/* Controls */}
        <div className="stack-v">
          {pacing?.rushed && template && (
            <div
              className="panel"
              style={{ background: 'var(--warn-soft)', borderColor: 'var(--warn)', padding: 14 }}
            >
              <strong style={{ fontSize: 14.5 }}>
                {stripPhotoIds.length} photos in {reel.durationSec}s is ~
                {(pacing.perPhotoMs / 1000).toFixed(1)}s each — faster than{' '}
                {template.name}’s {template.pace}.
              </strong>
              <p className="muted" style={{ fontSize: 13.5, margin: '6px 0 10px' }}>
                These are photos you added, so they all stay in. Give them room, or
                pick a style built for this pace.
              </p>
              <div className="row wrap">
                {pacing.neededSec && (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => void patchAndRebuild({ durationSec: pacing.neededSec! })}
                  >
                    Use {pacing.neededSec}s
                  </button>
                )}
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    void touchReel(reel.id, { templateId: 'quick-cut' }).then(() =>
                      rebuildActiveVersion(reel.id),
                    );
                  }}
                >
                  Switch to Quick Cut
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    void touchReel(reel.id, { templateId: 'rapid-fire' }).then(() =>
                      rebuildActiveVersion(reel.id),
                    );
                  }}
                >
                  Switch to Rapid Fire
                </button>
              </div>
            </div>
          )}

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
                  crop={photos.find((p) => p.id === id)?.customCrop}
                  onCrop={() => setCropPhotoId(id)}
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
              Drag (or use ‹ ›) to reorder. Tap ⛶ on any photo to fix its framing.
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
              <label>Purpose</label>
              <select
                value={reel.purpose ?? 'auto'}
                onChange={(e) => void patchAndRebuild({ purpose: e.target.value as ReelPurpose })}
              >
                <option value="auto">Surprise me — read the set</option>
                <option value="photography">Photography — selective showcase</option>
                <option value="school">School / Community — many faces, real moments</option>
              </select>
              <span className="hint">
                Purpose sets what matters (selection & breadth); style sets how it feels.
              </span>
            </div>
            <div className="field">
              <label>Length</label>
              <div className="row wrap">
                {REEL_DURATION_PRESETS.map((d) => (
                  <button
                    key={d}
                    className={`btn btn-sm ${reel.durationSec === d ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => void patchAndRebuild({ durationSec: d })}
                  >
                    {d}s
                  </button>
                ))}
                <span className="row" style={{ gap: 6 }}>
                  <input
                    type="number"
                    min={MIN_REEL_DURATION_SEC}
                    max={MAX_REEL_DURATION_SEC}
                    value={durationInput}
                    onChange={(e) => setDurationInput(e.target.value)}
                    onBlur={() => applyCustomDuration()}
                    onKeyDown={(e) => e.key === 'Enter' && applyCustomDuration()}
                    style={{
                      width: 64,
                      background: 'var(--paper-raised)',
                      border: '1px solid var(--line-strong)',
                      borderRadius: 8,
                      padding: '7px 8px',
                      textAlign: 'center',
                    }}
                    aria-label="Custom length in seconds"
                  />
                  <span className="faint">s (custom)</span>
                </span>
              </div>
              {includedCount > 0 && template && (
                <span className="hint">
                  {(() => {
                    const natural = estimateDurationSec(template, includedCount);
                    if (natural === null) {
                      return `${includedCount} included photos won’t fit comfortably even at ${MAX_REEL_DURATION_SEC}s with ${template.name} — try Rapid Fire.`;
                    }
                    if (natural === reel.durationSec) {
                      return `${includedCount} included photos fit ${template.name}’s pace right at ${reel.durationSec}s.`;
                    }
                    return `${includedCount} included photos would naturally fill about ${natural}s with ${template.name}.`;
                  })()}
                  {(() => {
                    const natural = estimateDurationSec(template, includedCount);
                    return natural !== null && natural !== reel.durationSec ? (
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ marginLeft: 6, padding: '2px 8px', minHeight: 'auto' }}
                        onClick={() => void patchAndRebuild({ durationSec: natural })}
                      >
                        Use {natural}s
                      </button>
                    ) : null;
                  })()}
                </span>
              )}
              {pacing && template && (
                <span className="hint">
                  {(() => {
                    const included = photos.filter((p) => p.included).length;
                    const showing = pacing.photoCount;
                    const comfy = pacing.comfortableCapacity;
                    if (reel.manualOrder) {
                      const cut = Math.max(0, Math.min(reel.manualOrder.length, included) - showing);
                      return (
                        `Showing ${showing} photos in your order at ~${(pacing.perPhotoMs / 1000).toFixed(1)}s each. ` +
                        `${template.name} sits best with ${comfy} at ${reel.durationSec}s.` +
                        (cut > 0
                          ? ` ${cut} more don’t fit at all; pick a longer length or Rapid Fire.`
                          : '')
                      );
                    }
                    return (
                      `Showing ${showing} of ${included} included photos at this style’s pace ` +
                      `(~${(pacing.perPhotoMs / 1000).toFixed(1)}s each; ${comfy} fit comfortably at ${reel.durationSec}s). ` +
                      `A tight edit is deliberate — use “Add to reel” on any photo that must appear.`
                    );
                  })()}
                </span>
              )}
            </div>
            <div className="field">
              <label>Music</label>
              {reel.instagramAudio ? (
                <div
                  className="panel"
                  style={{ padding: 12, background: 'var(--paper-sunken)' }}
                >
                  <div style={{ fontWeight: 600, fontSize: 14.5 }}>
                    🎵 {reel.instagramAudio.songTitle}
                    {reel.instagramAudio.artist ? ` — ${reel.instagramAudio.artist}` : ''}
                  </div>
                  <div className="faint" style={{ margin: '2px 0 8px' }}>
                    Instagram Audio Reference · starts at{' '}
                    {formatTimestamp(reel.instagramAudio.startSec)} · export stays silent —
                    add the official song when you post
                  </div>
                  <div className="row">
                    <button className="btn btn-secondary btn-sm" onClick={() => setIgModalOpen(true)}>
                      Edit section
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => void clearInstagramAudio(reel.id)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <select
                    value={reel.musicAssetKey ?? ''}
                    onChange={(e) => {
                      const track = music?.find((m) => m.assetKey === e.target.value);
                      void patchAndRebuild({
                        musicAssetKey: track?.assetKey ?? null,
                        musicName: track?.name ?? null,
                        instagramAudio: null,
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
                  <div className="row wrap">
                    <button className="btn btn-secondary btn-sm" onClick={() => musicInputRef.current?.click()}>
                      Upload a track
                    </button>
                    <button className="btn btn-secondary btn-sm" onClick={() => setIgModalOpen(true)}>
                      Edit to Instagram Audio
                    </button>
                  </div>
                  <span className="hint">
                    Upload music you’re licensed to include, or build your reel to an
                    Instagram song and add the official audio when you post.
                  </span>
                </>
              )}
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
                    await patchAndRebuild({
                      musicAssetKey: added.assetKey,
                      musicName: added.name,
                      instagramAudio: null,
                    });
                  }
                  show('Track added');
                }}
              />
            </div>
          </div>
        </div>
      </div>

      {cropPhotoId && (
        <CropModal
          photoId={cropPhotoId}
          reelId={reel.id}
          onClose={() => setCropPhotoId(null)}
        />
      )}

      {igModalOpen && <InstagramAudioModal reel={reel} onClose={() => setIgModalOpen(false)} />}

      {styleChooserOpen && (
        <Modal onClose={() => setStyleChooserOpen(false)}>
          <h2 style={{ marginBottom: 6 }}>Try another edit</h2>
          <p className="muted" style={{ fontSize: 13.5, marginBottom: 16 }}>
            {reel.manualOrder
              ? 'Your photos and order are kept — pacing, motion and treatments will vary.'
              : (reel.requiredIds?.length ?? 0) > 0
                ? 'Photos you added stay in; the sequence gets rethought.'
                : 'The whole edit gets rethought — earlier versions are always saved.'}
          </p>
          <div className="stack-v" style={{ gap: 8 }}>
            {reel.templateId && (
              <button
                className="btn btn-primary"
                onClick={() => void tryAnotherEdit(reel.templateId!)}
              >
                Same style — {getTemplate(reel.templateId).name}
              </button>
            )}
            {TEMPLATES.filter((t) => t.id !== reel.templateId).map((t) => (
              <button
                key={t.id}
                className="btn btn-secondary"
                style={{ justifyContent: 'flex-start' }}
                onClick={() => {
                  void touchReel(reel.id, { templateId: t.id }).then(() => tryAnotherEdit(t.id));
                }}
              >
                {t.name}
                <span className="faint" style={{ marginLeft: 8, fontWeight: 400 }}>
                  {t.pace}
                </span>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
