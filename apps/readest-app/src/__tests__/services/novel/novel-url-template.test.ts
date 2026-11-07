import { describe, test, expect } from 'vitest';
import {
  CHAPTER_PLACEHOLDER,
  buildChapterLinksFromTemplate,
  chapterNumberFromUrl,
  hasChapterPlaceholder,
} from '@/services/novel/urlTemplate';
import { MAX_NOVEL_CHAPTERS } from '@/services/novel/novelImport';

describe('hasChapterPlaceholder', () => {
  test('detects the marker', () => {
    expect(CHAPTER_PLACEHOLDER).toBe('!@!');
    expect(hasChapterPlaceholder('https://novel.example.com/naruto/c.!@!')).toBe(true);
    expect(hasChapterPlaceholder('https://novel/naruto')).toBe(false);
  });
});

describe('buildChapterLinksFromTemplate', () => {
  test('expands an inclusive range in order', () => {
    const links = buildChapterLinksFromTemplate('https://novel.example.com/naruto/c.!@!', 1, 10);
    expect(links).toHaveLength(10);
    expect(links[0]).toEqual({ title: 'Chapter 1', url: 'https://novel.example.com/naruto/c.1' });
    expect(links[9]!.url).toBe('https://novel.example.com/naruto/c.10');
    expect(links.map((l) => l.url)).toEqual(
      Array.from({ length: 10 }, (_, i) => `https://novel.example.com/naruto/c.${i + 1}`),
    );
  });

  test('keeps numeric order rather than sorting as text', () => {
    const urls = buildChapterLinksFromTemplate('https://x.test/!@!', 9, 11).map((l) => l.url);
    expect(urls).toEqual(['https://x.test/9', 'https://x.test/10', 'https://x.test/11']);
  });

  test('replaces every marker occurrence', () => {
    const [link] = buildChapterLinksFromTemplate('https://x.test/b-!@!/ch-!@!', 5, 5);
    expect(link!.url).toBe('https://x.test/b-5/ch-5');
  });

  test('a single chapter range is allowed', () => {
    expect(buildChapterLinksFromTemplate('https://x.test/!@!', 3, 3)).toHaveLength(1);
  });

  test('rejects a template with no marker', () => {
    expect(() => buildChapterLinksFromTemplate('https://x.test/c', 1, 3)).toThrow(/!@!/);
  });

  test('rejects non-http(s) and malformed URLs', () => {
    expect(() => buildChapterLinksFromTemplate('ftp://x.test/!@!', 1, 3)).toThrow();
    expect(() => buildChapterLinksFromTemplate('javascript:!@!', 1, 3)).toThrow();
    expect(() => buildChapterLinksFromTemplate('not a url !@!', 1, 3)).toThrow();
  });

  test('rejects private hosts like the rest of the importer', () => {
    expect(() => buildChapterLinksFromTemplate('http://127.0.0.1/c/!@!', 1, 3)).toThrow();
  });

  test('rejects single-label hosts such as https://novel/c.!@!', () => {
    expect(() => buildChapterLinksFromTemplate('https://novel/naruto/c.!@!', 1, 3)).toThrow();
  });

  test('rejects invalid ranges', () => {
    const t = 'https://x.test/!@!';
    expect(() => buildChapterLinksFromTemplate(t, 5, 4)).toThrow();
    expect(() => buildChapterLinksFromTemplate(t, 1.5, 4)).toThrow();
    expect(() => buildChapterLinksFromTemplate(t, Number.NaN, 4)).toThrow();
    expect(() => buildChapterLinksFromTemplate(t, -1, 4)).toThrow();
  });

  test('rejects ranges larger than the importer cap', () => {
    const t = 'https://x.test/!@!';
    expect(buildChapterLinksFromTemplate(t, 1, MAX_NOVEL_CHAPTERS)).toHaveLength(
      MAX_NOVEL_CHAPTERS,
    );
    expect(() => buildChapterLinksFromTemplate(t, 1, MAX_NOVEL_CHAPTERS + 1)).toThrow();
  });
});

describe('chapterNumberFromUrl', () => {
  const template = 'https://novel.example.com/naruto/c.!@!';

  test('reads the number a template put into a URL', () => {
    expect(chapterNumberFromUrl(template, 'https://novel.example.com/naruto/c.1')).toBe(1);
    expect(chapterNumberFromUrl(template, 'https://novel.example.com/naruto/c.250')).toBe(250);
  });

  test('works with text after the marker and with a marker used twice', () => {
    expect(
      chapterNumberFromUrl('https://x.example.com/c.!@!.html', 'https://x.example.com/c.12.html'),
    ).toBe(12);
    const twice = 'https://x.example.com/novel-!@!/chapter-!@!';
    expect(chapterNumberFromUrl(twice, 'https://x.example.com/novel-7/chapter-7')).toBe(7);
    expect(chapterNumberFromUrl(twice, 'https://x.example.com/novel-7/chapter-8')).toBeNull();
  });

  test('is round-trip safe with buildChapterLinksFromTemplate', () => {
    for (const link of buildChapterLinksFromTemplate(template, 0, 25)) {
      expect(chapterNumberFromUrl(template, link.url)).toBe(Number(link.title.slice(8)));
    }
  });

  test.each([
    ['a different site', 'https://other.example.com/naruto/c.3'],
    ['a different path', 'https://novel.example.com/bleach/c.3'],
    ['no number', 'https://novel.example.com/naruto/c.'],
    ['a non-numeric chapter', 'https://novel.example.com/naruto/c.final'],
    ['trailing text', 'https://novel.example.com/naruto/c.3/extra'],
    ['a negative number', 'https://novel.example.com/naruto/c.-3'],
    ['not a URL', 'garbage'],
  ])('returns null for %s', (_name, url) => {
    expect(chapterNumberFromUrl(template, url)).toBeNull();
  });

  test('returns null for a template without the marker', () => {
    expect(
      chapterNumberFromUrl('https://novel.example.com/naruto', 'https://novel.example.com/naruto'),
    ).toBeNull();
  });

  test('does not treat regex characters in the template as patterns', () => {
    expect(
      chapterNumberFromUrl(
        'https://x.example.com/a+b.c?id=!@!',
        'https://x.example.com/a+b.c?id=5',
      ),
    ).toBe(5);
    expect(
      chapterNumberFromUrl(
        'https://x.example.com/a+b.c?id=!@!',
        'https://x.example.com/aab.c?id=5',
      ),
    ).toBeNull();
  });
});
