import { describe, test, expect } from 'vitest';
import type { BookCharacter } from '@/types/book';
import { filterCharacters, normalizeSearchText } from '@/app/reader/utils/characterFilter';

const make = (id: string, name: string, extra: Partial<BookCharacter> = {}): BookCharacter => ({
  id,
  name,
  blocks: [],
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

const sasuke = make('c1', 'Sasuke', { aliases: ['Uchiha'], tagIds: ['ally', 'ninja'] });
const sakura = make('c2', 'Sakura', { tagIds: ['ally'] });
const sara = make('c3', 'Sára', { tagIds: [] });
const madara = make('c4', 'Madara');
const all = [sasuke, sakura, sara, madara];

describe('normalizeSearchText', () => {
  test('lowercases, strips accents and trims', () => {
    expect(normalizeSearchText('  SÁRA ')).toBe('sara');
  });
});

describe('filterCharacters', () => {
  test('empty query and no tags returns everyone', () => {
    expect(filterCharacters(all, {})).toEqual(all);
    expect(filterCharacters(all, { query: '   ', tagIds: [] })).toEqual(all);
  });

  test('matches by name, case-insensitive', () => {
    expect(filterCharacters(all, { query: 'SAKU' })).toEqual([sakura]);
  });

  test('matches accent-insensitively in both directions', () => {
    expect(filterCharacters(all, { query: 'sara' })).toEqual([sara]);
    expect(filterCharacters(all, { query: 'Sára' })).toEqual([sara]);
  });

  test('matches by alias', () => {
    expect(filterCharacters(all, { query: 'uchi' })).toEqual([sasuke]);
  });

  test('similar names all match a shared prefix', () => {
    expect(filterCharacters(all, { query: 'sa' })).toEqual([sasuke, sakura, sara]);
  });

  test('single tag filter', () => {
    expect(filterCharacters(all, { tagIds: ['ally'] })).toEqual([sasuke, sakura]);
  });

  test('multiple tags require ALL of them', () => {
    expect(filterCharacters(all, { tagIds: ['ally', 'ninja'] })).toEqual([sasuke]);
  });

  test('characters without tags never match a tag filter', () => {
    const result = filterCharacters(all, { tagIds: ['ally'] });
    expect(result).not.toContain(sara);
    expect(result).not.toContain(madara);
  });

  test('query and tags combine with AND', () => {
    expect(filterCharacters(all, { query: 'sa', tagIds: ['ninja'] })).toEqual([sasuke]);
    expect(filterCharacters(all, { query: 'madara', tagIds: ['ally'] })).toEqual([]);
  });

  test('no match returns empty array and does not mutate input', () => {
    const copy = [...all];
    expect(filterCharacters(all, { query: 'zzz' })).toEqual([]);
    expect(all).toEqual(copy);
  });
});
