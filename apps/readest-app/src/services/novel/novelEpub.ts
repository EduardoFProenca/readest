import { buildEpub } from '@/services/send/conversion/buildEpub';
import type { EpubBuildMetadata, EpubChapter, EpubImage } from '@/services/send/conversion/types';
import { configureZip } from '@/utils/zip';
import type { NovelChapterLink } from './chapterList';
import { NOVEL_SOURCE_FILENAME, parseNovelSource, serializeNovelSource } from './novelSource';
import type { NovelSource } from './novelSource';

export type NovelEpubErrorCode =
  | 'unsupported_structure'
  | 'no_source'
  | 'inconsistent_source'
  | 'nothing_to_add'
  | 'verification_failed';

export class NovelEpubError extends Error {
  constructor(
    message: string,
    readonly code: NovelEpubErrorCode,
  ) {
    super(message);
    this.name = 'NovelEpubError';
  }
}

export interface NovelEpubContents {
  metadata: EpubBuildMetadata;
  chapters: EpubChapter[];
  images: EpubImage[];
  cover?: EpubImage;
  source: NovelSource | null;
}

const DC_NS = 'http://purl.org/dc/elements/1.1/';
const CHAPTER_HREF = /^OEBPS\/chapter\d+\.xhtml$/;

async function unzipAll(blob: Blob): Promise<Map<string, Uint8Array>> {
  await configureZip();
  const { BlobReader, ZipReader, Uint8ArrayWriter } = await import('@zip.js/zip.js');
  const reader = new ZipReader(new BlobReader(blob));
  try {
    const out = new Map<string, Uint8Array>();
    for (const entry of await reader.getEntries()) {
      if (entry.directory) continue;
      out.set(entry.filename, await entry.getData!(new Uint8ArrayWriter()));
    }
    return out;
  } finally {
    await reader.close();
  }
}

const toBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const unescapeXml = (value: string): string =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((value, i) => value === b[i]);

const unsupported = (message: string) => new NovelEpubError(message, 'unsupported_structure');

/**
 * Read an EPUB produced by `buildEpub` back into the pieces it was built from.
 * Chapter bodies are returned exactly as written, so rebuilding them yields
 * byte-identical chapter files.
 */
export async function readNovelEpub(blob: Blob): Promise<NovelEpubContents> {
  const files = await unzipAll(blob);
  const decoder = new TextDecoder();
  const opfBytes = files.get('content.opf');
  if (!opfBytes) throw unsupported('Not a novel EPUB: content.opf is missing.');
  const opf = new DOMParser().parseFromString(decoder.decode(opfBytes), 'application/xml');
  if (opf.querySelector('parsererror')) throw unsupported('The EPUB package file is invalid.');

  const dc = (name: string) => opf.getElementsByTagNameNS(DC_NS, name)[0]?.textContent ?? '';
  const metadata: EpubBuildMetadata = {
    title: dc('title'),
    author: dc('creator'),
    language: dc('language'),
    identifier: dc('identifier'),
    ...(dc('source') ? { source: dc('source') } : {}),
  };

  const manifest = new Map<string, { href: string; mime: string }>();
  for (const item of Array.from(opf.getElementsByTagName('item'))) {
    manifest.set(item.getAttribute('id') ?? '', {
      href: item.getAttribute('href') ?? '',
      mime: item.getAttribute('media-type') ?? '',
    });
  }
  const coverId = opf.querySelector('meta[name="cover"]')?.getAttribute('content') ?? '';

  const chapters: EpubChapter[] = [];
  const chapterHrefs = new Set<string>();
  for (const itemref of Array.from(opf.getElementsByTagName('itemref'))) {
    const item = manifest.get(itemref.getAttribute('idref') ?? '');
    const xhtmlBytes = item && CHAPTER_HREF.test(item.href) ? files.get(item.href) : undefined;
    if (!item || !xhtmlBytes) throw unsupported('This EPUB was not built from web-novel chapters.');
    const xhtml = decoder.decode(xhtmlBytes);
    const title = /<title>([\s\S]*?)<\/title>/.exec(xhtml)?.[1];
    const start = xhtml.indexOf('<body>');
    const end = xhtml.lastIndexOf('</body>');
    if (title === undefined || start < 0 || end < start) {
      throw unsupported('A chapter file has an unexpected structure.');
    }
    chapterHrefs.add(item.href);
    chapters.push({ title: unescapeXml(title), html: xhtml.slice(start + '<body>'.length, end) });
  }

  const images: EpubImage[] = [];
  let cover: EpubImage | undefined;
  for (const [id, { href, mime }] of manifest) {
    if (!href.startsWith('OEBPS/') || chapterHrefs.has(href)) continue;
    const bytes = files.get(href);
    if (!bytes) throw unsupported(`A listed resource is missing: ${href}`);
    const image = { path: href.slice('OEBPS/'.length), bytes: toBuffer(bytes), mime };
    if (id === coverId) cover = image;
    else images.push(image);
  }

  const sourceBytes = files.get(NOVEL_SOURCE_FILENAME);
  const source = sourceBytes ? parseNovelSource(decoder.decode(sourceBytes)) : null;
  return { metadata, chapters, images, cover, source };
}

