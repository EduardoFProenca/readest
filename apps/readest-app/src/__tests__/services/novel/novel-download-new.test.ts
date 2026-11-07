import { describe, expect, it, vi } from 'vitest';
import { downloadNewChapters, isNovelImportCancelled } from '@/services/novel/novelImport';
import { ConversionError } from '@/services/send/conversion/types';
import type { NovelChapterLink } from '@/services/novel/chapterList';

const BASE = 'https://novels.example.org';
const link = (n: number): NovelChapterLink => ({
  title: `Chapter ${n}`,
  url: `${BASE}/novel/7/${n}`,
});
const links = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => link(from + i));

const chapterPage = (n: number) => `<!DOCTYPE html><html><head><title>Chapter ${n}</title></head>
<body><div id="content">
${Array.from({ length: 10 }, (_, i) => `<p>Chapter ${n} paragraph ${i} with plenty of narrative text to satisfy extraction quality floors.</p>`).join('\n')}
</div></body></html>`;

const makeFetchPage =
  (overrides: Record<number, string | Error> = {}, calls: string[] = []) =>
  async (url: string) => {
    calls.push(url);
    const n = parseInt(url.match(/\/(\d+)$/)![1]!, 10);
    const override = overrides[n];
    if (override instanceof Error) throw override;
    return { html: typeof override === 'string' ? override : chapterPage(n), finalUrl: url };
  };

const fail = () => new ConversionError('Could not fetch the page (HTTP 404).', 'fetch_failed');

describe('downloadNewChapters', () => {
  it('downloads only the given chapters, in order, with matching links', async () => {
    const calls: string[] = [];
    const result = await downloadNewChapters(links(4, 6), {
      fetchPage: makeFetchPage({}, calls),
    });
    expect(calls.sort()).toEqual(
      links(4, 6)
        .map((l) => l.url)
        .sort(),
    );
    expect(result.chapters.map((c) => c.title)).toEqual(['Chapter 4', 'Chapter 5', 'Chapter 6']);
    expect(result.links).toEqual(links(4, 6));
    expect(result.chapters[0]!.html).toContain('<h1>Chapter 4</h1>');
    expect(result.chapters[0]!.html).toContain('Chapter 4 paragraph 0');
    expect(result.failed).toEqual([]);
    expect(result.deferred).toEqual([]);
  });

  it('never adds a placeholder for a failed chapter', async () => {
    const result = await downloadNewChapters(links(4, 6), {
      fetchPage: makeFetchPage({ 6: fail() }),
    });
    expect(result.links).toEqual(links(4, 5));
    expect(result.failed).toEqual([link(6)]);
    for (const chapter of result.chapters) {
      expect(chapter.html).not.toContain('could not be downloaded');
    }
  });

  it('keeps the chapters contiguous: nothing after a failed chapter is appended', async () => {
    const result = await downloadNewChapters(links(4, 8), {
      fetchPage: makeFetchPage({ 6: fail() }),
    });
    expect(result.links).toEqual(links(4, 5));
    expect(result.failed).toEqual([link(6)]);
    // 7 and 8 downloaded fine but would leave a gap, so the next update retries them.
    expect(result.deferred).toEqual(links(7, 8));
    expect(result.chapters).toHaveLength(2);
  });

  it('treats a page with no readable prose as a failure', async () => {
    const result = await downloadNewChapters(links(4, 5), {
      fetchPage: makeFetchPage({ 4: '<html><body><p>Just a moment...</p></body></html>' }),
    });
    expect(result.chapters).toEqual([]);
    expect(result.failed).toEqual(links(4, 5).slice(0, 1));
    expect(result.deferred).toEqual([link(5)]);
  });

  it('reports progress for every chapter', async () => {
    const onProgress = vi.fn();
    await downloadNewChapters(links(1, 3), { fetchPage: makeFetchPage(), onProgress });
    expect(onProgress).toHaveBeenLastCalledWith(3, 3);
  });

  it('can be cancelled and then returns nothing', async () => {
    const controller = new AbortController();
    const base = makeFetchPage();
    const fetchPage = async (url: string) => {
      controller.abort();
      return base(url);
    };
    const error = await downloadNewChapters(links(1, 5), {
      fetchPage,
      signal: controller.signal,
    }).catch((e) => e);
    expect(isNovelImportCancelled(error)).toBe(true);
  });

  it('refuses an already-cancelled call without fetching', async () => {
    const controller = new AbortController();
    controller.abort();
    const calls: string[] = [];
    const error = await downloadNewChapters(links(1, 2), {
      fetchPage: makeFetchPage({}, calls),
      signal: controller.signal,
    }).catch((e) => e);
    expect(isNovelImportCancelled(error)).toBe(true);
    expect(calls).toEqual([]);
  });

  it('returns an empty result for no chapters', async () => {
    const calls: string[] = [];
    const result = await downloadNewChapters([], { fetchPage: makeFetchPage({}, calls) });
    expect(result).toEqual({
      chapters: [],
      links: [],
      images: [],
      failed: [],
      failureKinds: [],
      deferred: [],
    });
    expect(calls).toEqual([]);
  });

  it('refuses a chapter URL that points at a blocked host, as a failure', async () => {
    const result = await downloadNewChapters(
      [{ title: 'Chapter 1', url: 'http://127.0.0.1/novel/1' }],
      { fetchPage: makeFetchPage() },
    );
    expect(result.links).toEqual([]);
    expect(result.failed).toHaveLength(1);
  });

  describe('when the plain fetch says the chapter does not exist (HTTP 404)', () => {
    const missing = () =>
      new ConversionError('Could not fetch the page (HTTP 404).', 'fetch_failed', 404);
    const renderPage = vi.fn(async (url: string) => ({ html: chapterPage(1), finalUrl: url }));

    it('still tries the browser renderer by default, as an import does', async () => {
      renderPage.mockClear();
      const result = await downloadNewChapters(links(1, 1), {
        fetchPage: makeFetchPage({ 1: missing() }),
        renderPage,
      });
      expect(renderPage).toHaveBeenCalled();
      expect(result.links).toEqual(links(1, 1));
    });

    it('skips the renderer when asked, and reports the chapter as missing', async () => {
      renderPage.mockClear();
      const result = await downloadNewChapters(links(1, 1), {
        fetchPage: makeFetchPage({ 1: missing() }),
        renderPage,
        skipRenderOnMissing: true,
      });
      expect(renderPage).not.toHaveBeenCalled();
      expect(result.failureKinds).toEqual(['missing']);
    });

    it('does not skip the renderer for other failures such as a bot block', async () => {
      renderPage.mockClear();
      await downloadNewChapters(links(1, 1), {
        fetchPage: makeFetchPage({
          1: new ConversionError('blocked (HTTP 403)', 'fetch_failed', 403),
        }),
        renderPage,
        skipRenderOnMissing: true,
      });
      expect(renderPage).toHaveBeenCalled();
    });
  });

  it('classifies failures: missing, unreadable page, other error', async () => {
    const result = await downloadNewChapters(links(1, 3), {
      fetchPage: makeFetchPage({
        1: new ConversionError('Could not fetch the page (HTTP 404).', 'fetch_failed', 404),
        2: '<html><body><p>Not found</p></body></html>',
        3: new ConversionError('temporarily unavailable', 'fetch_transient'),
      }),
    });
    expect(result.failureKinds).toEqual(['missing', 'unreadable', 'error']);
  });
});
