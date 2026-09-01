import { describe, expect, it } from 'vitest';

import {
  Animation,
  AnimationTrack,
  CharacterLayer,
  DEFAULT_FRAME_DURATION_MS,
  MAX_ANIMATION_FRAMES,
} from '../../../../content/generated/character';
import {
  blankAnimation,
  blankVariant,
  clampDuration,
  clampFrames,
  heldOffset,
  heldPose,
  hierarchy,
  isNumeric,
  keyframeAt,
  poseAt,
  poseValue,
  usesOptions,
  wouldLoop,
} from './character-editor.types';

/**
 * The character editor's decisions, tested without Angular.
 *
 * The component owns signals and a canvas; everything that can be wrong about
 * *what it decides* — the box a new layer gets, which offset a drag starts
 * from, which pose is in force, what the layer list looks like — lives here,
 * and until now none of it was verified
 * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
 */

function layer(id: string, parent?: string): CharacterLayer {
  return { id, parent, variants: [] };
}

function track(...frames: number[]): AnimationTrack {
  return {
    node: 'body',
    keyframes: frames.map((frame) => ({ frame, offset: [frame, frame * 2] as [number, number] })),
  };
}

describe('control kinds', () => {
  it('knows which controls choose from a list', () => {
    expect(usesOptions('select')).toBe(true);
    expect(usesOptions('multiSelect')).toBe(true);
    expect(usesOptions('slider')).toBe(false);
    expect(usesOptions('text')).toBe(false);
  });

  it('knows which controls are numbers, and so can drive a scale', () => {
    expect(isNumeric('slider')).toBe(true);
    expect(isNumeric('number')).toBe(true);
    expect(isNumeric('select')).toBe(false);
    expect(isNumeric('toggle')).toBe(false);
  });
});

describe('blankVariant', () => {
  it('gives a new layer a visible box in the middle of the canvas', () => {
    const variant = blankVariant('default', { width: 64, height: 128 });

    expect(variant.rect).toEqual([22, 48, 21, 32]);
    expect(variant.sprite).toEqual({ asset: '' });
  });

  it('never proposes a box with no area, however small the canvas', () => {
    const variant = blankVariant('default', { width: 1, height: 1 });

    expect(variant.rect?.[2]).toBeGreaterThanOrEqual(1);
    expect(variant.rect?.[3]).toBeGreaterThanOrEqual(1);
  });
});

describe('blankAnimation', () => {
  it('is a breathing idle: four frames, looping, no tracks yet', () => {
    expect(blankAnimation('idle')).toEqual({
      id: 'idle',
      name: 'idle',
      frames: 4,
      frameDurationMs: DEFAULT_FRAME_DURATION_MS,
      looping: true,
      tracks: [],
    });
  });
});

