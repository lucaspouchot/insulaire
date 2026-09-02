/**
 * The edits the decoration-placement inspector makes to a map's placement list.
 *
 * A placement is a plain record — an id, the definition it draws from, a cell, a
 * whole-pixel nudge, an interactive flag — not one of the packed buffers
 * {@link WorldDocument} guards, so these are pure list transforms and
 * `placement-edits.spec.ts` drives them with plain objects and no `TestBed`.
 *
 * Every function takes the whole placement list and returns a new one. The map
 * editor reconciles the result onto the document through `renameDecoration`,
 * `updateDecoration` and `removeDecoration`
 * (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
 */

import { MAX_DECORATION_OFFSET } from '../../../../content/generated/world';
import type { PixelOffset } from '../../../../content/generated/shared';
import type { DocumentDecoration } from '../../../../content/world-document';

type Placements = readonly DocumentDecoration[];

/** A nudge component, rounded to a whole pixel and held inside the cell. */
function clampOffset(value: number): number {
  return Math.max(-MAX_DECORATION_OFFSET, Math.min(MAX_DECORATION_OFFSET, Math.round(value)));
}

/**
 * `true` when `next` is a name the rename may take: non-empty, changed, and not
 * already held by another placement anywhere on the map.
 *
 * The id is what a scenario addresses, so two placements answering to one name
 * is not a state worth passing through.
 */
export function idAvailable(placements: Placements, id: string, next: string): boolean {
  const trimmed = next.trim();
  return (
    trimmed.length > 0 &&
    trimmed !== id &&
    !placements.some((placement) => placement.id === trimmed)
  );
}

/** Renames one placement, or returns the list unchanged when the id is taken. */
export function renamePlacement(placements: Placements, id: string, next: string): Placements {
  const trimmed = next.trim();
  if (!idAvailable(placements, id, trimmed)) {
    return placements;
  }
  return placements.map((placement) =>
    placement.id === id ? { ...placement, id: trimmed } : placement,
  );
}

/** Sets whether a player may interact with **this** placement. */
export function setInteractive(
  placements: Placements,
  id: string,
  interactive: boolean,
): Placements {
  return placements.map((placement) =>
    placement.id === id ? { ...placement, interactive } : placement,
  );
}

/** Writes one axis of a placement's nudge, rounded and clamped to the cell. */
export function setOffsetAxis(
  placements: Placements,
  id: string,
  axis: 0 | 1,
  value: number,
): Placements {
  if (!Number.isFinite(value)) {
    return placements;
  }
  const clamped = clampOffset(value);
  return placements.map((placement) => {
    if (placement.id !== id) {
      return placement;
    }
    const offset: PixelOffset = [...placement.offset];
    offset[axis] = clamped;
    return { ...placement, offset };
  });
}

/** Nudges a placement by whole pixels, clamped to the cell. */
export function nudgePlacement(
  placements: Placements,
  id: string,
  dx: number,
  dy: number,
): Placements {
  return placements.map((placement) =>
    placement.id === id
      ? {
          ...placement,
          offset: [
            clampOffset(placement.offset[0] + dx),
            clampOffset(placement.offset[1] + dy),
          ] as PixelOffset,
        }
      : placement,
  );
}

/** Puts a placement back exactly where its definition anchors it. */
export function resetOffset(placements: Placements, id: string): Placements {
  return placements.map((placement) =>
    placement.id === id ? { ...placement, offset: [0, 0] as PixelOffset } : placement,
  );
}

/** Removes one placement, whatever else stands on its cell. */
export function removePlacement(placements: Placements, id: string): Placements {
  return placements.filter((placement) => placement.id !== id);
}
