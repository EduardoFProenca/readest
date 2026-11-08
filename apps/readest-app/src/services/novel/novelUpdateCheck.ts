import { readNovelEpub } from './novelEpub';
import { downloadNewChapters, fetchNovelToc } from './novelImport';
import type { NovelDownloadOptions } from './novelImport';
import { planNovelUpdate } from './novelUpdatePlan';
import { buildChapterLinksFromTemplate, chapterNumberFromUrl } from './urlTemplate';

export type NovelCheckOptions = Pick<NovelDownloadOptions, 'fetchPage' | 'renderPage' | 'signal'>;

export type NovelCheckResult =
  /** The source has chapters the book does not. `newCount` is null when it is not known
   *  (template books are probed one chapter ahead, not listed). */
  | { outcome: 'available'; newCount: number | null }
  | { outcome: 'up_to_date' }
  /** The source lists a new chapter, but its page cannot be read yet (not published, empty,
   *  or behind a sign-in): nothing the update could add, so no indicator. */
  | { outcome: 'not_ready'; newCount: number }
  /** The source no longer lines up with the stored chapters: nothing can be appended safely. */
  | { outcome: 'source_mismatch' }
  /** Not a web novel, or no usable source record: never queried. */
  | { outcome: 'unsupported'; reason: 'not_a_novel' | 'no_source' };

/**
 * Look for new chapters without downloading or changing anything: a TOC book
 * compares the source's chapter list with the stored one; a `!@!` template book
 * asks for the one chapter after the last stored one. Network failures throw (a
 * failed check is never reported as "up to date"); cancelling throws `AbortError`.
 */
export async function checkNovelForUpdates(
  book: Blob,
  options: NovelCheckOptions = {},
): Promise<NovelCheckResult> {
  let contents;
  try {
    contents = await readNovelEpub(book);
  } catch {
    return { outcome: 'unsupported', reason: 'not_a_novel' };
  }
  const { source } = contents;
  if (!source) return { outcome: 'unsupported', reason: 'no_source' };

  if (source.kind === 'template') {
    const numbers = source.chapters.map((c) => chapterNumberFromUrl(source.sourceUrl, c.url));
    const last = numbers[numbers.length - 1];
    const inOrder = numbers.every((n, i) => n !== null && (i === 0 || n > numbers[i - 1]!));
    if (!source.chapters.length || !inOrder || last == null) return { outcome: 'source_mismatch' };
    const probe = buildChapterLinksFromTemplate(source.sourceUrl, last + 1, last + 1);
    const result = await downloadNewChapters(probe, {
      fetchPage: options.fetchPage,
      renderPage: options.renderPage,
      renderChapters: source.renderChapters,
      skipRenderOnMissing: true,
      signal: options.signal,
    });
    if (result.chapters.length > 0) return { outcome: 'available', newCount: null };
    // Only a chapter that really does not exist means "no more"; a network error or
    // block says nothing about the source, so it must not clear or hide an indicator.
    if (result.failureKinds[0] === 'error') {
      throw new Error('Could not reach the source to check for new chapters.');
    }
    return { outcome: 'up_to_date' };
  }

  const toc = await fetchNovelToc(source.sourceUrl, {
    fetchPage: options.fetchPage,
    signal: options.signal,
    backfillMetadata: false,
  });
  const plan = planNovelUpdate(source, toc.chapters);
  if (plan.status === 'source_mismatch') return { outcome: 'source_mismatch' };
  if (plan.status === 'up_to_date' || plan.newChapters.length === 0)
    return { outcome: 'up_to_date' };

  // A chapter in the list is not yet a chapter the update can add. Read the first new one
  // the way the update would; the book is not touched and nothing is kept.
  const probe = await downloadNewChapters(plan.newChapters.slice(0, 1), {
    fetchPage: options.fetchPage,
    renderPage: options.renderPage,
    renderChapters: source.renderChapters,
    signal: options.signal,
  });
  if (probe.chapters.length > 0) return { outcome: 'available', newCount: plan.newChapters.length };
  if (probe.failureKinds[0] === 'error') {
    throw new Error('Could not reach the source to check for new chapters.');
  }
  return { outcome: 'not_ready', newCount: plan.newChapters.length };
}
