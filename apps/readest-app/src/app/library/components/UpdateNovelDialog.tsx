'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MdMenuBook } from 'react-icons/md';
import Dialog from '@/components/Dialog';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { isNovelImportCancelled } from '@/services/novel/novelImport';
import type { ChapterFailureKind } from '@/services/novel/novelImport';
import { updateNovel } from '@/services/novel/novelUpdate';
import type { NovelUpdateResult, NovelUpdateStage } from '@/services/novel/novelUpdate';
import { newLockOwner, novelUpdateKey, useNovelUpdateStore } from '@/store/novelUpdateStore';
import type { Book } from '@/types/book';

interface UpdateNovelDialogProps {
  /** The book to update; the dialog is open while this is set. */
  book: Book | null;
  onClose: () => void;
  /** Hand the updated `.epub` to the normal library import, which keeps the book's progress and notes. */
  onApply: (file: File) => Promise<void>;
}

type State =
  | {
      phase: 'working';
      stage: NovelUpdateStage;
      done: number;
      total: number;
      /** Title of the chapter being downloaded. */
      current?: string;
    }
  | { phase: 'result'; result: NovelUpdateResult }
  | { phase: 'error'; message: string };

const working = (stage: NovelUpdateStage): State => ({
  phase: 'working',
  stage,
  done: 0,
  total: 0,
});

/**
 * "Update novel" from a book's menu: checks the source for new chapters and
 * appends them. Cancellable while it works; the stored book is only replaced
 * once the whole updated file is built and verified.
 */
