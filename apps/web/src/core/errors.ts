/**
 * The one way this application turns a thrown thing into text for a human.
 *
 * Every screen that awaits something — a fetch, a workspace write, a WASM call
 * — catches `unknown`, and every one of them wants the same sentence out of it.
 * Nine files had written that sentence out by hand, byte for byte, which is
 * eight opportunities for one of them to start saying something else.
 *
 * In `core/` because the play page needs it as much as the editor does, and
 * `core/` is what both builds may reach (`docs/adr/ADR-0015-client-delivery-build.md`).
 */

/** The message of an `Error`, or whatever else was thrown, as text. */
export function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
