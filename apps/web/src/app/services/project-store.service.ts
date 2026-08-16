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
  PROJECT_SCHEMA_VERSION,
  ProjectDefinition,
  TileSetDefinition,
  WorldDefinition,
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

const STORAGE_KEY = 'hex-engine.editor.project.v1';

/** Where the current documents came from. */
export type ProjectSource = 'shipped' | 'restored' | 'imported' | 'new';

/** The shape mirrored into `localStorage`. */
interface StoredProject {
  readonly project: ProjectDefinition;
  readonly worlds: readonly WorldDefinition[];
  readonly activeWorldId: string;
}

@Injectable({ providedIn: 'root' })
export class ProjectStoreService {
  private readonly projectSignal = signal<ProjectDefinition | null>(null);
  private readonly documentsSignal = signal<readonly WorldDocument[]>([]);
  private readonly activeIdSignal = signal<string | null>(null);
  private readonly dirtySignal = signal(false);
  private readonly sourceSignal = signal<ProjectSource>('shipped');
  private tileSets = new Map<string, TileSetDefinition>();
  private loading: Promise<void> | null = null;

  /** The manifest, once loaded. */
  readonly project = this.projectSignal.asReadonly();
  /** Every map in the project, in load order. */
  readonly documents = this.documentsSignal.asReadonly();
  /** Id of the map currently open in the editor. */
  readonly activeWorldId = this.activeIdSignal.asReadonly();
  /** `true` when a document has changed since the last export. */
  readonly dirty = this.dirtySignal.asReadonly();
  /** Where the current documents came from. */
  readonly source = this.sourceSignal.asReadonly();

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

    if (BUILD_FEATURES.editor && this.restore()) {
      return;
    }

    const definitions = await Promise.all(
      project.worlds.map((entry) => fetchJson<WorldDefinition>(contentUrl(entry.path))),
    );
    this.adopt(definitions, project.startWorld, 'shipped');
  }

  /** Rebuilds documents from stored definitions. `false` when there are none. */
  private restore(): boolean {
    const stored = this.readStored();
    if (stored === null) {
      return false;
    }
    try {
      this.adopt(stored.worlds, stored.activeWorldId, 'restored');
      this.projectSignal.set(stored.project);
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
   * "export the project" produce a bundle a client build can boot.
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
      tileSets: project.tileSets,
      worlds: documents.map((document) => ({
        id: document.id,
        path: `worlds/${document.id}.json`,
      })),
    };
  }

  /** The manifest, in the canonical layout. */
  projectJson(): string {
    return serializeProject(this.projectDefinition());
  }

  /** Ids and names of every map, for pickers and link targets. */
  readonly worldChoices = computed(() =>
    this.documentsSignal().map((document) => ({ id: document.id, name: document.name })),
  );

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

    this.tileSets = tileSets;
    this.projectSignal.set(project);
    this.adopt(definitions, project.startWorld, 'shipped');
    this.clearStored();
  }

  /** Records that the project was exported to files. */
  markExported(): void {
    this.dirtySignal.set(false);
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
