import { useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { blobKey, db, auditLog, deletePhotoCompletely, getBlob, putBlob } from '../lib/db';
import { effectiveClassification, correctionAllowed, type NRect, type PhotoRecord } from '../lib/types';
import { isNearDuplicate } from '../lib/imaging/similarity';
import { renderCorrected } from '../lib/imaging/correction';
import { canvasToBlob } from '../lib/imaging/decode';
import { matchConfidenceLabel } from '../lib/restricted/matching';
import { ingestFiles } from '../lib/analysis/ingest';
import { chooseFromDropbox, dropboxConfigured } from '../lib/dropbox';
import { enrichWithAi } from '../lib/analysis/aiVision';
import { addPhotosToArrangement, rebuildActiveVersion, removePhotosFromArrangement } from '../lib/reels';
import { getTemplate, templateComfortableCapacity } from '../lib/engine/templates';
import { useBlobUrl, invalidateBlobUrl } from '../components/hooks';
import { Modal } from '../components/Modal';
import { CropEditor } from '../components/CropEditor';
import { useAdminAction } from '../components/AdminGate';
import { useToasts } from '../components/toast';

function Badges({
  photo,
  reelIndex,
  required,
}: {
  photo: PhotoRecord;
  reelIndex?: number;
  /** Photo the user has guaranteed a place in the reel. */
  required?: boolean;
}) {
  const cls = effectiveClassification(photo);
  const needsReview = photo.restrictedFlags.some((f) => f.status === 'pending');
  const blocked = photo.restrictedFlags.some((f) => f.status === 'blocked');
  return (
    <div className="badges">
      {needsReview && <span className="badge badge-restricted">Restricted?</span>}
      {/* A decision she already made is settled — it shouldn't keep shouting. */}
      {!needsReview && blocked && <span className="badge">Blocked</span>}
      {reelIndex !== undefined && (
        <span className="badge badge-recommended">In reel · {reelIndex + 1}</span>
      )}
      {required && (
        <span className="badge" style={{ color: 'var(--accent-ink)' }}>
          Must appear
        </span>
      )}
      {!photo.included && !blocked && <span className="badge">Not in this reel</span>}
      {cls === 'pro' && <span className="badge badge-pro">Pro</span>}
      {cls === 'mobile' && <span className="badge badge-mobile">Mobile</span>}
      {photo.correctionEnabled && photo.hasCorrected && (
        <span className="badge badge-corrected">Corrected</span>
      )}
      {photo.customCrop && <span className="badge">Cropped</span>}
    </div>
  );
}

function PhotoCell({
  photo,
  reelIndex,
  required,
  duplicate,
  onOpen,
}: {
  photo: PhotoRecord;
  reelIndex?: number;
  required?: boolean;
  duplicate: boolean;
  onOpen: () => void;
}) {
  const thumbUrl = useBlobUrl(photo.status !== 'ingesting' ? blobKey.thumb(photo.id) : null);
  const needsReview = photo.restrictedFlags.some((f) => f.status === 'pending');
  const blocked = photo.restrictedFlags.some((f) => f.status === 'blocked');
  return (
    <div
      className={`photo-cell ${photo.included ? '' : 'excluded'} ${needsReview ? 'flagged' : ''}`}
      style={blocked && !needsReview ? { borderColor: 'var(--line-strong)' } : undefined}
      onClick={onOpen}
    >
      {thumbUrl ? (
        <img src={thumbUrl} alt={photo.fileName} loading="lazy" />
      ) : (
        <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
          <div className="spinner" />
        </div>
      )}
      {photo.status === 'ready' && (
        <>
          <Badges photo={photo} reelIndex={reelIndex} required={required} />
          {duplicate && (
            <span className="badge badge-duplicate" style={{ position: 'absolute', top: 6, right: 6 }}>
              Duplicate
            </span>
          )}
        </>
      )}
      {photo.status === 'error' && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 12, color: 'var(--danger)', padding: 8, textAlign: 'center' }}>
          Couldn’t read this photo
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Render the gentle correction for one photo. Returns false when the photo
 * already sits well next to professional work and nothing was changed.
 * Shared so single-photo and bulk paths do exactly the same work.
 */
async function renderCorrectionFor(p: PhotoRecord): Promise<boolean> {
  const blob = await getBlob(blobKey.preview(p.id));
  if (!blob || !p.analysis) return false;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  const { canvas: corrected, changed } = renderCorrected(canvas, p.analysis.stats);
  bitmap.close();
  if (!changed) return false;
  await putBlob(blobKey.corrected(p.id), await canvasToBlob(corrected, 'image/jpeg', 0.92));
  invalidateBlobUrl(blobKey.corrected(p.id));
  await db.photos.update(p.id, { hasCorrected: true, correctionEnabled: true });
  return true;
}

function DetailModal({
  photo,
  reelPosition,
  required,
  hasTemplate,
  onAddToReel,
  onRemoveFromReel,
  onClose,
  onChanged,
}: {
  photo: PhotoRecord;
  /** Position in the current arrangement, if the photo is in it. */
  reelPosition?: number;
  /** The user has guaranteed this photo a place in the reel. */
  required: boolean;
  /** A style has been chosen, so there is an arrangement to add to. */
  hasTemplate: boolean;
  onAddToReel: () => void;
  onRemoveFromReel: () => void;
  onClose: () => void;
  /** Called after any change that affects the reel arrangement. */
  onChanged: () => void;
}) {
  const show = useToasts((s) => s.show);
  const { requireAdmin, GateModal } = useAdminAction();
  const previewUrl = useBlobUrl(blobKey.preview(photo.id));
  const correctedUrl = useBlobUrl(photo.hasCorrected ? blobKey.corrected(photo.id) : null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [cropping, setCropping] = useState(false);

  const cls = effectiveClassification(photo);
  const showingCorrected =
    photo.correctionEnabled && photo.hasCorrected && correctedUrl && !showOriginal;
  const pendingFlags = photo.restrictedFlags.filter((f) => f.status === 'pending');
  const blockedFlags = photo.restrictedFlags.filter((f) => f.status === 'blocked');

  const setOverride = async (value: 'pro' | 'mobile' | undefined) => {
    const patch: Partial<PhotoRecord> = { overrideClassification: value };
    if (value === 'pro') patch.correctionEnabled = false;
    await db.photos.update(photo.id, patch);
    if (value === 'mobile' && !photo.hasCorrected && photo.analysis) {
      const corrected = await renderCorrectionFor(photo);
      if (!corrected) {
        show('This photo already sits well next to professional work — no correction needed.');
      }
    }
    onChanged();
  };

  const saveCrop = async (crop: NRect | undefined) => {
    await db.photos.update(photo.id, { customCrop: crop });
    setCropping(false);
    onChanged();
    show(crop ? 'Crop saved — the reel will use this framing.' : 'Custom crop removed.');
  };

  const reviewFlag = async (profileId: string, status: 'safe' | 'blocked') => {
    const wasBlocked = photo.restrictedFlags.some(
      (f) => f.profileId === profileId && f.status === 'blocked',
    );
    const apply = async () => {
      const flags = photo.restrictedFlags.map((f) =>
        f.profileId === profileId ? { ...f, status, reviewedAt: Date.now(), reviewedBy: 'admin' } : f,
      );
      const stillBlocked = flags.some((f) => f.status === 'blocked');
      await db.photos.update(photo.id, {
        restrictedFlags: flags,
        // Blocking takes the photo out of the reel; lifting the last block
        // puts it back, so the decision and the result always agree.
        ...(status === 'blocked' ? { included: false } : {}),
        ...(status === 'safe' && wasBlocked && !stillBlocked ? { included: true } : {}),
      });
      await auditLog(
        'admin',
        `restricted-mark-${status}`,
        `photo ${photo.fileName}, profile ${profileId}`,
      );
      onChanged();
      show(
        status === 'blocked'
          ? 'Blocked — this photo stays out of the reel.'
          : 'Marked safe — this photo can appear in the reel again.',
      );
    };
    if (status === 'safe') {
      requireAdmin(() => void apply());
    } else {
      await apply();
    }
  };

  /**
   * Permanent: the photo and every version of it leave this device. Name the
   * file so nobody deletes the wrong one, and ask for the admin PIN whenever
   * a restricted-child review is involved — the same gate as "Mark as Safe".
   */
  const deletePhotoForever = () => {
    const restricted = photo.restrictedFlags.length > 0;
    const ok = window.confirm(
      `Delete “${photo.fileName}” from this device?\n\n` +
        'The photo, its crop and its correction are erased for good. This cannot be undone.',
    );
    if (!ok) return;
    const run = () => {
      void (async () => {
        await auditLog(
          restricted ? 'admin' : 'user',
          restricted ? 'restricted-remove-photo' : 'delete-photo',
          `photo ${photo.fileName}`,
        );
        await deletePhotoCompletely(photo.id);
        onChanged();
        onClose();
        show(`“${photo.fileName}” was deleted from this device.`);
      })();
    };
    if (restricted) requireAdmin(run);
    else run();
  };

  return (
    <Modal onClose={onClose}>
      <div className="row" style={{ marginBottom: 14, alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ fontSize: 19 }}>{photo.fileName}</h2>
          <p className="faint">
            {photo.width} × {photo.height} · {(photo.bytes / 1024 / 1024).toFixed(1)} MB
            {photo.exif.make ? ` · ${photo.exif.make} ${photo.exif.model ?? ''}` : ''}
          </p>
        </div>
        <div className="spacer" />
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          Close
        </button>
      </div>

      {pendingFlags.length > 0 && (
        <div
          className="panel"
          style={{ background: 'var(--danger-soft)', borderColor: 'var(--danger)', marginBottom: 16 }}
        >
          <h3 style={{ color: 'var(--danger)', marginBottom: 6 }}>
            Possible restricted child detected — review required
          </h3>
          <p className="muted" style={{ fontSize: 13.5, marginBottom: 12 }}>
            Face matching is never certain. Please look carefully before deciding.
          </p>
          {pendingFlags.map((flag) => (
            <div key={flag.profileId} style={{ marginBottom: 12 }}>
              <p style={{ fontWeight: 600, fontSize: 14 }}>
                May match: {flag.profileLabel}{' '}
                <span className="faint">({matchConfidenceLabel(flag.distance)})</span>
              </p>
              <div className="row wrap" style={{ marginTop: 8 }}>
                <button className="btn btn-secondary btn-sm" onClick={() => void reviewFlag(flag.profileId, 'safe')}>
                  Mark as Safe
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => void reviewFlag(flag.profileId, 'blocked')}>
                  Keep out of this reel
                </button>
                {/* Last, and named for what it does — this erases the file. */}
                <button className="btn btn-danger btn-sm" onClick={deletePhotoForever}>
                  Delete photo
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {blockedFlags.length > 0 && pendingFlags.length === 0 && (
        <div className="panel" style={{ background: 'var(--paper-sunken)', marginBottom: 16 }}>
          <h3 style={{ marginBottom: 6 }}>
            Blocked for {blockedFlags.map((f) => f.profileLabel).join(', ')} — kept out of this reel
          </h3>
          <p className="muted" style={{ fontSize: 13.5, marginBottom: 12 }}>
            You’ve already reviewed this one. It stays out of the reel and out of anything you
            export. You can change your mind at any time.
          </p>
          {blockedFlags.map((flag) => (
            <div key={flag.profileId} className="row wrap" style={{ marginBottom: 8 }}>
              <span style={{ fontSize: 14 }}>{flag.profileLabel}</span>
              <div className="spacer" />
              <button className="btn btn-secondary btn-sm" onClick={() => void reviewFlag(flag.profileId, 'safe')}>
                This isn’t them — mark as safe
              </button>
            </div>
          ))}
        </div>
      )}

      {cropping && previewUrl ? (
        <CropEditor
          imageUrl={showingCorrected ? correctedUrl! : previewUrl}
          imageWidth={photo.width}
          imageHeight={photo.height}
          initial={photo.customCrop}
          onSave={(crop) => void saveCrop(crop)}
          onReset={() => void saveCrop(undefined)}
          onClose={() => setCropping(false)}
        />
      ) : (
        <>
          <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', background: 'var(--paper-sunken)' }}>
            {previewUrl && (
              <img
                src={showingCorrected ? correctedUrl! : previewUrl}
                alt=""
                style={{ width: '100%', display: 'block', maxHeight: '48vh', objectFit: 'contain' }}
              />
            )}
            {[...pendingFlags, ...blockedFlags].map((flag, i) => (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  left: `${flag.face.x * 100}%`,
                  top: `${flag.face.y * 100}%`,
                  width: `${flag.face.w * 100}%`,
                  height: `${flag.face.h * 100}%`,
                  border: `2px solid ${
                    flag.status === 'pending' ? 'var(--danger)' : 'var(--line-strong)'
                  }`,
                  borderRadius: 4,
                }}
              />
            ))}
          </div>

          <div className="row wrap" style={{ marginTop: 12 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => setCropping(true)}>
              {photo.customCrop ? 'Adjust crop' : 'Crop for reel'}
            </button>
            {photo.hasCorrected && correctionAllowed(photo) && (
              <>
                <button
                  className="btn btn-secondary btn-sm"
                  onPointerDown={() => setShowOriginal(true)}
                  onPointerUp={() => setShowOriginal(false)}
                  onPointerLeave={() => setShowOriginal(false)}
                >
                  {showOriginal ? 'Original' : 'Hold to compare original'}
                </button>
                <label className="row" style={{ gap: 6, fontSize: 14 }}>
                  <input
                    type="checkbox"
                    checked={photo.correctionEnabled}
                    onChange={(e) => {
                      void db.photos.update(photo.id, { correctionEnabled: e.target.checked }).then(onChanged);
                    }}
                  />
                  Apply gentle correction
                </label>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => void db.photos.update(photo.id, { correctionEnabled: false }).then(onChanged)}
                >
                  Restore Original
                </button>
              </>
            )}
          </div>
        </>
      )}

      <hr className="divider" />

      <div className="row wrap">
        <span className="faint">
          Detected: {photo.analysis?.classification.label ?? '…'}
          {photo.overrideClassification ? ` · your setting: ${photo.overrideClassification}` : ''}
        </span>
        <div className="spacer" />
        <button
          className={`btn btn-sm ${cls === 'pro' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => void setOverride('pro')}
        >
          Treat as Professional
        </button>
        <button
          className={`btn btn-sm ${cls === 'mobile' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => void setOverride('mobile')}
        >
          Allow Mobile Correction
        </button>
      </div>

      {photo.analysis?.classification.reasons.length ? (
        <p className="faint" style={{ marginTop: 10 }}>
          {photo.analysis.classification.reasons.join(' · ')}
        </p>
      ) : null}

      <div className="row" style={{ marginTop: 16 }}>
        {reelPosition !== undefined ? (
          <>
            <span className="faint">In the reel — position {reelPosition + 1}</span>
            <button className="btn btn-secondary btn-sm" onClick={onRemoveFromReel}>
              Take out of this reel
            </button>
          </>
        ) : required ? (
          <>
            <span className="faint">Set to appear once you choose a style</span>
            <button className="btn btn-secondary btn-sm" onClick={onRemoveFromReel}>
              Take out of this reel
            </button>
          </>
        ) : (
          // Before a style exists there is nothing to add to, so the button
          // promises only what actually happens: this photo will be in it.
          <button className="btn btn-primary btn-sm" onClick={onAddToReel}>
            {hasTemplate ? 'Add to reel' : 'Must appear in the reel'}
          </button>
        )}
        <div className="spacer" />
        <button
          className="btn btn-ghost btn-sm"
          style={{ color: 'var(--danger)' }}
          onClick={deletePhotoForever}
        >
          Delete photo
        </button>
      </div>
      <GateModal />
    </Modal>
  );
}

// ---------------------------------------------------------------------------

export function PhotoReviewScreen() {
  const { reelId } = useParams<{ reelId: string }>();
  const navigate = useNavigate();
  const show = useToasts((s) => s.show);
  const addInputRef = useRef<HTMLInputElement>(null);
  const [dropboxBusy, setDropboxBusy] = useState(false);
  const [openPhotoId, setOpenPhotoId] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const reel = useLiveQuery(() => (reelId ? db.reels.get(reelId) : undefined), [reelId]);
  const photos = useLiveQuery(
    () => (reelId ? db.photos.where('reelId').equals(reelId).sortBy('order') : []),
    [reelId],
  );

  const ready = useMemo(() => (photos ?? []).filter((p) => p.status === 'ready'), [photos]);
  const analyzing = (photos ?? []).some((p) => p.status === 'ingesting' || p.status === 'analyzing');

  // Which photos appear in the current arrangement, and in what order.
  const inReelIndex = useMemo(() => {
    const map = new Map<string, number>();
    const version = reel?.versions.find((v) => v.id === reel.activeVersionId);
    if (!version) return map;
    for (const clip of version.timeline.clips) {
      for (const layer of clip.layers) {
        if (!map.has(layer.photoId)) map.set(layer.photoId, map.size);
      }
    }
    return map;
  }, [reel]);

  // Photos the user has guaranteed a place in the reel.
  const requiredIds = useMemo(() => new Set(reel?.requiredIds ?? []), [reel]);

  const duplicateIds = useMemo(() => {
    const seen: { id: string; phash: string }[] = [];
    const dupes = new Set<string>();
    for (const p of ready) {
      if (!p.analysis) continue;
      if (seen.some((s) => isNearDuplicate(s.phash, p.analysis!.phash))) {
        dupes.add(p.id);
      } else {
        seen.push({ id: p.id, phash: p.analysis.phash });
      }
    }
    return dupes;
  }, [ready]);

  if (!reel || !photos) return null;

  const flaggedCount = ready.filter((p) =>
    p.restrictedFlags.some((f) => f.status === 'pending'),
  ).length;
  const openPhoto = photos.find((p) => p.id === openPhotoId);
  const inReelCount = inReelIndex.size;

  const template = reel.templateId ? getTemplate(reel.templateId) : null;
  // The pace the style promises — not the most photos that physically fit.
  // Guiding by the physical floor pushes her into a rushed-looking reel.
  const comfortable = template
    ? templateComfortableCapacity(template, reel.durationSec * 1000)
    : null;

  const refreshArrangement = () => {
    if (reelId) void rebuildActiveVersion(reelId);
  };

  const addToReel = async (ids: string[]) => {
    if (!reelId) return;
    await addPhotosToArrangement(reelId, ids);
    if (!reel.templateId) {
      // Nothing is arranged yet, so say what the click actually did.
      show(
        ids.length === 1
          ? 'Saved — this photo will be in the reel. Choose a style next and we’ll place it.'
          : `Saved — those ${ids.length} photos will be in the reel. Choose a style next and we’ll place them.`,
      );
      return;
    }
    if (comfortable !== null && inReelCount + ids.length > comfortable) {
      show(
        `This style is at its best with about ${comfortable} photos at ${reel.durationSec}s — beyond that it starts to feel rushed. A longer reel or a faster style gives everyone room.`,
      );
    }
  };

  /**
   * Every way photos arrive here lands in one place, so she always hears
   * what actually came in — duplicates and unreadable files included.
   */
  const addPhotos = async (files: File[]) => {
    if (!reelId || files.length === 0) return;
    let failed = 0;
    try {
      const newIds = await ingestFiles(reelId, files, (p) => {
        failed = p.failed;
      });
      void enrichWithAi(reelId);
      // New uploads go straight into the current arrangement.
      if (newIds.length > 0) await addToReel(newIds);
      const duplicates = files.length - newIds.length - failed;
      if (failed > 0 || duplicates > 0) {
        const parts: string[] = [];
        parts.push(
          newIds.length === 0
            ? 'No new photos were added.'
            : `Added ${newIds.length} photo${newIds.length === 1 ? '' : 's'}.`,
        );
        if (duplicates > 0) {
          parts.push(
            `${duplicates} ${duplicates === 1 ? 'was already here' : 'were already here'}, so we kept the copy you had.`,
          );
        }
        if (failed > 0) {
          parts.push(
            `${failed} couldn’t be opened — that file type may not work in this browser.`,
          );
        }
        show(parts.join(' '), failed > 0 ? 'error' : 'info');
      }
    } catch (err) {
      show(
        'We couldn’t add those photos. Nothing already here was touched — try again.',
        'error',
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  const removeFromReel = async (ids: string[]) => {
    if (!reelId) return;
    await removePhotosFromArrangement(reelId, ids);
  };

  const bulk = async (fn: (p: PhotoRecord) => Partial<PhotoRecord>) => {
    for (const id of selected) {
      const p = photos.find((x) => x.id === id);
      if (p) await db.photos.update(id, fn(p));
    }
    setSelected(new Set());
    setSelecting(false);
    refreshArrangement();
  };

  /**
   * Allowing correction has to do the same work as the single-photo path:
   * mark the photo as mobile AND actually render the corrected version.
   */
  const bulkAllowCorrection = async () => {
    const ids = [...selected];
    setSelected(new Set());
    setSelecting(false);
    let corrected = 0;
    for (const id of ids) {
      const p = photos.find((x) => x.id === id);
      if (!p) continue;
      await db.photos.update(id, { overrideClassification: 'mobile' });
      if (!p.hasCorrected && p.analysis && (await renderCorrectionFor(p))) corrected++;
    }
    refreshArrangement();
    show(
      corrected > 0
        ? `Gentle correction added to ${corrected} photo${corrected === 1 ? '' : 's'}.`
        : 'Those already sit well next to your professional work — nothing needed changing.',
    );
  };

  const bulkReel = async (include: boolean) => {
    const ids = [...selected];
    setSelected(new Set());
    setSelecting(false);
    if (include) await addToReel(ids);
    else await removeFromReel(ids);
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>{reel.name}</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            {ready.length} photos
            {inReelCount > 0
              ? ` · ${inReelCount} in the current reel${comfortable !== null ? ` (best with about ${comfortable} at ${reel.durationSec}s)` : ''}`
              : ''}
            {analyzing ? ' · still looking through a few…' : ''}
            {flaggedCount > 0 ? ` · ${flaggedCount} need review` : ''}
          </p>
        </div>
        <div className="spacer" />
        <button className="btn btn-ghost" onClick={() => setSelecting(!selecting)}>
          {selecting ? 'Done' : 'Select'}
        </button>
        <button className="btn btn-secondary" onClick={() => addInputRef.current?.click()}>
          Add photos
        </button>
        {dropboxConfigured && (
          <button
            className="btn btn-secondary"
            disabled={dropboxBusy}
            onClick={async () => {
              if (!reelId) return;
              setDropboxBusy(true);
              try {
                const files = await chooseFromDropbox();
                await addPhotos(files);
              } catch (err) {
                show(
                  'Dropbox import didn’t work — try again.',
                  'error',
                  err instanceof Error ? err.message : String(err),
                );
              } finally {
                setDropboxBusy(false);
              }
            }}
          >
            {dropboxBusy ? <span className="spinner" /> : null} From Dropbox
          </button>
        )}
        {reel.templateId ? (
          <Link to={`/reel/${reel.id}/edit`} className="btn btn-primary btn-lg">
            Back to editor
          </Link>
        ) : (
          <button
            className="btn btn-primary btn-lg"
            disabled={ready.filter((p) => p.included).length < 3}
            onClick={() => navigate(`/reel/${reel.id}/template`)}
          >
            Choose a style
          </button>
        )}
      </div>

      {flaggedCount > 0 && (
        <div
          className="panel"
          style={{ background: 'var(--danger-soft)', borderColor: 'var(--danger)', marginBottom: 20 }}
        >
          <strong style={{ color: 'var(--danger)' }}>
            {flaggedCount} photo{flaggedCount > 1 ? 's' : ''} may show a restricted child.
          </strong>{' '}
          <span className="muted">Tap the flagged photos to review — export stays locked until then.</span>
        </div>
      )}

      {selecting && (
        <div className="row wrap panel" style={{ marginBottom: 16, padding: 12 }}>
          <span className="muted" style={{ fontSize: 14 }}>
            {selected.size} selected
          </span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() =>
              setSelected(
                selected.size === ready.length
                  ? new Set()
                  : new Set(ready.map((p) => p.id)),
              )
            }
          >
            {selected.size === ready.length ? 'Clear all' : 'Select all'}
          </button>
          <div className="spacer" />
          <button className="btn btn-secondary btn-sm" onClick={() => void bulkReel(true)}>
            Add to reel
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => void bulkReel(false)}>
            Take out of reel
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => void bulk(() => ({ overrideClassification: 'pro', correctionEnabled: false }))}
          >
            Treat as Pro
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => void bulkAllowCorrection()}>
            Allow Correction
          </button>
        </div>
      )}

      <div className="photo-grid">
        {photos.map((photo) => (
          <div key={photo.id} style={{ position: 'relative' }}>
            <PhotoCell
              photo={photo}
              reelIndex={inReelIndex.get(photo.id)}
              required={requiredIds.has(photo.id)}
              duplicate={duplicateIds.has(photo.id)}
              onOpen={() => {
                if (selecting) {
                  setSelected((s) => {
                    const next = new Set(s);
                    if (next.has(photo.id)) next.delete(photo.id);
                    else next.add(photo.id);
                    return next;
                  });
                } else {
                  setOpenPhotoId(photo.id);
                }
              }}
            />
            {selecting && (
              <div
                style={{
                  position: 'absolute',
                  top: 6,
                  left: 6,
                  width: 22,
                  height: 22,
                  borderRadius: 6,
                  border: '2px solid #fff',
                  background: selected.has(photo.id) ? 'var(--ink)' : 'rgba(0,0,0,0.25)',
                  display: 'grid',
                  placeItems: 'center',
                  color: '#fff',
                  fontSize: 13,
                  pointerEvents: 'none',
                }}
              >
                {selected.has(photo.id) ? '✓' : ''}
              </div>
            )}
          </div>
        ))}
      </div>

      {photos.length === 0 && (
        <div className="empty-state panel">
          <h2>No photos here yet</h2>
          <Link to="/new" className="btn btn-primary" style={{ marginTop: 14 }}>
            Upload photos
          </Link>
        </div>
      )}

      <input
        ref={addInputRef}
        type="file"
        accept="image/jpeg,image/png,image/heic,image/heif,.heic,.heif"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          // Clear it right away, or choosing the very same files again after
          // a failure never fires this and the button looks broken.
          e.target.value = '';
          void addPhotos(files);
        }}
      />

      {openPhoto && (
        <DetailModal
          photo={openPhoto}
          reelPosition={inReelIndex.get(openPhoto.id)}
          required={requiredIds.has(openPhoto.id)}
          hasTemplate={reel.templateId !== null}
          onAddToReel={() => void addToReel([openPhoto.id])}
          onRemoveFromReel={() => void removeFromReel([openPhoto.id])}
          onClose={() => setOpenPhotoId(null)}
          onChanged={refreshArrangement}
        />
      )}
    </div>
  );
}