const UpdateNovelDialog: React.FC<UpdateNovelDialogProps> = ({ book, onClose, onApply }) => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const [state, setState] = useState<State>(working('checking'));
  const [attempt, setAttempt] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const runUpdate = useCallback(
    async (target: Book, controller: AbortController) => {
      setState(working('checking'));
      let source: File;
      try {
        if (!appService) throw new Error('App service is not ready');
        source = (await appService.loadBookContent(target)).file;
      } catch {
        if (!controller.signal.aborted) {
          setState({ phase: 'error', message: _('Could not open the book file on this device.') });
        }
        return;
      }
      try {
        const result = await updateNovel(source, {
          signal: controller.signal,
          translate: _,
          onStage: (stage) => setState(working(stage)),
          onProgress: (done, total) =>
            setState((current) =>
              current.phase === 'working'
                ? { ...current, stage: 'downloading', done, total }
                : current,
            ),
          onChapterStart: (chapter) =>
            setState((current) =>
              current.phase === 'working' ? { ...current, current: chapter.title } : current,
            ),
        });
        if (controller.signal.aborted) return;
        if (result.outcome === 'updated') {
          try {
            await onApply(
              new File([result.blob], `${target.title}.epub`, { type: 'application/epub+zip' }),
            );
          } catch {
            if (!controller.signal.aborted) {
              setState({
                phase: 'error',
                message: _('Could not save the updated book. It was not changed.'),
              });
            }
            return;
          }
        }
        // The library dot follows the real outcome. A failed or cancelled update never reaches here.
        const dot = useNovelUpdateStore.getState();
        const key = novelUpdateKey(target);
        if (result.outcome === 'updated') {
          const left = result.failed.length + result.deferred.length;
          if (left > 0 || result.limitReached) dot.markAvailable(key, left || null);
          else dot.clear(key);
        } else if (result.outcome !== 'nothing_added') {
          dot.clear(key);
        }
        if (!controller.signal.aborted) setState({ phase: 'result', result });
      } catch (e) {
        if (isNovelImportCancelled(e) || controller.signal.aborted) return;
        // Network and parsing errors reach us as Error (or a raw string from the native layer).
        const message =
          e instanceof Error
            ? e.message
            : typeof e === 'string'
              ? e
              : _('Could not check for new chapters.');
        setState({ phase: 'error', message });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appService, onApply],
  );

  useEffect(() => {
    if (!book) return;
    const store = useNovelUpdateStore.getState();
    const key = novelUpdateKey(book);
    const owner = newLockOwner('update');
    // A book being checked or updated elsewhere is not queried a second time. Only a lock
    // this dialog acquired is ever released by it, so it can't free another operation's.
    if (!store.acquire(key, owner)) {
      setState({
        phase: 'error',
        message: _('This novel is already being checked or updated. Try again in a moment.'),
      });
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    void runUpdate(book, controller).finally(() => store.release(key, owner));
    return () => {
      controller.abort();
      // Frees the book even if the running update never settles after the abort.
      store.release(key, owner);
    };
    // `attempt` re-runs the update after "Try again".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, attempt]);

  const close = () => {
    abortRef.current?.abort();
    onClose();
  };

  if (!book) return null;

  const failureReason = (kind: ChapterFailureKind | undefined): string =>
    kind === 'missing'
      ? _('The chapter is listed but the source says it does not exist (yet).')
      : kind === 'unreadable'
        ? _(
            'The chapter page has no readable text. It may not be published yet, or need a sign-in.',
          )
        : _('The source could not be reached or refused the request. Try again later.');

  const message = (result: NovelUpdateResult): string[] => {
    switch (result.outcome) {
      case 'up_to_date':
        return [_('“{{title}}” is up to date.', { title: book.title })];
      case 'source_mismatch':
        return [
          _('The chapter list at the source no longer matches this book, so it was not changed.'),
        ];
      case 'nothing_added':
        return [
          _('None of the {{count}} new chapters could be downloaded. The book was not changed.', {
            count: result.failed.length + result.deferred.length,
          }),
          failureReason(result.failureKinds[0]),
        ];
      case 'unsupported':
        return [
          result.reason === 'no_source'
            ? _(
                'This book has no saved source, so it cannot be updated. Import it again to enable updates.',
              )
            : _('This book was not imported from a web novel, so it cannot be updated.'),
        ];
      case 'updated': {
        const lines = [
          _('Added {{count}} new chapters.', { count: result.addedCount }),
          _('The book now has {{count}} chapters.', { count: result.chapterCount }),
        ];
        if (result.limitReached) {
          lines.push(
            _('This update stopped at its limit. Update again to look for more chapters.'),
          );
        }
        const notAdded = result.failed.length + result.deferred.length;
        if (notAdded > 0) {
          lines.push(
            _(
              '{{count}} chapters were not added ({{failed}} failed to download). They will be tried again the next time you update.',
              { count: notAdded, failed: result.failed.length },
            ),
          );
        }
        return lines;
      }
    }
  };

  const canRetry =
    state.phase === 'error' ||
    (state.phase === 'result' && state.result.outcome === 'nothing_added');

  return (
    <Dialog
      isOpen
      onClose={close}
      title={_('Update Novel')}
      boxClassName='sm:w-[480px]! sm:max-w-[480px]! sm:h-auto! sm:max-h-[80vh]!'
    >
      <div className='flex flex-col gap-4 pb-6 pt-2'>
        <div className='flex items-start gap-4'>
          <MdMenuBook aria-hidden='true' className='text-base-content/70 mt-1 h-8 w-8 shrink-0' />
          <p className='min-w-0 break-words text-lg font-semibold leading-snug'>{book.title}</p>
        </div>

        {state.phase === 'working' && (
          <div className='flex flex-col gap-3' role='status'>
            {state.stage === 'checking' ? (
              <p className='text-base-content/70 text-sm'>{_('Checking for new chapters…')}</p>
            ) : (
              <>
                <p className='text-sm font-medium'>
                  {_('Updating: {{title}}', { title: book.title })}
                </p>
                {state.total > 0 ? (
                  <>
                    <p className='text-sm tabular-nums' data-testid='novel-update-chapter-count'>
                      {_('Chapter {{current}} of {{total}}', {
                        current: Math.min(state.done + 1, state.total),
                        total: state.total,
                      })}
                    </p>
                    <progress
                      aria-label={_('Downloading new chapters…')}
                      className='progress eink-bordered block h-2 w-full'
                      value={state.done}
                      max={state.total}
                    />
                    <div className='flex justify-between gap-4 text-sm tabular-nums'>
                      <span className='text-base-content/70'>
                        {_('{{done}} downloaded, {{left}} left', {
                          done: state.done,
                          left: state.total - state.done,
                        })}
                      </span>
                      <span className='font-medium'>
                        {Math.round((state.done / state.total) * 100)}%
                      </span>
                    </div>
                  </>
                ) : (
                  // URL-template books are probed until a chapter does not exist: no total yet,
                  // so no bar and no percentage.
                  <p className='text-sm tabular-nums'>
                    {_('{{count}} chapters downloaded so far', { count: state.done })}
                  </p>
                )}
                {state.current && (
                  <p className='text-base-content/70 break-words text-sm'>
                    {_('Downloading: {{title}}', { title: state.current })}
                  </p>
                )}
              </>
            )}
            <p className='text-base-content/60 text-sm leading-relaxed'>
              {_('Keep Readest open until the update is complete.')}
            </p>
          </div>
        )}

        {state.phase === 'result' && (
          <div className='flex flex-col gap-1'>
            {message(state.result).map((line) => (
              <p key={line} className='text-sm leading-relaxed'>
                {line}
              </p>
            ))}
          </div>
        )}

        {state.phase === 'error' && (
          <p className='text-error text-sm leading-relaxed'>{state.message}</p>
        )}

        <div className='flex justify-end gap-2 pt-1'>
          {state.phase === 'working' ? (
            <button type='button' className='btn btn-ghost btn-sm eink-bordered' onClick={close}>
              {_('Cancel')}
            </button>
          ) : (
            <>
              {canRetry && (
                <button
                  type='button'
                  className='btn btn-ghost btn-sm eink-bordered'
                  onClick={() => setAttempt((n) => n + 1)}
                >
                  {_('Try again')}
                </button>
              )}
              <button type='button' className='btn btn-contrast btn-sm' onClick={close}>
                {_('Close')}
              </button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
};

export default UpdateNovelDialog;
