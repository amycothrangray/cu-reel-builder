// "Edit to Instagram Audio" — build the reel to a song the user will add
// natively inside Instagram. A temporary reference track drives timing and
// preview; the export stays silent; Instagram supplies the licensed audio.
//
// Language matters: this is an "Instagram Audio Reference". Reel Studio never
// claims a song is available/licensed on Instagram — Instagram is the source
// of truth for its own catalog.

import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { WaveformPicker } from './WaveformPicker';
import { getBlob, putBlob, db } from '../lib/db';
import { uid } from '../lib/ids';
import { setInstagramAudio } from '../lib/reels';
import { useToasts } from './toast';
import type { InstagramAudioPlan, ReelRecord } from '../lib/types';

export function InstagramAudioModal({
  reel,
  onClose,
}: {
  reel: ReelRecord;
  onClose: () => void;
}) {
  const show = useToasts((s) => s.show);
  const fileRef = useRef<HTMLInputElement>(null);
  const existing = reel.instagramAudio ?? null;
  const [songTitle, setSongTitle] = useState(existing?.songTitle ?? '');
  const [artist, setArtist] = useState(existing?.artist ?? '');
  const [referenceKey, setReferenceKey] = useState(existing?.referenceAssetKey ?? null);
  const [referenceName, setReferenceName] = useState(existing?.referenceName ?? null);
  const [referenceBlob, setReferenceBlob] = useState<Blob | null>(null);
  const [startMs, setStartMs] = useState((existing?.startSec ?? 0) * 1000);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (referenceKey && !referenceBlob) {
      void getBlob(referenceKey).then((b) => b && setReferenceBlob(b));
    }
  }, [referenceKey, referenceBlob]);

  const uploadReference = async (file: File) => {
    const key = `igref:${uid()}`;
    await putBlob(key, file);
    if (referenceKey) await db.blobs.delete(referenceKey).catch(() => undefined);
    setReferenceKey(key);
    setReferenceName(file.name);
    setReferenceBlob(file);
    setStartMs(0);
  };

  const save = async () => {
    if (!songTitle.trim()) {
      show('Add the song title — you’ll search for it inside Instagram.', 'error');
      return;
    }
    setSaving(true);
    try {
      const plan: InstagramAudioPlan = {
        songTitle: songTitle.trim(),
        artist: artist.trim(),
        referenceAssetKey: referenceKey,
        referenceName,
        startSec: Math.round(startMs / 100) / 10,
      };
      await setInstagramAudio(reel.id, plan);
      show('Reel will be edited to this section — export stays silent for Instagram.');
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <h2 style={{ marginBottom: 6 }}>Edit to Instagram Audio</h2>
      <p className="muted" style={{ fontSize: 13.5, marginBottom: 16 }}>
        Build your reel to an Instagram song, then add the official audio when
        you post. Your export contains no music — Instagram plays the licensed
        song, and this reel is timed to meet it at the exact start point.
      </p>

      <div className="row" style={{ gap: 12 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Song title</label>
          <input
            type="text"
            placeholder="Beautiful Things"
            value={songTitle}
            onChange={(e) => setSongTitle(e.target.value)}
          />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Artist</label>
          <input
            type="text"
            placeholder="Benson Boone"
            value={artist}
            onChange={(e) => setArtist(e.target.value)}
          />
        </div>
      </div>

      <div className="field">
        <label>Reference track (for timing only)</label>
        {referenceName ? (
          <div className="row">
            <span style={{ fontSize: 14 }}>{referenceName}</span>
            <div className="spacer" />
            <button className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}>
              Replace
            </button>
          </div>
        ) : (
          <button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => fileRef.current?.click()}>
            Add reference audio
          </button>
        )}
        <span className="hint">
          A copy of the song you have access to for editing reference. It is
          used to time and preview the edit and is never included in your
          Instagram export.
        </span>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadReference(f);
          }}
        />
      </div>

      {referenceBlob && referenceKey && (
        <div className="panel" style={{ padding: 14, marginBottom: 16 }}>
          <h3 style={{ fontSize: 14.5, marginBottom: 10 }}>
            Choose the section — {reel.durationSec}s of the song
          </h3>
          <WaveformPicker
            blob={referenceBlob}
            assetKey={referenceKey}
            reelDurationMs={reel.durationSec * 1000}
            startMs={startMs}
            onChange={setStartMs}
          />
        </div>
      )}

      {!referenceBlob && (
        <p className="faint" style={{ marginBottom: 16 }}>
          Without a reference track you can still record the song and start
          point here, but the edit won’t be timed to the music.
        </p>
      )}

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
          {saving ? <span className="spinner" /> : null} Use this section
        </button>
      </div>
    </Modal>
  );
}
