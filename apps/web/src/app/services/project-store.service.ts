/**
 * Owns the project being authored or played: several maps, one tile set per
 * map, and the manifest that ties them together.
 *
 * This is *editor* state, kept strictly apart from the engine's runtime state
 * (`CLAUDE.md`). It holds one {@link WorldDocument} per map, mirrors them into
 * `localStorage` so a refresh does not lose work, and produces the
 * {@link WorldDefinition}s Play mode feeds to the engine.
 *
 * That last point is the important one: Play does not re-read the shipped files
 * when documents exist — it consumes the editor's own export. So "a world
 * created in the editor loads in the runtime unmodified" is exercised every
 * time someone presses Play, not just in tests.
 *
 * Several maps rather than one is what map links require: a door names another
 * map, so authoring one means having the others in hand
 * (`docs/adr/ADR-0017-map-links.md`).
 *
 * Content is loaded from static files (`content/` mirrored into `public/`).
 * There is no backend and no database; `localStorage` is a convenience for
 * in-progress documents, and only the dev build writes to it.
 */

import { Injectable, computed, signal } from '@angular/core';

import {
  ContentRef,
  DEFAULT_ZONE_ID,
  LanguageDefinition,
  PROJECT_SCHEMA_VERSION,
  ProjectDefinition,
  TileSetDefinition,
  WorldDefinition,
  ZoneDefinition,
} from '../../content/content-types';
import { WorldDocument } from '../../content/world-document';
import { serializeProject, serializeWorld } from '../../content/world-serializer';
import { assetUrl } from '../../core/asset-url';
import { BUILD_FEATURES } from '../build-features';

/** Where the mirrored authored content is served from, relative to the base. */
export const CONTENT_ROOT = 'content';

/** URL of a file under the content root, resolved against the document base. */
export function contentUrl(path: string): string {
  return assetUrl(`${CONTENT_ROOT}/${path}`);
}

/**
 * A map's file content, ignoring the `updatedAt` stamp.
 *
 * `toDefinition` takes the clock precisely so callers can pin it; pinning it to
 * the epoch is what lets two versions of a map be compared for a *real*
 * difference rather than for the second having been serialised later.
 */
function fingerprint(document: WorldDocument): string {
  return serializeWorld(document.toDefinition(() => new Date(0)));
}

const STORAGE_KEY = 'insulaire.editor.project.v1';

/** Where the current documents came from. */
export type ProjectSource = 'shipped' | 'restored' | 'imported' | 'new';

/**
 * One locale file as authored, ready to hand to the engine.
 *
 * The text is kept as the file's own JSON rather than parsed here: the engine
 * owns flattening, merging and the fallback rule, so no host can invent its own
 * (`docs/adr/ADR-0023-localised-content-keys.md`).
 */
export interface LocaleFile {
  readonly language: string;
  /** The file's id in the manifest, which is the key prefix it provides. */
  readonly namespace: string;
  readonly json: string;
}

/**
 * One map's file as it stands in the content directory.
 *
 * The fingerprint is the file **as the editor would write it**, timestamp
 * excluded: `toDefinition` stamps `updatedAt` on every call, so comparing raw
 * output would call every map changed on every save and rewrite the lot.
 */
interface DiskWorld {
  /** Path relative to the content directory, from the manifest. */
  readonly path: string;
  readonly fingerprint: string;
}

/** The shape mirrored into `localStorage`. */
interface StoredProject {
  readonly project: ProjectDefinition;
  readonly worlds: readonly WorldDefinition[];
  readonly activeWorldId: string;
}

/** A manifest entry paired with the file behind it, or `null` when it is absent. */
interface DiskFile {
  readonly entry: ContentRef;
  readonly definition: WorldDefinition | null;
}

