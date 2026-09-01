/**
 * Turns authored decoration *placements* into the flat list the renderer draws.
 *
 * A placement says which definition, where, and whether this one can be
 * interacted with; a definition says what it looks like, where its trunk sits
 * and which side of the characters it is drawn on. Putting the two together —
 * and putting the result in draw order — happens **once per model**, here,
 * rather than once per frame in the renderer
 * (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
 *
 * Both hosts use it: the map editor over the document being edited, and Play
 * over the world view the engine published. Neither may sort decorations its
 * own way, because the order is content, not presentation.
 */

import { PixelRect } from '../content/generated/shared';
import { PlacedDecoration } from '../content/generated/world';
import { ResolvedDecoration } from '../content/generated/decoration';
import { RenderDecoration } from './render-model';

/** Looks up what a decoration definition draws, or `null` when it is unknown. */
export type ResolveDecoration = (definitionId: string) => ResolvedDecoration | null;

/**
 * Resolves and sorts placements into draw order, nudge folded in.
 *
 * The order is `plane` first — everything behind the characters, then
 * everything in front — then the definition's `order` within that plane, then
 * **author order**, which is what settles two trees drawn from one definition
 * (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
 *
 * Each placement's `offset` is added to the box the definition's anchor gives
 * it, so what comes out is already where it goes.
 *
 * A placement naming a definition nothing loaded is dropped rather than drawn
 * as a gap: validation reports it as `decoration.unknownDefinition`, and a
 * renderer inventing a marker for it would be a second opinion.
 *
 * @param selectedId id of the placement to outline, for the editor
 */
export function renderDecorations(
  placements: readonly PlacedDecoration[],
  resolve: ResolveDecoration,
  selectedId: string | null = null,
): RenderDecoration[] {
  // One resolve per *definition*, not per tree: a forest of two hundred oaks
  // asks Rust once.
  const definitions = new Map<string, ResolvedDecoration | null>();
  const resolveOnce = (id: string): ResolvedDecoration | null => {
    if (!definitions.has(id)) {
      definitions.set(id, resolve(id));
    }
    return definitions.get(id) ?? null;
  };

  const entries = placements
    .map((placed, index) => ({ placed, index, drawn: resolveOnce(placed.decoration) }))
    .filter(
      (entry): entry is { placed: PlacedDecoration; index: number; drawn: ResolvedDecoration } =>
        entry.drawn !== null,
    );

  entries.sort((left, right) => {
    const plane = planeRank(left.drawn.plane) - planeRank(right.drawn.plane);
    if (plane !== 0) {
      return plane;
    }
    const order = left.drawn.order - right.drawn.order;
    return order !== 0 ? order : left.index - right.index;
  });

  return entries.map(({ placed, drawn }) => {
    // The nudge is folded in here, once, so neither host — and no renderer —
    // has to remember to add it (ADR-0035).
    const [dx, dy] = placed.offset ?? [0, 0];
    const [x, y, width, height] = drawn.placement;
    return {
      id: placed.id,
      at: { col: placed.at[0], row: placed.at[1] },
      plane: drawn.plane,
      placement: [x + dx, y + dy, width, height] as PixelRect,
      asset: drawn.asset,
      emphasised: selectedId !== null && placed.id === selectedId,
    };
  });
}

/** Behind the characters first, in front of them second. */
function planeRank(plane: ResolvedDecoration['plane']): number {
  return plane === 'front' ? 1 : 0;
}