describe('clampFrames', () => {
  it('rounds into what an animation may declare', () => {
    expect(clampFrames(6.4)).toBe(6);
    expect(clampFrames(0)).toBe(1);
    expect(clampFrames(-10)).toBe(1);
    expect(clampFrames(MAX_ANIMATION_FRAMES + 100)).toBe(MAX_ANIMATION_FRAMES);
  });

  it('answers one frame for anything that is not a number at all', () => {
    expect(clampFrames(Number.NaN)).toBe(1);
    expect(clampFrames(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('clampDuration', () => {
  it('keeps a rate that can actually be played', () => {
    expect(clampDuration(120)).toBe(120);
    expect(clampDuration(0)).toBe(1);
    expect(clampDuration(1_000_000)).toBe(10_000);
  });

  it('falls back to the schema default rather than to zero', () => {
    expect(clampDuration(Number.NaN)).toBe(DEFAULT_FRAME_DURATION_MS);
  });
});

describe('keyframeAt', () => {
  it('finds only a keyframe written at exactly this frame', () => {
    const written = track(0, 4);

    expect(keyframeAt(written, 4)?.offset).toEqual([4, 8]);
    expect(keyframeAt(written, 2)).toBeUndefined();
    expect(keyframeAt(undefined, 0)).toBeUndefined();
  });
});

describe('heldOffset', () => {
  it('starts a new keyframe from the last one written at or before it', () => {
    const written = track(0, 4);

    expect(heldOffset(written, 6)).toEqual([4, 8]);
    expect(heldOffset(written, 4)).toEqual([4, 8]);
    expect(heldOffset(written, 2)).toEqual([0, 0]);
  });

  it('reaches forwards when nothing was written before this frame', () => {
    expect(heldOffset(track(6), 2)).toEqual([6, 12]);
  });

  it('does not care what order the keyframes are stored in', () => {
    const shuffled: AnimationTrack = {
      node: 'body',
      keyframes: [
        { frame: 8, offset: [8, 0] },
        { frame: 2, offset: [2, 0] },
      ],
    };

    expect(heldOffset(shuffled, 4)).toEqual([2, 0]);
  });

  it('is the origin for a track with nothing in it', () => {
    expect(heldOffset(undefined, 3)).toEqual([0, 0]);
    expect(heldOffset({ node: 'body', keyframes: [] }, 3)).toEqual([0, 0]);
  });
});

describe('poses', () => {
  // The values sit beside the frame number, so a file reads
  // `{ "frame": 4, "view": "side" }`.
  const walk: Animation = {
    id: 'walk',
    frames: 8,
    poses: [
      { frame: 4, view: 'side' },
      { frame: 0, view: 'front' },
    ],
  };

  it('finds a pose written at exactly this frame', () => {
    expect(poseAt(walk, 4)?.['view']).toBe('side');
    expect(poseAt(walk, 2)).toBeUndefined();
    expect(poseAt(null, 0)).toBeUndefined();
  });

  it('holds the last pose written at or before this frame', () => {
    expect(heldPose(walk, 6)?.frame).toBe(4);
    expect(heldPose(walk, 3)?.frame).toBe(0);
  });

  it('holds the first pose backwards, as the engine does', () => {
    const late: Animation = { id: 'late', frames: 8, poses: [{ frame: 4, view: 'side' }] };

    expect(heldPose(late, 0)?.frame).toBe(4);
  });

  it('is nothing when the animation writes no poses at all', () => {
    expect(heldPose({ id: 'idle', frames: 4 }, 2)).toBeUndefined();
    expect(heldPose(null, 2)).toBeUndefined();
  });
});

describe('poseValue', () => {
  it('reads a boolean as a boolean, so a toggle variant can match it', () => {
    expect(poseValue('true')).toBe(true);
    expect(poseValue(' false ')).toBe(false);
  });

  it('reads a number as a number', () => {
    expect(poseValue('3')).toBe(3);
    expect(poseValue('-2.5')).toBe(-2.5);
  });

  it('keeps anything else exactly as typed, spaces included', () => {
    expect(poseValue('side')).toBe('side');
    expect(poseValue(' side ')).toBe(' side ');
    expect(poseValue('')).toBe('');
  });
});

describe('wouldLoop', () => {
  const layers = [layer('root'), layer('torso', 'root'), layer('arm', 'torso')];

  it('refuses a layer as its own parent', () => {
    expect(wouldLoop(layers, 'torso', 'torso')).toBe(true);
  });

  it('refuses a parent that already descends from this layer', () => {
    expect(wouldLoop(layers, 'torso', 'arm')).toBe(true);
    expect(wouldLoop(layers, 'root', 'arm')).toBe(true);
  });

  it('allows a parent that does not', () => {
    expect(wouldLoop(layers, 'arm', 'root')).toBe(false);
    expect(wouldLoop(layers, 'torso', 'root')).toBe(false);
  });

  it('gives an answer even when the list already holds a cycle', () => {
    const broken = [layer('a', 'b'), layer('b', 'a'), layer('c')];

    expect(wouldLoop(broken, 'c', 'a')).toBe(false);
  });
});

describe('hierarchy', () => {
  it('flattens the tree depth-first, keeping the authored draw order', () => {
    const rows = hierarchy([
      layer('body'),
      layer('head', 'body'),
      layer('hat', 'head'),
      layer('cape'),
    ]);

    expect(rows.map((row) => [row.layer.id, row.depth])).toEqual([
      ['body', 0],
      ['head', 1],
      ['hat', 2],
      ['cape', 0],
    ]);
  });

  it('reports where each layer sits in the definition, which is the draw order', () => {
    const rows = hierarchy([layer('body'), layer('head', 'body')]);

    expect(rows.map((row) => row.index)).toEqual([0, 1]);
  });

  it('shows a layer whose parent does not exist as a root, rather than hiding it', () => {
    const rows = hierarchy([layer('body'), layer('orphan', 'nowhere')]);

    expect(rows.map((row) => [row.layer.id, row.depth])).toEqual([
      ['body', 0],
      ['orphan', 0],
    ]);
  });

  it('lists every layer even when two of them point at each other', () => {
    const rows = hierarchy([layer('a', 'b'), layer('b', 'a')]);

    expect(rows.map((row) => row.layer.id).sort()).toEqual(['a', 'b']);
  });
});
