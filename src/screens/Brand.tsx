import { useEffect, useState } from 'react';
import { blobKey, putBlob } from '../lib/db';
import { getBrand, saveBrand } from '../lib/reels';
import { registerBrandFont } from '../lib/engine/resources';
import { uid } from '../lib/ids';
import { useBlobUrl, invalidateBlobUrl } from '../components/hooks';
import { useToasts } from '../components/toast';
import type { BrandConfig, BrandFont } from '../lib/types';

const FONT_ACCEPT = '.woff,.woff2,.otf,.ttf,font/woff,font/woff2,font/otf,font/ttf';

function FontField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: BrandFont | null;
  onChange: (font: BrandFont | null) => void;
}) {
  const show = useToasts((s) => s.show);
  return (
    <div className="field">
      <label>{label}</label>
      {value ? (
        <div className="row">
          <span style={{ fontFamily: `'${value.family}'`, fontSize: 17 }}>{value.fileName}</span>
          <div className="spacer" />
          <button className="btn btn-ghost btn-sm" onClick={() => onChange(null)}>
            Remove
          </button>
        </div>
      ) : (
        <label className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }}>
          Upload font file
          <input
            type="file"
            accept={FONT_ACCEPT}
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const assetKey = blobKey.font(uid());
              await putBlob(assetKey, file);
              const family = `brand-${assetKey.slice(-8)}`;
              const registered = await registerBrandFont(assetKey, family);
              if (!registered) {
                show('That font file couldn’t be read. WOFF, WOFF2, OTF and TTF work.', 'error');
                return;
              }
              onChange({ assetKey, fileName: file.name, family });
            }}
          />
        </label>
      )}
      <span className="hint">WOFF, WOFF2, OTF or TTF. Stored once, used on every reel.</span>
    </div>
  );
}

export function BrandScreen() {
  const show = useToasts((s) => s.show);
  const [brand, setBrand] = useState<BrandConfig | null>(null);
  const logoUrl = useBlobUrl(brand?.logoAssetKey);

  useEffect(() => {
    void getBrand().then(setBrand);
  }, []);

  if (!brand) return null;

  const update = (patch: Partial<BrandConfig>) => setBrand({ ...brand, ...patch });

  return (
    <div style={{ maxWidth: 620, margin: '0 auto' }}>
      <div className="page-header">
        <div>
          <h1>Brand</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            Set once — every reel uses your real logo, fonts and colors.
          </p>
        </div>
      </div>

      <div className="panel stack-v">
        <div className="field">
          <label>Logo</label>
          {logoUrl && (
            <img
              src={logoUrl}
              alt="Logo"
              style={{ maxHeight: 72, alignSelf: 'flex-start', marginBottom: 6 }}
            />
          )}
          <label className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }}>
            {brand.logoAssetKey ? 'Replace logo' : 'Upload logo'}
            <input
              type="file"
              accept="image/png,image/svg+xml,image/jpeg,image/webp"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const key = brand.logoAssetKey ?? blobKey.logo(uid());
                await putBlob(key, file);
                invalidateBlobUrl(key);
                update({ logoAssetKey: key });
              }}
            />
          </label>
          <span className="hint">PNG with transparency looks best on video.</span>
        </div>

        <FontField
          label="Primary font (titles & CTA)"
          value={brand.primaryFont}
          onChange={(primaryFont) => update({ primaryFont })}
        />
        <FontField
          label="Secondary font (captions & handles)"
          value={brand.secondaryFont}
          onChange={(secondaryFont) => update({ secondaryFont })}
        />

        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label>Primary color</label>
            <input
              type="color"
              value={brand.primaryColor}
              onChange={(e) => update({ primaryColor: e.target.value })}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Secondary color</label>
            <input
              type="color"
              value={brand.secondaryColor}
              onChange={(e) => update({ secondaryColor: e.target.value })}
            />
          </div>
        </div>

        <div className="field">
          <label>Default call to action</label>
          <input
            type="text"
            value={brand.cta}
            placeholder="Book your session"
            onChange={(e) => update({ cta: e.target.value })}
          />
        </div>
        <div className="field">
          <label>Website</label>
          <input
            type="url"
            value={brand.website}
            placeholder="yourstudio.com"
            onChange={(e) => update({ website: e.target.value })}
          />
        </div>
        <div className="field">
          <label>Instagram handle</label>
          <input
            type="text"
            value={brand.instagram}
            placeholder="@yourstudio"
            onChange={(e) => update({ instagram: e.target.value })}
          />
        </div>

        <button
          className="btn btn-primary"
          style={{ alignSelf: 'flex-start' }}
          onClick={async () => {
            await saveBrand(brand);
            show('Brand saved — future reels will use it automatically.');
          }}
        >
          Save brand
        </button>
      </div>
    </div>
  );
}
