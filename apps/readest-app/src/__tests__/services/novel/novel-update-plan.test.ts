import { describe, expect, test } from 'vitest';
import type { NovelChapterLink } from '@/services/novel/chapterList';
import { buildChapterLinksFromTemplate } from '@/services/novel/urlTemplate';
import {
  NOVEL_SOURCE_FILENAME,
  NovelSource,
  parseNovelSource,
  serializeNovelSource,
} from '@/services/novel/novelSource';
import { planNovelUpdate } from '@/services/novel/novelUpdatePlan';

const link = (n: number, title = `Chapter ${n}`): NovelChapterLink => ({
  title,
  url: `https://novel.example.com/book/chapter-${n}`,
});
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => link(from + i));

const tocSource = (chapters: NovelChapterLink[]): NovelSource => ({
  version: 1,
  kind: 'toc',
  sourceUrl: 'https://novel.example.com/book',
  chapters,
});

describe('planNovelUpdate', () => {
  test('reports up to date when nothing is new', () => {
    const plan = planNovelUpdate(tocSource(range(1, 5)), range(1, 5));
    expect(plan.status).toBe('up_to_date');
    expect(plan.newChapters).toEqual([]);
    expect(plan.totalFound).toBe(5);
  });

  test('finds only the chapters after the last stored one, in source order', () => {
    const plan = planNovelUpdate(tocSource(range(1, 5)), range(1, 8));
    expect(plan.status).toBe('new_chapters');
    expect(plan.newChapters.map((c) => c.url)).toEqual(range(6, 8).map((c) => c.url));
    expect(plan.totalFound).toBe(8);
  });

  test('does not confuse similar numbering (chapter-1 vs chapter-10 vs chapter-100)', () => {
    const stored = [link(1), link(10), link(100)];
    const plan = planNovelUpdate(tocSource(stored), [...stored, link(11), link(101)]);
    expect(plan.newChapters.map((c) => c.url)).toEqual([link(11).url, link(101).url]);
  });

  test('never uses the title as the identity: same title, different URL is new', () => {
    const stored = [link(1, 'Prologue'), link(2, 'Interlude')];
    const fresh = [...stored, link(3, 'Interlude')];
    const plan = planNovelUpdate(tocSource(stored), fresh);
    expect(plan.newChapters).toEqual([link(3, 'Interlude')]);
  });

  test('a stored chapter with a new title is not new and is reported, not applied', () => {
    const stored = range(1, 3);
    const fresh = [link(1), link(2, 'Chapter 2 (revised)'), link(3), link(4)];
    const plan = planNovelUpdate(tocSource(stored), fresh);
    expect(plan.newChapters.map((c) => c.url)).toEqual([link(4).url]);
    expect(plan.retitled).toEqual([
      { url: link(2).url, storedTitle: 'Chapter 2', freshTitle: 'Chapter 2 (revised)' },
    ]);
  });

  test('ignores duplicate links in the fresh list', () => {
    const plan = planNovelUpdate(tocSource(range(1, 2)), [...range(1, 2), link(3), link(3)]);
    expect(plan.newChapters).toEqual([link(3)]);
  });

  test('treats a fragment or trailing slash as the same URL', () => {
    const stored = [{ title: 'Chapter 1', url: 'https://novel.example.com/book/chapter-1' }];
    const fresh = [
      { title: 'Chapter 1', url: 'https://novel.example.com/book/chapter-1/#top' },
      link(2),
    ];
    const plan = planNovelUpdate(tocSource(stored), fresh);
    expect(plan.newChapters).toEqual([link(2)]);
  });

  test('chapters that would land before the last stored chapter are skipped, not inserted', () => {
    const stored = [link(1), link(3)];
    const fresh = [link(1), link(2), link(3), link(4)];
    const plan = planNovelUpdate(tocSource(stored), fresh);
    expect(plan.newChapters).toEqual([link(4)]);
    expect(plan.skipped).toEqual([link(2)]);
  });

  test('stored chapters that disappeared from the source are tolerated and reported', () => {
    const plan = planNovelUpdate(tocSource(range(1, 4)), [link(1), link(2), link(4), link(5)]);
    expect(plan.status).toBe('new_chapters');
    expect(plan.missingFromSource).toEqual([link(3)]);
    expect(plan.newChapters).toEqual([link(5)]);
  });

  test('refuses when none of the stored chapters appear in the source', () => {
    const other = [1, 2, 3].map((n) => ({ title: `C${n}`, url: `https://other.example.com/${n}` }));
    const plan = planNovelUpdate(tocSource(range(1, 3)), other);
    expect(plan.status).toBe('source_mismatch');
    expect(plan.newChapters).toEqual([]);
  });

  test('refuses when the stored chapters appear in a different order', () => {
    const plan = planNovelUpdate(tocSource(range(1, 3)), [link(3), link(2), link(1), link(4)]);
    expect(plan.status).toBe('source_mismatch');
    expect(plan.newChapters).toEqual([]);
  });

  test('refuses an empty stored list or an empty source', () => {
    expect(planNovelUpdate(tocSource([]), range(1, 3)).status).toBe('source_mismatch');
    expect(planNovelUpdate(tocSource(range(1, 3)), []).status).toBe('source_mismatch');
  });

  test('does not mutate its inputs', () => {
    const source = tocSource(range(1, 3));
    const fresh = range(1, 5);
    const before = JSON.stringify([source, fresh]);
    planNovelUpdate(source, fresh);
    expect(JSON.stringify([source, fresh])).toBe(before);
  });

  test('works for a book imported with a !@! template (item 6): 1-100 stored, 1-120 found', () => {
    const template = 'https://novel.example.com/naruto/chapter-!@!';
    const source: NovelSource = {
      version: 1,
      kind: 'template',
      sourceUrl: template,
      chapters: buildChapterLinksFromTemplate(template, 1, 100),
    };
    const plan = planNovelUpdate(source, buildChapterLinksFromTemplate(template, 1, 120));
    expect(plan.status).toBe('new_chapters');
    expect(plan.newChapters).toHaveLength(20);
    expect(plan.newChapters[0]!.url).toBe('https://novel.example.com/naruto/chapter-101');
    expect(plan.newChapters[19]!.url).toBe('https://novel.example.com/naruto/chapter-120');
  });

  test('handles thousands of chapters', () => {
    const plan = planNovelUpdate(tocSource(range(1, 5000)), range(1, 5010));
    expect(plan.newChapters).toHaveLength(10);
  });
});

