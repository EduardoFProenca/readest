import React from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { novelUpdateKey, useNovelUpdateStore } from '@/store/novelUpdateStore';
import type { Book } from '@/types/book';

/** Dot on a cover: shown only while a check has confirmed chapters this book does not have. */
const NovelUpdateDot: React.FC<{ book: Pick<Book, 'hash' | 'metaHash'> }> = ({ book }) => {
  const _ = useTranslation();
  const hasUpdate = useNovelUpdateStore((s) => !!s.updates[novelUpdateKey(book)]);
  if (!hasUpdate) return null;
  return (
    <span
      role='img'
      aria-label={_('New chapters available')}
      title={_('New chapters available')}
      data-testid='novel-update-dot'
      className='bg-primary border-base-100 eink-bordered pointer-events-none absolute end-1 top-1 z-10 h-3 w-3 rounded-full border-2'
    />
  );
};

export default NovelUpdateDot;
