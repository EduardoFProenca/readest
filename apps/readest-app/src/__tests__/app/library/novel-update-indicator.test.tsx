import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import UpdateNovelDialog from '@/app/library/components/UpdateNovelDialog';
import NovelUpdateDot from '@/app/library/components/NovelUpdateDot';
import NovelUpdateCheckButton from '@/app/library/components/NovelUpdateCheckButton';
import { novelSourceMarker } from '@/services/novel/novelSource';
import { novelUpdateKey, useNovelUpdateStore } from '@/store/novelUpdateStore';
import { useLibraryStore } from '@/store/libraryStore';
import type { NovelUpdateResult } from '@/services/novel/novelUpdate';
import type { Book } from '@/types/book';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string, options?: Record<string, string | number>) =>
    options ? key.replace(/{{(\w+)}}/g, (_m, name) => String(options[name] ?? '')) : key,
}));
vi.mock('@/hooks/useResponsiveSize', () => ({ useResponsiveSize: (n: number) => n }));
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => true }));
vi.mock('@/components/Dialog', () => ({
  __esModule: true,
  default: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div role='dialog'>{children}</div> : null,
}));

const loadBookContent = vi.fn();
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: { loadBookContent } }),
}));
const updateNovelMock = vi.fn();
vi.mock('@/services/novel/novelUpdate', () => ({
  updateNovel: (...args: unknown[]) => updateNovelMock(...args),
}));
const checkMock = vi.fn();
vi.mock('@/services/novel/novelUpdateCheck', () => ({
  checkNovelForUpdates: (...args: unknown[]) => checkMock(...args),
}));
vi.mock('@/services/novel/novelImport', () => ({
  isNovelImportCancelled: (err: unknown) =>
    err instanceof DOMException && err.name === 'AbortError',
}));
const toast = vi.fn();
vi.mock('@/utils/event', () => ({
  eventDispatcher: { dispatch: (...args: unknown[]) => toast(...args), on: vi.fn(), off: vi.fn() },
}));

const novel = (id: string): Book =>
  ({
    hash: `file-${id}`,
    metaHash: `meta-${id}`,
    format: 'EPUB',
    title: `Novel ${id}`,
    author: 'A',
    metadata: { title: id, source: novelSourceMarker('https://n.example.org/toc') },
  }) as unknown as Book;
const plain = { hash: 'p', metaHash: 'mp', format: 'EPUB', title: 'Plain', author: 'A' } as Book;

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

const resetStore = () => {
  localStorage.clear();
  useNovelUpdateStore.setState({
    updates: {},
    checking: false,
    progress: { done: 0, total: 0 },
    lastCheck: null,
    busy: {},
  });
};

beforeEach(() => {
  resetStore();
  loadBookContent.mockReset().mockResolvedValue({ file: new File(['x'], 'n.epub') });
  updateNovelMock.mockReset();
  checkMock.mockReset();
  toast.mockReset();
  useLibraryStore.setState({ library: [] });
});
afterEach(cleanup);

describe('NovelUpdateDot', () => {
  it('shows only for a book with a confirmed update, and disappears when it is cleared', () => {
    const book = novel('a');
    render(<NovelUpdateDot book={book} />);
    expect(screen.queryByTestId('novel-update-dot')).toBeNull();
    act(() => useNovelUpdateStore.getState().markAvailable(novelUpdateKey(book), 2));
    expect(screen.getByTestId('novel-update-dot')).toBeTruthy();
    act(() => useNovelUpdateStore.getState().clear(novelUpdateKey(book)));
    expect(screen.queryByTestId('novel-update-dot')).toBeNull();
  });

  it('keeps the dot when the book gets a new file hash (updates re-key the book)', () => {
    act(() => useNovelUpdateStore.getState().markAvailable('meta-a', 1));
    render(<NovelUpdateDot book={{ ...novel('a'), hash: 'brand-new-hash' }} />);
    expect(screen.getByTestId('novel-update-dot')).toBeTruthy();
  });
});

