/**
 * The rules for editing a project's zone list.
 *
 * A zone is a plain `{ id, name }` record on the manifest — not one of the
 * packed buffers {@link WorldDocument} guards — so these are pure list
 * transforms and `zone-edits.spec.ts` drives them with plain objects and no
 * `TestBed` (`docs/adr/ADR-0018-map-zones.md`).
 *
 * The map editor applies the returned list through `ProjectManifest.setZones`.
 * The first zone is the implicit default, so `addZone` appends and `removeZone`
 * refuses to leave the project with none.
 */

import type { ZoneDefinition } from '../../../../content/generated/project';

type Zones = readonly ZoneDefinition[];

/** The zone id derived from an author's free-text name. */
export function slugifyZone(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** `true` when a zone with this slug can be added: non-empty and not taken. */
export function canAddZone(zones: Zones, id: string): boolean {
  return id.length > 0 && !zones.some((zone) => zone.id === id);
}

/** Appends a zone, or returns the list unchanged when the slug is blank or taken. */
export function addZone(zones: Zones, id: string, name: string): Zones {
  if (!canAddZone(zones, id)) {
    return zones;
  }
  return [...zones, { id, name: name.trim() || id }];
}

/**
 * `true` when the zone can be removed: it exists, still holds no maps, and is
 * not the project's only one.
 *
 * `occupied` is the set of zone ids maps still resolve to — the implicit
 * default included, so the first zone counts as occupied while any map names no
 * zone of its own.
 */
export function canRemoveZone(zones: Zones, id: string, occupied: ReadonlySet<string>): boolean {
  return zones.length > 1 && zones.some((zone) => zone.id === id) && !occupied.has(id);
}

/** Removes a zone, or returns the list unchanged when the removal is refused. */
export function removeZone(zones: Zones, id: string, occupied: ReadonlySet<string>): Zones {
  if (!canRemoveZone(zones, id, occupied)) {
    return zones;
  }
  return zones.filter((zone) => zone.id !== id);
}
