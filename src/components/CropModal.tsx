// Fix a photo's framing from anywhere it appears — the photo strip in the
// editor, or the photo detail view. Saves the same non-destructive
// customCrop the reel engine already honors, then rebuilds the arrangement
// so the preview updates immediately.

import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { CropEditor } from './CropEditor';
import { blobKey, db } from '../lib/db';
import { rebuildActiveVersion } from '../lib/reels';
import { useBlobUrl } from './hooks';
import { useToasts } from './toast';
import type { NRect, PhotoRecord } from '../lib/types';

export function CropModal({
  photoId,
  reelId,
  onClose,
}: {
  photoId: string;
  /** When given, the reel's arrangement is rebuilt after saving. */
  reelId?: string;
  onClose: () => void;
}) {
  const show = useToasts((s) => s.show);
  const [photo, setPhoto] = useState<PhotoRecord | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void db.photos.get(photoId).then((p) => setPhoto(p ?? null));
  }, [photoId]);

  // Show the corrected variant when it's the one the reel will use.
  const useCorrected = Boolean(photo?.correctionEnabled && photo?.hasCorrected);
  const previewUrl = useBlobUrl(
    photo ? (useCorrected ? blobKey.corrected(photo.id) : blobKey.preview(photo.id)) : null,
  );

  const save = async (crop: NRect | undefined) => {
    setSaving(true);
    try {
      await db.photos.update(photoId, { customCrop: crop });
      if (reelId) await rebuildActiveVersion(reelId);
      show(crop ? 'Crop saved — the reel uses this framing.' : 'Custom crop removed.');
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <h2 style={{ marginBottom: 4 }}>Fix the crop</h2>
      <p className="faint" style={{ marginBottom: 14 }}>
        {photo?.fileName ?? ''}
      </p>
      {photo && previewUrl ? (
        <CropEditor
          imageUrl={previewUrl}
          imageWidth={photo.width}
          imageHeight={photo.height}
          initial={photo.customCrop}
          onSave={(crop) => void save(crop)}
          onReset={() => void save(undefined)}
          onClose={onClose}
        />
      ) : (
        <div className="row" style={{ padding: 24 }}>
          <span className="spinner" />
          <span className="muted">Loading photo…</span>
        </div>
      )}
      {saving && (
        <div className="row" style={{ marginTop: 10 }}>
          <span className="spinner" />
          <span className="faint">Updating the reel…</span>
        </div>
      )}
    </Modal>
  );
}