describe('NovelUpdateCheckButton', () => {
  it('is hidden when the library has no web novel', () => {
    useLibraryStore.setState({ library: [plain] });
    render(<NovelUpdateCheckButton />);
    expect(screen.queryByTestId('novel-update-check-button')).toBeNull();
  });

  it('does not check anything until it is pressed', async () => {
    useLibraryStore.setState({ library: [novel('a'), plain] });
    render(<NovelUpdateCheckButton />);
    await new Promise((r) => setTimeout(r, 20));
    expect(checkMock).not.toHaveBeenCalled();
    expect(loadBookContent).not.toHaveBeenCalled();
  });

  it('checks only novels, shows the dot on those with updates and reports the count', async () => {
    useLibraryStore.setState({ library: [novel('a'), novel('b'), plain] });
    checkMock
      .mockResolvedValueOnce({ outcome: 'available', newCount: 3 })
      .mockResolvedValueOnce({ outcome: 'up_to_date' });
    render(<NovelUpdateCheckButton />);
    fireEvent.click(screen.getByTestId('novel-update-check-button'));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(checkMock).toHaveBeenCalledTimes(2);
    expect(Object.keys(useNovelUpdateStore.getState().updates)).toEqual(['meta-a']);
    expect(toast.mock.calls[0]![1]).toMatchObject({ message: '1 novels have new chapters.' });
    expect(screen.getByTestId('novel-update-check-dot')).toBeTruthy();
  });

  it('restores saved indicators on mount without querying anything', () => {
    localStorage.setItem(
      'readest-novel-updates',
      JSON.stringify({ version: 1, updates: { 'meta-a': { newCount: 2, checkedAt: 1 } } }),
    );
    useLibraryStore.setState({ library: [novel('a')] });
    render(<NovelUpdateCheckButton />);
    expect(useNovelUpdateStore.getState().updates['meta-a']).toBeDefined();
    expect(screen.getByTestId('novel-update-check-dot')).toBeTruthy();
    expect(checkMock).not.toHaveBeenCalled();
  });

  it('turns into a cancel button while checking and stops at the next book', async () => {
    useLibraryStore.setState({ library: [novel('a'), novel('b'), novel('c')] });
    let release: (v: unknown) => void = () => {};
    checkMock.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    render(<NovelUpdateCheckButton />);
    const button = screen.getByTestId('novel-update-check-button');
    fireEvent.click(button);
    await waitFor(() => expect(checkMock).toHaveBeenCalledTimes(1));
    expect(button.getAttribute('aria-label')).toContain('Cancel update check');
    fireEvent.click(button); // cancel
    await act(async () => release({ outcome: 'available', newCount: 1 }));
    await waitFor(() => expect(useNovelUpdateStore.getState().checking).toBe(false));
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
    expect(button.getAttribute('aria-label')).toBe('Check for updates');
  });

  it('a pressed button cannot start a second check while one runs', async () => {
    useLibraryStore.setState({ library: [novel('a')] });
    checkMock.mockImplementation(() => new Promise(() => {}));
    render(<NovelUpdateCheckButton />);
    const button = screen.getByTestId('novel-update-check-button');
    fireEvent.click(button);
    await waitFor(() => expect(checkMock).toHaveBeenCalledTimes(1));
    fireEvent.click(button); // cancels, never starts another
    expect(checkMock).toHaveBeenCalledTimes(1);
  });

  it('on a failed check says so, and keeps the indicator it already had', async () => {
    useLibraryStore.setState({ library: [novel('a')] });
    useNovelUpdateStore.getState().markAvailable('meta-a', 2);
    checkMock.mockRejectedValue(new Error('offline'));
    render(<NovelUpdateCheckButton />);
    fireEvent.click(screen.getByTestId('novel-update-check-button'));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0]![1]).toMatchObject({ type: 'warning' });
    expect(useNovelUpdateStore.getState().updates['meta-a']).toBeDefined();
  });
});

