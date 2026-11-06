import { describe, expect, it } from 'vitest';
import { buildEpub } from '@/services/send/conversion/buildEpub';
import type { NovelChapterLink } from '@/services/novel/chapterList';
import { fetchNovelToc } from '@/services/novel/novelImport';
import {
  NOVEL_SOURCE_FILENAME,
  novelSourceMarker,
  serializeNovelSource,
} from '@/services/novel/novelSource';
import { readNovelEpub } from '@/services/novel/novelEpub';
import { updateNovel } from '@/services/novel/novelUpdate';

/**
 * A web novel's chapter list changes over time: new chapters, relative dates
 * ("2 days ago") inside the link text, newest-first ordering, a "latest
 * chapters" box repeating links, truncated lists. These run the real chapter
 * list parser against such pages and check that an update only ever appends the
 * chapters after the last stored one, and refuses when it cannot tell.
 */
const BASE = 'https://novels.example.org';
const TOC_URL = `${BASE}/novel/7/`;
const META = { title: 'My Novel', author: 'Author X', language: 'en', identifier: 'readest:abc' };

const url = (n: number) => `${BASE}/novel/7/chapter-${n}`;
const link = (n: number, title = `Chapter ${n}`): NovelChapterLink => ({ title, url: url(n) });
const range = (from: number, to: number, title?: (n: number) => string) =>
  Array.from({ length: to - from + 1 }, (_, i) => link(from + i, title?.(from + i)));

async function makeNovel(links: NovelChapterLink[]): Promise<Blob> {
  return buildEpub(
    links.map((l) => ({
      title: l.title,
      html: `<h1>${l.title}</h1><p>Stored text of ${l.title}.</p>`,
    })),
    { ...META, source: novelSourceMarker(TOC_URL) },
    [],
    undefined,
    [
      {
        path: NOVEL_SOURCE_FILENAME,
        content: serializeNovelSource({
          version: 1,
          kind: 'toc',
          sourceUrl: TOC_URL,
          chapters: links,
        }),
      },
    ],
  );
}

