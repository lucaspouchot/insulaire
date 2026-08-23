/**
 * Holds the project's character definitions, and puts them back after a content
 * reset.
 *
 * The same job `TitleScreenService` does, for the same reason: `resetContent()`
 * forgets every loaded file, and `loadProject` refuses a manifest naming a
 * character that is not loaded (`project.unloadedCharacter`). Anything that
 * reloads a project has to register these with the rest, or the project stops
 * loading (`docs/adr/ADR-0028-character-definitions.md`).
 *
 * Each file's own JSON is kept rather than a re-serialised definition: what goes
 * back in is byte for byte what the engine already accepted.
 */

import { Injectable, inject, signal } from '@angular/core';

import { CharacterCategory, CharacterDefinition } from '../../content/content-types';
import { EngineService } from './engine.service';
import { ProjectStoreService, contentUrl } from './project-store.service';

/** One registered character as a picker presents it. */
export interface CharacterChoice {
  readonly id: string;
  readonly name: string;
  readonly category: CharacterCategory;
}

@Injectable({ providedIn: 'root' })
export class CharacterLibraryService {
  private readonly engine = inject(EngineService);
  private readonly store = inject(ProjectStoreService);

  /** Ids of the definitions currently held, in manifest order. */
  readonly ids = signal<readonly string[]>([]);
  /** Picker labels and categories for the same definitions, in the same order. */
  readonly choices = signal<readonly CharacterChoice[]>([]);

  /** The files as authored, by id, kept so they can be registered again. */
  private files = new Map<string, string>();
  private descriptions = new Map<string, CharacterChoice>();
  private loading: Promise<readonly string[]> | null = null;

  /**
   * Loads every definition the manifest lists, at most once.
   *
   * A project that ships none is normal — a game of coloured tokens needs no
   * character definition — and a file that will not load is skipped rather than
   * fatal: the manifest reports it on the next `loadProject`, which is where
   * that failure belongs.
   */
  async ensureLoaded(): Promise<readonly string[]> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<readonly string[]> {
    await this.engine.ready();
    const declared = this.store.project()?.characters ?? [];
    const files = new Map<string, string>();
    const descriptions = new Map<string, CharacterChoice>();

    for (const entry of declared) {
      try {
        const response = await fetch(contentUrl(entry.path));
        if (!response.ok) {
          continue;
        }
        const json = await response.text();
        this.engine.loadCharacter(json);
        files.set(entry.id, json);
        descriptions.set(entry.id, describeCharacter(entry.id, json));
      } catch {
        continue;
      }
    }

    this.files = files;
    this.descriptions = descriptions;
    this.publish();
    return this.ids();
  }

  /** Registers every held definition again, after something ran `resetContent()`. */
  register(): void {
    for (const json of this.files.values()) {
      try {
        this.engine.loadCharacter(json);
      } catch {
        // A definition the engine refuses is reported where it was loaded; the
        // manifest will say so again on the next `loadProject`.
      }
    }
  }

  /** Takes on a definition the editor has just written, so it survives a reset. */
  adopt(id: string, json: string): void {
    this.files.set(id, json);
    this.descriptions.set(id, describeCharacter(id, json));
    this.publish();
    this.engine.loadCharacter(json);
  }

  /** Forgets a definition the editor has taken out of the project. */
  forget(id: string): void {
    this.files.delete(id);
    this.descriptions.delete(id);
    this.publish();
  }

  private publish(): void {
    this.ids.set([...this.files.keys()]);
    this.choices.set(
      [...this.files.keys()]
        .map((id) => this.descriptions.get(id))
        .filter((choice): choice is CharacterChoice => choice !== undefined),
    );
  }
}

function describeCharacter(id: string, json: string): CharacterChoice {
  const definition = JSON.parse(json) as CharacterDefinition;
  return {
    id,
    name: definition.name?.trim() || id,
    category: definition.category ?? 'other',
  };
}
