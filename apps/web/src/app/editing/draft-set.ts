/**
 * One editing session, for any kind of authored content.
 *
 * The documents the editor holds, which one is open, what is unwritten, and the
 * load and save choreography — written once. It was written four times: the
 * character, decoration and object workspaces each carried their own copy of
 * the same twenty steps in the same order, and `tile-workspace.ts` carried a
 * fourth that had already diverged. Roughly 420 lines of it, in components
 * nothing could reach without a canvas and a `TestBed`.
 *
 * What is here is the *session*. What each kind means by reading, validating,
 * writing and declaring is behind {@link DraftSource}, and the two are split
 * where they are because saving has an invariant the session owns: **a draft
 * with validation errors is never written**. An adapter that owned `save`
 * outright would have moved forty-five lines into three adapters and bought
 * indirection (`docs/adr/ADR-0012-shared-content-validation.md`).
 *
 * The word *session* is spoken for elsewhere in this project: a session is a
 * game in progress (`docs/adr/ADR-0023-session-outlives-the-route.md`). This is a
 * **draft set**, and never a session in anything it exposes.
 *
 * Signals, but no `inject()` and no `effect()`: dependencies arrive through the
 * constructor, which is what keeps the whole of it readable from a spec with no
 * `TestBed` — the bargain `HexMapRenderer` makes with its context.
 *
 * Editor-only. The client build never reaches `app/editing/`
 * (`docs/adr/ADR-0015-client-delivery-build.md`).
 */

import { computed, signal } from '@angular/core';

import { ValidationReport } from '../../engine/engine.types';
import { describeError } from '../../core/errors';
import { Draft, DraftServices, DraftSource } from './draft-source';

/** What saving says when it had to create locale keys. Takes `{ count }`. */
const KEYS_CREATED = 'ui.editor.locale.created';

export class DraftSet<TDraft extends Draft> {
  private readonly all = signal<readonly TDraft[]>([]);
  private readonly openIdSignal = signal<string | null>(null);
  /** Ids whose definition no longer matches the file. */
  private readonly changed = signal<readonly string[]>([]);
  /** Bumped by a brush stroke, so what the adapter says about pixels is re-read. */
  private readonly strokes = signal(0);

  private readonly loadingSignal = signal(true);
  private readonly busySignal = signal(false);
  private readonly errorSignal = signal<string | null>(null);
  private readonly messageSignal = signal<string | null>(null);
  private readonly reportSignal = signal<ValidationReport | null>(null);
  private readonly unreadableSignal = signal<readonly string[]>([]);

  constructor(
    private readonly source: DraftSource<TDraft>,
    private readonly services: DraftServices,
  ) {}

  /** Every draft the project holds, in manifest order, as edited. */
  readonly drafts = this.all.asReadonly();

  /** Id of the draft the form is showing. */
  readonly openId = this.openIdSignal.asReadonly();

  /** Paths the manifest declares that could not be read. */
  readonly unreadable = this.unreadableSignal.asReadonly();

  /** `true` until the first read has finished, however it finished. */
  readonly loading = this.loadingSignal.asReadonly();

  /** `true` while a write is in flight. */
  readonly busy = this.busySignal.asReadonly();

  /** What went wrong, in the author's language where the author's language said it. */
  readonly error = this.errorSignal.asReadonly();

  /** What the last write did, as one line. */
  readonly message = this.messageSignal.asReadonly();

  /** The engine's verdict on the open draft. */
  readonly report = this.reportSignal.asReadonly();

  /**
   * The draft being edited, or `null` when the project holds none.
   *
   * Falls back to the first rather than to nothing when the open id names
   * nothing: removing the open draft leaves the form showing its neighbour
   * instead of an empty screen.
   */
  readonly open = computed<TDraft | null>(() => {
    const id = this.openIdSignal();
    const drafts = this.all();
    return drafts.find((draft) => draft.id === id) ?? drafts[0] ?? null;
  });

  /** How many of the verdict's issues stop a write. */
  readonly errorCount = computed(
    () => this.reportSignal()?.issues.filter((issue) => issue.severity === 'error').length ?? 0,
  );

  /** `true` when the open draft differs from what is on disk. */
  readonly dirty = computed(() => {
    const draft = this.open();
    return draft !== null && this.isDirty(draft.id);
  });

