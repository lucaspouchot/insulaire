import { describe, expect, it } from 'vitest';

import { DEFAULT_FRAME_DURATION_MS } from './generated/character';
import { Flipbook, frameAt, frameDurationOf } from './flipbook';

/** A four-frame flipbook at the default rate, looping unless told otherwise. */
function flame(overrides: Partial<Flipbook> = {}): Flipbook {
  return {
    frames: ['a.png', 'b.png', 'c.png', 'd.png'],
    frameDurationMs: 120,
    looping: true,
    ...overrides,
  };
}

describe('frameDurationOf', () => {
  it('reads the declared rate', () => {
    expect(frameDurationOf(flame({ frameDurationMs: 200 }))).toBe(200);
  });

  it('falls back to the schema default when the flipbook declares none', () => {
    expect(frameDurationOf({ frames: ['a.png'] })).toBe(DEFAULT_FRAME_DURATION_MS);
    expect(frameDurationOf(null)).toBe(DEFAULT_FRAME_DURATION_MS);
  });

  it('never returns zero, which is what the frame index divides by', () => {
    expect(frameDurationOf(flame({ frameDurationMs: 0 }))).toBe(1);
    expect(frameDurationOf(flame({ frameDurationMs: -50 }))).toBe(1);
  });
});

describe('frameAt', () => {
  it('walks the frames in order across one play', () => {
    const animation = flame();

    expect(frameAt(animation, 0)).toBe(0);
    expect(frameAt(animation, 119)).toBe(0);
    expect(frameAt(animation, 120)).toBe(1);
    expect(frameAt(animation, 360)).toBe(3);
  });

  it('wraps when it loops — the rule crates/world/src/animation.rs follows', () => {
    const animation = flame();

    expect(frameAt(animation, 480)).toBe(0);
    expect(frameAt(animation, 600)).toBe(1);
    expect(frameAt(animation, 4_800)).toBe(0);
  });

  it('holds the last frame when it does not loop, so a state stays reached', () => {
    const once = flame({ looping: false });

    expect(frameAt(once, 480)).toBe(3);
    expect(frameAt(once, 100_000)).toBe(3);
  });

  it('treats an undeclared loop as one-shot, as the schema default does', () => {
    const once = flame({ looping: undefined });

    expect(frameAt(once, 100_000)).toBe(3);
  });

  it('answers zero for a flipbook with nothing in it', () => {
    expect(frameAt({ frames: [] }, 5_000)).toBe(0);
    expect(frameAt({}, 5_000)).toBe(0);
  });

  it('holds a still icon on its only frame', () => {
    expect(frameAt({ frames: ['still.png'], looping: true }, 100_000)).toBe(0);
  });

  it('stays inside the flipbook for a time before it started', () => {
    expect(frameAt(flame(), -1_000)).toBe(0);
    expect(frameAt(flame({ looping: false }), -1_000)).toBe(0);
  });
});
