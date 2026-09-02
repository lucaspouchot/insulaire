import { afterEach, describe, expect, it, vi } from 'vitest';

import { SpriteDocument } from '../../content/sprite-document';
import { DecodedSprite, SpriteSessions, SpriteStore } from './sprite-sessions';

/**
 * The open-sprite collection, driven with no DOM and no `TestBed`.
 *
 * The point of the module: ~600 lines of this were copied across four asset
 * workspaces, each reachable only through a canvas. What is pinned here is the
 * collection — decode-once, the unsaved set, the scoped batch write — not what
 * any workspace means by a "path".
 */

/** A 2×2 image of solid pixels, so a decoded document has real dimensions. */
function decoded(): DecodedSprite {
  return { width: 2, height: 2, pixels: new Uint8ClampedArray(2 * 2 * 4).fill(255) };
}

interface FakeStore extends SpriteStore {
  readonly loads: string[];
  readonly writes: string[];
  /** Paths the store has no bytes for. */
  readonly missing: Set<string>;
}

function fakeStore(): FakeStore {
  const loads: string[] = [];
  const writes: string[] = [];
  const missing = new Set<string>();
  return {
    loads,
    writes,
    missing,
    async load(path: string): Promise<DecodedSprite | null> {
      loads.push(path);
      return missing.has(path) ? null : decoded();
    },
    async write(path: string): Promise<void> {
      writes.push(path);
    },
  };
}

