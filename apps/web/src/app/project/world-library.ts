/**
 * The maps the editor holds open, and which one is being edited.
 *
 * Several maps rather than one is what map links require: a door names another
 * map, so authoring one means having the others in hand
 * (`docs/adr/ADR-0014-map-links.md`).
 *
 * A {@link WorldDocument} is a deep module in its own right — packed buffers
 * behind a small interface — and this is not a wrapper over it. It owns the
 * *set*: which documents exist, which is open, what happens to links when one
 * is renamed or removed, and which zone each is in.
 *
 * Zone membership is here rather than on {@link ProjectManifest} because
 * removing a zone has to know whether a map is still in it. The list itself is a
 * manifest field, and is written back through `setZones`
 * (`docs/adr/ADR-0018-map-zones.md`).
 */

import { Injectable, computed, inject, signal } from '@angular/core';

import { ProjectManifest } from './project-manifest';
import { TileSetDefinition } from '../../content/generated/tile-set';
import { WorldDefinition } from '../../content/generated/world';
import { WorldDocument } from '../../content/world-document';
import { serializeWorld } from '../../content/world-serializer';

/** Where the current documents came from. */
export type ProjectSource = 'shipped' | 'restored' | 'imported' | 'new';

@Injectable({ providedIn: 'root' })
export class WorldLibrary {
  private readonly manifest = inject(ProjectManifest);

  private readonly documentsSignal = signal<readonly WorldDocument[]>([]);
  private readonly sourceSignal = signal<ProjectSource>('shipped');
  private readonly activeIdSignal = signal<string | null>(null);
  private readonly editsSignal = signal(0);

  /** Every map in the project, in load order. */
  readonly documents = this.documentsSignal.asReadonly();

  /** Id of the map currently open in the editor. */
  readonly activeWorldId = this.activeIdSignal.asReadonly();

  /**
   * Where the maps now open came from, which the map editor shows beside the
   * dirty flag: an author needs to know whether they are looking at the shipped
   * files, a session restored from browser storage, or something imported.
   */
  readonly source = this.sourceSignal.asReadonly();

  /**
   * How many times the open maps have been edited since the process started.
   *
   * Counts edits this module cannot see as well as the ones it makes:
   * {@link markEdited} is what a brush stroke calls, because painting mutates a
   * document in place and changes no signal.
   */
  readonly edits = this.editsSignal.asReadonly();

  /** The map currently open, or `null` before loading. */
  readonly document = computed<WorldDocument | null>(() => {
    const id = this.activeIdSignal();
    return this.documentsSignal().find((document) => document.id === id) ?? null;
  });

  /** Ids, names and zones of every map, for pickers and link targets. */
  readonly worldChoices = computed(() => {
    const fallback = this.manifest.defaultZoneId();
    return this.documentsSignal().map((document) => ({
      id: document.id,
      name: document.name,
      // The *resolved* zone: a map that names none is in the default one, and
      // callers group maps without having to know that rule.
      zone: document.zone.length > 0 ? document.zone : fallback,
    }));
  });

  /** The open map, or throws when called before the project is loaded. */
  requireDocument(): WorldDocument {
    const document = this.document();
    if (document === null) {
      throw new Error('No map is open; await ensureLoaded() first.');
    }
    return document;
  }

  /** The authored file for the open map. */
  currentDefinition(): WorldDefinition {
    return this.requireDocument().toDefinition();
  }

  /** The authored file for the open map, in the canonical layout. */
  currentJson(): string {
    return serializeWorld(this.currentDefinition());
  }

  /** The authored files for every map, in project order. */
  definitions(): WorldDefinition[] {
    return this.documentsSignal().map((document) => document.toDefinition());
  }

  /**
   * Takes a loaded set of documents on. Editing starts from here, so it is not
   * an edit and the counter is left alone.
   */
  adopt(documents: readonly WorldDocument[], activeId: string, source: ProjectSource): void {
    this.documentsSignal.set([...documents]);
    this.sourceSignal.set(source);
    this.activeIdSignal.set(
      documents.some((document) => document.id === activeId)
        ? activeId
        : (documents[0]?.id ?? null),
    );
  }