  /** `true` when anything at all is unwritten — what the unload guard asks. */
  readonly anyUnsaved = computed(() => this.all().some((draft) => this.isDirty(draft.id)));

  /**
   * Whether this draft owes the disk a write.
   *
   * One definition of unsaved, covering both halves of it: the definition
   * itself, and the images the draft owns. `SpriteDocument.unsaved` is an input
   * here rather than a second answer kept somewhere else.
   */
  isDirty(id: string): boolean {
    if (this.changed().includes(id)) {
      return true;
    }
    this.strokes();
    const draft = this.all().find((candidate) => candidate.id === id);
    return draft !== undefined && this.source.dirtySprites(draft).length > 0;
  }

  /**
   * Reads every declared draft and opens the first.
   *
   * A file that will not open is named rather than dropped: a declared draft
   * that vanishes without a word is indistinguishable from one that was never
   * declared, and it is the editor, not the author, that knows the difference.
   */
  async load(): Promise<void> {
    try {
      await this.source.prepare();

      const declared = this.source.declared();
      const read: readonly (TDraft | null)[] = await Promise.all(
        declared.map((entry) => this.source.read(entry)),
      );
      this.all.set(read.filter((draft): draft is TDraft => draft !== null));
      this.unreadableSignal.set(
        declared.filter((_entry, index) => read[index] === null).map((entry) => entry.path),
      );

      // Nothing authored yet: a single-document kind starts from a blank that
      // already validates, and owes the disk a write straight away.
      const blank = this.all().length === 0 ? this.source.blank() : null;
      if (blank !== null) {
        this.all.set([blank]);
        this.markChanged(blank.id);
      }

      this.openIdSignal.set(this.all()[0]?.id ?? null);
      this.refresh();
    } catch (cause) {
      this.errorSignal.set(describeError(cause));
    } finally {
      this.loadingSignal.set(false);
    }
  }

  /** Opens another draft, or nothing. */
  select(id: string | null): void {
    this.openIdSignal.set(id);
    this.messageSignal.set(null);
    this.refresh();
  }

  /**
   * Applies a change to the open draft, then re-validates.
   *
   * A copy per edit, not a mutation: a definition is a tree of nested arrays and
   * `OnPush` only redraws what changed identity.
   *
   * A rename takes the manifest entry with it. The old *file* is left on disk —
   * deleting content is the author's decision — but a manifest still listing the
   * old id would name a definition nothing writes any more.
   */
  edit(mutate: (draft: TDraft) => void): void {
    const current = this.open();
    if (current === null) {
      return;
    }
    const draft = structuredClone(current) as TDraft;
    mutate(draft);

    this.all.update((drafts) =>
      drafts.map((candidate) => (candidate.id === current.id ? draft : candidate)),
    );
    if (this.openIdSignal() === current.id) {
      this.openIdSignal.set(draft.id);
    }
    if (draft.id !== current.id) {
      this.source.undeclare(current.id);
      this.source.forget(current.id);
      this.changed.update((ids) => ids.filter((id) => id !== current.id));
    }
    this.markChanged(draft.id);
    this.messageSignal.set(null);
    this.refresh();
  }

  /** Adds a draft to the project and opens it. It owes the disk a write at once. */
  add(draft: TDraft): void {
    this.all.update((drafts) => [...drafts, draft]);
    this.markChanged(draft.id);
    this.select(draft.id);
  }

  /**
   * Takes a draft out of the editor and out of the manifest.
   *
   * The file is left on disk: deleting content is a decision an author makes
   * with their own tools, and a manifest that no longer lists it is enough to
   * take it out of the game.
   */
  remove(id: string): void {
    const draft = this.all().find((candidate) => candidate.id === id);
    if (draft === undefined) {
      return;
    }
    this.all.update((drafts) => drafts.filter((candidate) => candidate.id !== id));
    this.source.removed(draft);
    this.source.undeclare(id);
    this.source.forget(id);
    this.changed.update((ids) => ids.filter((held) => held !== id));
    this.select(this.all()[0]?.id ?? null);
  }

  /** Tells the session that pixels moved, so dirtiness is re-read. */
  touchSprites(): void {
    this.strokes.update((count) => count + 1);
  }

