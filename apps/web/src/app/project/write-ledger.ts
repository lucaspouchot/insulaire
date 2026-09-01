/**
 * What the content directory holds, so a save can write only what moved.
 *
 * Authored content is kept under version control, so a save that rewrites forty
 * untouched files is a diff nobody can read. What a save has to write is a
 * *difference* between the open documents and the directory, not the documents
 * themselves (`docs/adr/ADR-0019-authoring-content-workspace.md`).
 *
 * The baseline is read from disk at load time — never from `localStorage`, which
 * describes edits that have *not* been written yet.
 *
 * It also holds the manifest **as it would be written**, regenerated from the
 * open documents. That lives here rather than on {@link ProjectManifest} because
 * regenerating it needs the documents, and this is the lowest module that sees
 * both. The same fact serves two callers: it is what a save compares against,
 * and it is what Play loads — Play does not re-read the shipped files when
 * documents exist, so "a world created in the editor loads in the runtime
 * unmodified" is exercised every time someone presses Play.
 */

import { Injectable, computed, inject, signal } from '@angular/core';

import { ProjectManifest } from './project-manifest';
import { WorldLibrary } from './world-library';
import { PROJECT_SCHEMA_VERSION, ProjectDefinition } from '../../content/generated/project';
import { WorldDocument } from '../../content/world-document';
import { serializeProject, serializeWorld } from '../../content/world-serializer';

/**
 * A map's file content, ignoring the `updatedAt` stamp.
 *
 * `toDefinition` takes the clock precisely so callers can pin it; pinning it to
 * the epoch is what lets two versions of a map be compared for a *real*
 * difference rather than for the second having been serialised later.
 */
export function fingerprint(document: WorldDocument): string {
  return serializeWorld(document.toDefinition(() => new Date(0)));
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

@Injectable({ providedIn: 'root' })
export class WriteLedger {
  private readonly manifest = inject(ProjectManifest);
  private readonly worlds = inject(WorldLibrary);

  private diskWorlds = new Map<string, DiskWorld>();
  /** The manifest as it stands in the content directory, canonically serialised. */
  private diskProjectJson: string | null = null;

  /** Total edits made to the project, however they were made. */
  private readonly edits = computed(() => this.manifest.edits() + this.worlds.edits());
  /** The edit count the project was last known to owe the disk nothing at. */
  private readonly cleanAt = signal(0);
  /** Raised by {@link refreshDirty} for a debt no edit of this session caused. */
  private readonly owed = signal(false);

  /**
   * `true` when the project has unwritten changes.
   *
   * Derived rather than set, because the modules that make an edit sit *below*
   * this one and cannot raise a flag it owns. Cheap on purpose: comparing two
   * counters costs nothing, where asking {@link hasUnwrittenChanges} fingerprints
   * every map — and this is read on every brush stroke.
   *
   * The second term is the case no counter can see: a project can owe the disk a
   * write the moment it loads, without anybody editing it — one that declares no
   * zone is about to have the implicit default materialised into its file
   * (`docs/adr/ADR-0018-map-zones.md`). {@link refreshDirty} is what looks.
   */
  readonly dirty = computed(() => this.owed() || this.edits() > this.cleanAt());

  /**
   * Marks the project as changed.
   *
   * What a caller holding a `WorldDocument` calls after editing it in place: a
   * brush stroke mutates packed buffers and changes no signal, so nothing else
   * would notice.
   */
  touch(): void {
    this.worlds.markEdited();
  }

  /**
   * Records that the project owes the disk nothing, whatever the counters say.
   *
   * A load or a reset, which start editing rather than continue it.
   */
  markClean(): void {
    this.cleanAt.set(this.edits());
    this.owed.set(false);
  }

  /**
   * Re-reads whether anything is still unwritten, and lowers the flag if not.
   *
   * An edit raises {@link dirty} without fingerprinting anything — it happens on
   * every brush stroke. Lowering it means fingerprinting every map, so a save
   * calls this **once**, when it is done: doing it per file would make a save of
   * N maps cost N² serialisations.
   */
  refreshDirty(): void {
    if (this.hasUnwrittenChanges()) {
      this.owed.set(true);
    } else {
      this.markClean();
    }
  }

  /**
   * The manifest as it stands, regenerated from the open documents.
   *
   * Maps added or renamed in the editor are reflected here, which is what makes
   * "save the project" write a manifest a client build can boot.
   */
  projectDefinition(): ProjectDefinition {
    const project = this.manifest.require();
    const documents = this.worlds.documents();
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
      zones: [...this.manifest.zones()],
      tileSets: [...this.manifest.tileSets()],
      worlds: documents.map((document) => ({
        id: document.id,
        path: `worlds/${document.id}.json`,
      })),
      // Carried through untouched, like the title screen below: each asset
      // editor owns its own list and declares its own files.
      characters: project.characters,
      decorations: project.decorations,
      objects: project.objects,
      characterCreation: project.characterCreation,
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
   * Records what the content directory holds, so a later save can write only
   * what moved.
   *
   * A map whose fingerprint cannot be computed — an unknown tile set, most
   * likely — is left out rather than guessed at: absent from the baseline it
   * counts as changed, and a needless write is a far better failure than a
   * skipped one.
   */
  captureBaseline(
    project: ProjectDefinition,
    onDisk: Iterable<{ id: string; path: string; document: WorldDocument | null }>,
  ): void {
    this.diskProjectJson = serializeProject(project);
    this.diskWorlds = new Map();
    for (const { id, path, document } of onDisk) {
      if (document !== null) {
        this.diskWorlds.set(id, { path, fingerprint: fingerprint(document) });
      }
    }
  }

  /** Where a map's file lives in the content directory. */
  worldPath(worldId: string): string {
    return this.diskWorlds.get(worldId)?.path ?? this.manifest.worldPath(worldId);
  }

  /**
   * `true` when this map's file does not match the document — including when
   * there is no file yet, which is the case for a map just added or imported.
   */
  worldNeedsWriting(worldId: string): boolean {
    const document = this.worlds.documents().find((candidate) => candidate.id === worldId);
    if (document === undefined) {
      return false;
    }
    return this.diskWorlds.get(worldId)?.fingerprint !== fingerprint(document);
  }

  /** Ids of every map whose file does not match the document, in project order. */
  changedWorldIds(): readonly string[] {
    return this.worlds
      .documents()
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
    const live = new Set(this.worlds.documents().map((document) => document.id));
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
    const document = this.worlds.documents().find((candidate) => candidate.id === worldId);
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
}
