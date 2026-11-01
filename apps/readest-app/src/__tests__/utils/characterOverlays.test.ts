import { describe, expect, it } from 'vitest';
import type { BookCharacter } from '@/types/book';
import type { FoliateView } from '@/types/view';
import {
  characterIdFromValue,
  drawCharacterDot,
  expandCharacter,
  isCharacterValue,
  removeCharacterOverlays,
} from '@/app/reader/utils/characterOverlays';

const character = (patch: Partial<BookCharacter> = {}): BookCharacter => ({
  id: 'c1',
  name: 'Ana',
  blocks: [],
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

// A rendered section: a real jsdom document plus an overlayer that records
// what was added and removed. `expandCharacter` talks to the view only through
// `renderer.getContents()` and a `draw-annotation` event.
const setup = (html: string) => {
  const doc = document.implementation.createHTMLDocument('s');
  doc.body.innerHTML = html;
  const added: string[] = [];
  const removed: string[] = [];
  const overlayer = {
    add: (value: string) => added.push(value),
    remove: (value: string) => removed.push(value),
  };
  const draws: string[] = [];
  const view = Object.assign(new EventTarget(), {
    renderer: { getContents: () => [{ index: 0, doc, overlayer }] },
  }) as unknown as FoliateView;
  (view as unknown as EventTarget).addEventListener('draw-annotation', (e) => {
    const detail = (e as CustomEvent).detail;
    detail.draw(() => document.createElementNS('http://www.w3.org/2000/svg', 'g'));
    draws.push(detail.annotation.value);
  });
  return { doc, view, added, removed, draws };
};

describe('character overlay values', () => {
  it('recognizes its own keys and extracts the character id', () => {
    expect(isCharacterValue('char:abc#0-3')).toBe(true);
    expect(isCharacterValue('epubcfi(/6/4)')).toBe(false);
    expect(isCharacterValue(undefined)).toBe(false);
    expect(characterIdFromValue('char:abc#0-3')).toBe('abc');
  });
});

describe('drawCharacterDot', () => {
  it('draws one circle after the last line box, in the given color', () => {
    const g = drawCharacterDot(
      [
        { left: 0, top: 0, width: 50, height: 20 },
        { left: 0, top: 20, width: 30, height: 20 },
      ],
      { color: '#123456' },
    );
    const circle = g.querySelector('circle')!;
    expect(g.querySelectorAll('circle')).toHaveLength(1);
    expect(circle.getAttribute('fill')).toBe('#123456');
    expect(Number(circle.getAttribute('cx'))).toBeGreaterThan(30);
    expect(Number(circle.getAttribute('cy'))).toBeGreaterThanOrEqual(20);
  });

  it('draws nothing for an empty rect list', () => {
    expect(drawCharacterDot([]).childNodes).toHaveLength(0);
  });
});

describe('expandCharacter', () => {
  it('draws one dot per whole-word occurrence of the name', () => {
    const { doc, view, draws } = setup('<p>Ana saw Ana. Ana left.</p>');
    expandCharacter(view, character(), doc, 0);
    expect(draws).toEqual(['char:c1#0-0', 'char:c1#0-1', 'char:c1#0-2']);
  });

  it('does not match inside a longer word ("Ana" in "Mariana")', () => {
    const { doc, view, draws } = setup('<p>Mariana and Anabel met Ana.</p>');
    expandCharacter(view, character(), doc, 0);
    expect(draws).toHaveLength(1);
  });

  it('draws dots for aliases too', () => {
    const { doc, view, draws } = setup('<p>Ana met the Fox.</p>');
    expandCharacter(view, character({ aliases: ['Fox'] }), doc, 0);
    expect(draws).toHaveLength(2);
  });

  it('lets the longest term claim its text first, so overlapping terms do not double up', () => {
    const { doc, view, draws } = setup('<p>Ana Maria arrived.</p>');
    expandCharacter(view, character({ name: 'Ana Maria', aliases: ['Ana'] }), doc, 0);
    expect(draws).toHaveLength(1);
  });

  it('does nothing for a deleted character or a section that is not rendered', () => {
    const a = setup('<p>Ana</p>');
    expandCharacter(a.view, character({ deletedAt: 1 }), a.doc, 0);
    expect(a.draws).toHaveLength(0);
    const b = setup('<p>Ana</p>');
    expandCharacter(b.view, character(), b.doc, 7);
    expect(b.draws).toHaveLength(0);
  });

  it('is memoized per document until the character changes', () => {
    const { doc, view, draws } = setup('<p>Ana</p>');
    expandCharacter(view, character(), doc, 0);
    expandCharacter(view, character(), doc, 0);
    expect(draws).toHaveLength(1);
    expandCharacter(view, character({ updatedAt: 2 }), doc, 0);
    expect(draws).toHaveLength(2);
  });

  it('caps the dots per character and section at 1000', () => {
    const { doc, view, draws } = setup(`<p>${'Ana '.repeat(1200)}</p>`);
    expandCharacter(view, character(), doc, 0);
    expect(draws).toHaveLength(1000);
  });
});

describe('removeCharacterOverlays', () => {
  it('removes exactly the dots that were drawn, and lets them be redrawn', () => {
    const { doc, view, removed, draws } = setup('<p>Ana and Ana</p>');
    const c = character();
    expandCharacter(view, c, doc, 0);
    removeCharacterOverlays(view, c);
    expect(removed).toEqual(['char:c1#0-0', 'char:c1#0-1']);
    expandCharacter(view, c, doc, 0);
    expect(draws).toHaveLength(4);
  });
});
