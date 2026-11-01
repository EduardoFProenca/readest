import type { BookCharacter } from '@/types/book';

/** Lowercase and strip diacritics so "Sára" matches "sara". */
export const normalizeSearchText = (text: string): string =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export interface CharacterFilterOptions {
  /** Free-text query matched against name and aliases. Empty = no text filter. */
  query?: string;
  /** Selected tag IDs. A character must have ALL of them. Empty = no tag filter. */
  tagIds?: string[];
}

/**
 * Filters characters by name/alias query AND selected tags (all selected tags
 * must be present). Characters without tags never match a non-empty tag filter.
 * Returns a new array; the input is not mutated.
 */
export const filterCharacters = (
  characters: BookCharacter[],
  { query = '', tagIds = [] }: CharacterFilterOptions,
): BookCharacter[] => {
  const q = normalizeSearchText(query);
  return characters.filter((c) => {
    if (tagIds.length > 0) {
      const own = c.tagIds ?? [];
      if (!tagIds.every((id) => own.includes(id))) return false;
    }
    if (!q) return true;
    if (normalizeSearchText(c.name).includes(q)) return true;
    return (c.aliases ?? []).some((a) => normalizeSearchText(a).includes(q));
  });
};
