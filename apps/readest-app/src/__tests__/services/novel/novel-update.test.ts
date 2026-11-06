import { describe, expect, it, vi } from 'vitest';
import { buildEpub } from '@/services/send/conversion/buildEpub';
import type { EpubChapter } from '@/services/send/conversion/types';
import { ConversionError } from '@/services/send/conversion/types';
import type { NovelChapterLink } from '@/services/novel/chapterList';
import { NOVEL_SOURCE_FILENAME, serializeNovelSource } from '@/services/novel/novelSource';
import type { NovelSource } from '@/services/novel/novelSource';
import { readNovelEpub } from '@/services/novel/novelEpub';
import { getMetadataHash } from '@/utils/book';
import type { BookMetadata } from '@/libs/document';
import { isNovelImportCancelled } from '@/services/novel/novelImport';
import { updateNovel } from '@/services/novel/novelUpdate';

const BASE = 'https://novels.example.org';
const TOC_URL = `${BASE}/novel/7/`;
const META = { title: 'My Novel', author: 'Author X', language: 'en', identifier: 'readest:abc' };

const link = (n: number): NovelChapterLink => ({
  title: `Chapter ${n}: Part ${n}`,
  url: `${BASE}/novel/7/${n}`,
});
const links = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => link(from + i));
const stored = (n: number): EpubChapter => ({
  title: link(n).title,
  html: `<h1>${link(n).title}</h1><p>Stored text of chapter ${n}.</p>`,
});

async function makeNovel(count: number, source: Partial<NovelSource> | null = {}): Promise<Blob> {
  const record: NovelSource | null = source && {
    version: 1,
    kind: 'toc',
    sourceUrl: TOC_URL,
    chapters: links(1, count),
    ...source,
  };
  return buildEpub(
    Array.from({ length: count }, (_, i) => stored(i + 1)),
    META,
    [],
    undefined,
    record ? [{ path: NOVEL_SOURCE_FILENAME, content: serializeNovelSource(record) }] : [],
  );
}

const tocPage = (chapters: NovelChapterLink[]) => `<!DOCTYPE html><html><head>
<title>My Novel</title><meta property="og:title" content="My Novel"/><meta name="author" content="Author X"/>
</head><body><ul>
${chapters.map((c) => `<li><a href="${c.url}">${c.title}</a></li>`).join('\n')}
</ul></body></html>`;

const chapterPage = (n: number) => `<!DOCTYPE html><html><head><title>Chapter ${n}</title></head>
<body><div id="content">
${Array.from({ length: 10 }, (_, i) => `<p>Fresh chapter ${n} paragraph ${i} with plenty of narrative text to satisfy extraction quality floors.</p>`).join('\n')}
</div></body></html>`;

const site =
  (
    listed: NovelChapterLink[],
    options: { broken?: Record<number, Error | string>; tocError?: Error; calls?: string[] } = {},
  ) =>
  async (url: string) => {
    options.calls?.push(url);
    if (url === TOC_URL) {
      if (options.tocError) throw options.tocError;
      return { html: tocPage(listed), finalUrl: url };
    }
    const n = parseInt(url.match(/\/(\d+)$/)![1]!, 10);
    const broken = options.broken?.[n];
    if (broken instanceof Error) throw broken;
    return { html: typeof broken === 'string' ? broken : chapterPage(n), finalUrl: url };
  };

const bytesOf = async (blob: Blob) => [...new Uint8Array(await blob.arrayBuffer())];

