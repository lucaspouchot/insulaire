/**
 * `project.json` as it was loaded: what the project declares, and the door
 * through which the editor declares more.
 *
 * The manifest is what lets a client build boot with no editor and no backend —
 * it reads this file and loads exactly what it lists
 * (`docs/adr/ADR-0015-client-delivery-build.md`). That makes its field names a
 * contract, and this module is where the contract stops: a caller asks for the
 * declared characters, and never learns that they live under `characters`.
 *
 * Reading around it is what this module exists to prevent. Ten modules used to
 * reach into `ProjectDefinition` directly, so renaming one field was a ten-file
 * change the compiler only caught because the interface happened to be exported
 * at all.
 *
 * It is the leaf of the project modules: it depends on nothing, and
 * {@link WorldLibrary}, {@link TileSetLibrary} and {@link WriteLedger} depend on
 * it. What it deliberately does **not** hold is the manifest *as it would be
 * written* — that is regenerated from the open documents, so it lives on
 * {@link WriteLedger}, which is the lowest module that sees both.
 */

import { Injectable, computed, signal } from '@angular/core';

import {
  ContentRef,
  DEFAULT_ZONE_ID,
  LanguageDefinition,
  LocalesDefinition,
  ProjectDefinition,
  ZoneDefinition,
} from '../../content/content-types';

/**
 * The manifest lists that hold one file per definition.
 *
 * Also the directory each one lives in by convention, which is what lets
 * {@link ProjectManifest.characterPath} and its siblings be one function.
 */
type LibraryKind = 'characters' | 'decorations' | 'objects';

@Injectable({ providedIn: 'root' })
export class ProjectManifest {
  private readonly definitionSignal = signal<ProjectDefinition | null>(null);
  private readonly editsSignal = signal(0);

  /**
   * How many times the manifest has been edited since the process started.
   *
   * The counter {@link WriteLedger} derives `dirty` from. A count rather than a
   * flag because the ledger has to be able to say "clean *as of here*" without
   * being able to reach back and lower a flag this module owns — see
   * `## Decisions` in `.scratch/module-depth/issues/05-close-the-project-store-read-side.md`.
   */
  readonly edits = this.editsSignal.asReadonly();

  /**
   * The manifest as loaded, or `null` before loading.
   *
   * Public for the two callers that need the whole document — the store, which
   * mirrors it, and the ledger, which regenerates it. Reach for an accessor
   * below rather than a field of this.
   */
  readonly definition = this.definitionSignal.asReadonly();

  /** `true` once a project has been loaded. */
  readonly loaded = computed(() => this.definitionSignal() !== null);

  /** The project's name, for the window title and the main menu. */
  readonly name = computed(() => this.definitionSignal()?.name ?? null);

  /** Id of the map a session starts on. */
  readonly startWorld = computed(() => this.definitionSignal()?.startWorld ?? null);

  /** Every map the file declares, in project order. */
  readonly worlds = computed<readonly ContentRef[]>(() => this.definitionSignal()?.worlds ?? []);

  /** Every tile set the file declares, in project order. */
  readonly tileSets = computed<readonly ContentRef[]>(() => this.definitionSignal()?.tileSets ?? []);

  /** Every character definition the file declares, in project order. */
  readonly characters = computed<readonly ContentRef[]>(() => this.listOf('characters'));

  /** Every decoration definition the file declares, in project order. */
  readonly decorations = computed<readonly ContentRef[]>(() => this.listOf('decorations'));

  /** Every object definition the file declares, in project order. */
  readonly objects = computed<readonly ContentRef[]>(() => this.listOf('objects'));

  /** The character-creation declaration, or `null` when the project has none. */
  readonly characterCreation = computed<ContentRef | null>(
    () => this.definitionSignal()?.characterCreation ?? null,
  );

  /** The title screen declaration, or `null` when the project opens on a map. */
  readonly titleScreen = computed<ContentRef | null>(
    () => this.definitionSignal()?.titleScreen ?? null,
  );

  /** The settings declaration, or `null` when the project offers none. */
  readonly settings = computed<ContentRef | null>(() => this.definitionSignal()?.settings ?? null);

  /** The whole locale declaration, or `null` when the project ships none. */
  readonly locales = computed<LocalesDefinition | null>(
    () => this.definitionSignal()?.locales ?? null,
  );

  /** Every language the project declares, in author order. */
  readonly languages = computed<readonly LanguageDefinition[]>(
    () => this.definitionSignal()?.locales?.languages ?? [],
  );

  /**
   * The project's zones, never empty.
   *
   * A project that declares none has one implicit zone, so the editor always
   * has something to put a new map in — zones are mandatory in the model even
   * where the file leaves them out (`docs/adr/ADR-0018-map-zones.md`).
   */
  readonly zones = computed<readonly ZoneDefinition[]>(() => {
    const declared = this.definitionSignal()?.zones ?? [];
    return declared.length > 0 ? declared : [{ id: DEFAULT_ZONE_ID, name: 'Default' }];
  });

  /** Id of the zone a map without one belongs to: the first declared. */
  readonly defaultZoneId = computed(() => this.zones()[0]?.id ?? DEFAULT_ZONE_ID);

