import type { NovelChapterLink } from './chapterList';

/** Entry inside a novel EPUB that records where the book came from. */
export const NOVEL_SOURCE_FILENAME = 'readest-novel.json';

/**
 * Where a web novel was imported from, stored inside its EPUB so it travels
 * with the file and survives re-keying and sync.
 *
 * - `toc`: `sourceUrl` is the table-of-contents page; chapters were detected from it.
 * - `template`: `sourceUrl` is a URL template containing `!@!` (item 6).
 *
 * `chapters` lists every chapter stored in the book, in book order.
 */
export interface NovelSource {
  version: 1;
  kind: 'toc' | 'template';
  sourceUrl: string;
  /** Chapters were rendered in a browser session (sign-in imports). */
  renderChapters?: boolean;
  chapters: NovelChapterLink[];
}

export const serializeNovelSource = (source: NovelSource): string => JSON.stringify(source);

const isHttpUrl = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
};

/** Parse and validate a stored record; returns null for anything unexpected. */
export function parseNovelSource(raw: string): NovelSource | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const value = data as Record<string, unknown>;
  if (value['version'] !== 1) return null;
  if (value['kind'] !== 'toc' && value['kind'] !== 'template') return null;
  if (!isHttpUrl(value['sourceUrl'])) return null;
  const chapters = value['chapters'];
  if (!Array.isArray(chapters)) return null;
  for (const chapter of chapters) {
    if (!chapter || typeof chapter !== 'object') return null;
    const { title, url } = chapter as Record<string, unknown>;
    if (typeof title !== 'string' || !isHttpUrl(url)) return null;
  }
  return {
    version: 1,
    kind: value['kind'],
    sourceUrl: value['sourceUrl'],
    ...(value['renderChapters'] === true ? { renderChapters: true } : {}),
    chapters: (chapters as NovelChapterLink[]).map(({ title, url }) => ({ title, url })),
  };
}
