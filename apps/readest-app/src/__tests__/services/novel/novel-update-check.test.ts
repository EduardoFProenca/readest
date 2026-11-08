import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEpub } from '@/services/send/conversion/buildEpub';
import type { EpubChapter } from '@/services/send/conversion/types';
import { ConversionError } from '@/services/send/conversion/types';
import type { NovelChapterLink } from '@/services/novel/chapterList';
import {
  NOVEL_SOURCE_FILENAME,
  novelSourceMarker,
  serializeNovelSource,
} from '@/services/novel/novelSource';
import { readNovelEpub } from '@/services/novel/novelEpub';
import { buildChapterLinksFromTemplate } from '@/services/novel/urlTemplate';
import { updateNovel } from '@/services/novel/novelUpdate';
import { checkNovelForUpdates } from '@/services/novel/novelUpdateCheck';
import { runNovelUpdateCheck } from '@/services/novel/novelUpdateCheckRunner';
import { novelUpdateKey, useNovelUpdateStore } from '@/store/novelUpdateStore';
import type { Book } from '@/types/book';

const BASE = 'https://novels.example.org';
const TOC_URL = `${BASE}/novel/7/`;
const TEMPLATE = `${BASE}/naruto/c.!@!`;
const META = { title: 'My Novel', author: 'Author X', language: 'en', identifier: 'readest:abc' };

const link = (n: number): NovelChapterLink => ({
  title: `Chapter ${n}: Part ${n}`,
  url: `${BASE}/novel/7/${n}`,
});
const links = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => link(from + i));
const stored = (l: NovelChapterLink): EpubChapter => ({
  title: l.title,
  html: `<h1>${l.title}</h1><p>Stored text of ${l.title}.</p>`,
});

async function makeTocNovel(count: number, sourceUrl = TOC_URL): Promise<Blob> {
  const chapters = links(1, count);
  return buildEpub(
    chapters.map(stored),
    { ...META, source: novelSourceMarker(sourceUrl) },
    [],
    undefined,
    [
      {
        path: NOVEL_SOURCE_FILENAME,
        content: serializeNovelSource({ version: 1, kind: 'toc', sourceUrl, chapters }),
      },
    ],
  );
}

