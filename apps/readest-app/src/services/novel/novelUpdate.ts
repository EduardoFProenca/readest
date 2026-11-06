import type { EpubImage } from '@/services/send/conversion/types';
import type { NovelChapterLink } from './chapterList';
import { appendChaptersToNovelEpub, NovelEpubError, readNovelEpub } from './novelEpub';
import { downloadNewChapters, fetchNovelToc } from './novelImport';
import type { NovelDownloadOptions } from './novelImport';
import { planNovelUpdate } from './novelUpdatePlan';
import type { NovelUpdatePlan } from './novelUpdatePlan';

export type NovelUpdateStage = 'checking' | 'downloading';

export interface NovelUpdateOptions
  extends Pick<NovelDownloadOptions, 'fetchPage' | 'renderPage' | 'translate' | 'signal'> {
  onStage?: (stage: NovelUpdateStage) => void;
  /** Progress of the new chapters being downloaded. */
  onProgress?: (done: number, total: number) => void;
}

/** Details of what was found at the source, never applied to stored chapters. */
interface UpdateReport {
  retitled: NovelUpdatePlan['retitled'];
  skipped: NovelChapterLink[];
  missingFromSource: NovelChapterLink[];
}

export type NovelUpdateResult =
  /** The book can't be updated: no source record, a template source, or not a web novel. */
  | { outcome: 'unsupported'; reason: 'not_a_novel' | 'no_source' | 'template_source' }
  | { outcome: 'up_to_date'; totalFound: number }
  /** The source no longer lines up with the stored chapters; nothing was changed. */
  | { outcome: 'source_mismatch' }
  /** New chapters exist but none could be downloaded; nothing was changed. */
  | { outcome: 'nothing_added'; failed: NovelChapterLink[]; deferred: NovelChapterLink[] }
  | ({
      outcome: 'updated';
      /** The updated EPUB. The input is never modified. */
      blob: Blob;
      addedCount: number;
      chapterCount: number;
      /** New chapters that failed. Not in the book; retried on the next update. */
      failed: NovelChapterLink[];
      /** Downloaded, but after a failed chapter, so also left for the next update. */
      deferred: NovelChapterLink[];
    } & UpdateReport);

/**
 * Check a downloaded novel against its source and append any new chapters.
 * Append-only and all-or-nothing: the result is a new EPUB that keeps every
 * stored chapter byte-for-byte (so reading positions and annotations stay
 * valid), or nothing at all. Network failures reading the chapter list throw;
 * cancelling throws `AbortError`.
 */
export async function updateNovel(
  book: Blob,
  options: NovelUpdateOptions = {},
): Promise<NovelUpdateResult> {
  const { signal } = options;
  let contents;
  try {
    contents = await readNovelEpub(book);
  } catch {
    return { outcome: 'unsupported', reason: 'not_a_novel' };
  }
  const { source } = contents;
  if (!source) return { outcome: 'unsupported', reason: 'no_source' };
  // Template books need to probe past the last stored chapter; not supported yet.
  if (source.kind === 'template') return { outcome: 'unsupported', reason: 'template_source' };

  options.onStage?.('checking');
  const toc = await fetchNovelToc(source.sourceUrl, {
    fetchPage: options.fetchPage,
    signal,
    backfillMetadata: false,
  });
  const plan = planNovelUpdate(source, toc.chapters);
  if (plan.status === 'source_mismatch') return { outcome: 'source_mismatch' };
  if (plan.status === 'up_to_date') return { outcome: 'up_to_date', totalFound: plan.totalFound };

  options.onStage?.('downloading');
  const downloaded = await downloadNewChapters(plan.newChapters, {
    fetchPage: options.fetchPage,
    renderPage: options.renderPage,
    renderChapters: source.renderChapters,
    translate: options.translate,
    onProgress: options.onProgress,
    signal,
  });
  if (downloaded.chapters.length === 0) {
    return { outcome: 'nothing_added', failed: downloaded.failed, deferred: downloaded.deferred };
  }

  try {
    const appended = await appendChaptersToNovelEpub(book, {
      chapters: downloaded.chapters,
      links: downloaded.links,
      images: downloaded.images as EpubImage[],
    });
    return {
      outcome: 'updated',
      blob: appended.blob,
      addedCount: appended.addedCount,
      chapterCount: appended.chapterCount,
      failed: downloaded.failed,
      deferred: downloaded.deferred,
      retitled: plan.retitled,
      skipped: plan.skipped,
      missingFromSource: plan.missingFromSource,
    };
  } catch (err) {
    // A book whose own record is inconsistent can't be updated safely.
    if (err instanceof NovelEpubError && err.code === 'inconsistent_source') {
      return { outcome: 'source_mismatch' };
    }
    throw err;
  }
}
