/**
 * The tile sets the project paints with, and what replacing one costs.
 *
 * Small, because a tile set is data the engine and the renderer do the work
 * with. The one piece of real behaviour is {@link replaceTileSet}: a
 * {@link WorldDocument} resolves its palette once, when it is built, so a set
 * edited in the asset editor is invisible to the map editor until the documents
 * are rebuilt. That rebuild is why this module depends on {@link WorldLibrary}
 * and not the other way round.
 */

import { Injectable, inject } from '@angular/core';

import { ProjectManifest } from './project-manifest';
import { WorldLibrary } from './world-library';
import { TileSetDefinition } from '../../content/content-types';
import { WorldDocument } from '../../content/world-document';

@Injectable({ providedIn: 'root' })
export class TileSetLibrary {
  private readonly manifest = inject(ProjectManifest);
  private readonly worlds = inject(WorldLibrary);

  private sets = new Map<string, TileSetDefinition>();

  /** Takes a loaded set of tile sets on, discarding whatever was held. */
  adopt(sets: ReadonlyMap<string, TileSetDefinition>): void {
    this.sets = new Map(sets);
  }

  /** The tile set with this id, or throws. */
  requireTileSetFor(tileSetId: string): TileSetDefinition {
    const tileSet = this.sets.get(tileSetId);
    if (tileSet === undefined) {
      throw new Error(`Tile set "${tileSetId}" is not part of this project.`);
    }
    return tileSet;
  }

  /** The tile set the open map paints with. */
  requireTileSet(): TileSetDefinition {
    return this.requireTileSetFor(this.worlds.requireDocument().tileSetId);
  }

  /** Every loaded tile set, in project order. */
  tileSetDefinitions(): readonly TileSetDefinition[] {
    return [...this.sets.values()];
  }

  /** The file the manifest lists for a tile set, or a conventional path. */
  tileSetPath(tileSetId: string): string {
    return this.manifest.tileSetPath(tileSetId);
  }

  /**
   * Replaces a loaded tile set, and rebuilds every map that paints with it.
   *
   * Rebuilding from `toDefinition()` keeps every painted cell — a cell holds a
   * palette *index*, and the definition it exports holds the tile *id*, which is
   * exactly the indirection ADR-0006 exists for
   * (`docs/adr/ADR-0006-assets-tilesets.md`).
   *
   * A map that no longer resolves — its tile was deleted out from under it — is
   * left as it was rather than dropped: the map editor still shows it, and
   * validation reports `tile.unknownReference`, which is where that belongs.
   */
  replaceTileSet(tileSet: TileSetDefinition): void {
    this.sets.set(tileSet.id, tileSet);
    this.worlds.rebuild(
      this.worlds.documents().map((document) => {
        if (document.tileSetId !== tileSet.id) {
          return document;
        }
        try {
          return WorldDocument.fromDefinition(document.toDefinition(), tileSet);
        } catch {
          return document;
        }
      }),
    );
  }
}
