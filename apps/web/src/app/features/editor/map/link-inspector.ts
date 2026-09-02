/**
 * The door inspector: the editor for the door under the selection, plus the
 * list of every door on the map and the "validate doors" button.
 *
 * It draws nothing. It takes the map's link list as `input()`, and emits a
 * rewritten list through {@link LinkInspector.changed} — the map editor
 * reconciles that onto the {@link WorldDocument} with `updateLink` /
 * `removeLinkAt` (`docs/adr/ADR-0014-map-links.md`).
 *
 * Cross-world validation is not the inspector's: a door's target lives in
 * another file, so the button raises {@link LinkInspector.validate} and the
 * page runs it against the whole loaded project.
 */

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { removeLink, setArrival, setName, setTarget } from './link-edits';
import type { Offset } from '../../../../core/hex/hex-coords';
import type { DocumentLink } from '../../../../content/world-document';
import { TranslatePipe } from '../../../i18n/translate.pipe';

/** The other maps a door may point at: id and name, from `worldChoices`. */
export interface LinkTargetChoice {
  readonly id: string;
  readonly name: string;
  readonly zone: string;
}

@Component({
  selector: 'app-link-inspector',
  imports: [TranslatePipe],
  templateUrl: './link-inspector.html',
  styleUrl: './link-inspector.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LinkInspector {
  /** Every door on the open map. Never mutated: edits come back as a copy. */
  readonly links = input.required<readonly DocumentLink[]>();
  /** The door under the selection, which the top of the panel edits. */
  readonly selectedLink = input.required<DocumentLink | null>();
  /** The maps a door may lead to. */
  readonly maps = input.required<readonly LinkTargetChoice[]>();

  /** The whole link list, rewritten, for the page to reconcile. */
  readonly changed = output<readonly DocumentLink[]>();
  /** The hex of a door the author picked from the list. */
  readonly picked = output<Offset>();
  /** The author asked to resolve every door across the project. */
  readonly validate = output<void>();

  protected setTarget(worldId: string): void {
    const link = this.selectedLink();
    if (link !== null) {
      this.changed.emit(setTarget(this.links(), link.id, worldId));
    }
  }

  protected setArrival(colRaw: string, rowRaw: string): void {
    const link = this.selectedLink();
    if (link !== null) {
      this.changed.emit(
        setArrival(this.links(), link.id, Number.parseInt(colRaw, 10), Number.parseInt(rowRaw, 10)),
      );
    }
  }

  protected setName(name: string): void {
    const link = this.selectedLink();
    if (link !== null) {
      this.changed.emit(setName(this.links(), link.id, name));
    }
  }

  protected remove(): void {
    const link = this.selectedLink();
    if (link !== null) {
      this.changed.emit(removeLink(this.links(), link.id));
    }
  }

  protected select(link: DocumentLink): void {
    this.picked.emit(link.at);
  }
}
