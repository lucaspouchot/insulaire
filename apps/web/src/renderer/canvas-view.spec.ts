import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { Offset, offset } from '../core/hex/hex-coords';
import { Point } from '../core/hex/hex-layout';
import { CanvasView } from './canvas-view';
import { HexMapRenderer, PointerTarget } from './hex-map-renderer';

/**
 * Pointer input, which is the half of this class that has to be exactly right.
 *
 * The renderer is a double: what a screen point resolves to is
 * `HexMapRenderer`'s business and is pinned there. What is pinned here is *when*
 * this class asks, and with what intent — the peek key is the case that cannot
 * be read off a pointer event at all, because a hand holding it over a still
 * pointer sends no pointer event
 * (`docs/adr/ADR-0047-relief-never-hides-a-hex.md`).
 */
describe('CanvasView pointer input', () => {
  /** The hex a pointer resolves to, with and without the peek key held. */
  const RELIEF = offset(4, 6);
  const BURIED = offset(4, 4);
  /** A physical position, not a printed character (ADR-0045). */
  const PEEK_KEY = 'KeyS';

  beforeAll(() => {
    globalThis.ResizeObserver ??= class {
      observe(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  });

  const views: CanvasView[] = [];
  afterEach(() => {
    for (const view of views.splice(0)) {
      view.dispose();
    }
  });

  interface Harness {
    readonly view: CanvasView;
    readonly canvas: HTMLCanvasElement;
    /** Every `resolvePointer` the view made, in order. */
    readonly asked: { point: Point; peek: boolean }[];
    /** Every hex handed to the renderer's outline. */
    readonly hovered: (Offset | null)[];
    /** Every hex handed to the renderer's reveal. */
    readonly revealed: (Offset | null)[];
    /** Every hex reported to the host. */
    readonly reported: (Offset | null)[];
  }

  function harness(peekKey: string | null = PEEK_KEY): Harness {
    const asked: { point: Point; peek: boolean }[] = [];
    const hovered: (Offset | null)[] = [];
    const revealed: (Offset | null)[] = [];
    const reported: (Offset | null)[] = [];

    const renderer = {
      resolvePointer(point: Point, peek = false): PointerTarget {
        asked.push({ point, peek });
        return { cell: peek ? BURIED : RELIEF, buried: BURIED };
      },
      setHover: (cell: Offset | null) => hovered.push(cell),
      setReveal: (cell: Offset | null) => revealed.push(cell),
      draw: () => undefined,
      camera: { panBy: () => undefined, zoomBy: () => undefined },
      fitToViewport: () => undefined,
    } as unknown as HexMapRenderer;

    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    const view = new CanvasView(canvas, renderer, { onHover: (cell) => reported.push(cell) });
    view.setPeekKey(peekKey);
    views.push(view);
    return { view, canvas, asked, hovered, revealed, reported };
  }

  /** jsdom has no `PointerEvent`; the handlers only read mouse fields. */
  function pointer(canvas: HTMLCanvasElement, type: string, init: MouseEventInit = {}): void {
    canvas.dispatchEvent(new MouseEvent(type, { clientX: 40, clientY: 70, ...init }));
  }

  function key(type: 'keydown' | 'keyup', init: KeyboardEventInit = {}): void {
    window.dispatchEvent(new KeyboardEvent(type, { code: PEEK_KEY, key: 's', ...init }));
  }

  it('asks without the peek while the key is not held', () => {
    const view = harness();
    pointer(view.canvas, 'pointermove');

    expect(view.asked).toEqual([{ point: { x: 40, y: 70 }, peek: false }]);
    expect(view.hovered).toEqual([RELIEF]);
    expect(view.revealed).toEqual([BURIED]);
  });

  it('re-asks with the peek when the key goes down under a still pointer', () => {
    const view = harness();
    pointer(view.canvas, 'pointermove');
    view.asked.length = 0;

    // No pointer event at all: the hand is on the keyboard.
    key('keydown');

    expect(view.asked).toEqual([{ point: { x: 40, y: 70 }, peek: true }]);
    // The outline moves onto the hex the relief hides, and the host is told.
    expect(view.hovered.at(-1)).toEqual(BURIED);
    expect(view.reported.at(-1)).toEqual(BURIED);
  });

  it('puts the pointer back on the relief when the key is released', () => {
    const view = harness();
    pointer(view.canvas, 'pointermove');
    key('keydown');
    view.asked.length = 0;

    key('keyup');

    expect(view.asked).toEqual([{ point: { x: 40, y: 70 }, peek: false }]);
    expect(view.hovered.at(-1)).toEqual(RELIEF);
  });

  it('watches the physical position rather than the printed character', () => {
    // AZERTY sends `{ code: 'KeyS', key: 's' }` here too, but a layout that
    // prints something else must still peek (ADR-0045).
    const view = harness();
    pointer(view.canvas, 'pointermove');
    view.asked.length = 0;

    key('keydown', { key: 'ς' });
    expect(view.asked.at(-1)?.peek).toBe(true);

    // ...and a different position that happens to print `s` does not.
    view.asked.length = 0;
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD', key: 's' }));
    expect(view.asked).toEqual([]);
  });

  it('ignores the key while it is being typed into a form', () => {
    const view = harness();
    pointer(view.canvas, 'pointermove');
    view.asked.length = 0;

    const input = document.createElement('input');
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { code: PEEK_KEY, bubbles: true }));
    input.remove();

    expect(view.asked).toEqual([]);
  });

  it('ignores the key held as part of a chord', () => {
    const view = harness();
    pointer(view.canvas, 'pointermove');
    view.asked.length = 0;

    // Ctrl+S is the browser's, not the map's.
    key('keydown', { ctrlKey: true });

    expect(view.asked).toEqual([]);
  });

  it('forgets the key when the window loses focus', () => {
    const view = harness();
    pointer(view.canvas, 'pointermove');
    key('keydown');
    view.asked.length = 0;

    // The `keyup` never arrives when focus leaves mid-press, and a stuck key
    // would silently re-point every later click.
    window.dispatchEvent(new Event('blur'));

    expect(view.asked).toEqual([{ point: { x: 40, y: 70 }, peek: false }]);
  });

  it('lets the key go when it is rebound while held', () => {
    const view = harness();
    pointer(view.canvas, 'pointermove');
    key('keydown');
    view.asked.length = 0;

    // The old key will never send its `keyup` to this class again.
    view.view.setPeekKey('KeyC');

    expect(view.asked).toEqual([{ point: { x: 40, y: 70 }, peek: false }]);
  });

  it('peeks on nothing when no key is bound', () => {
    const view = harness(null);
    pointer(view.canvas, 'pointermove');
    view.asked.length = 0;

    key('keydown');

    expect(view.asked).toEqual([]);
  });

  it('resolves nothing from a key press once the pointer has left the map', () => {
    const view = harness();
    pointer(view.canvas, 'pointermove');
    view.canvas.dispatchEvent(new MouseEvent('pointerleave'));
    view.asked.length = 0;

    key('keydown');

    expect(view.asked).toEqual([]);
    expect(view.hovered.at(-1)).toBeNull();
  });

  it('stops listening to the keyboard once disposed', () => {
    const view = harness();
    pointer(view.canvas, 'pointermove');
    for (const disposed of views.splice(0)) {
      disposed.dispose();
    }
    view.asked.length = 0;

    key('keydown');

    expect(view.asked).toEqual([]);
  });
});
