import React, { useMemo } from 'react';
import { MdOutlineSystemUpdateAlt } from 'react-icons/md';
import { useResponsiveSize } from '@/hooks/useResponsiveSize';
import { useTranslation } from '@/hooks/useTranslation';
import { isTauriAppPlatform } from '@/services/environment';
import { eligibleNovels } from '@/services/novel/novelUpdateCheckRunner';
import { useLibraryStore } from '@/store/libraryStore';
import { useNovelUpdateStore } from '@/store/novelUpdateStore';
import { eventDispatcher } from '@/utils/event';
import { useNovelUpdateCheck } from '@/hooks/useNovelUpdateCheck';

/**
 * Header button for the manual check. Hidden when the library has no web novel (or the
 * platform can't update one). While checking it becomes a cancel button with progress.
 */
const NovelUpdateCheckButton: React.FC = () => {
  const _ = useTranslation();
  const iconSize = useResponsiveSize(18);
  const library = useLibraryStore((s) => s.library);
  const { start, cancel, checking, progress } = useNovelUpdateCheck();
  const pending = useNovelUpdateStore((s) => Object.keys(s.updates).length);
  const hasNovels = useMemo(() => eligibleNovels(library).length > 0, [library]);

  if (!isTauriAppPlatform() || (!hasNovels && !checking)) return null;

  const handleClick = async () => {
    if (checking) return cancel();
    const summary = await start();
    if (!summary || summary.cancelled) return;
    const message =
      summary.withUpdates > 0
        ? _('{{count}} novels have new chapters.', { count: summary.withUpdates })
        : summary.failed > 0
          ? _('No new chapters found. {{count}} novels could not be checked.', {
              count: summary.failed,
            })
          : _('All novels are up to date.');
    eventDispatcher.dispatch('toast', {
      type: summary.failed > 0 && summary.withUpdates === 0 ? 'warning' : 'info',
      message,
      timeout: 4000,
    });
  };

  const label = checking
    ? _('Cancel update check ({{done}}/{{total}})', progress)
    : _('Check for updates');

  return (
    <button
      type='button'
      onClick={handleClick}
      aria-label={label}
      title={label}
      data-testid='novel-update-check-button'
      className='exclude-title-bar-mousedown btn btn-ghost relative h-8 min-h-8 w-8 p-0'
    >
      {checking ? (
        <span className='loading loading-spinner loading-sm' />
      ) : (
        <MdOutlineSystemUpdateAlt role='none' size={iconSize} />
      )}
      {!checking && pending > 0 && (
        <span
          data-testid='novel-update-check-dot'
          className='bg-primary eink-bordered absolute end-0.5 top-0.5 h-2 w-2 rounded-full'
        />
      )}
    </button>
  );
};

export default NovelUpdateCheckButton;
