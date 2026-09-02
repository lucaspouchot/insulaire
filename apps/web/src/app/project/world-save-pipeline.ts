/**
 * The map editor's save / validate / reconcile choreography, out of the page.
 *
 * `map-editor-page.ts` had a hand-rolled clone of `DraftSet.save` carrying five
 * concerns none of the seven `DraftSet` adapters has: deletion of renamed or
 * removed map files, writing many files in one action, cross-world link
 * validation (`docs/adr/ADR-0014-map-links.md`), an engine content reset with a
 * full re-register before validating, and letting the implicit default zone
 * reach `project.json` (`docs/adr/ADR-0018-map-zones.md`). That is not a
 * `DraftSet` fit, so it lives here instead.
 *
 * Signals nowhere and no `inject()`: dependencies arrive through the
 * constructor as {@link WorldSaveServices}, which is what keeps the whole of it
 * readable from a spec with no `TestBed` — the `DraftSet` bargain
 * (`docs/adr/ADR-0015-client-delivery-build.md`). The page keeps the busy flag,
 * the notices and the user-facing text; this returns a {@link SaveResult} for
 * the page to phrase. `WorldDocument` is untouched — brush-stroke editing stays
 * in the page.
 */

import { ValidationReport } from '../../engine/engine.types';
import { WorldDefinition } from '../../content/generated/world';
import { serializeWorld } from '../../content/world-serializer';

/** What a completed save did, for the page to turn into a notice. */
export interface SaveOutcome {
  /** The verdict the save validated against; a save only runs when it is valid. */
  readonly report: ValidationReport;
  /** Paths of the world files written this save, in project order. */
  readonly written: readonly string[];
  /** `true` when the open map already matched its file (`saveOpenWorld` only). */
  readonly openMapUpToDate: boolean;
  /** `true` when `project.json` was rewritten. */
  readonly manifestWritten: boolean;
  /** Paths of the world files deleted — maps removed, or renamed away. */
  readonly deleted: readonly string[];
}

/**
 * A save either did not run — the engine was still loading, or the content did
 * not validate — or it did, and says what it wrote.
 */
export type SaveResult =
  | { readonly status: 'engine-not-ready' }
  | { readonly status: 'invalid'; readonly report: ValidationReport }
  | { readonly status: 'written'; readonly outcome: SaveOutcome };

/**
 * Every operation the pipeline needs, as narrow calls so a spec can fake it
 * without a `TestBed`. The map editor wires these to `WriteLedger`, the
 * `EngineService`, the content libraries and the authoring server.
 */
export interface WorldSaveServices {
  /** `false` while the WASM engine has not loaded; the pipeline then does nothing. */
  engineReady(): boolean;

  /** The authored file for the open map. */
  openWorld(): WorldDefinition;
  /** The authored files for every map, in project order. */
  allWorlds(): readonly WorldDefinition[];

  // --- WriteLedger ---
  /** Where a map's file lives in the content directory. */
  worldPath(worldId: string): string;
  /** `true` when this map's file does not match the document. */
  worldNeedsWriting(worldId: string): boolean;
  /** Records that a map's file was written back. */
  markWorldWritten(worldId: string): void;
  /** Ids of every map whose file does not match the document, in project order. */
  changedWorldIds(): readonly string[];
  /** Files whose map no longer exists here — removed, or renamed away. */
  orphanedWorlds(): readonly { readonly id: string; readonly path: string }[];
  /** Records that a map's file was deleted. */
  markWorldDeleted(worldId: string): void;
  /** `true` when `project.json` on disk no longer describes the project. */
  manifestNeedsWriting(): boolean;
  /** The manifest as it would be written — the implicit default zone included. */
  projectJson(): string;
  /** Records that `project.json` was written back. */
  markManifestWritten(): void;

  // --- EngineService and the content registry ---
  /**
   * Registers the open map's tile set, so a single world validates against it
   * (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
   */
  registerOpenTileSet(): void;
  /**
   * Clears the engine's content registry and puts back everything a world is
   * judged against but the worlds themselves: locales, title screen, settings,
   * characters, decorations, objects and every tile set
   * (`docs/adr/ADR-0020-localised-content-keys.md`).
   */
  resetAndRegisterContent(): void;
  /** Runs the Rust validator over one world file. */
  validateWorld(json: string): ValidationReport;
  /** Registers one world file with the engine. */
  loadWorld(json: string): void;
  /** Resolves every door across the registered set. */
  validateLinks(): ValidationReport;

  // --- authoring server ---
  writeJson(path: string, json: string): Promise<void>;
  removeFile(path: string): Promise<void>;
}

export class WorldSavePipeline {
  constructor(private readonly services: WorldSaveServices) {}

