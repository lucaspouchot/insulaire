import { describe, expect, it } from 'vitest';

import { SpriteDocument } from './sprite-document';

/**
 * The buffer half of the sprite editor, which is all of it that matters: what
 * a stroke does, what undo takes back, and what the palette offers. None of it
 * needs a canvas, which is the point of keeping the DOM at the edges
 * (`docs/adr/ADR-0030-the-editor-paints-its-sprites.md`).
 */

/** Paints one pixel as a complete stroke, the way a click does. */
function click(sprite: SpriteDocument, x: number, y: number, color: string | null): void {
  sprite.begin();
  sprite.plot(x, y, color);
  sprite.end();
}

describe('SpriteDocument', () => {
  it('starts fully transparent, with nothing to undo and nothing to save', () => {
    const sprite = SpriteDocument.blank(4, 3);

    expect(sprite.width).toBe(4);
    expect(sprite.height).toBe(3);
    expect(sprite.colorAt(0, 0)).toBeNull();
    expect(sprite.palette()).toEqual([]);
    expect(sprite.canUndo).toBe(false);
    expect(sprite.unsaved).toBe(false);
  });

  it('paints an opaque pixel and reads it back', () => {
    const sprite = SpriteDocument.blank(4, 4);

    expect(sprite.plot(1, 2, '#8b5a2b')).toBe(true);

    expect(sprite.colorAt(1, 2)).toBe('#8b5a2b');
    expect(sprite.pixels[(2 * 4 + 1) * 4 + 3]).toBe(255);
    expect(sprite.unsaved).toBe(true);
  });

  it('reports no change when the pixel is already that colour', () => {
    const sprite = SpriteDocument.blank(2, 2);
    sprite.plot(0, 0, '#ffffff');

    expect(sprite.plot(0, 0, '#ffffff')).toBe(false);
  });

  it('accepts a short hex and refuses anything that is not a colour', () => {
    const sprite = SpriteDocument.blank(2, 2);

    expect(sprite.plot(0, 0, '#f80')).toBe(true);
    expect(sprite.colorAt(0, 0)).toBe('#ff8800');
    expect(sprite.plot(1, 0, 'rebeccapurple')).toBe(false);
  });

  it('erases to fully clear, leaving no colour behind the alpha', () => {
    const sprite = SpriteDocument.blank(2, 2);
    sprite.plot(0, 0, '#ff0000');

    expect(sprite.plot(0, 0, null)).toBe(true);

    expect(sprite.colorAt(0, 0)).toBeNull();
    expect([...sprite.pixels.slice(0, 4)]).toEqual([0, 0, 0, 0]);
  });

  it('ignores pixels outside the sprite rather than wrapping to the next row', () => {
    const sprite = SpriteDocument.blank(3, 3);

    expect(sprite.plot(3, 0, '#ffffff')).toBe(false);
    expect(sprite.plot(-1, 0, '#ffffff')).toBe(false);
    expect(sprite.colorAt(0, 1)).toBeNull();
  });

  it('joins a drag into a line with no gaps', () => {
    const sprite = SpriteDocument.blank(8, 8);

    // What a pointer reports when it moves fast: two positions, five pixels
    // apart, and nothing in between.
    sprite.stroke(1, 1, 5, 5, '#000000');

    for (let step = 1; step <= 5; step += 1) {
      expect(sprite.colorAt(step, step)).toBe('#000000');
    }
  });

  it('undoes a whole stroke at once, and redoes it', () => {
    const sprite = SpriteDocument.blank(8, 8);
    sprite.begin();
    sprite.stroke(0, 0, 4, 0, '#123456');
    sprite.end();

    expect(sprite.canUndo).toBe(true);
    expect(sprite.undo()).toBe(true);

    expect(sprite.colorAt(0, 0)).toBeNull();
    expect(sprite.colorAt(4, 0)).toBeNull();

    expect(sprite.redo()).toBe(true);
    expect(sprite.colorAt(2, 0)).toBe('#123456');
  });

  it('keeps no history for a stroke that changed nothing', () => {
    const sprite = SpriteDocument.blank(4, 4);
    click(sprite, 0, 0, '#ffffff');

    // Painting the same pixel the same colour: a click that did nothing.
    click(sprite, 0, 0, '#ffffff');

    expect(sprite.undo()).toBe(true);
    expect(sprite.colorAt(0, 0)).toBeNull();
    expect(sprite.canUndo).toBe(false);
  });

  it('drops the redo branch once something new is painted', () => {
    const sprite = SpriteDocument.blank(4, 4);
    click(sprite, 0, 0, '#111111');
    sprite.undo();

    click(sprite, 1, 1, '#222222');

    expect(sprite.canRedo).toBe(false);
    expect(sprite.colorAt(0, 0)).toBeNull();
    expect(sprite.colorAt(1, 1)).toBe('#222222');
  });

  it('stops undoing at the bottom of the history instead of failing', () => {
    const sprite = SpriteDocument.blank(2, 2);

    expect(sprite.undo()).toBe(false);
    expect(sprite.redo()).toBe(false);
  });

  it('forgets the oldest strokes rather than growing without bound', () => {
    const sprite = SpriteDocument.blank(64, 2);
    for (let x = 0; x < 40; x += 1) {
      click(sprite, x, 0, '#abcdef');
    }

    let undone = 0;
    while (sprite.undo()) {
      undone += 1;
    }

    expect(undone).toBe(32);
    // The strokes that fell off the bottom stayed painted: history is bounded,
    // the drawing is not.
    expect(sprite.colorAt(0, 0)).toBe('#abcdef');
    expect(sprite.colorAt(39, 0)).toBeNull();
  });

  it('offers the colours already in the drawing, most used first', () => {
    const sprite = SpriteDocument.blank(4, 4);
    sprite.stroke(0, 0, 3, 0, '#8b5a2b');
    sprite.plot(0, 1, '#ffd166');
    sprite.plot(1, 1, '#ffd166');
    sprite.plot(0, 2, '#2b2b2b');

    expect(sprite.palette()).toEqual(['#8b5a2b', '#ffd166', '#2b2b2b']);
    expect(sprite.palette(2)).toEqual(['#8b5a2b', '#ffd166']);
  });

  it('leaves an erased colour out of the palette', () => {
    const sprite = SpriteDocument.blank(4, 4);
    sprite.plot(0, 0, '#ff0000');
    sprite.plot(0, 0, null);

    expect(sprite.palette()).toEqual([]);
  });

  it('is clean again once it has been written', () => {
    const sprite = SpriteDocument.blank(2, 2);
    click(sprite, 0, 0, '#ffffff');

    sprite.markSaved();

    expect(sprite.unsaved).toBe(false);
    // An undo is a change like any other: the file no longer matches.
    sprite.undo();
    expect(sprite.unsaved).toBe(true);
  });

  it('bumps its revision whenever the pixels move, so a view can tell', () => {
    const sprite = SpriteDocument.blank(2, 2);
    const before = sprite.revision;

    sprite.plot(0, 0, '#ffffff');
    const painted = sprite.revision;
    sprite.plot(0, 0, '#ffffff');

    expect(painted).toBeGreaterThan(before);
    expect(sprite.revision).toBe(painted);
  });

  describe('fill, selection and alpha', () => {
    it('floods only the region reachable without crossing an edge', () => {
      const sprite = SpriteDocument.blank(5, 3);
      // A wall down the middle: the flood must stop at it.
      for (let y = 0; y < 3; y += 1) {
        sprite.plot(2, y, '#000000');
      }

      expect(sprite.fill(0, 0, '#ff0000')).toBe(true);

      expect(sprite.colorAt(0, 0)).toBe('#ff0000');
      expect(sprite.colorAt(1, 2)).toBe('#ff0000');
      expect(sprite.colorAt(2, 1)).toBe('#000000');
      // Four-connected and blocked, so nothing leaks to the far side.
      expect(sprite.colorAt(3, 0)).toBeNull();
    });

    it('does nothing when the fill colour is already there', () => {
      const sprite = SpriteDocument.blank(2, 2);
      sprite.fill(0, 0, '#123456');

      expect(sprite.fill(1, 1, '#123456')).toBe(false);
    });

    it('undoes a fill as one step', () => {
      const sprite = SpriteDocument.blank(4, 4);
      sprite.begin();
      sprite.fill(0, 0, '#00ff00');
      sprite.end();

      expect(sprite.undo()).toBe(true);
      expect(sprite.colorAt(2, 2)).toBeNull();
    });

    it('moves a selection and clears what it left behind', () => {
      const sprite = SpriteDocument.blank(4, 4);
      sprite.plot(0, 0, '#ffffff');
      sprite.plot(1, 0, '#aaaaaa');

      expect(sprite.moveSelection({ x: 0, y: 0, width: 2, height: 1 }, 1, 1)).toBe(true);

      expect(sprite.colorAt(0, 0)).toBeNull();
      expect(sprite.colorAt(1, 1)).toBe('#ffffff');
      expect(sprite.colorAt(2, 1)).toBe('#aaaaaa');
    });

    it('drops what a move pushes off the canvas', () => {
      const sprite = SpriteDocument.blank(3, 3);
      sprite.plot(2, 2, '#ffffff');

      sprite.moveSelection({ x: 2, y: 2, width: 1, height: 1 }, 1, 0);

      expect(sprite.colorAt(2, 2)).toBeNull();
    });

    it('crops a selection to the sprite, and refuses one wholly outside it', () => {
      const sprite = SpriteDocument.blank(4, 4);

      expect(sprite.clampSelection({ x: -2, y: -2, width: 4, height: 4 })).toEqual({
        x: 0,
        y: 0,
        width: 2,
        height: 2,
      });
      expect(sprite.clampSelection({ x: 9, y: 9, width: 2, height: 2 })).toBeNull();
    });

    it('paints a partly transparent pixel when one is asked for', () => {
      const sprite = SpriteDocument.blank(2, 2);

      sprite.plot(0, 0, '#204080', 128);

      expect(sprite.alphaAt(0, 0)).toBe(128);
      // Still a colour: the eyedropper and the palette read it as drawn.
      expect(sprite.colorAt(0, 0)).toBe('#204080');
      // And the default is unchanged, which is what the character stage relies on.
      sprite.plot(1, 1, '#204080');
      expect(sprite.alphaAt(1, 1)).toBe(255);
    });
  });
});
