/**
 * Holds the project's object definitions, and puts them back after a content
 * reset.
 *
 * The mechanics are {@link ContentLibrary}'s. What is an object's own is that
 * its picker label is a **key**, not text: an object's name is what a player
 * reads in an inventory, so the list shows the key and the editor resolves it
 * through the loaded languages (`docs/adr/ADR-0020-localised-content-keys.md`,
 * `docs/adr/ADR-0036-an-object-is-carried-not-placed.md`).
 */

import { Injectable } from '@angular/core';

import { ContentRef } from '../../content/generated/project';
import { ObjectDefinition, ObjectKind } from '../../content/generated/object';
import { ContentLibrary, LibraryChoice } from './content-library';

/** One registered object as a picker presents it. */
export interface ObjectChoice extends LibraryChoice {
  readonly kind: ObjectKind;
  /** Key of the player-facing name, for a host that wants to resolve it. */
  readonly nameKey: string;
}

@Injectable({ providedIn: 'root' })
export class ObjectLibraryService extends ContentLibrary<ObjectChoice> {
  protected declared(): readonly ContentRef[] {
    return this.manifest.objects();
  }

  protected registerOne(json: string): void {
    this.engine.loadObject(json);
  }

  protected describe(id: string, json: string): ObjectChoice {
    const definition = JSON.parse(json) as ObjectDefinition;
    return {
      id,
      name: definition.name?.trim() || id,
      kind: definition.kind ?? 'other',
      nameKey: definition.nameKey ?? '',
    };
  }
}
