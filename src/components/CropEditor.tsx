// Manual 9:16 crop editor: drag the frame around the photo, pinch/slider to
// zoom. Saves a normalized source rect that overrides automatic framing.
// Presentation-only — the stored photo is never modified.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { NRect } from '../lib/types';

const TARGET_ASPECT = 9 / 16;
const MAX_ZOOM = 2.2;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Largest 9:16 crop of the image at zoom 1, in normalized coords. */
function baseCropDims(imageAspect: number): { w: number; h: number } {
  if (imageAspect > TARGET_ASPECT) {
    return { w: TARGET_ASPECT / imageAspect, h: 1 };
  }
  return { w: 1, h: imageAspect / TARGET_ASPECT };
}

export function CropEditor({
  imageUrl,
  imageWidth,
  imageHeight,
  initial,
  onSave,
  onReset,
  onClose,
}: {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  initial?: NRect;
  onSave: (crop: NRect) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const imageAspect = imageWidth / imageHeight;
  const base = useMemo(() => baseCropDims(imageAspect), [imageAspect]);

  // Derive initial zoom + center from an existing crop, else centered zoom 1.
  const [zoom, setZoom] = useState(() =>
    initial ? clamp(base.w / initial.w, 1, MAX_ZOOM) : 1,
  );
  const [center, setCenter] = useState(() =>
    initial
      ? { x: initial.x + initial.w / 2, y: initial.y + initial.h / 2 }
      : { x: 0.5, y: 0.5 },
  );

  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ px: number; py: number; cx: number; cy: number } | null>(null);

  const crop: NRect = useMemo(() => {
    const w = base.w / zoom;
    const h = base.h / zoom;
    const x = clamp(center.x - w / 2, 0, 1 - w);
    const y = clamp(center.y - h / 2, 0, 1 - h);
    return { x, y, w, h };
  }, [base, zoom, center]);

  // Keep the center valid when zoom changes.
  useEffect(() => {
    setCenter((c) => ({
      x: clamp(c.x, base.w / zoom / 2, 1 - base.w / zoom / 2),
      y: clamp(c.y, base.h / zoom / 2, 1 - base.h / zoom / 2),
    }));
  }, [zoom, base]);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { px: e.clientX, py: e.clientY, cx: center.x, cy: center.y };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    const stage = stageRef.current;
    if (!drag || !stage) return;
    const rect = stage.getBoundingClientRect();
    const dx = (e.clientX - drag.px) / rect.width;
    const dy = (e.clientY - drag.py) / rect.height;
    setCenter({
      x: clamp(drag.cx + dx, crop.w / 2, 1 - crop.w / 2),
      y: clamp(drag.cy + dy, crop.h / 2, 1 - crop.h / 2),
    });
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  return (
    <div>
      <p className="muted" style={{ fontSize: 13.5, marginBottom: 10 }}>
        Drag the photo to frame it, use the slider to zoom. This frame is what
        shows in the reel.
      </p>
      <div
        ref={stageRef}
        style={{
          position: 'relative',
          borderRadius: 12,
          overflow: 'hidden',
          background: '#111',
          touchAction: 'none',
          cursor: 'grab',
          aspectRatio: `${imageWidth} / ${imageHeight}`,
          maxHeight: '46vh',
          margin: '0 auto',
          userSelect: 'none',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <img
          src={imageUrl}
          alt=""
          draggable={false}
          style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
        />
        {/* Dim everything outside the crop. */}
        <div
          style={{
            position: 'absolute',
            pointerEvents: 'none',
            boxShadow: `0 0 0 100vmax rgba(0,0,0,0.55)`,
            border: '2px solid #fff',
            borderRadius: 4,
            left: `${crop.x * 100}%`,
            top: `${crop.y * 100}%`,
            width: `${crop.w * 100}%`,
            height: `${crop.h * 100}%`,
          }}
        />
      </div>

      <div className="row" style={{ marginTop: 14 }}>
        <span className="faint">Zoom</span>
        <input
          type="range"
          min={1}
          max={MAX_ZOOM}
          step={0.01}
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          style={{ flex: 1 }}
        />
      </div>

      <div className="row wrap" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
        {initial && (
          <button className="btn btn-ghost" onClick={onReset}>
            Remove custom crop
          </button>
        )}
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={() => onSave(crop)}>
          Save crop
        </button>
      </div>
    </div>
  );
}