describe('novel source record', () => {
  test('round-trips through JSON', () => {
    const source: NovelSource = { ...tocSource(range(1, 3)), renderChapters: true };
    expect(parseNovelSource(serializeNovelSource(source))).toEqual(source);
  });

  test('is stored under a fixed file name', () => {
    expect(NOVEL_SOURCE_FILENAME).toBe('readest-novel.json');
  });

  test.each([
    ['not json', '{'],
    ['wrong version', JSON.stringify({ ...tocSource(range(1, 2)), version: 2 })],
    ['unknown kind', JSON.stringify({ ...tocSource(range(1, 2)), kind: 'rss' })],
    ['non-http source', JSON.stringify({ ...tocSource(range(1, 2)), sourceUrl: 'file:///x' })],
    ['bad chapter', JSON.stringify({ ...tocSource([]), chapters: [{ title: 1, url: 'x' }] })],
    ['non-http chapter', JSON.stringify(tocSource([{ title: 'a', url: 'javascript:alert(1)' }]))],
    ['null', 'null'],
  ])('rejects %s', (_name, raw) => {
    expect(parseNovelSource(raw)).toBeNull();
  });

  test('a template source may carry the !@! marker in its source URL', () => {
    const source: NovelSource = {
      version: 1,
      kind: 'template',
      sourceUrl: 'https://novel.example.com/naruto/chapter-!@!',
      chapters: [link(1)],
    };
    expect(parseNovelSource(serializeNovelSource(source))).toEqual(source);
  });
});
