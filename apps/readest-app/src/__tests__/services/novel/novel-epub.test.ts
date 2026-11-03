import { beforeEach, describe, expect, test, vi } from 'vitest';
import { configureZip } from '@/utils/zip';
import { buildEpub } from '@/services/send/conversion/buildEpub';
import type { EpubChapter, EpubImage } from '@/services/send/conversion/types';
import type { NovelChapterLink } from '@/services/novel/chapterList';
import { NOVEL_SOURCE_FILENAME, serializeNovelSource } from '@/services/novel/novelSource';
import type { NovelSource } from '@/services/novel/novelSource';
import {
  NovelEpubError,
  appendChaptersToNovelEpub,
  readNovelEpub,
} from '@/services/novel/novelEpub';

const mode = vi.hoisted(() => ({ value: 'normal' as 'normal' | 'throw' | 'tamper' }));
vi.mock('@/services/send/conversion/buildEpub', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/send/conversion/buildEpub')>();
  return {
    ...actual,
    buildEpub: async (chapters: EpubChapter[], ...rest: unknown[]) => {
      if (mode.value === 'throw') throw new Error('disk full');
      const used =
        mode.value === 'tamper'
          ? chapters.map((c, i) => (i === 0 ? { ...c, html: `${c.html}<p>tampered</p>` } : c))
          : chapters;
      return (actual.buildEpub as (...args: unknown[]) => Promise<Blob>)(used, ...rest);
    },
  };
});

const META = {
  title: 'My Novel',
  author: 'Author X',
  language: 'en',
  identifier: 'readest:abc123',
};
const url = (n: number) => `https://novel.example.com/book/chapter-${n}`;
const link = (n: number): NovelChapterLink => ({ title: `Chapter ${n}`, url: url(n) });
const chapter = (n: number): EpubChapter => ({
  title: `Chapter ${n}`,
  html: `<h1>Chapter ${n}</h1><p>Text of chapter ${n}.</p>`,
});
// Awkward on purpose: entities, quotes and markup that must survive verbatim.
const awkward: EpubChapter = {
  title: `Prologue & "Start" <1>'s`,
  html: '<h1>Prologue &amp; "Start"</h1><p>One &lt;two&gt; <em>three</em> <img src="images/a.png"/></p>',
};
const img = (name: string, bytes: number[]): EpubImage => ({
  path: `images/${name}`,
  bytes: new Uint8Array(bytes).buffer,
  mime: 'image/png',
});
const COVER: EpubImage = {
  path: 'cover.svg',
  bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
    .buffer as ArrayBuffer,
  mime: 'image/svg+xml',
};

async function makeNovel(
  count: number,
  options: { withSource?: boolean; sourceChapters?: NovelChapterLink[]; first?: EpubChapter } = {},
): Promise<Blob> {
  const { withSource = true, first } = options;
  const chapters = Array.from({ length: count }, (_, i) =>
    i === 0 && first ? first : chapter(i + 1),
  );
  const source: NovelSource = {
    version: 1,
    kind: 'toc',
    sourceUrl: 'https://novel.example.com/book',
    chapters: options.sourceChapters ?? Array.from({ length: count }, (_, i) => link(i + 1)),
  };
  return buildEpub(
    chapters,
    META,
    [img('a.png', [1, 2, 3]), img('b.png', [4, 5, 6])],
    COVER,
    withSource ? [{ path: NOVEL_SOURCE_FILENAME, content: serializeNovelSource(source) }] : [],
  );
}

async function unzip(blob: Blob): Promise<Map<string, Uint8Array>> {
  await configureZip();
  const { BlobReader, ZipReader, Uint8ArrayWriter } = await import('@zip.js/zip.js');
  const reader = new ZipReader(new BlobReader(blob));
  const out = new Map<string, Uint8Array>();
  for (const entry of await reader.getEntries()) {
    if (entry.directory) continue;
    out.set(entry.filename, await entry.getData!(new Uint8ArrayWriter()));
  }
  await reader.close();
  return out;
}
const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
const text = (b: Uint8Array) => new TextDecoder().decode(b);

beforeEach(() => {
  mode.value = 'normal';
});

describe('readNovelEpub', () => {
  test('reads metadata, chapters, images, cover and source exactly', async () => {
    const book = await readNovelEpub(await makeNovel(3, { first: awkward }));
    expect(book.metadata).toEqual(META);
    expect(book.chapters).toHaveLength(3);
    expect(book.chapters[0]).toEqual(awkward);
    expect(book.chapters[2]).toEqual(chapter(3));
    expect(book.images.map((i) => i.path)).toEqual(['images/a.png', 'images/b.png']);
    expect([...new Uint8Array(book.images[1]!.bytes)]).toEqual([4, 5, 6]);
    expect(book.cover?.path).toBe('cover.svg');
    expect(book.source?.chapters.map((c) => c.url)).toEqual([url(1), url(2), url(3)]);
  });

  test('returns no source for a novel without a record', async () => {
    const book = await readNovelEpub(await makeNovel(2, { withSource: false }));
    expect(book.source).toBeNull();
  });

  test('keeps the source record out of the manifest and spine', async () => {
    const files = await unzip(await makeNovel(2));
    expect(files.has(NOVEL_SOURCE_FILENAME)).toBe(true);
    expect(text(files.get('content.opf')!)).not.toContain(NOVEL_SOURCE_FILENAME);
  });

  test('rejects something that is not an EPUB', async () => {
    await expect(readNovelEpub(new Blob(['not a zip']))).rejects.toBeInstanceOf(Error);
  });
});