@Injectable({ providedIn: 'root' })
export class ProjectStoreService {
  private readonly projectSignal = signal<ProjectDefinition | null>(null);
  private readonly documentsSignal = signal<readonly WorldDocument[]>([]);
  private readonly activeIdSignal = signal<string | null>(null);
  private readonly dirtySignal = signal(false);
  private readonly sourceSignal = signal<ProjectSource>('shipped');
  private tileSets = new Map<string, TileSetDefinition>();
  private readonly localeFilesSignal = signal<readonly LocaleFile[]>([]);
  private loading: Promise<void> | null = null;
  /**
   * What the content directory holds, as the editor would write it.
   *
   * This is the baseline every save compares against, and it is what makes a
   * save touch **only** the files that moved: a map whose fingerprint still
   * matches is not rewritten, and a file whose map is gone from the editor is
   * deleted. It is read from disk at load time — never from `localStorage`,
   * which describes edits that have *not* been written yet.
   */
  private diskWorlds = new Map<string, DiskWorld>();
  /** The manifest as it stands in the content directory, canonically serialised. */
  private diskProjectJson: string | null = null;

  /** The manifest, once loaded. */
  readonly project = this.projectSignal.asReadonly();
  /** Every map in the project, in load order. */
  readonly documents = this.documentsSignal.asReadonly();
  /** Id of the map currently open in the editor. */
  readonly activeWorldId = this.activeIdSignal.asReadonly();
  /** `true` when a document has changed since the last save to disk. */
  readonly dirty = this.dirtySignal.asReadonly();
  /** Where the current documents came from. */
  readonly source = this.sourceSignal.asReadonly();
  /** Every locale file the manifest lists, as fetched. */
  readonly localeFiles = this.localeFilesSignal.asReadonly();

  /** The map currently open, or `null` before loading. */
  readonly document = computed<WorldDocument | null>(() => {
    const id = this.activeIdSignal();
    return this.documentsSignal().find((document) => document.id === id) ?? null;
  });

  /** Short label for the UI. */
  readonly title = computed(() => {
    const document = this.document();
    return document === null ? 'No map' : `${document.name} (${document.width}x${document.height})`;
  });

  /**
   * Loads the project, its tile sets and every map it lists, at most once.
   *
   * Prefers documents restored from `localStorage` in the dev build; the client
   * build always reads the shipped files.
   */
  async ensureLoaded(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    const project = await fetchJson<ProjectDefinition>(contentUrl('project.json'));
    this.projectSignal.set(project);

    this.tileSets = new Map(
      await Promise.all(
        project.tileSets.map(
          async (entry) =>
            [entry.id, await fetchJson<TileSetDefinition>(contentUrl(entry.path))] as const,
        ),
      ),
    );

    this.localeFilesSignal.set(await fetchLocaleFiles(project));

    // The files are read even when documents are restored: they are what a save
    // compares against, so the baseline has to be the directory itself and not
    // whatever was in `localStorage` when the tab was closed.
    const onDisk = await Promise.all(
      project.worlds.map(async (entry) => {
        try {
          return { entry, definition: await fetchJson<WorldDefinition>(contentUrl(entry.path)) };
        } catch {
          // A manifest entry with no file is broken content, not a reason to
          // refuse to open the editor: it is simply absent from the baseline,
          // so the first save writes it.
          return { entry, definition: null };
        }
      }),
    );
    this.captureDiskBaseline(project, onDisk);

    if (BUILD_FEATURES.editor && this.restore(project, onDisk)) {
      return;
    }

    const definitions = onDisk.map(({ entry, definition }) => {
      if (definition === null) {
        throw new Error(`The project declares "${entry.id}" at ${entry.path}, which is missing.`);
      }
      return definition;
    });
    this.adopt(definitions, project.startWorld, 'shipped');
  }

