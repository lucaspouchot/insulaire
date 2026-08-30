/**
 * Which drawing of a flipbook is on screen at a time.
 *
 * A **flipbook** is the simplest animation this project has: a list of images
 * in play order, a rate, and whether it starts again when it ends. A decoration
 * animation is one, an object's icon is one, and the two must not disagree
 * about which drawing 250ms lands on.
 *
 * This mirrors `flipbook_index_at` in `crates/world/src/animation.rs`, which
 * stays the authority: what is **drawn** anywhere comes from the Rust resolver,
 * here as everywhere (`docs/adr/ADR-0012-shared-content-validation.md`). What
 * this is for is the things around the drawing — the frame readout under a
 * timeline, the row the editor highlights while playback runs — which a
 * sixty-times-a-second call across the WASM boundary should not be paying for.
 * The mirroring is deliberate and the cases below are the same cases
 * `animation.rs` tests, for the reason
 * `docs/adr/ADR-0011-hex-coordinate-model.md` gives for the hex maths:
 * duplication that is cheaper than the call, with the drift pinned by tests on
 * both sides.
 *
 * In `content/` rather than beside an editor screen because decorations and
 * objects animate in a running game too, and `content/` is framework-free —
 * no signals here (`docs/adr/ADR-0015-client-delivery-build.md`).
 */

import { DEFAULT_FRAME_DURATION_MS } from './content-types';

/**
 * Anything played as a flipbook.
 *
 * Structural rather than a union of the two definitions that satisfy it today,
 * so a third kind costs nothing: `DecorationAnimation` and `ObjectDefinition`
 * both already have this shape.
 */
export interface Flipbook {
  /** Paths under the content root, in play order. */
  readonly frames?: readonly string[];
  /** How long each frame lasts, in milliseconds. */
  readonly frameDurationMs?: number;
  /** Whether it starts again when it ends. A state does not; a flame does. */
  readonly looping?: boolean;
}

/**
 * How long **one frame** lasts, in milliseconds.
 *
 * Not how long a play takes — that is `ResolvedObject.durationMs`, which is a
 * different number and comes from the engine. Named for the frame because the
 * two were once both called a duration.
 *
 * Never zero: it is what {@link frameAt} divides by, and a file may declare it.
 */
export function frameDurationOf(flipbook: Flipbook | null | undefined): number {
  const declared = flipbook?.frameDurationMs ?? DEFAULT_FRAME_DURATION_MS;
  return Number.isFinite(declared) ? Math.max(1, Math.floor(declared)) : DEFAULT_FRAME_DURATION_MS;
}

/**
 * Which frame this time falls in, `0`-based.
 *
 * A looping flipbook wraps; one that does not holds its **last** frame, which
 * is what makes a one-shot state stay in the state it reached — a chest that
 * finished opening is open. An empty flipbook is frame zero, which is the frame
 * a definition blocked out before its art has.
 */
export function frameAt(flipbook: Flipbook, timeMs: number): number {
  const count = flipbook.frames?.length ?? 0;
  if (count === 0) {
    return 0;
  }
  const elapsed = Number.isFinite(timeMs) ? Math.max(0, timeMs) : 0;
  const index = Math.floor(elapsed / frameDurationOf(flipbook));
  return flipbook.looping === true ? index % count : Math.min(index, count - 1);
}
