// Dropbox import via the official Chooser widget.
//
// This is the "pick files from Dropbox" popup, not full account access:
// Dropbox handles auth entirely in its own popup, and the app never sees a
// password or token. The only credential involved is the App key, which is
// public by design (Dropbox's own docs embed it in client-side <script>
// tags) — safe to ship in the browser bundle, unlike a real secret.
//
// Chosen files come back as short-lived "direct" links Dropbox serves with
// CORS headers for exactly this purpose, so we can fetch() them here and
// hand the resulting Blobs to the same ingestion pipeline as any other
// upload — no server component, no Dropbox data ever touches Netlify.

const SCRIPT_SRC = 'https://www.dropbox.com/static/api/2/dropins.js';

export const dropboxAppKey: string | undefined = import.meta.env.VITE_DROPBOX_APP_KEY;

export const dropboxConfigured = Boolean(dropboxAppKey);

interface DropboxChosenFile {
  name: string;
  link: string;
  bytes: number;
  isDir: boolean;
}

declare global {
  interface Window {
    Dropbox?: {
      choose: (options: {
        success: (files: DropboxChosenFile[]) => void;
        cancel?: () => void;
        linkType: 'direct' | 'preview';
        multiselect: boolean;
        extensions?: string[];
      }) => void;
    };
  }
}

let loadPromise: Promise<void> | null = null;

function loadChooserScript(): Promise<void> {
  if (window.Dropbox) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.id = 'dropboxjs';
    if (dropboxAppKey) script.setAttribute('data-app-key', dropboxAppKey);
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load the Dropbox chooser.'));
    document.head.appendChild(script);
  });
  return loadPromise;
}

export const guessMimeType = (name: string): string => {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'heic':
      return 'image/heic';
    case 'heif':
      return 'image/heif';
    default:
      return 'application/octet-stream';
  }
};

/**
 * Open the Dropbox file picker and resolve with downloaded File objects,
 * ready to feed straight into the normal upload pipeline. Resolves to []
 * if the user cancels.
 */
export async function chooseFromDropbox(): Promise<File[]> {
  if (!dropboxConfigured) {
    throw new Error(
      'Dropbox import is not set up yet — add a Dropbox App key in the Netlify site settings.',
    );
  }
  await loadChooserScript();

  const chosen = await new Promise<DropboxChosenFile[]>((resolve) => {
    window.Dropbox!.choose({
      linkType: 'direct',
      multiselect: true,
      extensions: ['.jpg', '.jpeg', '.png', '.heic', '.heif'],
      success: (files) => resolve(files),
      cancel: () => resolve([]),
    });
  });

  const files: File[] = [];
  for (const entry of chosen) {
    if (entry.isDir) continue;
    try {
      const res = await fetch(entry.link);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      files.push(new File([blob], entry.name, { type: guessMimeType(entry.name) }));
    } catch (err) {
      console.warn(`Could not download ${entry.name} from Dropbox:`, err);
    }
  }
  return files;
}