/** Lets the microtask that `open` starts run to completion. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('SpriteSessions open', () => {
  it('decodes a path and holds the document', async () => {
    const store = fakeStore();
    const sessions = new SpriteSessions(store);

    sessions.open('a.png');
    await settle();

    expect(store.loads).toEqual(['a.png']);
    const document = sessions.get('a.png');
    expect(document).toBeInstanceOf(SpriteDocument);
    expect(document?.width).toBe(2);
  });

  it('decodes each path once, however often it is asked for', async () => {
    const store = fakeStore();
    const sessions = new SpriteSessions(store);

    sessions.open('a.png');
    sessions.open('a.png');
    await settle();
    sessions.open('a.png');
    await settle();

    expect(store.loads).toEqual(['a.png']);
  });

  it('holds nothing for a path that names no bytes, and does not retry it', async () => {
    const store = fakeStore();
    store.missing.add('gone.png');
    const sessions = new SpriteSessions(store);

    sessions.open('gone.png');
    await settle();
    sessions.open('gone.png');
    await settle();

    expect(sessions.get('gone.png')).toBeNull();
    expect(sessions.has('gone.png')).toBe(false);
    expect(store.loads).toEqual(['gone.png']);
  });

  it('ignores the empty path', async () => {
    const store = fakeStore();
    const sessions = new SpriteSessions(store);

    sessions.open('');
    await settle();

    expect(store.loads).toEqual([]);
  });

  it('retries a path whose load threw rather than answering "no bytes"', async () => {
    const store = fakeStore();
    let attempt = 0;
    store.load = async (path: string): Promise<DecodedSprite | null> => {
      store.loads.push(path);
      attempt += 1;
      if (attempt === 1) {
        throw new Error('decode blew up');
      }
      return decoded();
    };
    const sessions = new SpriteSessions(store);

    sessions.open('a.png');
    await settle();
    expect(sessions.get('a.png')).toBeNull();

    sessions.open('a.png');
    await settle();

    expect(store.loads).toEqual(['a.png', 'a.png']);
    expect(sessions.get('a.png')).toBeInstanceOf(SpriteDocument);
  });
});

describe('SpriteSessions add and discard', () => {
  it('holds a document made elsewhere', () => {
    const sessions = new SpriteSessions(fakeStore());
    const blank = SpriteDocument.blank(4, 4);

    sessions.add('new.png', blank);

    expect(sessions.get('new.png')).toBe(blank);
    expect(sessions.has('new.png')).toBe(true);
  });

  it('does not decode over a path a document was added for', async () => {
    const store = fakeStore();
    const sessions = new SpriteSessions(store);

    sessions.add('new.png', SpriteDocument.blank(4, 4));
    sessions.open('new.png');
    await settle();

    expect(store.loads).toEqual([]);
  });

  it('drops a document and lets the next open decode fresh bytes', async () => {
    const store = fakeStore();
    const sessions = new SpriteSessions(store);

    sessions.open('a.png');
    await settle();
    sessions.discard('a.png');
    expect(sessions.get('a.png')).toBeNull();

    sessions.open('a.png');
    await settle();

    expect(store.loads).toEqual(['a.png', 'a.png']);
  });

  it('empties the whole set', async () => {
    const store = fakeStore();
    const sessions = new SpriteSessions(store);

    sessions.open('a.png');
    sessions.open('b.png');
    await settle();
    sessions.clear();

    expect(sessions.entries()).toEqual([]);
  });
});

describe('SpriteSessions unsaved set', () => {
  it('reports the scoped paths whose document is unwritten', async () => {
    const store = fakeStore();
    const sessions = new SpriteSessions(store);

    sessions.open('a.png');
    sessions.open('b.png');
    await settle();
    sessions.get('a.png')?.markUnsaved();

    expect(sessions.unsavedIn(['a.png', 'b.png'])).toEqual(['a.png']);
  });

  it('never reports a path outside the scope it was asked about', async () => {
    const store = fakeStore();
    const sessions = new SpriteSessions(store);

    sessions.open('a.png');
    sessions.open('sibling.png');
    await settle();
    sessions.get('a.png')?.markUnsaved();
    sessions.get('sibling.png')?.markUnsaved();

    expect(sessions.unsavedIn(['a.png'])).toEqual(['a.png']);
  });
});

describe('SpriteSessions writeIn', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the unsaved documents in scope, marks them saved, and counts them', async () => {
    vi.spyOn(SpriteDocument.prototype, 'toBlob').mockResolvedValue(new Blob());
    const store = fakeStore();
    const sessions = new SpriteSessions(store);

    sessions.open('a.png');
    sessions.open('b.png');
    await settle();
    sessions.get('a.png')?.markUnsaved();
    sessions.get('b.png')?.markUnsaved();

    const written = await sessions.writeIn(['a.png', 'b.png']);

    expect(written).toBe(2);
    expect(store.writes.sort()).toEqual(['a.png', 'b.png']);
    expect(sessions.unsavedIn(['a.png', 'b.png'])).toEqual([]);
  });

  it("does not write a sibling draft's images", async () => {
    vi.spyOn(SpriteDocument.prototype, 'toBlob').mockResolvedValue(new Blob());
    const store = fakeStore();
    const sessions = new SpriteSessions(store);

    sessions.open('draft-a.png');
    sessions.open('draft-b.png');
    await settle();
    sessions.get('draft-a.png')?.markUnsaved();
    sessions.get('draft-b.png')?.markUnsaved();

    const written = await sessions.writeIn(['draft-a.png']);

    expect(written).toBe(1);
    expect(store.writes).toEqual(['draft-a.png']);
    expect(sessions.get('draft-b.png')?.unsaved).toBe(true);
  });

  it('skips a document already on disk', async () => {
    const toBlob = vi.spyOn(SpriteDocument.prototype, 'toBlob').mockResolvedValue(new Blob());
    const store = fakeStore();
    const sessions = new SpriteSessions(store);

    sessions.open('a.png');
    await settle();

    const written = await sessions.writeIn(['a.png']);

    expect(written).toBe(0);
    expect(toBlob).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
  });
});

describe('SpriteSessions revision', () => {
  it('moves when the set changes and when a stroke is announced', async () => {
    const store = fakeStore();
    const sessions = new SpriteSessions(store);

    const start = sessions.revision();
    sessions.open('a.png');
    await settle();
    const afterOpen = sessions.revision();
    expect(afterOpen).toBeGreaterThan(start);

    sessions.touched();
    expect(sessions.revision()).toBeGreaterThan(afterOpen);
  });
});
