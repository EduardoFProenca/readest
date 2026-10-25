import { describe, test, expect } from 'vitest';
import type { BookCharacter } from '@/types/book';
import {
  applyMention,
  filterMentionCandidates,
  formatMention,
  getActiveMention,
  parseMentions,
} from '@/app/reader/utils/characterMentions';

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
const naruto = make('c3', 'Naruto Uzumaki');
const sara = make('c4', 'Sára');

describe('getActiveMention', () => {
  test('detects an @ at the caret and returns the typed query', () => {
    const text = 'Naruto conversou com @sa';
    expect(getActiveMention(text, text.length)).toEqual({ start: 21, query: 'sa' });
  });

  test('an @ right at the caret has an empty query', () => {
    expect(getActiveMention('oi @', 4)).toEqual({ start: 3, query: '' });
  });

  test('works at the start of the text and after a line break', () => {
    expect(getActiveMention('@sa', 3)).toEqual({ start: 0, query: 'sa' });
    expect(getActiveMention('linha\n@sa', 9)).toEqual({ start: 6, query: 'sa' });
  });

  test('ignores an @ glued to a word (e-mail) and a closed query', () => {
    expect(getActiveMention('a@b', 3)).toBeNull();
    expect(getActiveMention('oi @sa e mais', 13)).toBeNull();
  });

  test('is not active when the caret is before the @ or there is no @', () => {
    expect(getActiveMention('oi @sa', 2)).toBeNull();
    expect(getActiveMention('sem arroba', 10)).toBeNull();
  });

  test('does not reopen inside an already inserted mention', () => {
    const text = `oi ${formatMention(sasuke)}`;
    expect(getActiveMention(text, text.length)).toBeNull();
    expect(getActiveMention(text, 6)).toBeNull();
  });
});

describe('filterMentionCandidates', () => {
  const all = [sasuke, sakura, naruto, sara];

  test('empty query lists everyone, sorted by name', () => {
    expect(filterMentionCandidates(all, '').map((c) => c.id)).toEqual(['c3', 'c2', 'c4', 'c1']);
  });

  test('filters by name prefix, case-insensitive', () => {
    expect(filterMentionCandidates(all, 'SA').map((c) => c.id)).toEqual(['c2', 'c4', 'c1']);
  });

  test('ignores accents on both sides', () => {
    expect(filterMentionCandidates(all, 'sara').map((c) => c.id)).toEqual(['c4']);
    expect(filterMentionCandidates(all, 'sár').map((c) => c.id)).toEqual(['c4']);
  });

  test('matches aliases', () => {
    expect(filterMentionCandidates(all, 'uchi').map((c) => c.id)).toEqual(['c1']);
  });

  test('matches a later word of the name, ranked after prefix matches', () => {
    expect(filterMentionCandidates(all, 'uzu').map((c) => c.id)).toEqual(['c3']);
  });

  test('skips deleted characters and the excluded one', () => {
    const deleted = { ...sakura, deletedAt: 5 };
    expect(filterMentionCandidates([sasuke, deleted], 'sa').map((c) => c.id)).toEqual(['c1']);
    expect(filterMentionCandidates(all, 'sa', 'c1').map((c) => c.id)).toEqual(['c2', 'c4']);
  });

  test('returns an empty list when nothing matches', () => {
    expect(filterMentionCandidates(all, 'zzz')).toEqual([]);
  });
});

describe('applyMention', () => {
  test('replaces @query with the mention token and keeps the surrounding text', () => {
    const text = 'Naruto conversou com @sa depois';
    const active = getActiveMention(text, 24)!;
    const result = applyMention(text, active, 24, sasuke);
    expect(result.text).toBe(`Naruto conversou com ${formatMention(sasuke)} depois`);
    expect(result.caret).toBe(21 + formatMention(sasuke).length + 1);
  });

  test('adds a trailing space at the end of the text so typing continues', () => {
    const active = getActiveMention('oi @sa', 6)!;
    const result = applyMention('oi @sa', active, 6, sasuke);
    expect(result.text).toBe(`oi ${formatMention(sasuke)} `);
    expect(result.caret).toBe(result.text.length);
  });

  test('keeps line breaks after the caret untouched', () => {
    const text = 'oi @sa\nsegunda linha';
    const active = getActiveMention(text, 6)!;
    const result = applyMention(text, active, 6, sasuke);
    expect(result.text).toBe(`oi ${formatMention(sasuke)}\nsegunda linha`);
  });
});

describe('formatMention / parseMentions', () => {
  test('formats with the stable id and a readable name', () => {
    expect(formatMention(sasuke)).toBe('@[Sasuke](c1)');
  });

  test('strips characters that would break the token from the name', () => {
    expect(formatMention(make('c9', 'A]b\nc'))).toBe('@[Ab c](c9)');
  });

  test('splits text into text and mention segments, preserving the original text', () => {
    const text = `Oi ${formatMention(sasuke)}, e @${'sakura'} tambem\nfim ${formatMention(sakura)}`;
    const segments = parseMentions(text);
    expect(segments.map((s) => s.type)).toEqual(['text', 'mention', 'text', 'mention']);
    expect(segments.map((s) => (s.type === 'mention' ? s.id : s.text))).toEqual([
      'Oi ',
      'c1',
      ', e @sakura tambem\nfim ',
      'c2',
    ]);
  });

  test('plain text and a literal @ stay a single text segment', () => {
    expect(parseMentions('sem nada @ aqui')).toEqual([{ type: 'text', text: 'sem nada @ aqui' }]);
    expect(parseMentions('')).toEqual([]);
  });
});
