/**
 * What every library of authored definitions does, once.
 *
 * Three of the manifest's lists are the same shape — characters, decorations,
 * objects — and they all owe the runtime the same thing: the files as authored,
 * kept in hand so they can be **registered again** after a content reset.
 * `resetContent()` forgets every loaded file, and `loadProject` refuses a
 * manifest naming a definition that is not loaded (`project.unloadedCharacter`,
 * `project.unloadedDecoration`, `project.unloadedObject`), so anything that
 * reloads a project has to put them back or the project stops loading.
 *
 * Each file's own JSON is kept rather than a re-serialised definition: what goes
 * back in is byte for byte what the engine already accepted.
 *
 * A subclass says three things and nothing else: which manifest list it reads,
 * how one file is registered with the engine, and how one is described for a
 * picker (`docs/adr/ADR-0024-character-definitions.md`,
 * `docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`,
 * `docs/adr/ADR-0036-an-object-is-carried-not-placed.md`).
 */

import { inject, signal } from '@angular/core';

import { ContentRef } from '../../content/content-types';
import { EngineService } from './engine.service';
import { ProjectStoreService, contentUrl } from './project-store.service';

/** The least a picker needs of any definition. */
export interface LibraryChoice {
  readonly id: string;
  readonly name: string;
}

export abstract class ContentLibrary<TChoice extends LibraryChoice> {
  protected readonly engine = inject(EngineService);
  protected readonly store = inject(ProjectStoreService);

  /** Ids of the definitions currently held, in manifest order. */
  readonly ids = signal<readonly string[]>([]);
  /** Picker labels for the same definitions, in the same order. */
  readonly choices = signal<readonly TChoice[]>([]);

  /** The files as authored, by id, kept so they can be registered again. */
  private files = new Map<string, string>();
  private descriptions = new Map<string, TChoice>();
  private loading: Promise<readonly string[]> | null = null;

  /** The manifest list this library loads. */
  protected abstract declared(): readonly ContentRef[];

  /** Hands one file to the engine. */
  protected abstract registerOne(json: string): void;

  /** Reads one file into whatever a picker shows. */
  protected abstract describe(id: string, json: string): TChoice;

  /**
   * Loads every definition the manifest lists, at most once.
   *
   * A project that ships none is normal, and a file that will not load is
   * skipped rather than fatal: the manifest reports it on the next
   * `loadProject`, which is where that failure belongs.
   */
  async ensureLoaded(): Promise<readonly string[]> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<readonly string[]> {
    await this.engine.ready();
    const files = new Map<string, string>();
    const descriptions = new Map<string, TChoice>();

    for (const entry of this.declared()) {
      try {
        const response = await fetch(contentUrl(entry.path));
        if (!response.ok) {
          continue;
        }
        const json = await response.text();
        this.registerOne(json);
        files.set(entry.id, json);
        descriptions.set(entry.id, this.describe(entry.id, json));
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
        this.registerOne(json);
      } catch {
        // A definition the engine refuses is reported where it was loaded; the
        // manifest will say so again on the next `loadProject`.
      }
    }
  }

  /** Takes on a definition the editor has just written, so it survives a reset. */
  adopt(id: string, json: string): void {
    this.files.set(id, json);
    this.descriptions.set(id, this.describe(id, json));
    this.publish();
    this.registerOne(json);
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
        .filter((choice): choice is TChoice => choice !== undefined),
    );
  }
}