describe('appendChaptersToNovelEpub', () => {
  const added = (from: number, to: number) => ({
    chapters: Array.from({ length: to - from + 1 }, (_, i) => chapter(from + i)),
    links: Array.from({ length: to - from + 1 }, (_, i) => link(from + i)),
  });

  test('appends new chapters at the end, in order', async () => {
    const result = await appendChaptersToNovelEpub(await makeNovel(3), added(4, 6));
    expect(result.chapterCount).toBe(6);
    expect(result.addedCount).toBe(3);
    const book = await readNovelEpub(result.blob);
    expect(book.chapters.map((c) => c.title)).toEqual(
      [1, 2, 3, 4, 5, 6].map((n) => `Chapter ${n}`),
    );
    expect(book.source?.chapters.map((c) => c.url)).toEqual([1, 2, 3, 4, 5, 6].map(url));
  });

  test('keeps every existing chapter byte-for-byte, so positions and notes stay valid', async () => {
    const original = await makeNovel(3, { first: awkward });
    const before = await unzip(original);
    const after = await unzip((await appendChaptersToNovelEpub(original, added(4, 5))).blob);
    for (let n = 1; n <= 3; n++) {
      const name = `OEBPS/chapter${n}.xhtml`;
      expect(text(after.get(name)!)).toBe(text(before.get(name)!));
    }
    expect(after.has('OEBPS/chapter4.xhtml')).toBe(true);
    expect(after.has('OEBPS/chapter5.xhtml')).toBe(true);
    expect(after.has('OEBPS/chapter6.xhtml')).toBe(false);
  });

  test('keeps the identity of the book: identifier, title, author, language, cover, images', async () => {
    const original = await makeNovel(2);
    const before = await unzip(original);
    const result = await appendChaptersToNovelEpub(original, added(3, 3));
    const book = await readNovelEpub(result.blob);
    expect(book.metadata).toEqual(META);
    expect(book.cover?.path).toBe('cover.svg');
    const after = await unzip(result.blob);
    for (const name of ['OEBPS/images/a.png', 'OEBPS/images/b.png', 'OEBPS/cover.svg']) {
      expect([...after.get(name)!]).toEqual([...before.get(name)!]);
    }
  });

  test('adds new images and does not replace an existing image with the same path', async () => {
    const result = await appendChaptersToNovelEpub(await makeNovel(2), {
      ...added(3, 3),
      images: [img('a.png', [9, 9, 9]), img('c.png', [7, 8])],
    });
    const after = await unzip(result.blob);
    expect([...after.get('OEBPS/images/a.png')!]).toEqual([1, 2, 3]);
    expect([...after.get('OEBPS/images/c.png')!]).toEqual([7, 8]);
  });

  test('does not modify the input blob', async () => {
    const original = await makeNovel(3);
    const snapshot = await bytesOf(original);
    await appendChaptersToNovelEpub(original, added(4, 4));
    expect([...(await bytesOf(original))]).toEqual([...snapshot]);
  });

  test('refuses a book that has no source record', async () => {
    await expect(
      appendChaptersToNovelEpub(await makeNovel(2, { withSource: false }), added(3, 3)),
    ).rejects.toMatchObject({ code: 'no_source' });
  });

  test('refuses when the source record does not match the stored chapters', async () => {
    const book = await makeNovel(3, { sourceChapters: [link(1), link(2)] });
    await expect(appendChaptersToNovelEpub(book, added(4, 4))).rejects.toMatchObject({
      code: 'inconsistent_source',
    });
  });

  test('refuses chapters that are already stored (no duplicates)', async () => {
    await expect(
      appendChaptersToNovelEpub(await makeNovel(3), {
        chapters: [chapter(3)],
        links: [link(3)],
      }),
    ).rejects.toMatchObject({ code: 'inconsistent_source' });
  });

  test('refuses an empty or mismatched addition', async () => {
    const novel = await makeNovel(2);
    await expect(
      appendChaptersToNovelEpub(novel, { chapters: [], links: [] }),
    ).rejects.toMatchObject({ code: 'nothing_to_add' });
    await expect(
      appendChaptersToNovelEpub(novel, { chapters: [chapter(3)], links: [] }),
    ).rejects.toMatchObject({ code: 'inconsistent_source' });
  });

  test('a failure while building leaves the original untouched and reports the error', async () => {
    const original = await makeNovel(3);
    const snapshot = await bytesOf(original);
    mode.value = 'throw';
    await expect(appendChaptersToNovelEpub(original, added(4, 4))).rejects.toThrow('disk full');
    expect([...(await bytesOf(original))]).toEqual([...snapshot]);
  });

  test('refuses a rebuilt book whose old chapters changed (verification)', async () => {
    const original = await makeNovel(3);
    mode.value = 'tamper';
    const error = await appendChaptersToNovelEpub(original, added(4, 4)).catch((e) => e);
    expect(error).toBeInstanceOf(NovelEpubError);
    expect(error.code).toBe('verification_failed');
  });

  test('handles a large novel', async () => {
    const original = await makeNovel(1000);
    const result = await appendChaptersToNovelEpub(original, added(1001, 1010));
    expect(result.chapterCount).toBe(1010);
    expect((await readNovelEpub(result.blob)).chapters[1009]!.title).toBe('Chapter 1010');
  }, 60_000);
});
