import clsx from 'clsx';
import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { BookCharacter } from '@/types/book';
import {
  ActiveMention,
  applyMention,
  filterMentionCandidates,
  getActiveMention,
  parseMentions,
} from '@/app/reader/utils/characterMentions';

const DEFAULT_DOT_COLOR = '#f97316';

interface MentionTextProps {
  text: string;
  characters: BookCharacter[];
  onOpen: (characterId: string) => void;
}

/** A note rendered with its `@mentions` as links to the character sheets. */
export const MentionText: React.FC<MentionTextProps> = ({ text, characters, onOpen }) => {
  const _ = useTranslation();
  const byId = useMemo(() => new Map(characters.map((c) => [c.id, c])), [characters]);
  return (
    <span className='whitespace-pre-wrap break-words'>
      {parseMentions(text).map((segment, i) => {
        if (segment.type === 'text') return <React.Fragment key={i}>{segment.text}</React.Fragment>;
        const character = byId.get(segment.id);
        if (!character) {
          return (
            <span
              key={i}
              className='text-base-content/50 italic'
              title={_('This character no longer exists')}
            >
              @{segment.name}
            </span>
          );
        }
        return (
          <button
            key={i}
            type='button'
            className='text-primary font-medium hover:underline'
            onClick={(e) => {
              e.stopPropagation();
              onOpen(character.id);
            }}
          >
            @{character.name}
          </button>
        );
      })}
    </span>
  );
};

interface MentionTextareaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> {
  value: string;
  onValueChange: (value: string) => void;
  /** Characters offered after typing `@`. */
  characters: BookCharacter[];
  /** The character being edited, which is not offered as a mention. */
  excludeId?: string;
}

/**
 * A textarea that suggests characters while typing `@`. The list is an inline
 * popover (not a modal), so the text, caret and focus stay in the editor.
 */
export const MentionTextarea: React.FC<MentionTextareaProps> = ({
  value,
  onValueChange,
  characters,
  excludeId,
  onKeyDown,
  onBlur,
  ...rest
}) => {
  const _ = useTranslation();
  const listId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const [active, setActive] = useState<ActiveMention | null>(null);
  // `@` the reader chose to keep as a literal character (Escape).
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [placeAbove, setPlaceAbove] = useState(false);

  const open = !!active && active.start !== dismissedAt;
  const query = active?.query;
  const candidates = useMemo(
    () => (open ? filterMentionCandidates(characters, query ?? '', excludeId) : []),
    [open, characters, query, excludeId],
  );

  const refreshActive = (text: string, caret: number) => {
    const next = getActiveMention(text, caret);
    if (!next) setDismissedAt(null);
    setActive((prev) => (prev?.start === next?.start && prev?.query === next?.query ? prev : next));
  };

  useEffect(() => setHighlight(0), [query]);

  // Put the caret after the inserted mention once the new value is rendered.
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    textareaRef.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [value]);

  // Open upwards when the keyboard or screen edge leaves no room below.
  useLayoutEffect(() => {
    if (!open || !textareaRef.current) return;
    const rect = textareaRef.current.getBoundingClientRect();
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const below = viewportHeight - rect.bottom;
    setPlaceAbove(below < 200 && rect.top > below);
  }, [open, query]);

  useEffect(() => {
    const option = listRef.current?.children[highlight] as HTMLElement | undefined;
    option?.scrollIntoView?.({ block: 'nearest' });
  }, [highlight, open]);

  const choose = (character: BookCharacter) => {
    const el = textareaRef.current;
    if (!active || !el) return;
    const result = applyMention(value, active, el.selectionStart, character);
    pendingCaret.current = result.caret;
    onValueChange(result.text);
    setActive(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(e);
    if (!open || e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setDismissedAt(active!.start);
    } else if (candidates.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setHighlight((h) => (h + step + candidates.length) % candidates.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        choose(candidates[highlight]!);
      }
    }
  };

  return (
    <div className='relative w-full'>
      <textarea
        {...rest}
        ref={textareaRef}
        value={value}
        role='combobox'
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && candidates.length ? `${listId}-${highlight}` : undefined}
        aria-autocomplete='list'
        aria-haspopup='listbox'
        onChange={(e) => {
          onValueChange(e.target.value);
          refreshActive(e.target.value, e.target.selectionStart);
        }}
        onSelect={(e) => refreshActive(e.currentTarget.value, e.currentTarget.selectionStart)}
        onKeyDown={handleKeyDown}
        onBlur={(e) => {
          setActive(null);
          onBlur?.(e);
        }}
      />
      {open && (
        <div
          id={listId}
          ref={listRef}
          role='listbox'
          aria-label={_('Characters')}
          // Keep focus in the textarea while picking with the pointer.
          onMouseDown={(e) => e.preventDefault()}
          className={clsx(
            'bg-base-100 border-base-300 eink-bordered absolute inset-x-0 z-50 max-h-48 overflow-y-auto rounded-lg border shadow-lg',
            placeAbove ? 'bottom-full mb-1' : 'top-full mt-1',
          )}
        >
          {candidates.length === 0 && (
            <div role='status' className='text-base-content/60 px-3 py-2 text-sm'>
              {_('No characters found')}
            </div>
          )}
          {candidates.map((character, i) => (
            <div
              key={character.id}
              id={`${listId}-${i}`}
              role='option'
              aria-selected={i === highlight}
              onClick={() => choose(character)}
              onMouseEnter={() => setHighlight(i)}
              className={clsx(
                'flex cursor-pointer items-center gap-2 px-3 py-2 text-sm',
                i === highlight && 'bg-base-200',
              )}
            >
              {character.avatarSrc ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={character.avatarSrc}
                  alt=''
                  className='h-6 w-6 shrink-0 rounded-full object-cover'
                />
              ) : (
                <span
                  className='h-3 w-3 shrink-0 rounded-full'
                  style={{ backgroundColor: character.color ?? DEFAULT_DOT_COLOR }}
                />
              )}
              <span className='truncate font-medium'>{character.name}</span>
              {!!character.aliases?.length && (
                <span className='text-base-content/50 truncate text-xs'>
                  {character.aliases.join(', ')}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
