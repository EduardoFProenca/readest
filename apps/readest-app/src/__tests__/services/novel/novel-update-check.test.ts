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
    // The list, then only the first new chapter, to prove it can be read. Not the other two.
    expect(calls).toEqual([TOC_URL, link(6).url]);
  });

  it('does not report a chapter that is listed but cannot be read yet', async () => {
    const site = async (url: string) =>
      url === TOC_URL
        ? { html: tocPage(links(1, 6)), finalUrl: url }
        : { html: '<html><body><p>Coming soon</p></body></html>', finalUrl: url };
    expect(await checkNovelForUpdates(await makeTocNovel(5), { fetchPage: site })).toEqual({
      outcome: 'not_ready',
      newCount: 1,
    });
  });

  it('a network error while reading the new chapter is a failed check, not "not ready"', async () => {
    const site = async (url: string) => {
      if (url === TOC_URL) return { html: tocPage(links(1, 6)), finalUrl: url };
      throw new ConversionError('temporarily unavailable', 'fetch_transient');
    };
    await expect(
      checkNovelForUpdates(await makeTocNovel(5), { fetchPage: site }),
    ).rejects.toThrow();
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
    useNovelUpdateStore.getState().acquire(novelUpdateKey(a), 'someone-else');
    const check = vi.fn();
    await runNovelUpdateCheck([a], { loadFile: async () => new Blob(['x']), check });
    expect(check).not.toHaveBeenCalled();
  });

  it('cancelled during the only query in flight: nothing is recorded', async () => {
    const [a, b, c] = await Promise.all([bookOf('a', null), bookOf('b', null), bookOf('c', null)]);
    const controller = new AbortController();
    const check = vi.fn(async () => {
      controller.abort();
      return { outcome: 'available', newCount: 1 } as const;
    });
    // The only query in flight is cancelled: its answer is not recorded as a finished check.
    const summary = await runNovelUpdateCheck([a, b, c], {
      loadFile: async () => new Blob(['x']),
      check,
      signal: controller.signal,
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ cancelled: true, withUpdates: 0, checked: 0 });
    expect(useNovelUpdateStore.getState().updates).toEqual({});
    expect(useNovelUpdateStore.getState().busy).toEqual({});
  });

  it('keeps what was found before the cancel', async () => {
    const [a, b, c] = await Promise.all([bookOf('a', null), bookOf('b', null), bookOf('c', null)]);
    const controller = new AbortController();
    let calls = 0;
    const summary = await runNovelUpdateCheck([a, b, c], {
      loadFile: async () => new Blob(['x']),
      signal: controller.signal,
      check: async () => {
        if (++calls === 2) controller.abort();
        return { outcome: 'available', newCount: 1 };
      },
    });
    expect(summary).toMatchObject({ cancelled: true, withUpdates: 1, checked: 1 });
    expect(Object.keys(useNovelUpdateStore.getState().updates)).toEqual([novelUpdateKey(a)]);
  });

  it('a cancel while the file is loading is not recorded either', async () => {
    const a = await bookOf('a', null);
    const controller = new AbortController();
    const summary = await runNovelUpdateCheck([a], {
      loadFile: async () => {
        controller.abort();
        return new Blob(['x']);
      },
      signal: controller.signal,
      check: async () => ({ outcome: 'available', newCount: 1 }),
    });
    expect(summary).toMatchObject({ cancelled: true, withUpdates: 0 });
    expect(useNovelUpdateStore.getState().updates).toEqual({});
  });

  it('clears the indicator of a listed chapter that cannot be read yet', async () => {
    const a = await bookOf('a', null);
    useNovelUpdateStore.getState().markAvailable(novelUpdateKey(a), 1);
    await runNovelUpdateCheck([a], {
      loadFile: async () => new Blob(['x']),
      check: async () => ({ outcome: 'not_ready', newCount: 1 }),
    });
    expect(useNovelUpdateStore.getState().updates).toEqual({});
  });

  it('drops indicators of books that are no longer web novels', async () => {
    const was = await bookOf('was', null, false);
    useNovelUpdateStore.getState().markAvailable(novelUpdateKey(was), 2);
    await runNovelUpdateCheck([was, await bookOf('a', null)], {
      loadFile: async () => new Blob(['x']),
      check: async () => ({ outcome: 'up_to_date' }),
    });
    expect(useNovelUpdateStore.getState().updates[novelUpdateKey(was)]).toBeUndefined();
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

describe('updating, in the EPUB', () => {
  const spineTitles = async (blob: Blob) =>
    (await readNovelEpub(blob)).chapters.map((c) => c.title);

  it('appends new chapters after the last one, in source order, with the same structure', async () => {
    const original = await makeTocNovel(5);
    const result = await updateNovel(original, { fetchPage: tocSite(links(1, 8)) });
    if (result.outcome !== 'updated') throw new Error(result.outcome);
    const book = await readNovelEpub(result.blob);
    expect(await spineTitles(result.blob)).toEqual(links(1, 8).map((l) => l.title));
    // Same shape as the stored chapters: a canonical <h1> heading, then paragraphs.
    for (const chapter of book.chapters.slice(5)) {
      expect(chapter.html.startsWith(`<h1>${chapter.title}</h1>`)).toBe(true);
      expect(chapter.html).toContain('<p>');
    }
    // Old chapters are not touched.
    const before = await readNovelEpub(original);
    expect(book.chapters.slice(0, 5)).toEqual(before.chapters);
    // The source record lists the new chapters last.
    expect(book.source!.chapters.map((c) => c.url)).toEqual(links(1, 8).map((l) => l.url));
  });

  it('keeps the new chapter last even when the site lists newest chapters first', async () => {
    const original = await makeTocNovel(5);
    const result = await updateNovel(original, {
      fetchPage: tocSite(links(1, 6).reverse()),
    });
    if (result.outcome !== 'updated') throw new Error(result.outcome);
    expect(await spineTitles(result.blob)).toEqual(links(1, 6).map((l) => l.title));
  });

  it('does not duplicate chapters when updating twice', async () => {
    const site = tocSite(links(1, 7));
    const first = await updateNovel(await makeTocNovel(5), { fetchPage: site });
    if (first.outcome !== 'updated') throw new Error(first.outcome);
    expect(await updateNovel(first.blob, { fetchPage: site })).toMatchObject({
      outcome: 'up_to_date',
    });
    expect(await spineTitles(first.blob)).toHaveLength(7);
  });

  it('updates two different novels one after the other, each from its own source', async () => {
    const otherToc = `${BASE}/novel/9/`;
    const otherLinks = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        title: `Chapter ${i + 1}: Other ${i + 1}`,
        url: `${BASE}/novel/9/${i + 1}`,
      }));
    const otherBook = await buildEpub(
      otherLinks(5).map(stored),
      {
        ...META,
        title: 'Other Novel',
        identifier: 'readest:other',
        source: novelSourceMarker(otherToc),
      },
      [],
      undefined,
      [
        {
          path: NOVEL_SOURCE_FILENAME,
          content: serializeNovelSource({
            version: 1,
            kind: 'toc',
            sourceUrl: otherToc,
            chapters: otherLinks(5),
          }),
        },
      ],
    );
    const site = async (url: string) =>
      url === otherToc
        ? { html: tocPage(otherLinks(6)), finalUrl: url }
        : tocSite(links(1, 6))(url);
    const a = await updateNovel(await makeTocNovel(5), { fetchPage: site });
    const b = await updateNovel(otherBook, { fetchPage: site });
    if (a.outcome !== 'updated' || b.outcome !== 'updated') throw new Error('not updated');
    expect(await spineTitles(a.blob)).toHaveLength(6);
    expect(await spineTitles(b.blob)).toEqual(
      [1, 2, 3, 4, 5, 6].map((n) => `Chapter ${n}: Other ${n}`),
    );
    expect((await readNovelEpub(b.blob)).metadata.title).toBe('Other Novel');
  });

  it('a chapter that fails to download leaves the book unchanged and says why', async () => {
    const site = async (url: string) => {
      if (url === TOC_URL) return { html: tocPage(links(1, 6)), finalUrl: url };
      throw new ConversionError('Could not fetch the page (HTTP 404).', 'fetch_failed', 404);
    };
    const result = await updateNovel(await makeTocNovel(5), { fetchPage: site });
    expect(result).toMatchObject({ outcome: 'nothing_added', failureKinds: ['missing'] });
  });

  it('a title that changed at the source is reported, not applied, and loses nothing', async () => {
    const original = await makeTocNovel(5);
    const renamed = links(1, 6).map((l) => (l.url.endsWith('/2') ? { ...l, title: 'Renamed' } : l));
    const result = await updateNovel(original, { fetchPage: tocSite(renamed) });
    if (result.outcome !== 'updated') throw new Error(result.outcome);
    expect(result.retitled).toEqual([
      { url: link(2).url, storedTitle: link(2).title, freshTitle: 'Renamed' },
    ]);
    const book = await readNovelEpub(result.blob);
    expect(book.chapters[1]).toEqual(stored(link(2)));
    expect(book.source!.chapters[1]!.title).toBe(link(2).title);
  });

  it('reports which chapter is downloading, with the running count', async () => {
    const started: string[] = [];
    const progress: [number, number][] = [];
    const result = await updateNovel(await makeTocNovel(5), {
      fetchPage: tocSite(links(1, 8)),
      onChapterStart: (chapter) => started.push(chapter.title),
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(result.outcome).toBe('updated');
    expect(started).toEqual([link(6).title, link(7).title, link(8).title]);
    // Exactly one progress call per finished chapter, as before.
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });
});