export interface AddedChapters {
  chapters: EpubChapter[];
  /** One link per chapter, same order: the URLs recorded in the source. */
  links: NovelChapterLink[];
  images?: EpubImage[];
}

export interface AppendResult {
  blob: Blob;
  chapterCount: number;
  addedCount: number;
}

/**
 * Append chapters to the end of a novel EPUB. The new book is built in memory
 * and checked against the original before it is returned; the input is never
 * modified. Existing chapters, images, cover and identity are carried over
 * unchanged, so reading positions and annotations stay valid.
 */
export async function appendChaptersToNovelEpub(
  original: Blob,
  added: AddedChapters,
): Promise<AppendResult> {
  const old = await readNovelEpub(original);
  const { source } = old;
  if (!source) {
    throw new NovelEpubError('This book has no recorded source to update from.', 'no_source');
  }
  if (source.chapters.length !== old.chapters.length) {
    throw new NovelEpubError(
      'The recorded source does not match the chapters in this book.',
      'inconsistent_source',
    );
  }
  if (added.chapters.length === 0 && added.links.length === 0) {
    throw new NovelEpubError('There are no new chapters to add.', 'nothing_to_add');
  }
  const stored = new Set(source.chapters.map((chapter) => chapter.url));
  const incoming = new Set(added.links.map((link) => link.url));
  if (
    added.chapters.length !== added.links.length ||
    incoming.size !== added.links.length ||
    added.links.some((link) => stored.has(link.url))
  ) {
    throw new NovelEpubError(
      'The new chapters overlap the stored ones or do not match their links.',
      'inconsistent_source',
    );
  }

  const knownPaths = new Set(old.images.map((image) => image.path));
  const images = [
    ...old.images,
    ...(added.images ?? []).filter((image) => !knownPaths.has(image.path)),
  ];
  const nextSource: NovelSource = {
    ...source,
    chapters: [...source.chapters, ...added.links.map(({ title, url }) => ({ title, url }))],
  };
  const blob = await buildEpub(
    [...old.chapters, ...added.chapters],
    old.metadata,
    images,
    old.cover,
    [{ path: NOVEL_SOURCE_FILENAME, content: serializeNovelSource(nextSource) }],
  );

  await verifyAppend(original, blob, old, nextSource, added.chapters.length);
  return {
    blob,
    chapterCount: old.chapters.length + added.chapters.length,
    addedCount: added.chapters.length,
  };
}

async function verifyAppend(
  original: Blob,
  rebuilt: Blob,
  old: NovelEpubContents,
  nextSource: NovelSource,
  addedCount: number,
): Promise<void> {
  const fail = (detail: string) =>
    new NovelEpubError(`The updated book failed verification: ${detail}`, 'verification_failed');
  const before = await unzipAll(original);
  const after = await unzipAll(rebuilt);
  // Every resource of the old book (chapters, images, cover) must be byte-identical.
  for (const [name, bytes] of before) {
    if (!name.startsWith('OEBPS/')) continue;
    const next = after.get(name);
    if (!next || !sameBytes(bytes, next)) throw fail(`${name} changed`);
  }
  const book = await readNovelEpub(rebuilt);
  const expected = old.chapters.length + addedCount;
  if (book.chapters.length !== expected) throw fail('chapter count is wrong');
  const { title, author, language, identifier, source } = old.metadata;
  if (
    book.metadata.source !== source ||
    book.metadata.title !== title ||
    book.metadata.author !== author ||
    book.metadata.language !== language ||
    book.metadata.identifier !== identifier
  ) {
    throw fail('book identity changed');
  }
  if (book.source?.chapters.length !== nextSource.chapters.length) {
    throw fail('source record is wrong');
  }
}
