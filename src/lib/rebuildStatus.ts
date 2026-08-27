// Tracks whether the preview reflects the current settings.
//
// Every rebuild of the active arrangement runs through here, so the editor
// can say plainly: "Updating preview…" while work is in flight, and
// "Preview up to date" (with the moment it was built) once it settles.

import { create } from 'zustand';

interface RebuildState {
  /** Number of rebuilds currently in flight. */
  pending: number;
  /** When the preview last finished rebuilding. */
  builtAt: number;
  begin: () => void;
  end: () => void;
}

export const useRebuildStatus = create<RebuildState>((set) => ({
  pending: 0,
  builtAt: Date.now(),
  begin: () => set((s) => ({ pending: s.pending + 1 })),
  end: () =>
    set((s) => ({ pending: Math.max(0, s.pending - 1), builtAt: Date.now() })),
}));

/** Wrap an async rebuild so the UI knows the preview is being refreshed. */
export async function trackRebuild<T>(work: () => Promise<T>): Promise<T> {
  useRebuildStatus.getState().begin();
  try {
    return await work();
  } finally {
    useRebuildStatus.getState().end();
  }
}
