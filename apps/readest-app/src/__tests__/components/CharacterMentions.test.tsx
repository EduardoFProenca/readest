import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';

import { MentionText, MentionTextarea } from '@/app/reader/components/character/CharacterMentions';
import type { BookCharacter } from '@/types/book';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));

afterEach(() => cleanup());

const make = (id: string, name: string, aliases?: string[]): BookCharacter => ({
  id,
  name,
  aliases,
  blocks: [],
  createdAt: 0,
  updatedAt: 0,
});

const sasuke = make('c1', 'Sasuke', ['Uchiha']);
const sakura = make('c2', 'Sakura');
const naruto = make('c3', 'Naruto');
const characters = [sasuke, sakura, naruto];

const Harness = ({
  initial = '',
  onChange,
}: {
  initial?: string;
  onChange?: (v: string) => void;
}) => {
  const [value, setValue] = useState(initial);
  return (
    <MentionTextarea
      aria-label='note'
      value={value}
      characters={characters}
      excludeId='c3'
      onValueChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
    />
  );
};

const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const note = () => screen.getByLabelText('note') as HTMLTextAreaElement;

describe('MentionTextarea', () => {
  it('opens the suggestions when @ is typed and lists everyone but the excluded one', () => {
    render(<Harness />);
    type(note(), 'oi @');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      expect.stringContaining('Sakura'),
      expect.stringContaining('Sasuke'),
    ]);
  });

  it('filters as the reader keeps typing, including aliases', () => {
    render(<Harness />);
    type(note(), 'oi @sak');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    type(note(), 'oi @uchi');
    expect(screen.getByRole('option').textContent).toContain('Sasuke');
  });

  it('shows an empty state without interrupting the editing', () => {
    render(<Harness />);
    type(note(), 'oi @zzz');
    expect(screen.getByRole('status').textContent).toBe('No characters found');
    expect(note().value).toBe('oi @zzz');
  });

  it('selects with Enter after ArrowDown and inserts the token with the stable id', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    type(note(), 'Naruto falou com @sa');
    fireEvent.keyDown(note(), { key: 'ArrowDown' });
    fireEvent.keyDown(note(), { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('Naruto falou com @[Sasuke](c1) ');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('selects with a pointer click', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    type(note(), '@sak');
    fireEvent.click(screen.getByRole('option'));
    expect(onChange).toHaveBeenLastCalledWith('@[Sakura](c2) ');
  });

  it('Escape closes the list and keeps a literal @ without reopening while typing on', () => {
    render(<Harness />);
    type(note(), 'email @');
    fireEvent.keyDown(note(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    type(note(), 'email @s');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(note().value).toBe('email @s');
  });

  it('does not swallow Enter when nothing matches', () => {
    render(<Harness />);
    type(note(), 'oi @zzz');
    const notPrevented = fireEvent.keyDown(note(), { key: 'Enter' });
    expect(notPrevented).toBe(true);
  });

  it('an @ glued to a word does not open the list', () => {
    render(<Harness />);
    type(note(), 'a@b');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('reflects characters that were renamed or deleted', () => {
    const { rerender } = render(
      <MentionTextarea
        aria-label='note'
        value='@sa'
        characters={[sasuke]}
        onValueChange={() => {}}
      />,
    );
    fireEvent.select(note());
    note().setSelectionRange(3, 3);
    fireEvent.select(note());
    expect(screen.getByRole('option').textContent).toContain('Sasuke');
    rerender(
      <MentionTextarea
        aria-label='note'
        value='@sa'
        characters={[
          { ...sasuke, name: 'Itachi', aliases: [] },
          { ...sakura, deletedAt: 1 },
        ]}
        onValueChange={() => {}}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe('No characters found');
  });
});

describe('MentionText', () => {
  it('renders mentions as links that open the right character, and keeps other text', () => {
    const onOpen = vi.fn();
    render(
      <MentionText
        text={'Oi @[Sasuke](c1)!\nE @sozinho'}
        characters={characters}
        onOpen={onOpen}
      />,
    );
    const link = screen.getByRole('button');
    expect(link.textContent).toBe('@Sasuke');
    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledWith('c1');
    expect(document.body.textContent).toContain('E @sozinho');
  });

  it('shows the current name after a rename', () => {
    render(
      <MentionText
        text='@[Sasuke](c1)'
        characters={[{ ...sasuke, name: 'Sasuke Uchiha' }]}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByRole('button').textContent).toBe('@Sasuke Uchiha');
  });

  it('a mention of a deleted character is not clickable and keeps its stored name', () => {
    const onOpen = vi.fn();
    render(<MentionText text='@[Sasuke](c1)' characters={[sakura]} onOpen={onOpen} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.body.textContent).toContain('@Sasuke');
  });
});
