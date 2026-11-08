import type { EpubChapter, EpubImage } from '@/services/send/conversion/types';
import type { NovelChapterLink } from './chapterList';
import { appendChaptersToNovelEpub, NovelEpubError, readNovelEpub } from './novelEpub';
import { downloadNewChapters, fetchNovelToc } from './novelImport';
import type { ChapterFailureKind } from './novelImport';
import type { NovelDownloadOptions } from './novelImport';
import type { NovelSource } from './novelSource';
import { planNovelUpdate } from './novelUpdatePlan';
import type { NovelUpdatePlan } from './novelUpdatePlan';
import { buildChapterLinksFromTemplate, chapterNumberFromUrl } from './urlTemplate';

/** Chapters probed and downloaded in one go for a template book. */
export const TEMPLATE_UPDATE_BATCH = 8;
/** Most chapters one update adds to a template book; run it again for more. */
export const DEFAULT_MAX_NEW_CHAPTERS = 200;

export type NovelUpdateStage = 'checking' | 'downloading';

export interface NovelUpdateOptions
  extends Pick<NovelDownloadOptions, 'fetchPage' | 'renderPage' | 'translate' | 'signal'> {
  onStage?: (stage: NovelUpdateStage) => void;
  /** Progress of the new chapters being downloaded. `total` is 0 when it is not known
   *  in advance (template books are probed until a chapter does not exist). */
  onProgress?: (done: number, total: number) => void;
  /** The chapter that just started downloading, for "Downloading: <title>". */
  onChapterStart?: (chapter: NovelChapterLink) => void;
  /** Most chapters to add to a template book in one update. */
  maxNewChapters?: number;
}

/** Details of what was found at the source, never applied to stored chapters. */
interface UpdateReport {
  retitled: NovelUpdatePlan['retitled'];
  skipped: NovelChapterLink[];
  missingFromSource: NovelChapterLink[];
}

export type NovelUpdateResult =
  /** The book can't be updated: no source record, a template source, or not a web novel. */
  | { outcome: 'unsupported'; reason: 'not_a_novel' | 'no_source' }
  | { outcome: 'up_to_date'; totalFound: number }
  /** The source no longer lines up with the stored chapters; nothing was changed. */
  | { outcome: 'source_mismatch' }
  /** New chapters exist but none could be downloaded; nothing was changed. */
  | {
      outcome: 'nothing_added';
      failed: NovelChapterLink[];
      deferred: NovelChapterLink[];
      /** Why each chapter in `failed` failed, in the same order. */
      failureKinds: ChapterFailureKind[];
    }
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
      /** A template book stopped at the per-update limit; there may be more chapters. */
      limitReached?: boolean;
    } & UpdateReport);

const emptyReport: UpdateReport = { retitled: [], skipped: [], missingFromSource: [] };

/**
 * A book imported from a `!@!` URL template has no chapter list to compare
 * with, so the next chapters are probed: batch after batch, starting at the
 * number after the last stored one, until a chapter does not exist. Only a
 * chapter that is really missing (HTTP 404/410, or a page with no text) ends
 * the book; a network error or block stops the update without claiming that.
 * A chapter missing in the middle of a site's numbering ends the probe there,
 * and the next update starts at the same place, so nothing is ever skipped.
 */
async function updateFromTemplate(
  book: Blob,
  source: NovelSource,
  options: NovelUpdateOptions,
): Promise<NovelUpdateResult> {
  const numbers = source.chapters.map((chapter) =>
    chapterNumberFromUrl(source.sourceUrl, chapter.url),
  );
  const last = numbers[numbers.length - 1];
  const inOrder = numbers.every((n, i) => n !== null && (i === 0 || n > numbers[i - 1]!));
  if (!source.chapters.length || !inOrder || last == null) return { outcome: 'source_mismatch' };

  const limit = Math.max(1, options.maxNewChapters ?? DEFAULT_MAX_NEW_CHAPTERS);
  options.onStage?.('downloading');
  const chapters: EpubChapter[] = [];
  const links: NovelChapterLink[] = [];
  const images = new Map<string, EpubImage>();
  let failed: NovelChapterLink[] = [];
  let reachedEnd = false;
  let next = last + 1;
  while (links.length < limit && !reachedEnd && failed.length === 0) {
    const size = Math.min(TEMPLATE_UPDATE_BATCH, limit - links.length);
    const batch = buildChapterLinksFromTemplate(source.sourceUrl, next, next + size - 1);
    const downloaded = await downloadNewChapters(batch, {
      fetchPage: options.fetchPage,
      renderPage: options.renderPage,
      renderChapters: source.renderChapters,
      skipRenderOnMissing: true,
      translate: options.translate,
      signal: options.signal,
    });
    chapters.push(...downloaded.chapters);
    links.push(...downloaded.links);
    for (const image of downloaded.images)
      if (!images.has(image.path)) images.set(image.path, image);
    if (downloaded.failed.length > 0) {
      const kind: ChapterFailureKind | undefined = downloaded.failureKinds[0];
      if (kind === 'error') failed = downloaded.failed.slice(0, 1);
      else reachedEnd = true;
    }
    options.onProgress?.(links.length, 0);
    next += size;
  }

  if (links.length === 0) {
    return failed.length > 0
      ? { outcome: 'nothing_added', failed, deferred: [], failureKinds: ['error'] }
      : { outcome: 'up_to_date', totalFound: source.chapters.length };
  }
  const appended = await appendChaptersToNovelEpub(book, {
    chapters,
    links,
    images: [...images.values()],
  });
  return {
    outcome: 'updated',
    blob: appended.blob,
    addedCount: appended.addedCount,
    chapterCount: appended.chapterCount,
    failed,
    deferred: [],
    limitReached: links.length >= limit && !reachedEnd && failed.length === 0,
    ...emptyReport,
  };
}

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
  if (source.kind === 'template') return updateFromTemplate(book, source, options);

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
    onChapterStart: options.onChapterStart,
    signal,
  });
  if (downloaded.chapters.length === 0) {
    return {
      outcome: 'nothing_added',
      failed: downloaded.failed,
      deferred: downloaded.deferred,
      failureKinds: downloaded.failureKinds,
    };
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
