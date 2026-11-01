import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookCharacter, BookConfig } from '@/types/book';

// A minimal in-memory stand-in for the book data store: `setConfig` merges a
// patch synchronously and `saveConfig` records what would reach the disk.
let config: BookConfig;
const saveConfig = vi.fn(async (_env: unknown, _key: string, _config: BookConfig) => {});
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: {
    getState: () => ({
      getConfig: () => config,
      setConfig: (_key: string, patch: Partial<BookConfig>) => {
        config = { ...config, ...patch };
      },
      saveConfig,
    }),
  },
}));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ settings: { id: 'settings' } }) },
}));

import {
  addQuoteToCharacter,
  createCharacter,
  deleteCharacter,
  getBookCharacters,
  upsertCharacter,
} from '@/store/characterStore';

const env = {} as never;
const cfg = (characters: BookCharacter[] = []): BookConfig => ({ characters }) as BookConfig;
const make = (patch: Partial<BookCharacter> = {}): BookCharacter => ({
  ...createCharacter('Ana'),
  ...patch,
});

beforeEach(() => {
  config = cfg([]);
  saveConfig.mockClear();
});

describe('createCharacter', () => {
  it('starts with an empty image slot and an empty text paragraph', () => {
    const c = createCharacter('Ana');
    expect(c.name).toBe('Ana');
    expect(c.blocks.map((b) => b.type)).toEqual(['image', 'text']);
    expect(c.blocks[0]!.src).toBe('');
    expect(c.blocks[1]!.text).toBe('');
    expect(c.createdAt).toBe(c.updatedAt);
  });

  it('gives every character and block its own id', () => {
    const a = createCharacter('A');
    const b = createCharacter('B');
    const ids = [a.id, b.id, ...a.blocks.map((x) => x.id), ...b.blocks.map((x) => x.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('getBookCharacters', () => {
  it('hides soft-deleted characters and tolerates a config without the field', () => {
    config = cfg([make({ name: 'Live' }), make({ name: 'Gone', deletedAt: 5 })]);
    expect(getBookCharacters('k').map((c) => c.name)).toEqual(['Live']);
    config = {} as BookConfig;
    expect(getBookCharacters('k')).toEqual([]);
  });
});

describe('upsertCharacter', () => {
  it('appends a new character and saves the whole config once', async () => {
    const c = make();
    await upsertCharacter(env, 'k', c);
    expect(config.characters).toHaveLength(1);
    expect(config.characters![0]!.id).toBe(c.id);
    expect(saveConfig).toHaveBeenCalledTimes(1);
  });

  it('replaces by id, bumps updatedAt and clears deletedAt', async () => {
    const c = make({ updatedAt: 1, deletedAt: 9 });
    config = cfg([c]);
    await upsertCharacter(env, 'k', { ...c, name: 'Ana Maria' });
    expect(config.characters).toHaveLength(1);
    const saved = config.characters![0]!;
    expect(saved.name).toBe('Ana Maria');
    expect(saved.updatedAt).toBeGreaterThan(1);
    expect(saved.deletedAt).toBeNull();
  });

  it('keeps the other characters untouched', async () => {
    const other = make({ name: 'Bo' });
    const c = make();
    config = cfg([other, c]);
    await upsertCharacter(env, 'k', { ...c, name: 'Ana 2' });
    expect(config.characters![0]).toEqual(other);
  });

  it('two calls without awaiting in between both land in the config', async () => {
    const a = make({ name: 'A' });
    const b = make({ name: 'B' });
    await Promise.all([upsertCharacter(env, 'k', a), upsertCharacter(env, 'k', b)]);
    expect(config.characters!.map((c) => c.name).sort()).toEqual(['A', 'B']);
  });
});

describe('addQuoteToCharacter', () => {
  it('appends a quote block with its source CFI and bumps updatedAt', async () => {
    const c = make({ updatedAt: 1 });
    config = cfg([c]);
    await addQuoteToCharacter(env, 'k', c.id, 'Hello there.', 'epubcfi(/6/4)');
    const saved = config.characters![0]!;
    const quote = saved.blocks.at(-1)!;
    expect(quote).toMatchObject({
      type: 'quote',
      text: 'Hello there.',
      sourceCfi: 'epubcfi(/6/4)',
    });
    expect(saved.blocks).toHaveLength(c.blocks.length + 1);
    expect(saved.updatedAt).toBeGreaterThan(1);
  });

  it('does nothing and saves nothing for an unknown id', async () => {
    config = cfg([make()]);
    await addQuoteToCharacter(env, 'k', 'missing', 'x');
    expect(saveConfig).not.toHaveBeenCalled();
    expect(config.characters![0]!.blocks.some((b) => b.type === 'quote')).toBe(false);
  });
});

describe('deleteCharacter', () => {
  it('soft-deletes: the record stays with deletedAt, only the id given', async () => {
    const a = make({ name: 'A' });
    const b = make({ name: 'B' });
    config = cfg([a, b]);
    await deleteCharacter(env, 'k', a.id);
    expect(config.characters).toHaveLength(2);
    expect(config.characters![0]!.deletedAt).toEqual(expect.any(Number));
    expect(config.characters![1]!.deletedAt).toBeUndefined();
    expect(getBookCharacters('k').map((c) => c.name)).toEqual(['B']);
  });
});
