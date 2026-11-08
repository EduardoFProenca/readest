import { create } from 'zustand';
import type { Book } from '@/types/book';

// Which web novels are known to have chapters the book does not. Filled only by the
// manual "Check for updates" button and by the Update Novel dialog; per device, kept in
// localStorage like the TTS download queue. An entry exists only for a confirmed update,
// so the library dot is exactly `hasUpdate`.

const STORAGE_KEY = 'readest-novel-updates';

/** A book's identity across updates: the file hash changes with every update, `metaHash` does not. */
export const novelUpdateKey = (book: Pick<Book, 'hash' | 'metaHash'>): string =>
  book.metaHash || book.hash;

export interface NovelUpdateEntry {
  /** New chapters at the source; null when not known (URL-template books are probed). */
  newCount: number | null;
  checkedAt: number;
}

export interface NovelCheckSummary {
  finishedAt: number;
  cancelled: boolean;
  checked: number;
  withUpdates: number;
  failed: number;
}

interface NovelUpdateState {
  updates: Record<string, NovelUpdateEntry>;
  /** A check is running. */
  checking: boolean;
  progress: { done: number; total: number };
  lastCheck: NovelCheckSummary | null;
  /** Keys being checked or updated right now: a book is never queried twice at once. */
  busy: Record<string, true>;

  markAvailable: (key: string, newCount: number | null) => void;
  clear: (key: string) => void;
  /** Drop entries for books that are no longer in the library. */
  prune: (keepKeys: Set<string>) => void;
  /** Returns false when the key is already busy. */
  acquire: (key: string) => boolean;
  release: (key: string) => void;
  startCheck: (total: number) => boolean;
  setProgress: (done: number) => void;
  finishCheck: (summary: NovelCheckSummary) => void;
  restore: () => void;
}

const readStored = (): Record<string, NovelUpdateEntry> => {
  try {
    if (typeof localStorage === 'undefined') return {};
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as {
      updates?: Record<string, NovelUpdateEntry>;
    } | null;
    const out: Record<string, NovelUpdateEntry> = {};
    for (const [key, entry] of Object.entries(data?.updates ?? {})) {
      if (entry && typeof entry.checkedAt === 'number') {
        out[key] = {
          newCount: typeof entry.newCount === 'number' ? entry.newCount : null,
          checkedAt: entry.checkedAt,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
};

const persist = (updates: Record<string, NovelUpdateEntry>) => {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, updates }));
  } catch (err) {
    console.error('Failed to persist novel update state', err);
  }
};

export const useNovelUpdateStore = create<NovelUpdateState>((set, get) => ({
  updates: {},
  checking: false,
  progress: { done: 0, total: 0 },
  lastCheck: null,
  busy: {},

  markAvailable: (key, newCount) => {
    const updates = { ...get().updates, [key]: { newCount, checkedAt: Date.now() } };
    persist(updates);
    set({ updates });
  },
  clear: (key) => {
    if (!(key in get().updates)) return;
    const { [key]: _removed, ...updates } = get().updates;
    persist(updates);
    set({ updates });
  },
  prune: (keepKeys) => {
    const current = get().updates;
    const updates = Object.fromEntries(Object.entries(current).filter(([k]) => keepKeys.has(k)));
    if (Object.keys(updates).length === Object.keys(current).length) return;
    persist(updates);
    set({ updates });
  },
  acquire: (key) => {
    if (get().busy[key]) return false;
    set({ busy: { ...get().busy, [key]: true } });
    return true;
  },
  release: (key) => {
    const { [key]: _released, ...busy } = get().busy;
    set({ busy });
  },
  startCheck: (total) => {
    if (get().checking) return false;
    set({ checking: true, progress: { done: 0, total } });
    return true;
  },
  setProgress: (done) => set({ progress: { done, total: get().progress.total } }),
  finishCheck: (summary) => set({ checking: false, lastCheck: summary }),
  restore: () => set({ updates: readStored() }),
}));