const page = (body: string) => `<!DOCTYPE html><html><head><title>My Novel</title>
<meta property="og:title" content="My Novel"/><meta name="author" content="Author X"/></head>
<body>${body}</body></html>`;
const list = (items: string[]) =>
  `<ul class="chapters">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
const anchor = (n: number, text = `Chapter ${n}`, href = url(n)) => `<a href="${href}">${text}</a>`;

const chapterPage = (n: number) =>
  `<!DOCTYPE html><html><head><title>Chapter ${n}</title></head><body><div id="content">${Array.from(
    { length: 10 },
    (_, i) =>
      `<p>Fresh chapter ${n} paragraph ${i} with plenty of narrative text to satisfy extraction quality floors.</p>`,
  ).join('')}</div></body></html>`;

const site = (tocHtml: string) => async (target: string) => {
  if (target === TOC_URL) return { html: page(tocHtml), finalUrl: target };
  const n = parseInt(target.match(/chapter-(\d+)/)![1]!, 10);
  return { html: chapterPage(n), finalUrl: target };
};

const titlesOf = async (blob: Blob) => (await readNovelEpub(blob)).chapters.map((c) => c.title);

describe('updating when the chapter list at the source has drifted', () => {
  it('ignores a date that sits next to the link, and appends only what is new', async () => {
    const original = await makeNovel(range(1, 5));
    const toc = list(
      range(1, 8).map((_l, i) => `${anchor(i + 1)} <span>Oct ${i + 1}, 2026</span>`),
    );
    const result = await updateNovel(original, { fetchPage: site(toc) });
    if (result.outcome !== 'updated') throw new Error(result.outcome);
    expect(result.addedCount).toBe(3);
    expect(await titlesOf(result.blob)).toEqual(range(1, 8).map((l) => l.title));
  });

  it('is not confused when a relative date inside the link text changed since the download', async () => {
    const original = await makeNovel(range(1, 5, (n) => `Chapter ${n} - 2 days ago`));
    const toc = list(range(1, 7).map((_l, i) => anchor(i + 1, `Chapter ${i + 1} - 3 weeks ago`)));
    const result = await updateNovel(original, { fetchPage: site(toc) });
    if (result.outcome !== 'updated') throw new Error(result.outcome);
    // The stored chapters keep the titles they were downloaded with...
    expect((await titlesOf(result.blob)).slice(0, 5)).toEqual(
      range(1, 5).map((l) => `${l.title} - 2 days ago`),
    );
    // ...and only chapters 6 and 7 were added.
    expect(result.addedCount).toBe(2);
    // The changed text is reported as retitled, never applied.
    expect(result.retitled).toHaveLength(5);
  });

  it('keeps chapter order when the site lists the newest chapter first', async () => {
    const original = await makeNovel(range(1, 5));
    const toc = list(
      range(1, 8)
        .reverse()
        .map((l) => anchor(Number(l.title.replace('Chapter ', '')))),
    );
    const result = await updateNovel(original, { fetchPage: site(toc) });
    if (result.outcome !== 'updated') throw new Error(result.outcome);
    expect(await titlesOf(result.blob)).toEqual(range(1, 8).map((l) => l.title));
  });

  it('ignores a "latest chapters" box that repeats links above the full list', async () => {
    const original = await makeNovel(range(1, 5));
    const latest = `<div class="latest"><a href="${url(8)}">Chapter 8</a><a href="${url(7)}">Chapter 7</a></div>`;
    const toc = latest + list(range(1, 8).map((_l, i) => anchor(i + 1)));
    const result = await updateNovel(original, { fetchPage: site(toc) });
    if (result.outcome !== 'updated') throw new Error(result.outcome);
    expect(await titlesOf(result.blob)).toEqual(range(1, 8).map((l) => l.title));
  });

  it('matches relative links on the page with the absolute URLs that were stored', async () => {
    const original = await makeNovel(range(1, 5));
    const toc = list(
      range(1, 7).map((_l, i) => anchor(i + 1, undefined, `/novel/7/chapter-${i + 1}`)),
    );
    const result = await updateNovel(original, { fetchPage: site(toc) });
    if (result.outcome !== 'updated') throw new Error(result.outcome);
    expect(result.addedCount).toBe(2);
  });

  it('works when the page now lists only the latest chapters', async () => {
    const original = await makeNovel(range(1, 20));
    const toc = list(range(16, 25).map((_l, i) => anchor(16 + i)));
    const result = await updateNovel(original, { fetchPage: site(toc) });
    if (result.outcome !== 'updated') throw new Error(result.outcome);
    expect(result.addedCount).toBe(5);
    expect(result.missingFromSource).toHaveLength(15);
    expect((await titlesOf(result.blob)).slice(0, 20)).toEqual(range(1, 20).map((l) => l.title));
  });

  it('refuses when the list no longer overlaps the stored chapters at all', async () => {
    const original = await makeNovel(range(1, 5));
    const toc = list(range(30, 36).map((_l, i) => anchor(30 + i)));
    expect((await updateNovel(original, { fetchPage: site(toc) })).outcome).toBe('source_mismatch');
  });

  it('refuses, rather than duplicating, when every link gained a tracking parameter', async () => {
    const original = await makeNovel(range(1, 5));
    const toc = list(
      range(1, 8).map((_l, i) => anchor(i + 1, undefined, `${url(i + 1)}?ref=home`)),
    );
    expect((await updateNovel(original, { fetchPage: site(toc) })).outcome).toBe('source_mismatch');
  });

  it('tolerates a chapter removed from the middle of the list', async () => {
    const original = await makeNovel(range(1, 6));
    const toc = list([1, 2, 4, 5, 6, 7, 8].map((n) => anchor(n)));
    const result = await updateNovel(original, { fetchPage: site(toc) });
    if (result.outcome !== 'updated') throw new Error(result.outcome);
    expect(result.missingFromSource.map((l) => l.url)).toEqual([url(3)]);
    expect(await titlesOf(result.blob)).toEqual(range(1, 8).map((l) => l.title));
  });

  it('after a partial import (chapters 10-14), appends what follows and never inserts earlier ones', async () => {
    const original = await makeNovel(range(10, 14));
    const toc = list(range(1, 18).map((_l, i) => anchor(i + 1)));
    const result = await updateNovel(original, { fetchPage: site(toc) });
    if (result.outcome !== 'updated') throw new Error(result.outcome);
    expect(await titlesOf(result.blob)).toEqual(range(10, 18).map((l) => l.title));
    expect(result.skipped).toHaveLength(9);
  });

  it('reading the list twice gives the same plan: a second update finds nothing new', async () => {
    const original = await makeNovel(range(1, 5));
    const fetchPage = site(list(range(1, 8).map((_l, i) => anchor(i + 1))));
    const first = await updateNovel(original, { fetchPage });
    if (first.outcome !== 'updated') throw new Error(first.outcome);
    expect(await updateNovel(first.blob, { fetchPage })).toMatchObject({ outcome: 'up_to_date' });
  });

  it('parses the same pages the import reads, so stored and fresh chapters line up', async () => {
    const toc = list(range(1, 6).map((_l, i) => anchor(i + 1, `Chapter ${i + 1}: Title ${i + 1}`)));
    const fetched = await fetchNovelToc(TOC_URL, { fetchPage: site(toc), backfillMetadata: false });
    expect(fetched.chapters.map((c) => c.url)).toEqual(range(1, 6).map((c) => c.url));
  });
});