  /**
   * Records what the content directory holds, so a later save can write only
   * what moved.
   *
   * A map whose fingerprint cannot be computed — an unknown tile set, most
   * likely — is left out rather than guessed at: absent from the baseline it
   * counts as changed, and a needless write is a far better failure than a
   * skipped one.
   */
  private captureDiskBaseline(project: ProjectDefinition, onDisk: readonly DiskFile[]): void {
    this.diskProjectJson = serializeProject(project);
    this.diskWorlds = new Map();
    for (const { entry, definition } of onDisk) {
      if (definition === null) {
        continue;
      }
      try {
        const document = WorldDocument.fromDefinition(
          definition,
          this.requireTileSetFor(definition.tileSetId),
        );
        this.diskWorlds.set(entry.id, { path: entry.path, fingerprint: fingerprint(document) });
      } catch {
        continue;
      }
    }
  }

  /**
   * Rebuilds documents from stored definitions. `false` when there are none.
   *
   * What browser storage holds is the editor's **work in progress**, not the
   * project: the content directory is the project (ADR-0022), and an author may
   * write into it by hand between two sessions — a map dropped in, a character
   * declared in `project.json`. So the files win wherever the two disagree, and
   * storage contributes only what it alone holds: the maps and the manifest
   * entries the editor made and has not written yet.
   *
   * Restoring the stored manifest wholesale, which is what this used to do, hid
   * everything hand-added — and left the next save ready to overwrite the file
   * with the stale list.
   */
  private restore(onDisk: ProjectDefinition, files: readonly DiskFile[]): boolean {
    const stored = this.readStored();
    if (stored === null) {
      return false;
    }
    try {
      // A map added to the directory since the tab was last open is loaded from
      // its file: the merged manifest is about to declare it, and a declared map
      // with no document is a project the editor cannot show.
      const restored = new Set(stored.worlds.map((world) => world.id));
      const added = files
        .filter((file) => file.definition !== null && !restored.has(file.entry.id))
        .map((file) => file.definition as WorldDefinition);

      this.adopt([...stored.worlds, ...added], stored.activeWorldId, 'restored');
      this.projectSignal.set(mergeManifest(onDisk, stored.project));
      return true;
    } catch {
      // Stored content that no longer matches the tile sets is discarded rather
      // than blocking the editor; the shipped project is always loadable.
      this.clearStored();
      return false;
    }
  }

  private adopt(
    definitions: readonly WorldDefinition[],
    activeId: string,
    source: ProjectSource,
  ): void {
    const documents = definitions.map((definition) =>
      WorldDocument.fromDefinition(definition, this.requireTileSetFor(definition.tileSetId)),
    );
    this.documentsSignal.set(documents);
    this.activeIdSignal.set(
      documents.some((document) => document.id === activeId)
        ? activeId
        : (documents[0]?.id ?? null),
    );
    this.sourceSignal.set(source);
    this.dirtySignal.set(false);
  }

  // ------------------------------------------------------------- accessors

  /** The tile set with this id, or throws. */
  requireTileSetFor(tileSetId: string): TileSetDefinition {
    const tileSet = this.tileSets.get(tileSetId);
    if (tileSet === undefined) {
      throw new Error(`Tile set "${tileSetId}" is not part of this project.`);
    }
    return tileSet;
  }

  /** The tile set the open map paints with. */
  requireTileSet(): TileSetDefinition {
    return this.requireTileSetFor(this.requireDocument().tileSetId);
  }

  /** Every loaded tile set, in project order. */
  tileSetDefinitions(): readonly TileSetDefinition[] {
    return [...this.tileSets.values()];
  }

  /** The open map, or throws when called before {@link ensureLoaded}. */
  requireDocument(): WorldDocument {
    const document = this.document();
    if (document === null) {
      throw new Error('No map is open; await ensureLoaded() first.');
    }
    return document;
  }

