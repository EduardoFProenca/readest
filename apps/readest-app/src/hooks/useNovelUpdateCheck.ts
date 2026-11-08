import { useCallback, useEffect, useRef } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useLibraryStore } from '@/store/libraryStore';
import { useNovelUpdateStore } from '@/store/novelUpdateStore';
import { runNovelUpdateCheck } from '@/services/novel/novelUpdateCheckRunner';

/**
 * Drives the library's "Check for updates" button. Nothing runs on its own:
 * the saved indicators are restored on mount, and a check starts only from `start()`.
 */
export const useNovelUpdateCheck = () => {
  const { appService } = useEnv();
  const checking = useNovelUpdateStore((s) => s.checking);
  const progress = useNovelUpdateStore((s) => s.progress);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    useNovelUpdateStore.getState().restore();
    return () => abortRef.current?.abort();
  }, []);

  const start = useCallback(async () => {
    if (!appService || useNovelUpdateStore.getState().checking) return null;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      return await runNovelUpdateCheck(useLibraryStore.getState().library, {
        signal: controller.signal,
        loadFile: async (book) => (await appService.loadBookContent(book)).file,
      });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [appService]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  return { start, cancel, checking, progress };
};
