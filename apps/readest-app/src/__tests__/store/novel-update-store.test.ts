import { beforeEach, describe, expect, it } from 'vitest';
import { novelUpdateKey, useNovelUpdateStore } from '@/store/novelUpdateStore';

const reset = () =>
  useNovelUpdateStore.setState({
    updates: {},
    checking: false,
    progress: { done: 0, total: 0 },
    lastCheck: null,
    busy: {},
  });

describe('novelUpdateStore', () => {
  beforeEach(() => {
    localStorage.clear();
    reset();
  });

  it('keys a book by metaHash, which survives updates, falling back to hash', () => {
    expect(novelUpdateKey({ hash: 'h', metaHash: 'm' })).toBe('m');
    expect(novelUpdateKey({ hash: 'h' })).toBe('h');
  });

  it('persists indicators and restores them after a restart', () => {
    useNovelUpdateStore.getState().markAvailable('m1', 4);
    useNovelUpdateStore.getState().markAvailable('m2', null);
    reset(); // a fresh app start: memory is empty, localStorage is not
    useNovelUpdateStore.getState().restore();
    const { updates } = useNovelUpdateStore.getState();
    expect(updates['m1']?.newCount).toBe(4);
    expect(updates['m2']?.newCount).toBeNull();
  });

  it('clearing persists too, and clearing an unknown key is a no-op', () => {
    useNovelUpdateStore.getState().markAvailable('m1', 1);
    useNovelUpdateStore.getState().clear('m1');
    useNovelUpdateStore.getState().clear('nope');
    reset();
    useNovelUpdateStore.getState().restore();
    expect(useNovelUpdateStore.getState().updates).toEqual({});
  });

  it('ignores corrupt stored data', () => {
    localStorage.setItem('readest-novel-updates', '{not json');
    useNovelUpdateStore.getState().restore();
    expect(useNovelUpdateStore.getState().updates).toEqual({});
    localStorage.setItem(
      'readest-novel-updates',
      JSON.stringify({ updates: { ok: { newCount: 2, checkedAt: 1 }, bad: { newCount: 'x' } } }),
    );
    useNovelUpdateStore.getState().restore();
    expect(Object.keys(useNovelUpdateStore.getState().updates)).toEqual(['ok']);
  });

  it('acquire is exclusive per key until released', () => {
    const s = useNovelUpdateStore.getState();
    expect(s.acquire('a')).toBe(true);
    expect(useNovelUpdateStore.getState().acquire('a')).toBe(false);
    expect(useNovelUpdateStore.getState().acquire('b')).toBe(true);
    useNovelUpdateStore.getState().release('a');
    expect(useNovelUpdateStore.getState().acquire('a')).toBe(true);
  });

  it('only one check can run at a time', () => {
    expect(useNovelUpdateStore.getState().startCheck(3)).toBe(true);
    expect(useNovelUpdateStore.getState().startCheck(3)).toBe(false);
  });
});
