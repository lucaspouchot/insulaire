/**
 * Where a set of drafts comes from, and what writing one means.
 *
 * The seam of {@link DraftSet}: everything about a *kind* of content that the
 * editing session itself must not know. A character, a decoration and an object
 * are read, validated, written and declared by three different pairs of engine
 * and store methods, and every other step between them is the same — so the
 * steps are the session's and the pairs are here.
 *
 * The division is deliberate and is not "the adapter owns saving". Saving is a
 * fixed pipeline in `DraftSet` that calls in here at the kind-specific points,
 * because *a draft with validation errors is never written* is an invariant of
 * the session, not a promise each kind makes separately
 * (`docs/adr/ADR-0012-shared-content-validation.md`).
 *
 * `ContentLibrary` is a peer, not a part: an adapter calls it to adopt and
 * forget definitions, and it goes on doing its own job — putting the project's
 * files back after a content reset — for callers that have no drafts at all.
 */

import { ContentRef } from '../../content/content-types';
import { ValidationReport } from '../../engine/engine.types';

/** Anything the editor holds a draft of. Its id is what everything else keys on. */
export interface Draft {
  id: string;
}

/** The strings one kind of draft announces itself with, as locale keys. */
export interface DraftMessages {
  /** Shown instead of writing, when the draft does not validate. */
  readonly invalid: string;
  /** Shown when the file is written. Takes `{ file }`. */
  readonly saved: string;
  /** Shown when images went with it. Takes `{ count }`. */
  readonly spritesSaved: string;
  /** Shown when the manifest had to be rewritten too. */
  readonly savedManifest: string;
}

export interface DraftSource<TDraft extends Draft> {
  /** What this kind's messages are called. */
  readonly messages: DraftMessages;

  /**
   * Everything that must be ready before the first draft can be read.
   *
   * The engine, the languages, the project, the content directory, and this
   * kind's library — registered as well as fetched, because the runtime holds
   * these and the editor is about to replace one of them. Some kinds need more:
   * the decoration editor stands a real character on the hex, so it loads the
   * character library too.
   */
  prepare(): Promise<void>;

  /**
   * Whether saving this kind can move the manifest.
   *
   * `true` for a kind the manifest lists one entry per draft of — saving a new
   * character adds a line to `project.json` and the file has to be rewritten.
   * `false` for a kind whose file is at a fixed path: nothing about saving it
   * changes the manifest, so it must not write one, and in particular must not
   * flush a manifest another screen has left half-edited.
   */
  readonly declaredInManifest: boolean;

  /** The manifest list this kind is declared in, in project order. */
  declared(): readonly ContentRef[];

  /**
   * What to open when the project declares nothing at all.
   *
   * A single-document kind starts from something that already validates rather
   * than from an empty screen — there is no "add" button for the settings
   * file, so the blank *is* the way to author the first one, and it owes the
   * disk a write from the moment it appears. `null` for a kind that is a list:
   * a project shipping no decorations opens on an empty list, which is honest.
   */
  blank(): TDraft | null;

  /**
   * Reads one declared draft.
   *
   * `null` for a file that is missing or will not parse — which is reported
   * rather than fatal, because a manifest may name a file nobody wrote yet.
   */
  read(entry: ContentRef): Promise<TDraft | null>;

  /** The file this draft is written to, declared or by convention. */
  pathOf(id: string): string;

  /** The bytes written for a draft. */
  serialize(draft: TDraft): string;

  /** The engine's verdict on those bytes. */
  validate(draft: TDraft, json: string): ValidationReport;

  /** Takes a written draft on, so the runtime agrees with the file without a reload. */
  adopt(id: string, json: string): void;

  /** Forgets a draft the editor has taken out of the project, or renamed away from. */
  forget(id: string): void;

  /** Lists a draft in the manifest. */
  declare(id: string, path: string): void;

  /** Takes a draft out of the manifest. */
  undeclare(id: string): void;

  /**
   * Paths of images this draft owns whose pixels are not on disk.
   *
   * What makes a draft dirty when its definition has not changed: an author who
   * painted and saved meant both, and a sprite left only in a tab is a sprite
   * lost. Read inside a `computed`, so it must read its signals.
   */
  dirtySprites(draft: TDraft): readonly string[];

  /**
   * Writes those images, one file each.
   *
   * @returns how many were written
   */
  writeSprites(draft: TDraft): Promise<number>;

  /** Every locale key this draft names, so saving can create them empty. */
  keysOf(draft: TDraft): readonly string[];

  /** Forgets whatever a removed draft alone was holding. */
  removed(draft: TDraft): void;

  /**
   * Re-draws whatever this kind previews, for the draft now open.
   *
   * The verdict is the session's — it holds the report — so this is the
   * *picture*: the resolved decoration on its hex, the character in its pose.
   */
  refresh(draft: TDraft | null): void;
}

/* --------------------------------------------------------------- the ports */

/**
 * The four services a session needs, each as the little of it that is used.
 *
 * Ports rather than the services themselves so a spec can drive the pipeline
 * with four object literals and no `TestBed`. The real services satisfy these
 * structurally; nothing declares that it does.
 */

/** What a session needs of the language table. */
export interface DraftTranslator {
  t(key: string, params?: Readonly<Record<string, string | number>>): string;
}

/** What a session needs of the content directory. */
export interface DraftWriter {
  writeJson(path: string, json: string): Promise<void>;
}

/** What a session needs of the manifest — `ProjectStoreService`'s own names. */
export interface DraftManifest {
  manifestNeedsWriting(): boolean;
  projectJson(): string;
  markManifestWritten(): void;
  refreshDirty(): void;
}

/** What a session needs of the authored languages. */
export interface DraftLocales {
  ensureKeys(keys: Iterable<string>): readonly string[];
  save(): Promise<unknown>;
}

/** Everything a session is handed, in one bag, so the constructor stays readable. */
export interface DraftServices {
  readonly i18n: DraftTranslator;
  readonly workspace: DraftWriter;
  readonly manifest: DraftManifest;
  readonly locales: DraftLocales;
}
