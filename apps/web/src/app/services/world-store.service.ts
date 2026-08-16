/**
 * Owns the world currently being authored.
 *
 * This is *editor* state, kept strictly apart from the engine's runtime state
 * (`CLAUDE.md`). It holds one {@link WorldDocument}, mirrors it into
 * `localStorage` so a refresh does not lose work, and produces the
 * {@link WorldDefinition} that Play mode feeds to the engine.
 *
 * That last point is the important one: Play does not read the demo file when a
 * document exists — it consumes the editor's own export. So "a world created in
 * the editor loads in the runtime unmodified" is exercised every time someone
 * presses Play, not just in tests.
 *
 * Content is loaded from static files (`content/` mirrored into `public/`).
 * There is no backend and no database; `localStorage` is a convenience for the
 * in-progress document only.
 */

import { Injectable, computed, signal } from '@angular/core';

import { TileSetDefinition, WorldDefinition } from '../../content/content-types';
import { WorldDocument } from '../../content/world-document';
import { serializeWorld } from '../../content/world-serializer';

/** Where the mirrored authored content is served from. */
export const DEMO_TILE_SET_URL = '/content/tilesets/mvp_terrain.json';
export const DEMO_WORLD_URL = '/content/worlds/demo_world.json';

const STORAGE_KEY = 'hex-engine.editor.world.v1';

@Injectable({ providedIn: 'root' })
export class WorldStoreService {
  private readonly documentSignal = signal<WorldDocument | null>(null);
  private readonly tileSetSignal = signal<TileSetDefinition | null>(null);
  private readonly dirtySignal = signal(false);
  private readonly sourceSignal = signal<'demo' | 'restored' | 'imported' | 'new'>('demo');
  private loading: Promise<void> | null = null;

  /** The document being authored, once loaded. */
  readonly document = this.documentSignal.asReadonly();
  /** The tile set the document paints with. */
  readonly tileSet = this.tileSetSignal.asReadonly();
  /** `true` when the document has unsaved changes relative to its last export. */
  readonly dirty = this.dirtySignal.asReadonly();
  /** Where the current document came from. */
  readonly source = this.sourceSignal.asReadonly();

  /** Short label for the UI. */
  readonly title = computed(() => {
    const document = this.documentSignal();
    return document === null ? 'No world' : `${document.name} (${document.width}x${document.height})`;
  });

  /**
   * Loads the tile set and a document, at most once per session.
   *
   * Prefers a document restored from `localStorage`, falling back to the bundled
   * demo world.
   */
  async ensureLoaded(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    const tileSet = await fetchJson<TileSetDefinition>(DEMO_TILE_SET_URL);
    this.tileSetSignal.set(tileSet);

    const restored = this.readStoredDefinition();
    if (restored !== null) {
      try {
        this.documentSignal.set(WorldDocument.fromDefinition(restored, tileSet));
        this.sourceSignal.set('restored');
        return;
      } catch {
        // A stored world that no longer matches the tile set is discarded rather
        // than blocking the editor; the demo world is always loadable.
        this.clearStored();
      }
    }

    const demo = await fetchJson<WorldDefinition>(DEMO_WORLD_URL);
    this.documentSignal.set(WorldDocument.fromDefinition(demo, tileSet));
    this.sourceSignal.set('demo');
  }

  /** The loaded tile set, or throws when called before {@link ensureLoaded}. */
  requireTileSet(): TileSetDefinition {
    const tileSet = this.tileSetSignal();
    if (tileSet === null) {
      throw new Error('Tile set is not loaded yet; await ensureLoaded() first.');
    }
    return tileSet;
  }

  /** The current document, or throws when called before {@link ensureLoaded}. */
  requireDocument(): WorldDocument {
    const document = this.documentSignal();
    if (document === null) {
      throw new Error('No world document is loaded; await ensureLoaded() first.');
    }
    return document;
  }

  /** The authored file for the current document. */
  currentDefinition(): WorldDefinition {
    return this.requireDocument().toDefinition();
  }

  /** The authored file, serialised in the canonical layout. */
  currentJson(): string {
    return serializeWorld(this.currentDefinition());
  }

  /** Marks the document as changed and mirrors it into `localStorage`. */
  touch(): void {
    this.dirtySignal.set(true);
    this.persist();
  }

  /** Replaces the document, e.g. after "New world" or an import. */
  replaceDocument(document: WorldDocument, source: 'imported' | 'new'): void {
    this.documentSignal.set(document);
    this.sourceSignal.set(source);
    this.dirtySignal.set(true);
    this.persist();
  }

  /** Rebuilds the document from an imported world file. */
  importDefinition(definition: WorldDefinition): WorldDocument {
    const document = WorldDocument.fromDefinition(definition, this.requireTileSet());
    this.replaceDocument(document, 'imported');
    return document;
  }

  /** Discards local changes and reloads the bundled demo world. */
  async resetToDemo(): Promise<void> {
    const demo = await fetchJson<WorldDefinition>(DEMO_WORLD_URL);
    this.documentSignal.set(WorldDocument.fromDefinition(demo, this.requireTileSet()));
    this.sourceSignal.set('demo');
    this.dirtySignal.set(false);
    this.clearStored();
  }

  /** Records that the document was exported to a file. */
  markExported(): void {
    this.dirtySignal.set(false);
  }

  private persist(): void {
    const document = this.documentSignal();
    if (document === null) {
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, serializeWorld(document.toDefinition()));
    } catch {
      // Storage can be full or blocked (private mode). The editor keeps working;
      // only crash recovery is lost.
    }
  }

  private readStoredDefinition(): WorldDefinition | null {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored === null ? null : (JSON.parse(stored) as WorldDefinition);
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
