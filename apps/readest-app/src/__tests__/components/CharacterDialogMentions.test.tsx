import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';

import CharacterDialog from '@/app/reader/components/character/CharacterDialog';
import type { BookCharacter } from '@/types/book';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig: {} }) }));
vi.mock('@/store/characterTagsStore', () => ({
  getCharacterTags: () => [],
  upsertCharacterTag: vi.fn(),
}));
vi.mock('@/components/Dialog', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

afterEach(() => cleanup());

const make = (id: string, name: string, text = ''): BookCharacter => ({
  id,
  name,
  blocks: [{ id: `${id}-b`, type: 'text', text }],
  createdAt: 0,
  updatedAt: 0,
});

const naruto = make('c3', 'Naruto', 'Amigo de @[Sasuke](c1) desde a academia');
const sasuke = make('c1', 'Sasuke');
const sakura = make('c2', 'Sakura');

const setup = (character = naruto) => {
  const onSave = vi.fn();
  const onOpenMention = vi.fn();
  render(
    <CharacterDialog
      character={character}
      isNew={false}
      characters={[naruto, sasuke, sakura]}
      onSave={onSave}
      onDelete={vi.fn()}
      onOpenMention={onOpenMention}
      onClose={vi.fn()}
    />,
  );
  return { onSave, onOpenMention };
};

describe('CharacterDialog mentions', () => {
  it('shows a saved mention as a link and opens the mentioned sheet with the current edits', () => {
    const { onOpenMention } = setup();
    fireEvent.change(screen.getByPlaceholderText('Heading (optional)'), {
      target: { value: 'Amizades' },
    });
    fireEvent.click(screen.getByRole('button', { name: '@Sasuke' }));
    expect(onOpenMention).toHaveBeenCalledTimes(1);
    const [current, targetId] = onOpenMention.mock.calls[0]!;
    expect(targetId).toBe('c1');
    expect(current.id).toBe('c3');
    expect(current.blocks[0].heading).toBe('Amizades');
    expect(current.blocks[0].text).toBe('Amigo de @[Sasuke](c1) desde a academia');
  });

  it('clicking the note text (not the mention) goes back to editing the raw text', () => {
    setup();
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByText(/desde a academia/));
    expect((screen.getByRole('combobox') as HTMLTextAreaElement).value).toBe(
      'Amigo de @[Sasuke](c1) desde a academia',
    );
  });

  it('typing @ in a note offers the other characters and saves the chosen mention', () => {
    const { onSave } = setup(make('c3', 'Naruto', ''));
    const note = screen.getByRole('combobox');
    fireEvent.change(note, { target: { value: 'Rival: @sa' } });
    expect(screen.getAllByRole('option')).toHaveLength(2);
    fireEvent.click(screen.getByRole('option', { name: /Sakura/ }));
    fireEvent.click(screen.getByText('Save'));
    expect(onSave.mock.calls[0]![0].blocks[0].text).toBe('Rival: @[Sakura](c2) ');
  });

  it('does not offer the character being edited', () => {
    setup(make('c3', 'Naruto', ''));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '@na' } });
    expect(screen.getByRole('status').textContent).toBe('No characters found');
  });
});
