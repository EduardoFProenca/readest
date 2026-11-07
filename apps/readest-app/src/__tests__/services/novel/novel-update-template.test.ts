import { describe, expect, it, vi } from 'vitest';
import { buildEpub } from '@/services/send/conversion/buildEpub';
import { ConversionError } from '@/services/send/conversion/types';
import type { NovelChapterLink } from '@/services/novel/chapterList';
import {
  NOVEL_SOURCE_FILENAME,
  novelSourceMarker,
  serializeNovelSource,
} from '@/services/novel/novelSource';
import { readNovelEpub } from '@/services/novel/novelEpub';
import { isNovelImportCancelled } from '@/services/novel/novelImport';
import { buildChapterLinksFromTemplate } from '@/services/novel/urlTemplate';
import { updateNovel } from '@/services/novel/novelUpdate';

const TEMPLATE = 'https://novels.example.org/naruto/c.!@!';
const META = { title: 'Naruto', author: 'Unknown', language: 'en', identifier: 'readest:tpl' };

async function makeNovel(
  count: number,
  template = TEMPLATE,
  chapters: NovelChapterLink[] = buildChapterLinksFromTemplate(template, 1, count),
): Promise<Blob> {
  return buildEpub(
    chapters.map((l) => ({ title: l.title, html: `<h1>${l.title}</h1><p>Stored ${l.title}.</p>` })),
    { ...META, source: novelSourceMarker(template) },
    [],
    undefined,
    [
      {
        path: NOVEL_SOURCE_FILENAME,
        content: serializeNovelSource({
          version: 1,
          kind: 'template',
          sourceUrl: template,
          chapters,
        }),
      },
    ],
  );
}

const chapterPage = (n: number) =>
  `<!DOCTYPE html><html><head><title>Chapter ${n}</title></head><body><div id="content">${Array.from(
    { length: 10 },
    (_, i) =>
      `<p>Fresh chapter ${n} paragraph ${i} with plenty of narrative text to satisfy extraction quality floors.</p>`,
  ).join('')}</div></body></html>`;

type Behaviour = 'ok' | 'missing' | 'soft404' | 'transient' | 'blocked';
const numberOf = (url: string) => parseInt(url.match(/(\d+)(?:\.html)?$/)![1]!, 10);

/** A site whose chapters 1..last exist; `special` overrides single chapters. */
const site =
  (last: number, special: Record<number, Behaviour> = {}, calls: string[] = []) =>
  async (url: string) => {
    calls.push(url);
    const n = numberOf(url);
    const behaviour: Behaviour = special[n] ?? (n <= last ? 'ok' : 'missing');
    switch (behaviour) {
      case 'ok':
        return { html: chapterPage(n), finalUrl: url };
      case 'soft404':
        return { html: '<html><body><p>Chapter not found.</p></body></html>', finalUrl: url };
      case 'transient':
        throw new ConversionError(
          'The site is temporarily unavailable (HTTP 503).',
          'fetch_transient',
        );
      case 'blocked':
        throw new ConversionError('The site blocked the request (HTTP 403).', 'fetch_failed', 403);
      default:
        throw new ConversionError('Could not fetch the page (HTTP 404).', 'fetch_failed', 404);
    }
  };

const titles = async (blob: Blob) => (await readNovelEpub(blob)).chapters.map((c) => c.title);
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `Chapter ${from + i}`);
const updated = (result: Awaited<ReturnType<typeof updateNovel>>) => {
  if (result.outcome !== 'updated') throw new Error(`unexpected ${result.outcome}`);
  return result;
};

