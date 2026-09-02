/**
 * The zone editor: declare a zone, or remove the one the maps picker is
 * filtered on.
 *
 * It draws nothing. It takes the project's zone list as `input()` and emits a
 * rewritten list — with a note on what changed — through
 * {@link ZoneInspector.changed}; the map editor writes it back through
 * `ProjectManifest.setZones` (`docs/adr/ADR-0018-map-zones.md`).
 *
 * Which zone the picker shows is the page's view state, not a world slice, so
 * the component only asks for it to be moved through {@link ZoneInspector.filterPicked}.
 */

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { addZone, canAddZone, canRemoveZone, removeZone, slugifyZone } from './zone-edits';
import type { ZoneDefinition } from '../../../../content/generated/project';
import { TranslatePipe } from '../../../i18n/translate.pipe';

/** A rewritten zone list plus what the author just did to it. */
export interface ZoneChange {
  readonly zones: readonly ZoneDefinition[];
  readonly notice: { readonly kind: 'added' | 'removed'; readonly id: string };
}

@Component({
  selector: 'app-zone-inspector',
  imports: [TranslatePipe],
  templateUrl: './zone-inspector.html',
  styleUrl: './zone-inspector.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ZoneInspector {
  /** The project's zones, in author order. Never mutated. */
  readonly zones = input.required<readonly ZoneDefinition[]>();
  /** The zone the maps picker is filtered on, or `null` for every map. */
  readonly activeFilter = input.required<string | null>();
  /** Every zone id maps still resolve to — the implicit default included. */
  readonly occupiedZoneIds = input.required<readonly string[]>();

  /** A rewritten zone list, for the page to write back. */
  readonly changed = output<ZoneChange>();
  /** The zone the maps picker should move to, or `null` for every map. */
  readonly filterPicked = output<string | null>();
  /** A refusal the author should see, as a finished sentence. */
  readonly rejected = output<string>();

  protected add(name: string): void {
    const id = slugifyZone(name);
    if (!canAddZone(this.zones(), id)) {
      this.rejected.emit(
        id.length === 0
          ? 'Give the zone a name.'
          : `The project already has a zone called "${id}".`,
      );
      return;
    }
    this.filterPicked.emit(id);
    this.changed.emit({ zones: addZone(this.zones(), id, name), notice: { kind: 'added', id } });
  }

  protected removeFiltered(): void {
    const id = this.activeFilter();
    if (id === null) {
      return;
    }
    const occupied = new Set(this.occupiedZoneIds());
    if (!canRemoveZone(this.zones(), id, occupied)) {
      this.rejected.emit(
        `Zone "${id}" still holds maps, or is the project's only zone. Move its maps first.`,
      );
      return;
    }
    this.filterPicked.emit(null);
    this.changed.emit({
      zones: removeZone(this.zones(), id, occupied),
      notice: { kind: 'removed', id },
    });
  }
}