describe('updateNovel', () => {
  it('appends only the chapters that are new, keeping the stored ones', async () => {
    const calls: string[] = [];
    const original = await makeNovel(5);
    const result = await updateNovel(original, { fetchPage: site(links(1, 7), { calls }) });
    if (result.outcome !== 'updated') throw new Error(`unexpected ${result.outcome}`);
    expect(result.addedCount).toBe(2);
    expect(result.chapterCount).toBe(7);
    expect(result.failed).toEqual([]);
    // The stored chapters are never downloaded again.
    expect(calls.filter((u) => /\/[1-5]$/.test(u))).toEqual([]);
    const book = await readNovelEpub(result.blob);
    expect(book.chapters.map((c) => c.title)).toEqual(links(1, 7).map((l) => l.title));
    expect(book.chapters[0]).toEqual(stored(1));
    expect(book.chapters[6]!.html).toContain('Fresh chapter 7');
    expect(book.source?.chapters.map((c) => c.url)).toEqual(links(1, 7).map((l) => l.url));
    expect(book.metadata).toEqual(META);
  });

  it('reports up to date without producing a file', async () => {
    const result = await updateNovel(await makeNovel(5), { fetchPage: site(links(1, 5)) });
    expect(result).toMatchObject({ outcome: 'up_to_date', totalFound: 5 });
    expect('blob' in result).toBe(false);
  });

  it('refuses when the source no longer lines up with the stored chapters', async () => {
    const other = [1, 2, 3, 4, 5, 6].map((n) => ({
      title: `Chapter ${n}: Part ${n}`,
      url: `${BASE}/other/${n}`,
    }));
    const result = await updateNovel(await makeNovel(5), { fetchPage: site(other) });
    expect(result.outcome).toBe('source_mismatch');
  });

  it('does not touch a book that has no recorded source', async () => {
    const result = await updateNovel(await makeNovel(5, null), { fetchPage: site(links(1, 5)) });
    expect(result).toMatchObject({ outcome: 'unsupported', reason: 'no_source' });
  });

  it('does not support books imported from a URL template yet', async () => {
    const novel = await makeNovel(5, { kind: 'template', sourceUrl: `${BASE}/novel/7/!@!` });
    const calls: string[] = [];
    const result = await updateNovel(novel, { fetchPage: site(links(1, 5), { calls }) });
    expect(result).toMatchObject({ outcome: 'unsupported', reason: 'template_source' });
    expect(calls).toEqual([]);
  });

  it('does not support a file that is not a web-novel EPUB', async () => {
    expect(await updateNovel(new Blob(['not a zip']), { fetchPage: site([]) })).toMatchObject({
      outcome: 'unsupported',
      reason: 'not_a_novel',
    });
  });

  it('leaves a failed chapter out, and everything after it, to retry next time', async () => {
    const result = await updateNovel(await makeNovel(5), {
      fetchPage: site(links(1, 8), {
        broken: { 7: new ConversionError('HTTP 404', 'fetch_failed') },
      }),
    });
    if (result.outcome !== 'updated') throw new Error(`unexpected ${result.outcome}`);
    expect(result.addedCount).toBe(1);
    expect(result.failed).toEqual([link(7)]);
    expect(result.deferred).toEqual([link(8)]);
    const book = await readNovelEpub(result.blob);
    expect(book.chapters.map((c) => c.title)).toEqual(links(1, 6).map((l) => l.title));
    expect(book.chapters.some((c) => c.html.includes('could not be downloaded'))).toBe(false);
  });

  it('adds nothing when the first new chapter fails', async () => {
    const result = await updateNovel(await makeNovel(5), {
      fetchPage: site(links(1, 7), {
        broken: { 6: new ConversionError('HTTP 404', 'fetch_failed') },
      }),
    });
    expect(result).toMatchObject({ outcome: 'nothing_added' });
    if (result.outcome !== 'nothing_added') return;
    expect(result.failed).toEqual([link(6)]);
    expect(result.deferred).toEqual([link(7)]);
  });

  it('reports retitled, skipped and missing chapters without applying them', async () => {
    const fresh = [link(1), { ...link(2), title: 'Chapter 2: Part 2 (revised)' }, ...links(3, 6)];
    const result = await updateNovel(await makeNovel(5), { fetchPage: site(fresh) });
    if (result.outcome !== 'updated') throw new Error(`unexpected ${result.outcome}`);
    expect(result.retitled).toHaveLength(1);
    const book = await readNovelEpub(result.blob);
    expect(book.chapters[1]!.title).toBe(link(2).title);
  });

  it('propagates a failure to read the chapter list', async () => {
    const original = await makeNovel(5);
    const before = await bytesOf(original);
    const error = await updateNovel(original, {
      fetchPage: site([], { tocError: new ConversionError('HTTP 503', 'fetch_failed') }),
    }).catch((e) => e);
    expect(error).toBeInstanceOf(ConversionError);
    expect(await bytesOf(original)).toEqual(before);
  });

  it('never modifies the input blob', async () => {
    const original = await makeNovel(5);
    const before = await bytesOf(original);
    await updateNovel(original, { fetchPage: site(links(1, 7)) });
    expect(await bytesOf(original)).toEqual(before);
  });

  it('reports stages in order and per-chapter progress', async () => {
    const stages: string[] = [];
    const onProgress = vi.fn();
    await updateNovel(await makeNovel(5), {
      fetchPage: site(links(1, 7)),
      onStage: (stage) => stages.push(stage),
      onProgress,
    });
    expect(stages).toEqual(['checking', 'downloading']);
    expect(onProgress).toHaveBeenLastCalledWith(2, 2);
  });

  it('can be cancelled while downloading', async () => {
    const controller = new AbortController();
    const base = site(links(1, 8));
    const fetchPage = async (url: string) => {
      if (url !== TOC_URL) controller.abort();
      return base(url);
    };
    const error = await updateNovel(await makeNovel(5), {
      fetchPage,
      signal: controller.signal,
    }).catch((e) => e);
    expect(isNovelImportCancelled(error)).toBe(true);
  });

  it('renders the new chapters when the book was imported through a sign-in session', async () => {
    const renderPage = vi.fn(async (url: string) => ({
      html: chapterPage(parseInt(url.match(/\/(\d+)$/)![1]!, 10)),
      finalUrl: url,
    }));
    const calls: string[] = [];
    const result = await updateNovel(await makeNovel(5, { renderChapters: true }), {
      fetchPage: site(links(1, 6), { calls }),
      renderPage,
    });
    expect(result.outcome).toBe('updated');
    expect(renderPage).toHaveBeenCalledTimes(1);
    expect(calls.filter((u) => /\/6$/.test(u))).toEqual([]);
  });

  it('keeps the identity the library uses to recognise the book, so the import re-keys it', async () => {
    const original = await makeNovel(5);
    const result = await updateNovel(original, { fetchPage: site(links(1, 7)) });
    if (result.outcome !== 'updated') throw new Error(`unexpected ${result.outcome}`);
    const hashOf = async (blob: Blob) =>
      getMetadataHash((await readNovelEpub(blob)).metadata as unknown as BookMetadata);
    expect(await hashOf(result.blob)).toBe(await hashOf(original));
    expect(await hashOf(original)).toBeTruthy();
  });
});