async function makeTemplateNovel(count: number): Promise<Blob> {
  const chapters = buildChapterLinksFromTemplate(TEMPLATE, 1, count);
  return buildEpub(
    chapters.map(stored),
    { ...META, source: novelSourceMarker(TEMPLATE) },
    [],
    undefined,
    [
      {
        path: NOVEL_SOURCE_FILENAME,
        content: serializeNovelSource({
          version: 1,
          kind: 'template',
          sourceUrl: TEMPLATE,
          chapters,
        }),
      },
    ],
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

const tocSite =
  (listed: NovelChapterLink[], opts: { tocError?: Error; calls?: string[] } = {}) =>
  async (url: string) => {
    opts.calls?.push(url);
    if (url === TOC_URL) {
      if (opts.tocError) throw opts.tocError;
      return { html: tocPage(listed), finalUrl: url };
    }
    return { html: chapterPage(parseInt(url.match(/\/(\d+)$/)![1]!, 10)), finalUrl: url };
  };

const templateSite =
  (last: number, error?: Error, calls: string[] = []) =>
  async (url: string) => {
    calls.push(url);
    if (error) throw error;
    const n = parseInt(url.match(/(\d+)$/)![1]!, 10);
    if (n > last)
      throw new ConversionError('Could not fetch the page (HTTP 404).', 'fetch_failed', 404);
    return { html: chapterPage(n), finalUrl: url };
  };

describe('checkNovelForUpdates', () => {
  it('finds new chapters in a TOC book without downloading any of them', async () => {
    const calls: string[] = [];
    const result = await checkNovelForUpdates(await makeTocNovel(5), {
      fetchPage: tocSite(links(1, 8), { calls }),
    });
    expect(result).toEqual({ outcome: 'available', newCount: 3 });
    expect(calls).toEqual([TOC_URL]);
  });

  it('reports up to date when the source has nothing new', async () => {
    expect(
      await checkNovelForUpdates(await makeTocNovel(5), { fetchPage: tocSite(links(1, 5)) }),
    ).toEqual({ outcome: 'up_to_date' });
  });

  it('does not report an update when the source no longer lines up', async () => {
    const other = links(1, 6).map((l) => ({ ...l, url: l.url.replace('/novel/7/', '/other/') }));
    expect(
      await checkNovelForUpdates(await makeTocNovel(5), { fetchPage: tocSite(other) }),
    ).toEqual({ outcome: 'source_mismatch' });
  });

  it('throws on a network failure instead of claiming the book is up to date', async () => {
    await expect(
      checkNovelForUpdates(await makeTocNovel(5), {
        fetchPage: tocSite([], { tocError: new Error('offline') }),
      }),
    ).rejects.toThrow('offline');
  });

  it('skips files without a source record or that are not novels', async () => {
    const plain = await buildEpub([stored(link(1))], META, [], undefined, []);
    expect(await checkNovelForUpdates(plain, { fetchPage: tocSite([]) })).toEqual({
      outcome: 'unsupported',
      reason: 'no_source',
    });
    expect(await checkNovelForUpdates(new Blob(['x']), { fetchPage: tocSite([]) })).toEqual({
      outcome: 'unsupported',
      reason: 'not_a_novel',
    });
  });

  it('probes only the chapter after the last stored one for a template book', async () => {
    const calls: string[] = [];
    const result = await checkNovelForUpdates(await makeTemplateNovel(5), {
      fetchPage: templateSite(8, undefined, calls),
    });
    expect(result).toEqual({ outcome: 'available', newCount: null });
    expect(calls).toEqual([`${BASE}/naruto/c.6`]);
  });

  it('treats a missing next chapter as up to date, but a network error as a failure', async () => {
    expect(
      await checkNovelForUpdates(await makeTemplateNovel(5), { fetchPage: templateSite(5) }),
    ).toEqual({ outcome: 'up_to_date' });
    await expect(
      checkNovelForUpdates(await makeTemplateNovel(5), {
        fetchPage: templateSite(
          5,
          new ConversionError('temporarily unavailable', 'fetch_transient'),
        ),
      }),
    ).rejects.toThrow();
  });
});

const bookOf = async (id: string, blob: Blob | null, novel = true): Promise<Book> =>
  ({
    hash: `file-${id}`,
    metaHash: `meta-${id}`,
    format: 'EPUB',
    title: id,
    author: 'A',
    createdAt: 1,
    updatedAt: 1,
    metadata: novel ? { title: id, source: novelSourceMarker(TOC_URL) } : { title: id },
    ...(blob ? {} : {}),
  }) as unknown as Book;

describe('runNovelUpdateCheck', () => {
  beforeEach(() => {
    localStorage.clear();
    useNovelUpdateStore.setState({
      updates: {},
      checking: false,
      progress: { done: 0, total: 0 },
      lastCheck: null,
      busy: {},
    });
  });

  it('queries only novels with a source and marks only confirmed updates', async () => {
    const files: Record<string, Blob> = {
      'file-a': await makeTocNovel(5),
      'file-b': await makeTocNovel(5),
    };
    const a = await bookOf('a', null);
    const b = await bookOf('b', null);
    const plain = await bookOf('plain', null, false);
    const asked: string[] = [];
    const summary = await runNovelUpdateCheck([a, b, plain], {
      loadFile: async (book) => {
        asked.push(book.hash);
        return files[book.hash]!;
      },
      check: async (_file, _o) =>
        asked[asked.length - 1] === 'file-a'
          ? { outcome: 'available', newCount: 2 }
          : { outcome: 'up_to_date' },
    });
    expect(asked).toEqual(['file-a', 'file-b']);
    expect(summary).toMatchObject({ checked: 2, withUpdates: 1, failed: 0, cancelled: false });
    expect(Object.keys(useNovelUpdateStore.getState().updates)).toEqual([novelUpdateKey(a)]);
  });

  it('a failed check leaves existing indicators alone and reports the failure', async () => {
    const a = await bookOf('a', null);
    useNovelUpdateStore.getState().markAvailable(novelUpdateKey(a), 3);
    const summary = await runNovelUpdateCheck([a], {
      loadFile: async () => new Blob(['x']),
      check: async () => {
        throw new Error('offline');
      },
    });
    expect(summary).toMatchObject({ failed: 1, withUpdates: 0 });
    expect(useNovelUpdateStore.getState().updates[novelUpdateKey(a)]).toBeDefined();
  });

  it('refuses to start a second check while one is running', async () => {
    const a = await bookOf('a', null);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = runNovelUpdateCheck([a], {
      loadFile: async () => new Blob(['x']),
      check: async () => {
        await gate;
        return { outcome: 'up_to_date' };
      },
    });
    const loadSecond = vi.fn();
    expect(await runNovelUpdateCheck([a], { loadFile: loadSecond })).toBeNull();
    expect(loadSecond).not.toHaveBeenCalled();
    release();
    expect((await first)?.checked).toBe(1);
    expect(useNovelUpdateStore.getState().checking).toBe(false);
  });

  it('does not query a book that is being updated right now', async () => {
    const a = await bookOf('a', null);
    useNovelUpdateStore.getState().acquire(novelUpdateKey(a));
    const check = vi.fn();
    await runNovelUpdateCheck([a], { loadFile: async () => new Blob(['x']), check });
    expect(check).not.toHaveBeenCalled();
  });

  it('can be cancelled: stops querying and keeps what was already found', async () => {
    const [a, b, c] = await Promise.all([bookOf('a', null), bookOf('b', null), bookOf('c', null)]);
    const controller = new AbortController();
    const check = vi.fn(async () => {
      controller.abort();
      return { outcome: 'available', newCount: 1 } as const;
    });
    const summary = await runNovelUpdateCheck([a, b, c], {
      loadFile: async () => new Blob(['x']),
      check,
      signal: controller.signal,
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ cancelled: true, withUpdates: 1 });
    expect(Object.keys(useNovelUpdateStore.getState().updates)).toEqual([novelUpdateKey(a)]);
    expect(useNovelUpdateStore.getState().busy).toEqual({});
  });

  it('drops indicators for books that left the library', async () => {
    useNovelUpdateStore.getState().markAvailable('gone', 1);
    await runNovelUpdateCheck([await bookOf('a', null)], {
      loadFile: async () => new Blob(['x']),
      check: async () => ({ outcome: 'up_to_date' }),
    });
    expect(useNovelUpdateStore.getState().updates['gone']).toBeUndefined();
  });
});

describe('check, then update: end to end', () => {
  it('finds new chapters, and applying the update really appends them to the EPUB', async () => {
    const original = await makeTocNovel(5);
    const site = tocSite(links(1, 8));
    const found = await checkNovelForUpdates(original, { fetchPage: site });
    expect(found).toEqual({ outcome: 'available', newCount: 3 });

    const result = await updateNovel(original, { fetchPage: site });
    if (result.outcome !== 'updated') throw new Error(`unexpected ${result.outcome}`);
    expect(result.addedCount).toBe(3);
    const book = await readNovelEpub(result.blob);
    expect(book.chapters.map((c) => c.title)).toEqual(links(1, 8).map((l) => l.title));
    expect(book.chapters[0]).toEqual(stored(link(1)));
    expect(book.chapters[7]!.html).toContain('Fresh chapter 8');

    // After the update the same source has nothing new.
    expect(await checkNovelForUpdates(result.blob, { fetchPage: site })).toEqual({
      outcome: 'up_to_date',
    });
  });

  it('a template book: the probe finds the next chapter and the update appends it', async () => {
    const original = await makeTemplateNovel(5);
    const site = templateSite(7);
    expect(await checkNovelForUpdates(original, { fetchPage: site })).toEqual({
      outcome: 'available',
      newCount: null,
    });
    const result = await updateNovel(original, { fetchPage: site });
    if (result.outcome !== 'updated') throw new Error(`unexpected ${result.outcome}`);
    expect((await readNovelEpub(result.blob)).chapters).toHaveLength(7);
    expect(await checkNovelForUpdates(result.blob, { fetchPage: site })).toEqual({
      outcome: 'up_to_date',
    });
  });
});
