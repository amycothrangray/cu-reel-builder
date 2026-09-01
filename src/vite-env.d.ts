/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public Dropbox App key (safe client-side) — enables Dropbox import. */
  readonly VITE_DROPBOX_APP_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
