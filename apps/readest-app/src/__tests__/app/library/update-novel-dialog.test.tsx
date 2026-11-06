import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import UpdateNovelDialog from '@/app/library/components/UpdateNovelDialog';
import type { Book } from '@/types/book';
import type { NovelUpdateOptions, NovelUpdateResult } from '@/services/novel/novelUpdate';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string, options?: Record<string, string | number>) => {
    if (!options) return key;
    return key.replace(/{{(\w+)}}/g, (_match, name) => String(options[name] ?? ''));
  },
}));

vi.mock('@/components/Dialog', () => ({
  __esModule: true,
  default: ({
    isOpen,
    title,
    children,
    onClose,
  }: {
    isOpen: boolean;
    title?: string;
    children: React.ReactNode;
    onClose?: () => void;
  }) =>
    isOpen ? (
      <div role='dialog' aria-label={title}>
        <button type='button' aria-label='dismiss' onClick={onClose} />
        {children}
      </div>
    ) : null,
}));

const loadBookContent = vi.fn();
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: { loadBookContent } }),
}));

const updateNovelMock = vi.fn();
vi.mock('@/services/novel/novelUpdate', () => ({
  updateNovel: (...args: unknown[]) => updateNovelMock(...args),
}));
vi.mock('@/services/novel/novelImport', () => ({
  isNovelImportCancelled: (err: unknown) =>
    err instanceof DOMException && err.name === 'AbortError',
}));

const book = { hash: 'h1', format: 'EPUB', title: 'My Novel', author: 'A' } as Book;
const link = (n: number) => ({ title: `Chapter ${n}`, url: `https://n.example.org/c/${n}` });
const updated = (over: Partial<Extract<NovelUpdateResult, { outcome: 'updated' }>> = {}) =>
  ({
    outcome: 'updated',
    blob: new Blob(['epub']),
    addedCount: 2,
    chapterCount: 7,
    failed: [],
    deferred: [],
    retitled: [],
    skipped: [],
    missingFromSource: [],
    ...over,
  }) as NovelUpdateResult;

const setup = (over: { onApply?: (file: File) => Promise<void> } = {}) => {
  const onClose = vi.fn();
  const onApply = over.onApply ?? vi.fn(async () => {});
  render(<UpdateNovelDialog book={book} onClose={onClose} onApply={onApply} />);
  return { onClose, onApply };
};

beforeEach(() => {
  loadBookContent.mockReset().mockResolvedValue({ book, file: new File(['x'], 'My Novel.epub') });
  updateNovelMock.mockReset();
});
afterEach(cleanup);

describe('UpdateNovelDialog', () => {
  it('renders nothing without a book', () => {
    render(<UpdateNovelDialog book={null} onClose={vi.fn()} onApply={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(loadBookContent).not.toHaveBeenCalled();
  });

  it('shows that it is checking, then replaces the book with the updated file', async () => {
    let finish: (value: NovelUpdateResult) => void = () => {};
    updateNovelMock.mockImplementation(
      (_file: Blob, options: NovelUpdateOptions) =>
        new Promise((resolve) => {
          options.onStage?.('checking');
          finish = resolve;
        }),
    );
    const { onApply } = setup();
    expect(await screen.findByText('Checking for new chapters…')).toBeTruthy();
    await act(async () => finish(updated()));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    const file = (onApply as ReturnType<typeof vi.fn>).mock.calls[0]![0] as File;
    expect(file.name).toBe('My Novel.epub');
    expect(await screen.findByText('Added 2 new chapters.')).toBeTruthy();
    expect(screen.getByText('The book now has 7 chapters.')).toBeTruthy();
  });

  it('shows download progress and can be cancelled without changing the book', async () => {
    updateNovelMock.mockImplementation(
      (_file: Blob, options: NovelUpdateOptions) =>
        new Promise((_resolve, reject) => {
          options.onStage?.('downloading');
          options.onProgress?.(1, 4);
          options.signal?.addEventListener('abort', () =>
            reject(new DOMException('cancelled', 'AbortError')),
          );
        }),
    );
    const { onApply, onClose } = setup();
    expect(await screen.findByText('1 / 4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onApply).not.toHaveBeenCalled();
  });

  it('says so when the book is already up to date', async () => {
    updateNovelMock.mockResolvedValue({ outcome: 'up_to_date', totalFound: 5 });
    const { onApply } = setup();
    expect(await screen.findByText('“My Novel” is up to date.')).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('reports chapters that failed or were deferred, and that they will be retried', async () => {
    updateNovelMock.mockResolvedValue(
      updated({ addedCount: 1, failed: [link(7)], deferred: [link(8), link(9)] }),
    );
    setup();
    // The test translator only substitutes values; real plural forms come from i18next.
    expect(await screen.findByText('Added 1 new chapters.')).toBeTruthy();
    expect(
      screen.getByText(
        '3 chapters were not added (1 failed to download). They will be tried again the next time you update.',
      ),
    ).toBeTruthy();
  });

  it('does not change the book when no new chapter could be downloaded', async () => {
    updateNovelMock.mockResolvedValue({
      outcome: 'nothing_added',
      failed: [link(6)],
      deferred: [link(7)],
    });
    const { onApply } = setup();
    expect(
      await screen.findByText(
        'None of the 2 new chapters could be downloaded. The book was not changed.',
      ),
    ).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('refuses to guess when the source no longer matches the book', async () => {
    updateNovelMock.mockResolvedValue({ outcome: 'source_mismatch' });
    const { onApply } = setup();
    expect(
      await screen.findByText(
        'The chapter list at the source no longer matches this book, so it was not changed.',
      ),
    ).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
  });

  it.each([
    ['not_a_novel', 'This book was not imported from a web novel, so it cannot be updated.'],
    [
      'no_source',
      'This book has no saved source, so it cannot be updated. Import it again to enable updates.',
    ],
    ['template_source', 'Books imported from a URL template cannot be updated yet.'],
  ])('explains why a %s book cannot be updated', async (reason, message) => {
    updateNovelMock.mockResolvedValue({ outcome: 'unsupported', reason });
    setup();
    expect(await screen.findByText(message)).toBeTruthy();
  });

  it('shows a network error and lets the user try again', async () => {
    updateNovelMock.mockRejectedValueOnce(new Error('The site is temporarily unavailable'));
    setup();
    expect(await screen.findByText('The site is temporarily unavailable')).toBeTruthy();
    updateNovelMock.mockResolvedValueOnce({ outcome: 'up_to_date', totalFound: 5 });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('“My Novel” is up to date.')).toBeTruthy();
  });

  it('tells the user when the book file cannot be read', async () => {
    loadBookContent.mockRejectedValue(new Error('missing'));
    setup();
    expect(await screen.findByText('Could not open the book file on this device.')).toBeTruthy();
    expect(updateNovelMock).not.toHaveBeenCalled();
  });

  it('keeps the original when saving the updated file fails', async () => {
    updateNovelMock.mockResolvedValue(updated());
    setup({ onApply: vi.fn(async () => Promise.reject(new Error('disk full'))) });
    expect(
      await screen.findByText('Could not save the updated book. It was not changed.'),
    ).toBeTruthy();
  });

  it('aborts the running update when the dialog is dismissed', async () => {
    let signal: AbortSignal | undefined;
    updateNovelMock.mockImplementation(
      (_file: Blob, options: NovelUpdateOptions) =>
        new Promise(() => {
          signal = options.signal;
        }),
    );
    const { onClose } = setup();
    await waitFor(() => expect(signal).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));
    expect(signal!.aborted).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });
});