describe('updating a book imported from a !@! URL template', () => {
  it('appends the chapters after the last stored one and stops at the first that does not exist', async () => {
    const calls: string[] = [];
    const result = updated(
      await updateNovel(await makeNovel(5), { fetchPage: site(8, {}, calls) }),
    );
    expect(result.addedCount).toBe(3);
    expect(result.failed).toEqual([]);
    expect(result.limitReached).toBeFalsy();
    expect(await titles(result.blob)).toEqual(range(1, 8));
    // Stored chapters are never requested again.
    expect(calls.filter((u) => numberOf(u) <= 5)).toEqual([]);
    expect(calls).toContain('https://novels.example.org/naruto/c.6');
  });

  it('keeps the template record, extending it with the new chapters', async () => {
    const result = updated(await updateNovel(await makeNovel(5), { fetchPage: site(7) }));
    const { source } = await readNovelEpub(result.blob);
    expect(source?.kind).toBe('template');
    expect(source?.sourceUrl).toBe(TEMPLATE);
    expect(source?.chapters.map((c) => c.url)).toEqual(
      buildChapterLinksFromTemplate(TEMPLATE, 1, 7).map((c) => c.url),
    );
  });

  it('says up to date when the very next chapter does not exist', async () => {
    expect(await updateNovel(await makeNovel(5), { fetchPage: site(5) })).toMatchObject({
      outcome: 'up_to_date',
      totalFound: 5,
    });
  });

  it('treats a 200 page with no chapter text ("not found" soft 404) as the end', async () => {
    const result = updated(
      await updateNovel(await makeNovel(5), { fetchPage: site(99, { 8: 'soft404' }) }),
    );
    expect(await titles(result.blob)).toEqual(range(1, 7));
  });

  it('a network error is not the end of the novel: it keeps what it has and reports the failure', async () => {
    const result = updated(
      await updateNovel(await makeNovel(5), { fetchPage: site(99, { 8: 'transient' }) }),
    );
    expect(await titles(result.blob)).toEqual(range(1, 7));
    expect(result.failed.map((l) => l.url)).toEqual(['https://novels.example.org/naruto/c.8']);
  });

  it('adds nothing, and does not claim up to date, when the next chapter fails with an error', async () => {
    for (const behaviour of ['transient', 'blocked'] as const) {
      const result = await updateNovel(await makeNovel(5), {
        fetchPage: site(99, { 6: behaviour }),
      });
      expect(result.outcome).toBe('nothing_added');
    }
  });

  it('adds at most one run of chapters and says there may be more', async () => {
    const result = updated(
      await updateNovel(await makeNovel(5), { fetchPage: site(999), maxNewChapters: 10 }),
    );
    expect(result.addedCount).toBe(10);
    expect(result.limitReached).toBe(true);
    expect(await titles(result.blob)).toEqual(range(1, 15));
  });

  it('works with text after the marker and with the marker used twice', async () => {
    const suffixed = 'https://novels.example.org/naruto/c.!@!.html';
    const a = updated(await updateNovel(await makeNovel(5, suffixed), { fetchPage: site(7) }));
    expect(a.addedCount).toBe(2);
    const twice = 'https://novels.example.org/novel-!@!/chapter-!@!';
    const b = updated(await updateNovel(await makeNovel(5, twice), { fetchPage: site(7) }));
    expect(b.addedCount).toBe(2);
  });

  it('refuses a book whose stored chapters do not follow its template', async () => {
    const stray = buildChapterLinksFromTemplate('https://other.example.org/x/c.!@!', 1, 5);
    expect(
      (await updateNovel(await makeNovel(5, TEMPLATE, stray), { fetchPage: site(8) })).outcome,
    ).toBe('source_mismatch');
  });

  it('refuses stored chapters that are out of order', async () => {
    const links = buildChapterLinksFromTemplate(TEMPLATE, 1, 5).reverse();
    expect(
      (await updateNovel(await makeNovel(5, TEMPLATE, links), { fetchPage: site(8) })).outcome,
    ).toBe('source_mismatch');
  });

  it('continues from the last stored number after a partial import (chapters 10-14)', async () => {
    const links = buildChapterLinksFromTemplate(TEMPLATE, 10, 14);
    const calls: string[] = [];
    const result = updated(
      await updateNovel(await makeNovel(5, TEMPLATE, links), { fetchPage: site(16, {}, calls) }),
    );
    expect(await titles(result.blob)).toEqual(range(10, 16));
    expect(calls.some((u) => numberOf(u) < 15)).toBe(false);
  });

  it('reports how many chapters were downloaded, with no known total', async () => {
    const onProgress = vi.fn();
    await updateNovel(await makeNovel(5), { fetchPage: site(8), onProgress });
    expect(onProgress).toHaveBeenLastCalledWith(3, 0);
  });

  it('can be cancelled, leaving the original untouched', async () => {
    const original = await makeNovel(5);
    const before = [...new Uint8Array(await original.arrayBuffer())];
    const controller = new AbortController();
    const base = site(50);
    const fetchPage = async (url: string) => {
      controller.abort();
      return base(url);
    };
    const error = await updateNovel(original, { fetchPage, signal: controller.signal }).catch(
      (e) => e,
    );
    expect(isNovelImportCancelled(error)).toBe(true);
    expect([...new Uint8Array(await original.arrayBuffer())]).toEqual(before);
  });

  it('a second update finds nothing new', async () => {
    const fetchPage = site(8);
    const first = updated(await updateNovel(await makeNovel(5), { fetchPage }));
    expect(await updateNovel(first.blob, { fetchPage })).toMatchObject({ outcome: 'up_to_date' });
  });
});
