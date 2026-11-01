import { ConversionError } from '@/services/send/conversion/types';
import { stubTranslation as _ } from '@/utils/misc';
import { MAX_NOVEL_CHAPTERS } from './novelImport';
import { assertNovelUrlAllowed } from './renderNovelPage';
import type { NovelChapterLink } from './chapterList';

/** Stands for the chapter number in a user-supplied chapter URL template. */
export const CHAPTER_PLACEHOLDER = '!@!';

export const hasChapterPlaceholder = (template: string): boolean =>
  template.includes(CHAPTER_PLACEHOLDER);

const fail = (message: string): never => {
  throw new ConversionError(message, 'parse_failed');
};

/**
 * Expand a URL template such as `https://site/novel/c.!@!` over an inclusive
 * chapter range. Chapters stay in numeric order; the result feeds the same
 * download pipeline as a parsed table of contents.
 */
export function buildChapterLinksFromTemplate(
  template: string,
  start: number,
  end: number,
): NovelChapterLink[] {
  if (!hasChapterPlaceholder(template)) {
    fail(_('The URL must contain !@! where the chapter number goes.'));
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    fail(_('Enter a valid chapter range.'));
  }
  if (end - start + 1 > MAX_NOVEL_CHAPTERS) {
    fail(
      _('A single import is limited to {{count}} chapters.').replace(
        '{{count}}',
        `${MAX_NOVEL_CHAPTERS}`,
      ),
    );
  }
  const urlFor = (n: number) => template.split(CHAPTER_PLACEHOLDER).join(`${n}`);
  try {
    const first = new URL(urlFor(start));
    if (!/^https?:$/.test(first.protocol)) throw new Error('protocol');
    assertNovelUrlAllowed(first.href);
  } catch {
    fail(_('Enter a valid http:// or https:// URL.'));
  }
  return Array.from({ length: end - start + 1 }, (_unused, i) => {
    const n = start + i;
    return { title: `Chapter ${n}`, url: urlFor(n) };
  });
}
