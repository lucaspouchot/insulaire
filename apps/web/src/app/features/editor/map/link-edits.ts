/**
 * The edits the door inspector makes to a map's link list.
 *
 * A link is a plain record — an id, the hex it sits on, a target world and
 * arrival, a name — not one of the packed buffers {@link WorldDocument} guards,
 * so these are pure list transforms and `link-edits.spec.ts` drives them with
 * plain objects and no `TestBed`.
 *
 * Every function takes the whole link list and returns a new one; the map
 * editor reconciles the result onto the document through `updateLink` and
 * `removeLinkAt` (`docs/adr/ADR-0014-map-links.md`). Whether an arrival is in
 * bounds, passable and free stays the Rust validator's verdict — nothing here
 * checks the target map.
 */

import type { DocumentLink } from '../../../../content/world-document';

type Links = readonly DocumentLink[];

/** A grid coordinate: a whole number, never negative. */
export function clampCoordinate(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** Repoints one door at another map. */
export function setTarget(links: Links, id: string, worldId: string): Links {
  return links.map((link) => (link.id === id ? { ...link, targetWorld: worldId } : link));
}

/** Moves where one door lands, each axis clamped to a non-negative whole. */
export function setArrival(links: Links, id: string, col: number, row: number): Links {
  return links.map((link) =>
    link.id === id
      ? { ...link, targetAt: { col: clampCoordinate(col), row: clampCoordinate(row) } }
      : link,
  );
}

/** Renames one door; a blank name is the unnamed state. */
export function setName(links: Links, id: string, name: string): Links {
  const trimmed = name.trim();
  return links.map((link) => (link.id === id ? { ...link, name: trimmed } : link));
}

/** Removes one door. */
export function removeLink(links: Links, id: string): Links {
  return links.filter((link) => link.id !== id);
}