  /** The manifest, or throws when called before {@link ensureLoaded}. */
  requireProject(): ProjectDefinition {
    const project = this.projectSignal();
    if (project === null) {
      throw new Error('No project is loaded; await ensureLoaded() first.');
    }
    return project;
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
   * The manifest as it stands, regenerated from the open documents.
   *
   * Maps added or renamed in the editor are reflected here, which is what makes
   * "save the project" write a manifest a client build can boot.
   */
  projectDefinition(): ProjectDefinition {
    const project = this.requireProject();
    const documents = this.documentsSignal();
    const startWorld = documents.some((document) => document.id === project.startWorld)
      ? project.startWorld
      : (documents[0]?.id ?? project.startWorld);

    return {
      id: project.id,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      name: project.name,
      startWorld,
      // Always written out, implicit default included: a map's zone id has to
      // resolve against the manifest it ships with.
      zones: [...this.zones()],
      tileSets: project.tileSets,
      worlds: documents.map((document) => ({
        id: document.id,
        path: `worlds/${document.id}.json`,
      })),
      // Carried through untouched, like the title screen below: the character
      // editor owns this list and declares its own files.
      characters: project.characters,
      // Carried through untouched, like the languages below: these name files
      // the editor does not hold documents for, so regenerating them from what
      // happens to be loaded would drop the title screen and the settings on
      // the first save — and, because this is also what is mirrored into
      // `localStorage`, on the first reload after any edit.
      titleScreen: project.titleScreen,
      settings: project.settings,
      // Carried through untouched: the editor never regenerates the language
      // list from what happens to be loaded, or an export would quietly drop a
      // language whose files failed to fetch.
      locales: project.locales,
    };
  }

  /** The manifest, in the canonical layout. */
  projectJson(): string {
    return serializeProject(this.projectDefinition());
  }

  /**
   * The project's zones, never empty.
   *
   * A project that declares none has one implicit zone, so the editor always
   * has something to put a new map in — zones are mandatory in the model even
   * where the file leaves them out (`docs/adr/ADR-0021-map-zones.md`).
   */
  readonly zones = computed<readonly ZoneDefinition[]>(() => {
    const declared = this.projectSignal()?.zones ?? [];
    return declared.length > 0 ? declared : [{ id: DEFAULT_ZONE_ID, name: 'Default' }];
  });

  /** Id of the zone a map without one belongs to: the first declared. */
  readonly defaultZoneId = computed(() => this.zones()[0]?.id ?? DEFAULT_ZONE_ID);

  /** Ids, names and zones of every map, for pickers and link targets. */
  readonly worldChoices = computed(() => {
    const fallback = this.defaultZoneId();
    return this.documentsSignal().map((document) => ({
      id: document.id,
      name: document.name,
      // The *resolved* zone: a map that names none is in the default one, and
      // callers group maps without having to know that rule.
      zone: document.zone.length > 0 ? document.zone : fallback,
    }));
  });

  // --------------------------------------------------------------- mutation

  /** Opens another map of the project. */
  selectWorld(worldId: string): void {
    if (this.documentsSignal().some((document) => document.id === worldId)) {
      this.activeIdSignal.set(worldId);
    }
  }

  /** Marks the project as changed and mirrors it into `localStorage`. */
  touch(): void {
    this.dirtySignal.set(true);
    this.persist();
  }

  /** Adds a map to the project and opens it. */
  addWorld(document: WorldDocument, source: ProjectSource = 'new'): void {
    this.documentsSignal.update((documents) => [
      ...documents.filter((existing) => existing.id !== document.id),
      document,
    ]);
    this.activeIdSignal.set(document.id);
    this.sourceSignal.set(source);
    this.touch();
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
    this.touch();
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

    const project = this.projectSignal();
    if (project !== null && project.startWorld === previousId) {
      // The renamed map is still where a session starts; leaving the old id in
      // the manifest would silently move the start elsewhere on export.
      this.projectSignal.set({ ...project, startWorld: nextId });
    }

    // Documents are mutable objects held in a signal, so an in-place edit is
    // invisible to `computed`s until the array identity changes.
    this.documentsSignal.set([...documents]);
    this.activeIdSignal.set(nextId);
    this.touch();
    return true;
  }

  /**
   * Declares a zone.
   *
   * The zones a project declares are content, not a derived list: a zone has to
   * exist before a map can be put in it, which is the whole point of creating
   * one. Materialising the implicit default alongside it keeps every map that
   * named no zone exactly where it was — the default is the *first* zone.
   *
   * @returns `false` when the id is empty or already taken.
   */
  addZone(id: string, name: string): boolean {
    if (id.length === 0 || this.zones().some((zone) => zone.id === id)) {
      return false;
    }
    this.projectSignal.set({
      ...this.requireProject(),
      zones: [...this.zones(), { id, name: name.trim() || id }],
    });
    this.touch();
    return true;
  }

  /**
   * Removes a zone.
   *
   * @returns `false` when it is the last zone or a map is still in it — moving
   * those maps somewhere is the author's decision, not this method's.
   */
  removeZone(id: string): boolean {
    const zones = this.zones();
    if (zones.length <= 1 || !zones.some((zone) => zone.id === id)) {
      return false;
    }
    if (this.worldChoices().some((world) => world.zone === id)) {
      return false;
    }
    this.projectSignal.set({
      ...this.requireProject(),
      zones: zones.filter((zone) => zone.id !== id),
    });
    this.touch();
    return true;
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
    this.touch();
    return true;
  }

  /** Rebuilds a map from an imported world file, replacing one with the same id. */
  importDefinition(definition: WorldDefinition): WorldDocument {
    const document = WorldDocument.fromDefinition(
      definition,
      this.requireTileSetFor(definition.tileSetId),
    );
    this.addWorld(document, 'imported');
    return document;
  }

  /**
   * Discards local changes and reloads the shipped project.
   *
   * Everything is fetched before anything is replaced, so a failed reload
   * leaves the editor on the documents it already had rather than half way
   * between two projects.
   */
  async resetToShipped(): Promise<void> {
    const project = await fetchJson<ProjectDefinition>(contentUrl('project.json'));
    const definitions = await Promise.all(
      project.worlds.map((entry) => fetchJson<WorldDefinition>(contentUrl(entry.path))),
    );
    const tileSets = new Map(
      await Promise.all(
        project.tileSets.map(
          async (entry) =>
            [entry.id, await fetchJson<TileSetDefinition>(contentUrl(entry.path))] as const,
        ),
      ),
    );

    const localeFiles = await fetchLocaleFiles(project);

    this.tileSets = tileSets;
    this.projectSignal.set(project);
    this.localeFilesSignal.set(localeFiles);
    this.captureDiskBaseline(
      project,
      project.worlds.map((entry, index) => ({ entry, definition: definitions[index] })),
    );
    this.adopt(definitions, project.startWorld, 'shipped');
    this.clearStored();
  }

  /**
   * Replaces the locale files held for the project.
   *
   * The language editor writes files to disk; this is what keeps the *loaded*
   * project holding the same text, so a later content reset re-registers what
   * was authored rather than what was fetched at boot
   * (`docs/adr/ADR-0027-authoring-creates-keys.md`).
   */
  setLocaleFiles(files: readonly LocaleFile[]): void {
    this.localeFilesSignal.set([...files]);
  }

  /**
   * Declares a locale file in the manifest, so the namespace it provides is
   * loaded next time the project is.
   *
   * A key names its namespace — `menu.title.credits` lives in `menu` — and an
   * author writing the first key of a new namespace should not have to hand-edit
   * `project.json` for it to exist.
   *
   * @returns `false` when the language already declares that namespace.
   */
  declareLocaleFile(language: string, namespace: string, path: string): boolean {
    const project = this.requireProject();
    const languages = project.locales?.languages ?? [];
    const declared = languages.find((candidate) => candidate.id === language);
    if (declared?.files?.some((file) => file.id === namespace)) {
      return false;
    }

    const file = { id: namespace, path };
    const next: LanguageDefinition[] =
      declared === undefined
        ? [...languages, { id: language, files: [file] }]
        : languages.map((candidate) =>
            candidate.id === language
              ? { ...candidate, files: [...(candidate.files ?? []), file] }
              : candidate,
          );

    this.projectSignal.set({
      ...project,
      locales: { default: project.locales?.default, languages: next },
    });
    this.touch();
    return true;
  }

  /**
   * Declares a character definition in the manifest, so it is loaded next time
   * the project is.
   *
   * The same door `declareLocaleFile` opens, for the same reason: creating a
   * character in the editor should not mean hand-editing `project.json` for it
   * to exist (`docs/adr/ADR-0028-character-definitions.md`).
   *
   * @returns `false` when the project already declares that id.
   */
  declareCharacter(id: string, path: string): boolean {
    const project = this.requireProject();
    const declared = project.characters ?? [];
    if (declared.some((entry) => entry.id === id)) {
      return false;
    }
    this.projectSignal.set({ ...project, characters: [...declared, { id, path }] });
    this.touch();
    return true;
  }

  /**
   * Removes a character definition from the manifest.
   *
   * @returns `false` when the project does not declare it.
   */
  undeclareCharacter(id: string): boolean {
    const project = this.requireProject();
    const declared = project.characters ?? [];
    if (!declared.some((entry) => entry.id === id)) {
      return false;
    }
    this.projectSignal.set({
      ...project,
      characters: declared.filter((entry) => entry.id !== id),
    });
    this.touch();
    return true;
  }

  /** Where a character's file lives, declared or by convention. */
  characterPath(id: string): string {
    const declared = this.projectSignal()?.characters?.find((entry) => entry.id === id);
    return declared?.path ?? `characters/${id}.json`;
  }

  // ------------------------------------------------------------------ saving
  //
  // What a save has to write is a *difference* between the documents and the
  // content directory, not the documents themselves: authored content is kept
  // under version control, and a save that rewrites forty untouched files is a
  // diff nobody can read.

  /** Where a map's file lives in the content directory. */
  worldPath(worldId: string): string {
    const onDisk = this.diskWorlds.get(worldId);
    if (onDisk !== undefined) {
      return onDisk.path;
    }
    const declared = this.projectSignal()?.worlds.find((entry) => entry.id === worldId);
    return declared?.path ?? `worlds/${worldId}.json`;
  }

  /**
   * `true` when this map's file does not match the document — including when
   * there is no file yet, which is the case for a map just added or imported.
   */
  worldNeedsWriting(worldId: string): boolean {
    const document = this.documentsSignal().find((candidate) => candidate.id === worldId);
    if (document === undefined) {
      return false;
    }
    return this.diskWorlds.get(worldId)?.fingerprint !== fingerprint(document);
  }

  /** Ids of every map whose file does not match the document, in project order. */
  changedWorldIds(): readonly string[] {
    return this.documentsSignal()
      .filter((document) => this.diskWorlds.get(document.id)?.fingerprint !== fingerprint(document))
      .map((document) => document.id);
  }

  /**
   * Files in the content directory whose map no longer exists here — removed,
   * or renamed, which leaves the old file behind just the same.
   *
   * An id the editor still holds is never orphaned, so renaming a map away and
   * back does not queue its own file for deletion.
   */
  orphanedWorlds(): readonly { id: string; path: string }[] {
    const live = new Set(this.documentsSignal().map((document) => document.id));
    return [...this.diskWorlds]
      .filter(([id]) => !live.has(id))
      .map(([id, onDisk]) => ({ id, path: onDisk.path }));
  }

  /**
   * `true` when `project.json` on disk no longer describes the project as
   * edited — a map was added, renamed, removed, or moved between zones.
   */
  manifestNeedsWriting(): boolean {
    return this.projectJson() !== this.diskProjectJson;
  }

  /** `true` when anything at all is waiting to be written or deleted. */
  hasUnwrittenChanges(): boolean {
    return (
      this.changedWorldIds().length > 0 ||
      this.orphanedWorlds().length > 0 ||
      this.manifestNeedsWriting()
    );
  }

  /** Records that a map's file was written back to the content directory. */
  markWorldWritten(worldId: string): void {
    const document = this.documentsSignal().find((candidate) => candidate.id === worldId);
    if (document !== undefined) {
      this.diskWorlds.set(worldId, {
        path: this.worldPath(worldId),
        fingerprint: fingerprint(document),
      });
    }
  }

  /** Records that a map's file was deleted from the content directory. */
  markWorldDeleted(worldId: string): void {
    this.diskWorlds.delete(worldId);
  }

  /** Records that `project.json` was written back to the content directory. */
  markManifestWritten(): void {
    this.diskProjectJson = this.projectJson();
  }

  /**
   * Re-reads whether anything is still unwritten, and lowers the flag if not.
   *
   * `touch` raises it on the first edit without fingerprinting anything — it
   * runs on every brush stroke. Lowering it means fingerprinting every map, so
   * a save calls this **once**, when it is done: doing it per file would make a
   * save of N maps cost N² serialisations.
   */
  refreshDirty(): void {
    this.dirtySignal.set(this.hasUnwrittenChanges());
  }

  // --------------------------------------------------------------- storage

  private persist(): void {
    if (!BUILD_FEATURES.editor) {
      return;
    }
    const project = this.projectSignal();
    const activeWorldId = this.activeIdSignal();
    if (project === null || activeWorldId === null) {
      return;
    }
    try {
      const stored: StoredProject = {
        project: this.projectDefinition(),
        worlds: this.definitions(),
        activeWorldId,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // Storage can be full or blocked (private mode). The editor keeps working;
      // only crash recovery is lost.
    }
  }

  private readStored(): StoredProject | null {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored === null ? null : (JSON.parse(stored) as StoredProject);
    } catch {
      return null;
    }
  }

  private clearStored(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing to do; see persist().
    }
  }
}

