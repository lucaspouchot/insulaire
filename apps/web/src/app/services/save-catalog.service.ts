/**
 * The saved games a player can continue from.
 *
 * **Nothing writes here yet.** Saving needs the engine to serialise its
 * `GameState`, which it does not, and a store in IndexedDB, which ADR-0007
 * specifies and nobody has built. This service exists so that the one screen
 * that asks the question — the title screen's *Continue* button — asks it of a
 * real place, and so that implementing saves is a matter of filling this in
 * rather than of finding every caller
 * (`docs/adr/ADR-0021-authored-title-screen.md`).
 *
 * Until then it answers honestly: there are no saves, and *Continue* is offered
 * disabled rather than hidden, because a menu that changes shape depending on
 * hidden state is worse than one that says why a choice is unavailable.
 */

import { Injectable, signal } from '@angular/core';

/** One entry in the load menu. */
export interface SaveSlot {
  readonly id: string;
  /** Display name, already resolved — a save is named by the player, not keyed. */
  readonly name: string;
  /** ISO 8601 timestamp of the write. */
  readonly savedAt: string;
  readonly worldId: string;
  readonly tick: number;
}

@Injectable({ providedIn: 'root' })
export class SaveCatalogService {
  private readonly slotsSignal = signal<readonly SaveSlot[]>([]);

  /** Saved games, newest first. Empty until the save system exists. */
  readonly slots = this.slotsSignal.asReadonly();

  /** `true` when there is something to continue from. */
  hasSaves(): boolean {
    return this.slotsSignal().length > 0;
  }

  /**
   * Re-reads the catalogue.
   *
   * A no-op today; the title screen calls it so the call site is already right
   * when IndexedDB is behind it.
   */
  async refresh(): Promise<void> {
    this.slotsSignal.set([]);
  }
}
