import { describe, test, expect } from 'vitest';
import {
  CHAPTER_PLACEHOLDER,
  buildChapterLinksFromTemplate,
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