describe('UpdateNovelDialog and the indicator', () => {
  const run = async (result: NovelUpdateResult | Error, onApply = vi.fn(async () => {})) => {
    if (result instanceof Error) updateNovelMock.mockRejectedValue(result);
    else updateNovelMock.mockResolvedValue(result);
    render(<UpdateNovelDialog book={novel('a')} onClose={vi.fn()} onApply={onApply} />);
    await waitFor(() => expect(updateNovelMock).toHaveBeenCalled());
    await act(async () => {});
    return onApply;
  };
  beforeEach(() => useNovelUpdateStore.getState().markAvailable('meta-a', 3));

  it('removes the indicator once the new chapters were added', async () => {
    const onApply = await run(updated());
    expect(onApply).toHaveBeenCalled();
    expect(useNovelUpdateStore.getState().updates['meta-a']).toBeUndefined();
  });

  it('keeps the indicator when the download fails', async () => {
    await run(new Error('network down'));
    expect(useNovelUpdateStore.getState().updates['meta-a']).toBeDefined();
  });

  it('keeps the indicator when nothing could be added', async () => {
    await run({
      outcome: 'nothing_added',
      failed: [],
      deferred: [],
      failureKinds: [],
    } as NovelUpdateResult);
    expect(useNovelUpdateStore.getState().updates['meta-a']).toBeDefined();
  });

  it('keeps the indicator when saving the updated book fails', async () => {
    await run(
      updated(),
      vi.fn(async () => {
        throw new Error('disk full');
      }),
    );
    expect(useNovelUpdateStore.getState().updates['meta-a']).toBeDefined();
  });

  it('keeps it, with the remaining count, when only some chapters were added', async () => {
    const l = { title: 'c', url: 'https://n.example.org/c/9' };
    await run(updated({ failed: [l], deferred: [l, l] }));
    expect(useNovelUpdateStore.getState().updates['meta-a']?.newCount).toBe(3);
  });

  it('keeps it when the per-update limit stopped before the end', async () => {
    await run(updated({ limitReached: true }));
    expect(useNovelUpdateStore.getState().updates['meta-a']).toBeDefined();
  });

  it('removes it when the source turns out to be up to date', async () => {
    await run({ outcome: 'up_to_date', totalFound: 5 });
    expect(useNovelUpdateStore.getState().updates['meta-a']).toBeUndefined();
  });

  it('does not start a second update for a book that is already being checked', async () => {
    useNovelUpdateStore.getState().acquire('meta-a', 'check-1');
    render(<UpdateNovelDialog book={novel('a')} onClose={vi.fn()} onApply={vi.fn()} />);
    await act(async () => {});
    expect(updateNovelMock).not.toHaveBeenCalled();
    expect(screen.getByText(/already being checked or updated/)).toBeTruthy();
  });

  it('releases the book when the update ends, so it can be checked again', async () => {
    await run(updated());
    expect(useNovelUpdateStore.getState().busy).toEqual({});
  });

  it('does not release a lock it never acquired (another check keeps its lock)', async () => {
    useNovelUpdateStore.getState().acquire('meta-a', 'check-9');
    const { unmount } = render(
      <UpdateNovelDialog book={novel('a')} onClose={vi.fn()} onApply={vi.fn()} />,
    );
    await act(async () => {});
    unmount();
    expect(useNovelUpdateStore.getState().busy['meta-a']).toBe('check-9');
  });

  it('updates two different novels in the same session', async () => {
    updateNovelMock.mockResolvedValue(updated());
    useNovelUpdateStore.getState().markAvailable('meta-b', 1);
    const onApply = vi.fn(async () => {});
    const { rerender } = render(
      <UpdateNovelDialog book={novel('a')} onClose={vi.fn()} onApply={onApply} />,
    );
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    rerender(<UpdateNovelDialog book={null} onClose={vi.fn()} onApply={onApply} />);
    rerender(<UpdateNovelDialog book={novel('b')} onClose={vi.fn()} onApply={onApply} />);
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(2));
    expect(updateNovelMock).toHaveBeenCalledTimes(2);
    expect(useNovelUpdateStore.getState().updates).toEqual({});
    expect(useNovelUpdateStore.getState().busy).toEqual({});
  });

  it('after a failed update of one novel, the next novel still updates and the first keeps its dot', async () => {
    updateNovelMock
      .mockResolvedValueOnce({
        outcome: 'nothing_added',
        failed: [],
        deferred: [],
        failureKinds: ['error'],
      })
      .mockResolvedValueOnce(updated());
    useNovelUpdateStore.getState().markAvailable('meta-b', 1);
    const onApply = vi.fn(async () => {});
    const { rerender } = render(
      <UpdateNovelDialog book={novel('a')} onClose={vi.fn()} onApply={onApply} />,
    );
    await act(async () => {});
    expect(useNovelUpdateStore.getState().busy).toEqual({});
    rerender(<UpdateNovelDialog book={null} onClose={vi.fn()} onApply={onApply} />);
    rerender(<UpdateNovelDialog book={novel('b')} onClose={vi.fn()} onApply={onApply} />);
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(useNovelUpdateStore.getState().updates['meta-a']).toBeDefined();
    expect(useNovelUpdateStore.getState().updates['meta-b']).toBeUndefined();
  });
});
