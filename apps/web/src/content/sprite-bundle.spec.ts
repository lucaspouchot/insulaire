import { describe, expect, it } from 'vitest';

import { packSpriteBundle } from '../../../../scripts/sprite-bundle.mjs';

import { TILE_ART_BUNDLE, unpackSpriteBundle } from './sprite-bundle';

/**
 * The bundle is written by a Node script and read by the browser, so the only
 * test worth writing is the one that runs **both halves**: this spec imports
 * the real packer rather than a hand-built buffer, so a change to either side
 * that the other does not follow fails here rather than in a browser.
 */

/** A file for the packer, with `bytes` a recognisable run of one value. */
function file(path: string, type: string, fill: number, length: number) {
  return { path, type, bytes: Buffer.alloc(length, fill) };
}

/**
 * `packSpriteBundle` returns a Node `Buffer`; the reader wants an `ArrayBuffer`.
 *
 * Copied rather than sliced out of `packed.buffer`, whose type is the wider
 * `ArrayBufferLike`: what a `fetch` hands the reader is always its own buffer,
 * and this is what makes the test's input the same shape.
 */
function bufferOf(packed: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(packed.byteLength);
  new Uint8Array(copy).set(packed);
  return copy;
}

describe('unpackSpriteBundle', () => {
  it('round-trips what the packer wrote, in order', () => {
    const packed = packSpriteBundle([
      file('assets/tiles/grass/surfaces/grass_a.png', 'image/png', 0x11, 5),
      file('assets/tiles/rock/elevation/level_1/rock_b.png', 'image/png', 0x22, 3),
    ]);

    const sprites = unpackSpriteBundle(bufferOf(packed));

    expect(sprites.map((sprite) => sprite.path)).toEqual([
      'assets/tiles/grass/surfaces/grass_a.png',
      'assets/tiles/rock/elevation/level_1/rock_b.png',
    ]);
    expect(sprites[0].type).toBe('image/png');
    expect([...sprites[0].bytes]).toEqual([0x11, 0x11, 0x11, 0x11, 0x11]);
    expect([...sprites[1].bytes]).toEqual([0x22, 0x22, 0x22]);
  });

  it('carries a file whose bytes are empty without disturbing its neighbours', () => {
    const packed = packSpriteBundle([
      file('a.png', 'image/png', 0x01, 2),
      file('empty.png', 'image/png', 0, 0),
      file('b.png', 'image/png', 0x03, 2),
    ]);

    const sprites = unpackSpriteBundle(bufferOf(packed));

    expect(sprites).toHaveLength(3);
    expect([...sprites[1].bytes]).toEqual([]);
    expect([...sprites[2].bytes]).toEqual([0x03, 0x03]);
  });

  it('unpacks a bundle carrying nothing', () => {
    expect(unpackSpriteBundle(bufferOf(packSpriteBundle([])))).toEqual([]);
  });

  it('refuses a file that is not a bundle', () => {
    const notABundle = new TextEncoder().encode('<!doctype html><title>404</title>');
    expect(() => unpackSpriteBundle(bufferOf(Buffer.from(notABundle)))).toThrow(
      /not a sprite bundle/,
    );
  });

  it('refuses a bundle too short to hold its own header', () => {
    expect(() => unpackSpriteBundle(new ArrayBuffer(4))).toThrow(/shorter than its own header/);
  });

  it('refuses a version it does not know', () => {
    const packed = packSpriteBundle([file('a.png', 'image/png', 0x01, 1)]);
    packed.writeUInt32LE(99, 4);
    expect(() => unpackSpriteBundle(bufferOf(packed))).toThrow(/version 99/);
  });

  it('refuses a bundle whose payload was truncated', () => {
    const packed = packSpriteBundle([file('a.png', 'image/png', 0x01, 8)]);
    const truncated = bufferOf(packed).slice(0, packed.byteLength - 4);
    expect(() => unpackSpriteBundle(truncated)).toThrow(/runs past the end/);
  });

  it('refuses a header that is not valid JSON', () => {
    const packed = packSpriteBundle([file('a.png', 'image/png', 0x01, 1)]);
    // Corrupt the first byte of the header, which the packer wrote as `{`.
    packed[12] = 0x5b;
    expect(() => unpackSpriteBundle(bufferOf(packed))).toThrow(/no entry list|not valid JSON/);
  });

  it('names the file the whole content tree agrees on', () => {
    expect(TILE_ART_BUNDLE).toBe('tile-art.bundle');
  });
});
