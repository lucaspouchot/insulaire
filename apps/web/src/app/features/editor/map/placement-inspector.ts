/**
 * The decoration-placement inspector: the per-placement editor shown under the
 * decoration tool.
 *
 * It draws nothing. It takes the map's whole placement list as `input()`, shows
 * the ones standing on the selected hex, and emits a rewritten list through
 * {@link PlacementInspector.changed} — the map editor reconciles that onto the
 * {@link WorldDocument} with the document's own mutators
 * (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
 *
 * Keeping it a slice-in / slice-out component is what lets `placement-edits.ts`
 * carry the rules and be tested without the map canvas.
 */

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import {
  idAvailable,
  nudgePlacement,
  removePlacement,
  renamePlacement,
  resetOffset,
  setInteractive,
  setOffsetAxis,
} from './placement-edits';
import { MAX_DECORATION_OFFSET } from '../../../../content/generated/world';
import type { Offset } from '../../../../core/hex/hex-coords';
import type { DocumentDecoration } from '../../../../content/world-document';
import { TranslatePipe } from '../../../i18n/translate.pipe';

@Component({
  selector: 'app-placement-inspector',
  imports: [TranslatePipe],
  templateUrl: './placement-inspector.html',
  styleUrl: './placement-inspector.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlacementInspector {
  /** Every decoration on the open map. Never mutated: edits come back as a copy. */
  readonly placements = input.required<readonly DocumentDecoration[]>();
  /** The selected hex, whose placements the panel edits; `null` shows nothing. */
  readonly cell = input.required<Offset | null>();
  /** Id of the placement outlined on the canvas. */
  readonly selectedId = input<string | null>(null);

  /** The whole placement list, rewritten, for the page to reconcile. */
  readonly changed = output<readonly DocumentDecoration[]>();
  /** A placement the author asked to outline, or `null` to clear the outline. */
  readonly picked = output<string | null>();
  /** An id the author typed that another placement already holds. */
  readonly renameRejected = output<string>();

  protected readonly maxOffset = MAX_DECORATION_OFFSET;

  /** The placements standing on the selected hex, in author order. */
  protected readonly here = computed<readonly DocumentDecoration[]>(() => {
    const cell = this.cell();
    if (cell === null) {
      return [];
    }
    return this.placements().filter(
      (placement) => placement.at.col === cell.col && placement.at.row === cell.row,
    );
  });

  /** Outlines one placement on the canvas, so a row and a tree can be paired. */
  protected pick(id: string): void {
    this.picked.emit(this.selectedId() === id ? null : id);
  }

  protected rename(id: string, field: HTMLInputElement): void {
    const next = field.value.trim();
    if (next === id) {
      return;
    }
    if (!idAvailable(this.placements(), id, next)) {
      // Put the real id back by hand: nothing about the list changed, so no
      // binding would, and a field showing a name the placement does not have
      // is the field lying.
      field.value = id;
      this.renameRejected.emit(next);
      return;
    }
    this.changed.emit(renamePlacement(this.placements(), id, next));
    if (this.selectedId() === id) {
      this.picked.emit(next);
    }
  }

  protected setInteractive(id: string, interactive: boolean): void {
    this.changed.emit(setInteractive(this.placements(), id, interactive));
  }

  protected setOffset(id: string, axis: 0 | 1, raw: string): void {
    this.changed.emit(setOffsetAxis(this.placements(), id, axis, Number.parseFloat(raw)));
    this.picked.emit(id);
  }

  protected nudge(id: string, dx: number, dy: number): void {
    this.changed.emit(nudgePlacement(this.placements(), id, dx, dy));
    this.picked.emit(id);
  }

  protected resetOffset(id: string): void {
    this.changed.emit(resetOffset(this.placements(), id));
    this.picked.emit(id);
  }

  protected remove(id: string): void {
    this.changed.emit(removePlacement(this.placements(), id));
    if (this.selectedId() === id) {
      this.picked.emit(null);
    }
  }
}