  /**
   * Validates the open map against its tile set.
   *
   * `null` when the engine is not ready. The tile set is registered first: a
   * world is validated against it, and re-registering is harmless.
   */
  validateOpenWorld(): ValidationReport | null {
    if (!this.services.engineReady()) {
      return null;
    }
    this.services.registerOpenTileSet();
    return this.services.validateWorld(serializeWorld(this.services.openWorld()));
  }

  /**
   * Validates every map, then the doors between them.
   *
   * Each world is validated before it is registered — `loadWorld` throws on
   * content the validator would reject, and a thrown error is a worse report
   * than the validator's. Bails on the first invalid map. `null` when the
   * engine is not ready (`docs/adr/ADR-0014-map-links.md`).
   */
  validateProject(): ValidationReport | null {
    if (!this.services.engineReady()) {
      return null;
    }
    this.services.resetAndRegisterContent();
    for (const definition of this.services.allWorlds()) {
      const json = serializeWorld(definition);
      const report = this.services.validateWorld(json);
      if (!report.valid) {
        return report;
      }
      this.services.loadWorld(json);
    }
    return this.services.validateLinks();
  }

  /**
   * Resolves every door across the whole loaded project.
   *
   * The registry is reset and the whole project re-registered first: loading
   * is additive, so a map removed or renamed in the editor would otherwise
   * still be there to satisfy a door that points at it, and the check would
   * pass on content that no longer exists (`docs/adr/ADR-0014-map-links.md`).
   */
  revalidateLinks(): ValidationReport {
    this.services.resetAndRegisterContent();
    for (const definition of this.services.allWorlds()) {
      this.services.loadWorld(serializeWorld(definition));
    }
    return this.services.validateLinks();
  }

  /**
   * Writes the open map into the content directory, then reconciles the rest.
   *
   * Validated first; an invalid map is never written — the file on disk is what
   * the runtime boots on. A map that already matches its file is left alone.
   */
  async saveOpenWorld(): Promise<SaveResult> {
    const report = this.validateOpenWorld();
    if (report === null) {
      return { status: 'engine-not-ready' };
    }
    if (!report.valid) {
      return { status: 'invalid', report };
    }

    const definition = this.services.openWorld();
    const written: string[] = [];
    if (this.services.worldNeedsWriting(definition.id)) {
      const path = this.services.worldPath(definition.id);
      await this.services.writeJson(path, serializeWorld(definition));
      this.services.markWorldWritten(definition.id);
      written.push(path);
    }

    const { manifestWritten, deleted } = await this.reconcileManifest();
    return {
      status: 'written',
      outcome: { report, written, openMapUpToDate: written.length === 0, manifestWritten, deleted },
    };
  }

  /**
   * Brings the whole content directory in line with the project.
   *
   * Only the maps that actually differ are written: rewriting untouched files
   * would bury the real change in a diff of timestamps.
   */
  async saveProject(): Promise<SaveResult> {
    const report = this.validateProject();
    if (report === null) {
      return { status: 'engine-not-ready' };
    }
    if (!report.valid) {
      return { status: 'invalid', report };
    }

    const byId = new Map(
      this.services.allWorlds().map((definition) => [definition.id, definition]),
    );
    const written: string[] = [];
    for (const id of this.services.changedWorldIds()) {
      const definition = byId.get(id);
      if (definition === undefined) {
        continue;
      }
      const path = this.services.worldPath(id);
      await this.services.writeJson(path, serializeWorld(definition));
      this.services.markWorldWritten(id);
      written.push(path);
    }

    const { manifestWritten, deleted } = await this.reconcileManifest();
    return {
      status: 'written',
      outcome: { report, written, openMapUpToDate: false, manifestWritten, deleted },
    };
  }

  /**
   * Writes `project.json` when it no longer describes the project, then deletes
   * the files of maps the editor no longer holds.
   *
   * The manifest goes first on purpose: one still naming a deleted file is
   * content the runtime cannot load, while a file no manifest names is only
   * clutter. If one of the two fails, this is the half to have done.
   */
  private async reconcileManifest(): Promise<{
    manifestWritten: boolean;
    deleted: readonly string[];
  }> {
    let manifestWritten = false;
    if (this.services.manifestNeedsWriting()) {
      await this.services.writeJson('project.json', this.services.projectJson());
      this.services.markManifestWritten();
      manifestWritten = true;
    }

    const deleted: string[] = [];
    for (const orphan of this.services.orphanedWorlds()) {
      await this.services.removeFile(orphan.path);
      this.services.markWorldDeleted(orphan.id);
      deleted.push(orphan.path);
    }

    return { manifestWritten, deleted };
  }
}
