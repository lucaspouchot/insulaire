/**
 * Holds the project's character definitions, and puts them back after a content
 * reset.
 *
 * The mechanics are {@link ContentLibrary}'s — the same three things a
 * decoration or object library does — and what is left here is what makes a
 * character one: the manifest list it reads, the engine call that registers
 * one, and the category a picker groups by
 * (`docs/adr/ADR-0024-character-definitions.md`).
 */

import { Injectable } from '@angular/core';

import { CharacterCategory, CharacterDefinition, ContentRef } from '../../content/content-types';
import { ContentLibrary, LibraryChoice } from './content-library';

/** One registered character as a picker presents it. */
export interface CharacterChoice extends LibraryChoice {
  readonly category: CharacterCategory;
}

@Injectable({ providedIn: 'root' })
export class CharacterLibraryService extends ContentLibrary<CharacterChoice> {
  protected declared(): readonly ContentRef[] {
    return this.store.project()?.characters ?? [];
  }

  protected registerOne(json: string): void {
    this.engine.loadCharacter(json);
  }

  protected describe(id: string, json: string): CharacterChoice {
    const definition = JSON.parse(json) as CharacterDefinition;
    return {
      id,
      name: definition.name?.trim() || id,
      category: definition.category ?? 'other',
    };
  }
}
