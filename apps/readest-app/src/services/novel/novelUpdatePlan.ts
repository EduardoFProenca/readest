import type { NovelChapterLink } from './chapterList';
import type { NovelSource } from './novelSource';

export interface NovelUpdatePlan {
  /**
   * - `new_chapters`: there are chapters to append.
   * - `up_to_date`: nothing to append.
   * - `source_mismatch`: the source no longer lines up with the stored book
   *   (changed site, reordered list); nothing is safe to append.
   */
  status: 'up_to_date' | 'new_chapters' | 'source_mismatch';
  /** Chapters after the last stored one, in source order. The only ones to append. */
  newChapters: NovelChapterLink[];
  /** Not stored, but positioned before the last stored chapter. Reported, never inserted. */
  skipped: NovelChapterLink[];
  /** Stored chapters whose title changed at the source. Reported, never applied. */
  retitled: { url: string; storedTitle: string; freshTitle: string }[];
  /** Stored chapters no longer listed at the source. Kept in the book. */
  missingFromSource: NovelChapterLink[];
  /** Distinct chapters currently listed at the source. */
  totalFound: number;
}

/** Identity of a chapter: its URL, ignoring the fragment and trailing slashes. */
const urlKey = (url: string): string => {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.href;
  } catch {
    return url;
  }
};

const sameTitle = (a: string, b: string) =>
  a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

/**
 * Compare the chapters stored in a book with the chapters currently listed at
 * its source. Append-only: only chapters after the last stored one are
 * returned for download, so every existing chapter keeps its position (and
 * with it every reading position and annotation). Chapters are matched by
 * URL, never by title.
 */
export function planNovelUpdate(source: NovelSource, fresh: NovelChapterLink[]): NovelUpdatePlan {
  const seen = new Set<string>();
  const listed: { link: NovelChapterLink; key: string }[] = [];
  for (const link of fresh) {
    const key = urlKey(link.url);
    if (seen.has(key)) continue;
    seen.add(key);
    listed.push({ link, key });
  }
  const mismatch: NovelUpdatePlan = {
    status: 'source_mismatch',
    newChapters: [],
    skipped: [],
    retitled: [],
    missingFromSource: [],
    totalFound: listed.length,
  };
  if (source.chapters.length === 0 || listed.length === 0) return mismatch;

  const freshIndex = new Map(listed.map((entry, index) => [entry.key, index]));
  const storedKeys = new Set<string>();
  const retitled: NovelUpdatePlan['retitled'] = [];
  const missingFromSource: NovelChapterLink[] = [];
  let lastIndex = -1;
  let found = 0;
  for (const stored of source.chapters) {
    const key = urlKey(stored.url);
    if (storedKeys.has(key)) continue;
    storedKeys.add(key);
    const index = freshIndex.get(key);
    if (index === undefined) {
      missingFromSource.push(stored);
      continue;
    }
    // Stored chapters must keep their relative order, or positions can't be trusted.
    if (index < lastIndex) return mismatch;
    lastIndex = index;
    found++;
    const freshTitle = listed[index]!.link.title;
    if (!sameTitle(stored.title, freshTitle)) {
      retitled.push({ url: stored.url, storedTitle: stored.title, freshTitle });
    }
  }
  if (found === 0) return mismatch;

  const newChapters: NovelChapterLink[] = [];
  const skipped: NovelChapterLink[] = [];
  listed.forEach(({ link, key }, index) => {
    if (storedKeys.has(key)) return;
    (index > lastIndex ? newChapters : skipped).push(link);
  });
  return {
    status: newChapters.length > 0 ? 'new_chapters' : 'up_to_date',
    newChapters,
    skipped,
    retitled,
    missingFromSource,
    totalFound: listed.length,
  };
}
