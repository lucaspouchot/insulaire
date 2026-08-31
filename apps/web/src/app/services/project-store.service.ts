/**
 * Loads the project being authored or played, and mirrors it into
 * `localStorage` so a refresh does not lose work.
 *
 * This is *editor* state, kept strictly apart from the engine's runtime state
 * (`CLAUDE.md`). What the project **is** belongs to four modules under
 * `app/project/`, and this one composes them:
 *
 * - {@link ProjectManifest} — `project.json` as loaded, and what it declares
 * - {@link WorldLibrary} — the maps held open, and which one is being edited
 * - {@link TileSetLibrary} — the sets those maps paint with
 * - {@link WriteLedger} — the content directory as a baseline, and every
 *   question a save asks of it
 *
 * It forwards none of them. A caller injects the one it needs
 * (`.scratch/module-depth/issues/05-close-the-project-store-read-side.md`).
 *
 * Content is loaded from static files (`content/` mirrored into `public/`).
 * There is no backend and no database; `localStorage` is a convenience for
 * in-progress documents, and only the dev build writes to it.
 */

import { Injectable, computed, effect, inject, signal } from '@angular/core';

import {
  ContentRef,
  ProjectDefinition,
  TileSetDefinition,
  WorldDefinition,
} from '../../content/content-types';
import { WorldDocument } from '../../content/world-document';
import { assetUrl } from '../../core/asset-url';
import { ProjectManifest } from '../project/project-manifest';
import { ProjectSource, WorldLibrary } from '../project/world-library';
import { TileSetLibrary } from '../project/tile-set-library';
import { WriteLedger } from '../project/write-ledger';
import { BUILD_FEATURES } from '../build-features';

/** Where the mirrored authored content is served from, relative to the base. */
export const CONTENT_ROOT = 'content';

/** URL of a file under the content root, resolved against the document base. */
export function contentUrl(path: string): string {
  return assetUrl(`${CONTENT_ROOT}/${path}`);
}

const STORAGE_KEY = 'insulaire.editor.project.v1';

/**
 * One locale file as authored, ready to hand to the engine.
 *
 * The text is kept as the file's own JSON rather than parsed here: the engine
 * owns flattening, merging and the fallback rule, so no host can invent its own
 * (`docs/adr/ADR-0020-localised-content-keys.md`).
 */
export interface LocaleFile {
  readonly language: string;
  /** The file's id in the manifest, which is the key prefix it provides. */
  readonly namespace: string;
  readonly json: string;
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
  private readonly manifest = inject(ProjectManifest);
  private readonly worlds = inject(WorldLibrary);
  private readonly tileSets = inject(TileSetLibrary);
  private readonly ledger = inject(WriteLedger);

  private readonly localeFilesSignal = signal<readonly LocaleFile[]>([]);
  private loading: Promise<void> | null = null;

  /** Every locale file the manifest lists, as fetched. */
  readonly localeFiles = this.localeFilesSignal.asReadonly();

  /** Every edit made to the project, however it was made. */
  private readonly edits = computed(() => this.manifest.edits() + this.worlds.edits());
  /**
   * The edit count this session opened at.
   *
   * The counters are monotonic for the life of the process — nothing resets
   * them, because the ledger dates its own clean point against them — so "has
   * anything been edited" has to be asked *against the current session*, not
   * against zero.
   */
  private openedAt = 0;

  constructor() {
    // The mirror follows the edit counters rather than being written by each
    // mutation, so no module can change the project and forget to mirror it —
    // which is what a hand-called `touch()` allowed.
    effect(() => {
      this.edits();
      this.persist();
    });
  }

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
    this.manifest.adopt(project);

    this.tileSets.adopt(await fetchTileSets(project));
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
    this.captureBaseline(project, onDisk);

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
   * Hands the ledger the content directory as documents, so it can fingerprint
   * what is there. A file that will not rebuild is passed as `null`, which is
   * how it stays out of the baseline.
   */
  private captureBaseline(project: ProjectDefinition, onDisk: readonly DiskFile[]): void {
    this.ledger.captureBaseline(
      project,
      onDisk.map(({ entry, definition }) => ({
        id: entry.id,
        path: entry.path,
        document: definition === null ? null : this.rebuild(definition),
      })),
    );
  }

  /** A document for this definition, or `null` when its tile set is unknown. */
  private rebuild(definition: WorldDefinition): WorldDocument | null {
    try {
      return WorldDocument.fromDefinition(
        definition,
        this.tileSets.requireTileSetFor(definition.tileSetId),
      );
    } catch {
      return null;
    }
  }

  /**
   * Rebuilds documents from stored definitions. `false` when there are none.
   *
   * What browser storage holds is the editor's **work in progress**, not the
   * project: the content directory is the project (ADR-0019), and an author may
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

      // Documents first: a failure to rebuild them must leave the manifest as
      // the files describe it, which is what `load` adopted before calling here.
      this.adopt([...stored.worlds, ...added], stored.activeWorldId, 'restored');
      this.manifest.adopt(mergeManifest(onDisk, stored.project));
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
    // A session starts here, so nothing is owed the mirror yet.
    this.openedAt = this.edits();
    this.worlds.adopt(
      definitions.map((definition) =>
        WorldDocument.fromDefinition(
          definition,
          this.tileSets.requireTileSetFor(definition.tileSetId),
        ),
      ),
      activeId,
      source,
    );
    this.ledger.markClean();
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
    const tileSets = await fetchTileSets(project);
    const localeFiles = await fetchLocaleFiles(project);

    this.tileSets.adopt(tileSets);
    this.manifest.adopt(project);
    this.localeFilesSignal.set(localeFiles);
    this.captureBaseline(
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
   * (`docs/adr/ADR-0020-localised-content-keys.md`).
   */
  setLocaleFiles(files: readonly LocaleFile[]): void {
    this.localeFilesSignal.set([...files]);
  }

  // --------------------------------------------------------------- storage

  private persist(): void {
    // Nothing edited yet is nothing to recover: a project just loaded is
    // already on disk, and mirroring it here would make the *next* load call
    // itself `restored` when it had restored nothing.
    //
    // Against `openedAt` rather than zero, because an effect runs *after* the
    // signals it watches settle: `resetToShipped` adopts, clears storage, and
    // this then runs — so a session that had edited anything before the reset
    // would write the mirror straight back over the clearing.
    if (!BUILD_FEATURES.editor || !this.manifest.loaded() || this.edits() === this.openedAt) {
      return;
    }
    const activeWorldId = this.worlds.activeWorldId();
    if (activeWorldId === null) {
      return;
    }
    try {
      const stored: StoredProject = {
        project: this.ledger.projectDefinition(),
        worlds: this.worlds.definitions(),
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

/** Fetches every tile set the manifest lists, keyed by id. */
async function fetchTileSets(
  project: ProjectDefinition,
): Promise<ReadonlyMap<string, TileSetDefinition>> {
  return new Map(
    await Promise.all(
      project.tileSets.map(
        async (entry) =>
          [entry.id, await fetchJson<TileSetDefinition>(contentUrl(entry.path))] as const,
      ),
    ),
  );
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
    decorations: union(onDisk.decorations ?? [], stored.decorations ?? []),
    objects: union(onDisk.objects ?? [], stored.objects ?? []),
    characterCreation: onDisk.characterCreation ?? stored.characterCreation,
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
