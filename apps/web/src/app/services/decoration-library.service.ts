/**
 * Holds the project's decoration definitions, and puts them back after a
 * content reset.
 *
 * The mechanics are {@link ContentLibrary}'s. What is a decoration's own is the
 * plane a picker shows beside the name: which side of the characters this thing
 * is drawn on is the first question an author asks about a prop, and the answer
 * belongs in the list rather than two clicks in
 * (`docs/adr/ADR-0048-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
 */

import { Injectable } from '@angular/core';

import {
  ContentRef,
  DecorationCategory,
  DecorationDefinition,
  DecorationPlane,
} from '../../content/content-types';
import { ContentLibrary, LibraryChoice } from './content-library';

/** One registered decoration as a picker presents it. */
export interface DecorationChoice extends LibraryChoice {
  readonly category: DecorationCategory;
  readonly plane: DecorationPlane;
}

@Injectable({ providedIn: 'root' })
export class DecorationLibraryService extends ContentLibrary<DecorationChoice> {
  protected declared(): readonly ContentRef[] {
    return this.store.project()?.decorations ?? [];
  }

  protected registerOne(json: string): void {
    this.engine.loadDecoration(json);
  }

  protected describe(id: string, json: string): DecorationChoice {
    const definition = JSON.parse(json) as DecorationDefinition;
    return {
      id,
      name: definition.name?.trim() || id,
      category: definition.category ?? 'other',
      plane: definition.plane ?? 'behind',
    };
  }
}