/**
 * Fetches every locale file the manifest lists.
 *
 * A language whose file is missing is *not* fatal here: the fetch failure is
 * skipped and the engine's `validateLocales` reports the gap, which keeps a
 * typo in one path from making the whole editor unopenable.
 */
async function fetchLocaleFiles(project: ProjectDefinition): Promise<LocaleFile[]> {
  const requested = (project.locales?.languages ?? []).flatMap((language) =>
    (language.files ?? []).map((file) => ({
      language: language.id,
      namespace: file.id,
      path: file.path,
    })),
  );

  const fetched = await Promise.all(
    requested.map(async (entry) => {
      try {
        return { ...entry, json: await fetchText(contentUrl(entry.path)) };
      } catch {
        return null;
      }
    }),
  );

  return fetched.filter((entry) => entry !== null);
}

/**
 * The manifest on disk, plus whatever the stored one declares that it does not.
 *
 * Additive on purpose, and only additive: an entry the file holds is the
 * author's, whether they wrote it by hand or the editor wrote it for them, and
 * nothing in browser storage may remove or redirect one. What storage may still
 * contribute is an entry it alone has — something declared in this session and
 * not yet written — which is exactly what would otherwise be lost on a reload.
 *
 * A removal made in the editor and not saved is therefore undone by a reload.
 * That is the safe direction: content comes back, it does not disappear.
 */
function mergeManifest(onDisk: ProjectDefinition, stored: ProjectDefinition): ProjectDefinition {
  return {
    ...onDisk,
    tileSets: union(onDisk.tileSets, stored.tileSets),
    worlds: union(onDisk.worlds, stored.worlds),
    characters: union(onDisk.characters ?? [], stored.characters ?? []),
  };
}

/** `first`, then every entry of `second` under an id `first` does not hold. */
function union(first: readonly ContentRef[], second: readonly ContentRef[]): ContentRef[] {
  const held = new Set(first.map((entry) => entry.id));
  return [...first, ...second.filter((entry) => !held.has(entry.id))];
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load ${url} (HTTP ${response.status}).`);
  }
  return response.text();
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Could not load ${url} (HTTP ${response.status}). ` +
        'Authored content is served from content/; run "npm start" from the repository root.',
    );
  }
  return (await response.json()) as T;
}
