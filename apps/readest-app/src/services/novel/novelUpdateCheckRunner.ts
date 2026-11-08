import type { Book } from '@/types/book';
import { novelUpdateKey, useNovelUpdateStore } from '@/store/novelUpdateStore';
import type { NovelCheckSummary } from '@/store/novelUpdateStore';
import { isNovelImportCancelled } from './novelImport';
import { isWebNovelMetadata } from './novelSource';
import { checkNovelForUpdates } from './novelUpdateCheck';
import type { NovelCheckResult, NovelCheckOptions } from './novelUpdateCheck';

export interface NovelCheckDeps {
  loadFile: (book: Book) => Promise<Blob>;
  check?: (file: Blob, options: NovelCheckOptions) => Promise<NovelCheckResult>;
  signal?: AbortSignal;
}

/** Only books carrying the web-novel marker are ever queried. */
export const eligibleNovels = (library: Book[]): Book[] =>
  library.filter((book) => !book.deletedAt && isWebNovelMetadata(book.metadata));

/**
 * Manual "Check for updates": query every web novel one at a time and record only
 * confirmed results. A failed check (network, unreadable file) leaves that book's
 * indicator as it was; it never adds or clears one. Returns null when a check is
 * already running.
 */
export async function runNovelUpdateCheck(
  library: Book[],
  deps: NovelCheckDeps,
): Promise<NovelCheckSummary | null> {
  const store = useNovelUpdateStore.getState();
  const books = eligibleNovels(library);
  if (!store.startCheck(books.length)) return null;
  store.prune(new Set(library.filter((b) => !b.deletedAt).map(novelUpdateKey)));

  const check = deps.check ?? checkNovelForUpdates;
  const summary: NovelCheckSummary = {
    finishedAt: 0,
    cancelled: false,
    checked: 0,
    withUpdates: 0,
    failed: 0,
  };
  try {
    for (const [index, book] of books.entries()) {
      if (deps.signal?.aborted) {
        summary.cancelled = true;
        break;
      }
      const key = novelUpdateKey(book);
      // Being updated or already checked right now: skip, never query twice at once.
      if (!useNovelUpdateStore.getState().acquire(key)) continue;
      try {
        const result = await check(await deps.loadFile(book), { signal: deps.signal });
        const s = useNovelUpdateStore.getState();
        if (result.outcome === 'available') {
          s.markAvailable(key, result.newCount);
          summary.withUpdates++;
        } else {
          // up to date, mismatched or unsupported: no real update to point at.
          s.clear(key);
        }
        summary.checked++;
      } catch (err) {
        if (isNovelImportCancelled(err) || deps.signal?.aborted) {
          summary.cancelled = true;
          break;
        }
        summary.failed++;
      } finally {
        useNovelUpdateStore.getState().release(key);
        useNovelUpdateStore.getState().setProgress(index + 1);
      }
    }
  } finally {
    summary.finishedAt = Date.now();
    useNovelUpdateStore.getState().finishCheck(summary);
  }
  return summary;
}