  /**
   * Replaces the held documents with rebuilt versions of the same maps.
   *
   * Not {@link adopt}, which starts a session, and not an edit: rebuilding a
   * document after its tile set was replaced changes what is *drawn*, not what
   * the author has written, so it must not make the project owe the disk a
   * write. The open map is kept by id.
   */
  rebuild(documents: readonly WorldDocument[]): void {
    this.documentsSignal.set([...documents]);
  }

  /**
   * Records that a document changed under this module's feet.
   *
   * A `WorldDocument` is a mutable object held in a signal, so painting a hex
   * changes nothing a `computed` can see. This is what a brush stroke calls, and
   * it is the whole of what `WriteLedger.touch()` does to this module.
   */
  markEdited(): void {
    this.editsSignal.update((count) => count + 1);
  }

  /** Opens another map of the project. */
  selectWorld(worldId: string): void {
    if (this.documentsSignal().some((document) => document.id === worldId)) {
      this.activeIdSignal.set(worldId);
    }
  }

  /** Adds a map to the project and opens it. */
  addWorld(document: WorldDocument, source: ProjectSource = 'new'): void {
    this.documentsSignal.update((documents) => [
      ...documents.filter((existing) => existing.id !== document.id),
      document,
    ]);
    this.activeIdSignal.set(document.id);
    this.sourceSignal.set(source);
    this.markEdited();
  }

  /**
   * Removes a map.
   *
   * Links pointing at it are deliberately left alone: silently rewriting them
   * would hide the breakage, and `validateLinks` reports it as
   * `link.unknownTargetWorld` — which is the author's cue to fix or repoint it.
   *
   * @returns `false` when it was the last map, which the project may not lose.
   */
  removeWorld(worldId: string): boolean {
    const remaining = this.documentsSignal().filter((document) => document.id !== worldId);
    if (remaining.length === 0 || remaining.length === this.documentsSignal().length) {
      return false;
    }
    this.documentsSignal.set(remaining);
    if (this.activeIdSignal() === worldId) {
      this.activeIdSignal.set(remaining[0]?.id ?? null);
    }
    this.markEdited();
    return true;
  }

  /**
   * Renames the open map, repointing every link that targeted it.
   *
   * @returns `false` when the id is already taken.
   */
  renameWorld(nextId: string, nextName: string): boolean {
    const document = this.requireDocument();
    const previousId = document.id;
    const documents = this.documentsSignal();
    if (nextId !== previousId && documents.some((other) => other.id === nextId)) {
      return false;
    }

    document.id = nextId;
    document.name = nextName;
    for (const other of documents) {
      other.retargetLinks(previousId, nextId);
    }

    if (this.manifest.startWorld() === previousId) {
      // The renamed map is still where a session starts; leaving the old id in
      // the manifest would silently move the start elsewhere on export.
      this.manifest.setStartWorld(nextId);
    }

    // Documents are mutable objects held in a signal, so an in-place edit is
    // invisible to `computed`s until the array identity changes.
    this.documentsSignal.set([...documents]);
    this.activeIdSignal.set(nextId);
    this.markEdited();
    return true;
  }

  /**
   * Rebuilds a map from an imported world file, replacing one with the same id.
   *
   * Takes its tile set rather than resolving one: {@link TileSetLibrary} already
   * depends on this module — replacing a set rebuilds the maps that paint with
   * it — and this is the one method that would have needed the other direction.
   */
  importDefinition(definition: WorldDefinition, tileSet: TileSetDefinition): WorldDocument {
    const document = WorldDocument.fromDefinition(definition, tileSet);
    this.addWorld(document, 'imported');
    return document;
  }

  /**
   * Moves the open map into a zone.
   *
   * @returns `true` when the zone changed.
   */
  setZone(zone: string): boolean {
    const document = this.requireDocument();
    if (document.zone === zone) {
      return false;
    }
    document.zone = zone;
    // In-place edit of a document held in a signal, as in `renameWorld`: the
    // array identity has to change for `worldChoices` to see it.
    this.documentsSignal.set([...this.documentsSignal()]);
    this.markEdited();
    return true;
  }
}