  /** Says something in the message line — what a kind-specific action reports. */
  announce(message: string | null): void {
    this.messageSignal.set(message);
  }

  /** Reports a failure a kind-specific action ran into. */
  fail(cause: unknown): void {
    this.errorSignal.set(describeError(cause));
  }

  /** Takes the last failure off the screen — what an action does before trying. */
  clearError(): void {
    this.errorSignal.set(null);
  }

  /** Whether a write is in flight, for actions outside the save pipeline. */
  setBusy(busy: boolean): void {
    this.busySignal.set(busy);
  }

  /**
   * Re-validates the open draft and re-draws whatever its kind previews.
   *
   * The verdict is this module's — writing depends on it — and the picture is
   * the kind's.
   */
  refresh(): void {
    const draft = this.open();
    if (draft === null) {
      this.reportSignal.set(null);
      this.source.refresh(null);
      return;
    }
    try {
      this.reportSignal.set(this.source.validate(draft, this.source.serialize(draft)));
      this.errorSignal.set(null);
    } catch (cause) {
      this.errorSignal.set(describeError(cause));
    }
    this.source.refresh(draft);
  }

  /**
   * Writes the open draft into the content directory.
   *
   * The fixed pipeline, in this order and no other: validate, bail, write the
   * file, adopt it, write the images, declare it, write the manifest if the
   * manifest moved, create the locale keys it names, and only then call it
   * saved. Every step but the four kind-specific ones is here rather than in
   * three copies.
   */
  async save(): Promise<void> {
    const draft = this.open();
    if (draft === null) {
      return;
    }
    const { i18n, workspace, ledger, locales } = this.services;

    this.busySignal.set(true);
    this.errorSignal.set(null);
    this.messageSignal.set(null);

    try {
      const json = this.source.serialize(draft);
      this.reportSignal.set(this.source.validate(draft, json));
      if (this.errorCount() > 0) {
        this.errorSignal.set(i18n.t(this.source.messages.invalid));
        return;
      }

      const path = this.source.pathOf(draft.id);
      await workspace.writeJson(path, json);
      // Adopting it is what makes the *runtime* agree with the file from here
      // on, without a reload — and what a later content reset puts back.
      this.source.adopt(draft.id, json);

      const parts = [i18n.t(this.source.messages.saved, { file: path })];

      // The art goes with the definition. An author who painted and pressed
      // Save meant both, and a sprite left only in a tab is a sprite lost.
      const written = await this.source.writeSprites(draft);
      const spritesSaved = this.source.messages.spritesSaved;
      if (written > 0 && spritesSaved !== undefined) {
        parts.push(i18n.t(spritesSaved, { count: written }));
      }

      // A definition nobody lists is a definition nobody loads. A kind whose
      // file is at a fixed path lists nothing, and leaves the manifest alone
      // rather than flushing an edit another screen has not finished.
      if (this.source.declaredInManifest) {
        this.source.declare(draft.id, path);
        if (ledger.manifestNeedsWriting()) {
          await workspace.writeJson('project.json', ledger.projectJson());
          ledger.markManifestWritten();
          const savedManifest = this.source.messages.savedManifest;
          if (savedManifest !== undefined) {
            parts.push(i18n.t(savedManifest));
          }
        }
      }
      ledger.refreshDirty();

      // Every label this file names now exists as a key, in every language, so
      // the Languages tab lists it and a translator can fill it in. A kind with
      // no player-facing text names none, and the table is left alone.
      const keys = this.source.keysOf(draft);
      const created = keys.length === 0 ? [] : locales.ensureKeys(keys);
      if (created.length > 0) {
        await locales.save();
        parts.push(i18n.t(KEYS_CREATED, { count: created.length }));
      }

      this.changed.update((ids) => ids.filter((id) => id !== draft.id));
      this.touchSprites();
      this.refresh();
      this.messageSignal.set(parts.join(' · '));
    } catch (cause) {
      this.errorSignal.set(describeError(cause));
    } finally {
      this.busySignal.set(false);
    }
  }

  private markChanged(id: string): void {
    this.changed.update((ids) => (ids.includes(id) ? ids : [...ids, id]));
  }
}
