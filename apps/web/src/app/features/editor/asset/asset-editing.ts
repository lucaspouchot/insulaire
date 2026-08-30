/**
 * The small arithmetic every asset category's form does.
 *
 * Three functions, and they are here rather than in one category's types file
 * because a tile, a character, a decoration and an object all name things,
 * reorder lists and declare a canvas. Nothing here knows what is being edited
 * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
 */

import { MAX_SPRITE_RESOLUTION } from '../../../../content/content-types';

/** A canvas side clamped into what a definition may declare. */
export function clampResolution(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(MAX_SPRITE_RESOLUTION, Math.max(1, Math.round(value)));
}

/** `<stem>`, `<stem>_2`, … — the first one nobody is using. */
export function freeId(stem: string, taken: readonly string[]): string {
  if (!taken.includes(stem)) {
    return stem;
  }
  let index = 2;
  while (taken.includes(`${stem}_${index}`)) {
    index += 1;
  }
  return `${stem}_${index}`;
}

/** Moves one entry of an array, staying inside it. */
export function move<T>(items: T[], index: number, delta: number): void {
  const target = index + delta;
  if (target < 0 || target >= items.length) {
    return;
  }
  const [moved] = items.splice(index, 1);
  if (moved !== undefined) {
    items.splice(target, 0, moved);
  }
}