  private listOf(library: LibraryKind): readonly ContentRef[] {
    return this.definitionSignal()?.[library] ?? [];
  }

  /** The manifest, or throws when called before the project is loaded. */
  require(): ProjectDefinition {
    const project = this.definitionSignal();
    if (project === null) {
      throw new Error('No project is loaded; await ensureLoaded() first.');
    }
    return project;
  }

  /**
   * Takes a loaded manifest on. Editing starts from here, so it is not an edit.
   *
   * The counter is left alone deliberately: adopting is what a load or a reset
   * does, and either has to leave the project looking clean.
   */
  adopt(project: ProjectDefinition): void {
    this.definitionSignal.set(project);
  }

  /** Replaces the manifest and counts it as one edit. */
  private edit(next: ProjectDefinition): void {
    this.definitionSignal.set(next);
    this.editsSignal.update((count) => count + 1);
  }

  /** Repoints `startWorld`, which a rename of the map it names has to do. */
  setStartWorld(worldId: string): void {
    const project = this.require();
    if (project.startWorld === worldId) {
      return;
    }
    this.edit({ ...project, startWorld: worldId });
  }

  /**
   * Replaces the zone list.
   *
   * {@link WorldLibrary} owns the zone *operations* — which maps are in a zone
   * decides whether one may be removed — and writes the result through here,
   * because the list itself is a manifest field.
   */
  setZones(zones: readonly ZoneDefinition[]): void {
    this.edit({ ...this.require(), zones: [...zones] });
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
    const project = this.require();
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

    this.edit({ ...project, locales: { default: project.locales?.default, languages: next } });
    return true;
  }

  /**
   * Declares a definition in one of the manifest's libraries, so it is loaded
   * next time the project is.
   *
   * The same door {@link declareLocaleFile} opens, for the same reason: creating
   * a character — or a decoration, or an object — in the editor should not mean
   * hand-editing `project.json` for it to exist
   * (`docs/adr/ADR-0024-character-definitions.md`,
   * `docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
   *
   * @returns `false` when the project already declares that id.
   */
  private declareIn(library: LibraryKind, id: string, path: string): boolean {
    const project = this.require();
    const declared = project[library] ?? [];
    if (declared.some((entry) => entry.id === id)) {
      return false;
    }
    this.edit({ ...project, [library]: [...declared, { id, path }] });
    return true;
  }

  /**
   * Removes a definition from one of the manifest's libraries.
   *
   * @returns `false` when the project does not declare it.
   */
  private undeclareFrom(library: LibraryKind, id: string): boolean {
    const project = this.require();
    const declared = project[library] ?? [];
    if (!declared.some((entry) => entry.id === id)) {
      return false;
    }
    this.edit({ ...project, [library]: declared.filter((entry) => entry.id !== id) });
    return true;
  }

  /** Where a definition's file lives, declared or by convention. */
  private pathIn(library: LibraryKind, id: string): string {
    const declared = this.definitionSignal()?.[library]?.find((entry) => entry.id === id);
    return declared?.path ?? `${library}/${id}.json`;
  }

  /** Declares a character definition in the manifest. */
  declareCharacter(id: string, path: string): boolean {
    return this.declareIn('characters', id, path);
  }

  /** Removes a character definition from the manifest. */
  undeclareCharacter(id: string): boolean {
    return this.undeclareFrom('characters', id);
  }

  /** Where a character's file lives, declared or by convention. */
  characterPath(id: string): string {
    return this.pathIn('characters', id);
  }

  /** Declares a decoration definition in the manifest. */
  declareDecoration(id: string, path: string): boolean {
    return this.declareIn('decorations', id, path);
  }

  /** Removes a decoration definition from the manifest. */
  undeclareDecoration(id: string): boolean {
    return this.undeclareFrom('decorations', id);
  }

  /** Where a decoration's file lives, declared or by convention. */
  decorationPath(id: string): string {
    return this.pathIn('decorations', id);
  }

  /** Declares an object definition in the manifest. */
  declareObject(id: string, path: string): boolean {
    return this.declareIn('objects', id, path);
  }

  /** Removes an object definition from the manifest. */
  undeclareObject(id: string): boolean {
    return this.undeclareFrom('objects', id);
  }

  /** Where an object's file lives, declared or by convention. */
  objectPath(id: string): string {
    return this.pathIn('objects', id);
  }

  /** Declares or replaces the project's single character-creation file. */
  declareCharacterCreation(id: string, path: string): void {
    this.edit({ ...this.require(), characterCreation: { id, path } });
  }

  /** Where the character-creation declaration lives. */
  characterCreationPath(): string {
    return this.definitionSignal()?.characterCreation?.path ?? 'character-creation.json';
  }

  /** The file the manifest lists for a tile set, or a conventional path. */
  tileSetPath(tileSetId: string): string {
    const declared = this.tileSets().find((entry) => entry.id === tileSetId);
    return declared?.path ?? `tilesets/${tileSetId}.json`;
  }

  /** The file the manifest lists for a map, or a conventional path. */
  worldPath(worldId: string): string {
    const declared = this.worlds().find((entry) => entry.id === worldId);
    return declared?.path ?? `worlds/${worldId}.json`;
  }
}
