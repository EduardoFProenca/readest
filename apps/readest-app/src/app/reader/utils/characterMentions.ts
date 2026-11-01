import type { BookCharacter } from '@/types/book';

/**
 * Character mentions live inside the plain note text as `@[Name](characterId)`.
 * The id is what links to the sheet, so renaming a character never breaks a
 * mention; the name is only a readable fallback for deleted characters.
 */
const MENTION_RE = /@\[([^\]\n]*)\]\(([^)\s]+)\)/g;

export type MentionSegment =
  | { type: 'text'; text: string }
  | { type: 'mention'; id: string; name: string };

export interface ActiveMention {
  /** Index of the `@` that opened the suggestions. */
  start: number;
  /** What was typed after the `@`, up to the caret. */
  query: string;
}

export const formatMention = (character: Pick<BookCharacter, 'id' | 'name'>): string =>
  `@[${character.name.replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim()}](${character.id})`;

export function parseMentions(text: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION_RE)) {
    if (match.index > last) segments.push({ type: 'text', text: text.slice(last, match.index) });
    segments.push({ type: 'mention', name: match[1]!, id: match[2]! });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ type: 'text', text: text.slice(last) });
  return segments;
}

/**
 * The `@query` being typed right before the caret, or null. An `@` only opens
 * suggestions at the start of the text or after whitespace, so e-mail
 * addresses and already inserted mentions are left alone.
 */
export function getActiveMention(text: string, caret: number): ActiveMention | null {
  if (text[caret] === '[') return null;
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (ch === '@') {
      if (i > 0 && !/\s/.test(text[i - 1]!)) return null;
      return { start: i, query: text.slice(i + 1, caret) };
    }
    if (/[\s[\]()]/.test(ch)) return null;
  }
  return null;
}

export const normalizeForSearch = (value: string): string =>
  value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * The live character whose name or one of whose aliases equals `term`, ignoring
 * case, accents and surrounding or repeated whitespace. Names win over aliases,
 * so a character called "Ana" is found before another one aliased "Ana".
 */
export function findCharacterByTerm(
  characters: BookCharacter[],
  term: string,
): BookCharacter | undefined {
  const clean = (value: string) => normalizeForSearch(value.replace(/\s+/g, ' ').trim());
  const wanted = clean(term);
  if (!wanted) return undefined;
  const live = characters.filter((c) => !c.deletedAt);
  return (
    live.find((c) => clean(c.name) === wanted) ??
    live.find((c) => (c.aliases ?? []).some((alias) => clean(alias) === wanted))
  );
}

/**
 * Characters whose name or alias matches `query` (case and accent
 * insensitive). Name prefixes rank first, then alias prefixes and later words
 * of the name, then any other substring.
 */
export function filterMentionCandidates(
  characters: BookCharacter[],
  query: string,
  excludeId?: string,
): BookCharacter[] {
  const q = normalizeForSearch(query.trim());
  const ranked: { character: BookCharacter; name: string; tier: number }[] = [];
  for (const character of characters) {
    if (character.deletedAt || character.id === excludeId) continue;
    const name = normalizeForSearch(character.name);
    const aliases = (character.aliases ?? []).map(normalizeForSearch);
    let tier: number;
    if (name.startsWith(q)) tier = 0;
    else if (aliases.some((a) => a.startsWith(q)) || name.split(/\s+/).some((w) => w.startsWith(q)))
      tier = 1;
    else if (name.includes(q) || aliases.some((a) => a.includes(q))) tier = 2;
    else continue;
    ranked.push({ character, name, tier });
  }
  return ranked
    .sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name))
    .map((r) => r.character);
}

/** Replaces the typed `@query` with the mention token and returns the new caret. */
export function applyMention(
  text: string,
  active: ActiveMention,
  caret: number,
  character: BookCharacter,
): { text: string; caret: number } {
  const token = formatMention(character);
  const after = text.slice(caret);
  // Land after a following space; add one when the text would run into the token.
  const gap = after.startsWith(' ') ? 1 : /^\s/.test(after) ? 0 : 1;
  const filler = after.startsWith(' ') || gap === 0 ? '' : ' ';
  return {
    text: text.slice(0, active.start) + token + filler + after,
    caret: active.start + token.length + gap,
  };
}
