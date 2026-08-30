import { describe, expect, it } from 'vitest';

import { PlacedDecoration, ResolvedDecoration } from '../content/content-types';
import { renderDecorations } from './decoration-model';

/**
 * Turning placements into what the renderer draws: the order, and the nudge.
 *
 * Both are content decisions, and both are made once here rather than in each
 * host (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
 */
describe('renderDecorations', () => {
  /** A definition anchored at the bottom middle of a 32×48 canvas. */
  function drawn(id: string, plane: 'behind' | 'front', order: number): ResolvedDecoration {
    return {
      id,
      resolution: { width: 32, height: 48 },
      anchor: [16, 47],
      placement: [-16, -47, 32, 48],
      plane,
      order,
      animation: 'idle',
      frame: 0,
      asset: `${id}.png`,
    };
  }

  const DEFINITIONS: Record<string, ResolvedDecoration> = {
    grass: drawn('grass', 'behind', 0),
    canopy: drawn('canopy', 'front', 0),
    fence: drawn('fence', 'front', 5),
  };

  const resolve = (id: string): ResolvedDecoration | null => DEFINITIONS[id] ?? null;

  it('sorts by plane, then order, then author order', () => {
    const placements: PlacedDecoration[] = [
      { id: 'fence_0', decoration: 'fence', at: [1, 1] },
      { id: 'canopy_0', decoration: 'canopy', at: [1, 1] },
      { id: 'grass_0', decoration: 'grass', at: [1, 1] },
      { id: 'canopy_1', decoration: 'canopy', at: [1, 1] },
    ];

    expect(renderDecorations(placements, resolve).map((entry) => entry.id)).toEqual([
      // Behind the characters first…
      'grass_0',
      // …then in front, by the definition's order, and author order settles
      // the two that share it.
      'canopy_0',
      'canopy_1',
      'fence_0',
    ]);
  });

  it('adds each placement nudge to the box its anchor gives it', () => {
    const [plain, nudged] = renderDecorations(
      [
        { id: 'a', decoration: 'grass', at: [0, 0] },
        { id: 'b', decoration: 'grass', at: [0, 0], offset: [5, -3] },
      ],
      resolve,
    );

    expect(plain?.placement).toEqual([-16, -47, 32, 48]);
    // Right and down are positive, and the size never moves.
    expect(nudged?.placement).toEqual([-11, -50, 32, 48]);
  });

  /**
   * Validation reports the dangling reference as `decoration.unknownDefinition`;
   * a renderer inventing a marker for it would be a second opinion.
   */
  it('drops a placement whose definition nothing loaded', () => {
    const drawnList = renderDecorations([{ id: 'x', decoration: 'nope', at: [0, 0] }], resolve);
    expect(drawnList).toEqual([]);
  });

  it('outlines the selected placement, and only it', () => {
    const list = renderDecorations(
      [
        { id: 'a', decoration: 'grass', at: [0, 0] },
        { id: 'b', decoration: 'grass', at: [0, 0] },
      ],
      resolve,
      'b',
    );

    expect(list.map((entry) => entry.emphasised)).toEqual([false, true]);
  });
});
