/**
 * Holds the project's generic character-creation declaration and re-registers
 * it after a content reset.
 */

import { Injectable, inject, signal } from '@angular/core';

import { CharacterCreationDefinition, CharacterCreationResult } from '../../content/content-types';
import { CharacterLibraryService } from './character-library.service';
import { EngineService } from './engine.service';
import { ProjectManifest } from '../project/project-manifest';
import { ProjectStoreService, contentUrl } from './project-store.service';

@Injectable({ providedIn: 'root' })
export class CharacterCreationService {
  private readonly engine = inject(EngineService);
  private readonly store = inject(ProjectStoreService);
  private readonly manifest = inject(ProjectManifest);
  private readonly characters = inject(CharacterLibraryService);

  readonly definition = signal<CharacterCreationDefinition | null>(null);
  /** The result accepted by the player for this new-game journey. */
  readonly result = signal<CharacterCreationResult | null>(null);

  private json: string | null = null;
  private loading: Promise<CharacterCreationDefinition | null> | null = null;

  /** Loads the optional declaration after its character dependencies. */
  async ensureLoaded(): Promise<CharacterCreationDefinition | null> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<CharacterCreationDefinition | null> {
    await this.engine.ready();
    await this.store.ensureLoaded();
    await this.characters.ensureLoaded();
    const declared = this.manifest.characterCreation();
    if (declared === null) {
      return null;
    }
    const response = await fetch(contentUrl(declared.path));
    if (!response.ok) {
      throw new Error(`Could not load ${declared.path} (HTTP ${response.status}).`);
    }
    this.json = await response.text();
    this.engine.loadCharacterCreation(this.json);
    const definition = this.engine.characterCreation();
    this.definition.set(definition);
    return definition;
  }

  /** Registers the held file again after `resetContent()`. */
  register(): void {
    if (this.json === null) {
      return;
    }
    try {
      this.engine.loadCharacterCreation(this.json);
    } catch {
      // The manifest reports an invalid or missing registration at load time.
    }
  }

  /** Adopts the file the editor just wrote. */
  adopt(json: string): void {
    this.json = json;
    this.engine.loadCharacterCreation(json);
    this.definition.set(this.engine.characterCreation());
  }

  /** Starts a fresh traversal without carrying an earlier draft forward. */
  begin(): void {
    this.result.set(null);
  }

  /** Keeps the accepted generic result available for the session that follows. */
  complete(result: CharacterCreationResult): void {
    this.result.set(structuredClone(result));
  }
}
