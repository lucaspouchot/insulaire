/**
 * The object editor.
 *
 * It edits **object definitions** — the things a character carries: a potion, a
 * key, a sword, a torn letter. The sibling of the decoration editor next door
 * and its opposite: a decoration stands on a hex and shares it with the
 * characters walking over it, an object travels in an inventory and is drawn in
 * a panel (`docs/adr/ADR-0036-an-object-is-carried-not-placed.md`).
 *
 * Which is why this screen is the small one. An object has no anchor, no plane
 * and no order — it has an **icon**, a kind, a stack size, and the two keys a
 * player reads. The icon is a flipbook, painted on the same pixel surface every
 * other category paints on: one frame is a still potion, four are a glinting
 * gem, and neither needs a PNG from somewhere else to exist
 * (`docs/adr/ADR-0036-an-object-is-carried-not-placed.md`,
 * `docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
 *
 * Labels are keys: this screen picks and **creates** them — saving writes every
 * key the file names into every language, empty — and the language editor is
 * where their text is written (`docs/adr/ADR-0020-localised-content-keys.md`,
 * `docs/adr/ADR-0020-localised-content-keys.md`).
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';

import {
  ContentRef,
  DEFAULT_FRAME_DURATION_MS,
  DEFAULT_ICON_RESOLUTION,
  MAX_FLIPBOOK_FRAMES,
  MAX_STACK_SIZE,
  OBJECT_SCHEMA_VERSION,
  ObjectDefinition,
  ObjectKind,
  ResolvedObject,
  SpriteResolution,
} from '../../../../content/content-types';
import { serializeObject } from '../../../../content/object-serializer';
import { SpriteDocument } from '../../../../content/sprite-document';
import { routeUndoRedo } from '../../../../core/keyboard-shortcuts';
import { zoomBy } from '../../../../renderer/canvas-surface';
import { assetUrl } from '../../../../core/asset-url';
import { I18nService } from '../../../i18n/i18n.service';
import { TranslatePipe } from '../../../i18n/translate.pipe';
import {
  ContentWorkspaceService,
  WorkspaceFile,
} from '../../../services/content-workspace.service';
import { EngineService } from '../../../services/engine.service';
import { LocaleAuthoringService } from '../../../services/locale-authoring.service';
import { ObjectLibraryService } from '../../../services/object-library.service';
import { ProjectManifest } from '../../../project/project-manifest';
import { WriteLedger } from '../../../project/write-ledger';
import { CONTENT_ROOT, ProjectStoreService } from '../../../services/project-store.service';
import { AssetWorkspace } from './asset-workspace';
import { clampResolution, move } from './asset-editing';
import { PixelEditor } from './pixel-editor';
import { DraftSet } from '../../../editing/draft-set';
import { DraftSource } from '../../../editing/draft-source';
import { FlipbookClock } from '../../../editing/flipbook-clock';
import { freeId } from '../../../editing/ids';

/** The kinds the picker offers, in the order it shows them. */
const KINDS: readonly ObjectKind[] = ['consumable', 'equipment', 'quest', 'material', 'other'];

/** Where a created or uploaded frame goes: a convention, not a rule. */
const ASSET_DIR = 'assets/objects';

/** What an icon opens at: a 32-pixel square is unreadable at 1x. */
const DEFAULT_ZOOM = 8;

@Component({
  selector: 'app-object-workspace',
  imports: [TranslatePipe, AssetWorkspace, PixelEditor],
  templateUrl: './object-workspace.html',
  styleUrl: './object-workspace.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown)': 'onKeyDown($event)',
    '(window:beforeunload)': 'onUnload($event)',
  },
})
export class ObjectWorkspace implements OnDestroy {
  private readonly store = inject(ProjectStoreService);
  private readonly manifest = inject(ProjectManifest);
  private readonly ledger = inject(WriteLedger);
  private readonly engine = inject(EngineService);
  private readonly i18n = inject(I18nService);
  private readonly workspace = inject(ContentWorkspaceService);
  private readonly locales = inject(LocaleAuthoringService);
  private readonly library = inject(ObjectLibraryService);

  /** What the engine says is on screen at the clock's time. */
  protected readonly resolved = signal<ResolvedObject | null>(null);

  /** Content files the workspace holds, for the frame picker. */
  protected readonly files = signal<readonly WorkspaceFile[]>([]);
  protected readonly zoom = signal(DEFAULT_ZOOM);
  protected readonly showGrid = signal(true);

  /** The frames open for editing, by content path. */
  private readonly sessions = new Map<string, SpriteDocument>();
  /** Paths being decoded, so the effect asks for each of them only once. */
  private readonly opening = new Set<string>();
  /** Bumped by every stroke, so the buttons re-read the pixels. */
  private readonly strokes = signal(0);

  protected readonly kinds = KINDS;
  protected readonly maxStack = MAX_STACK_SIZE;
  protected readonly maxFrames = MAX_FLIPBOOK_FRAMES;
  protected readonly defaultFrameDuration = DEFAULT_FRAME_DURATION_MS;

  /**
   * The editing session: what is held, what is open, what is unwritten.
   *
   * The whole of load and save, which this screen only supplies the object's
   * half of (`app/editing/draft-set.ts`).
   */
  private readonly drafts = new DraftSet<ObjectDefinition>(this.draftSource(), {
    i18n: this.i18n,
    workspace: this.workspace,
    ledger: this.ledger,
    locales: this.locales,
  });

  /**
   * Playback, which only moves which frame is on the surface.
   *
   * Which frame that is, is `content/flipbook.ts`'s answer — the same one the
   * Rust resolver gives, so the readout and the picture cannot disagree.
   */
  private readonly clock = new FlipbookClock(
    () => this.document(),
    () => this.repose(),
  );

  protected readonly playing = this.clock.playing;

  protected readonly report = this.drafts.report;
  protected readonly message = this.drafts.message;
  protected readonly error = this.drafts.error;
  protected readonly busy = this.drafts.busy;
  protected readonly loading = this.drafts.loading;
  /** Paths the manifest declares that could not be read. */
  protected readonly unreadable = this.drafts.unreadable;

  /** Every definition, in project order. */
  protected readonly documents = this.drafts.drafts;

  /** The definition being edited, or `null` when the project has none. */
  protected readonly document = this.drafts.open;

  /** Path this definition's file has, declared or by convention. */
  protected readonly path = computed(() => {
    const document = this.document();
    return document === null ? '' : this.manifest.objectPath(document.id);
  });

  /** `true` when the open definition, or a frame it owns, differs from disk. */
  protected readonly dirty = this.drafts.dirty;

  /** `true` when files can actually be written — the editor is honest about it. */
  protected readonly writable = computed(() => this.workspace.status() !== null);

  /** `true` when the manifest does not list the open definition. */
  protected readonly unlisted = computed(() => {
    const document = this.document();
    if (document === null) {
      return false;
    }
    return !this.manifest.objects().some((entry) => entry.id === document.id);
  });

  /** The canvas every frame of the open icon is drawn on. */
  protected readonly resolution = computed<SpriteResolution>(
    () => this.document()?.resolution ?? { ...DEFAULT_ICON_RESOLUTION },
  );

  /** The frames of the open icon, in play order. */
  protected readonly frames = computed<readonly string[]>(() => this.document()?.frames ?? []);

  /** Which frame is selected — the clock's answer, running or parked. */
  protected readonly frameIndex = this.clock.frame;

  /** The path of the selected frame; `''` when it names none. */
  protected readonly frame = computed(() => this.frames()[this.frameIndex()] ?? '');

  /** Every image in the content directory, which is what a frame may name. */
  protected readonly images = computed<readonly WorkspaceFile[]>(() =>
    this.files().filter((file) => /\.(png|gif|webp)$/i.test(file.path)),
  );

  /** The pixels behind the selected frame, once its image has been decoded. */
  protected readonly sprite = computed<SpriteDocument | null>(() => {
    this.strokes();
    const asset = this.frame();
    return asset.length === 0 ? null : (this.sessions.get(asset) ?? null);
  });

  /** Frames holding pixels the content directory has not been told about. */
  protected readonly unsavedSprites = computed<readonly string[]>(() => {
    this.strokes();
    return [...this.sessions].filter(([, sprite]) => sprite.unsaved).map(([asset]) => asset);
  });

  protected readonly errorCount = this.drafts.errorCount;

  /** Keys this file names that no language gives text to yet. */
  protected readonly untranslated = computed(
    () => referencedKeys(this.document()).filter((key) => !this.i18n.has(key)).length,
  );

  constructor() {
    void this.drafts.load();

    // The frame being painted is decoded on demand: a frame the author has not
    // selected costs nothing.
    effect(() => {
      const asset = this.frame();
      if (asset.length > 0) {
        this.requireSprite(asset);
      }
    });
  }

  ngOnDestroy(): void {
    this.clock.stop();
    this.sessions.clear();
  }

  // ----------------------------------------------------------------- source

  /**
   * What an *object* means by reading, validating, writing and declaring.
   *
   * Everything else about the session — the order of the steps, the bail-out on
   * a failing verdict, what a rename takes with it — is `DraftSet`'s.
   */
  private draftSource(): DraftSource<ObjectDefinition> {
    return {
      declaredInManifest: true,
      // A list: a project shipping no objects opens on an empty list.
      blank: () => null,
      messages: {
        invalid: 'ui.editor.object.invalid',
        saved: 'ui.editor.object.saved',
        spritesSaved: 'ui.editor.object.framesSaved',
        savedManifest: 'ui.editor.object.savedManifest',
      },
      prepare: async () => {
        await this.engine.ready();
        await this.i18n.ensureAdopted();
        await this.store.ensureLoaded();
        await this.workspace.ensureProbed();
        await this.locales.ensureLoaded();
        // Registered as well as fetched: the *runtime* holds these, and this
        // screen is about to replace one of them.
        await this.library.ensureLoaded();
        await this.refreshFiles();
      },
      declared: () => this.manifest.objects(),
      read: (entry) => this.fetchObject(entry),
      pathOf: (id) => this.manifest.objectPath(id),
      serialize: (document) => serializeObject(document),
      validate: (_document, json) => this.engine.validateObject(json),
      adopt: (id, json) => this.library.adopt(id, json),
      forget: (id) => this.library.forget(id),
      declare: (id, path) => this.manifest.declareObject(id, path),
      undeclare: (id) => this.manifest.undeclareObject(id),
      dirtySprites: (document) => {
        this.strokes();
        return (document.frames ?? []).filter(
          (asset) => this.sessions.get(asset)?.unsaved === true,
        );
      },
      writeSprites: () => this.writeSprites(),
      keysOf: (document) => referencedKeys(document),
      removed: (document) => this.forgetFrames(document),
      refresh: () => this.repose(),
    };
  }

  private async refreshFiles(): Promise<void> {
    if (this.workspace.status() === null) {
      return;
    }
    try {
      this.files.set(await this.workspace.list());
    } catch {
      // Reported by the workspace service; the editor stays usable without it.
    }
  }

  /**
   * Reads one declared definition off disk.
   *
   * A file that is missing or unreadable is skipped rather than fatal: the
   * manifest is content like any other and may name a file nobody wrote yet.
   */
  private async fetchObject(entry: ContentRef): Promise<ObjectDefinition | null> {
    try {
      const response = await fetch(assetUrl(`${CONTENT_ROOT}/${entry.path}`));
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as ObjectDefinition;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ edits

  private edit(mutate: (draft: ObjectDefinition) => void): void {
    this.drafts.edit(mutate);
  }

  protected open(id: string): void {
    this.drafts.select(id);
    this.selectFrame(0);
  }

  /**
   * Adds a definition to the project and opens it.
   *
   * It starts as a nameless "other" with **no frame at all**, which is a
   * warning and not an error: an object is routinely blocked out before its art
   * and its text exist, and the scene offers to paint the first frame rather
   * than asking for a PNG (`docs/adr/ADR-0036-an-object-is-carried-not-placed.md`).
   */
  protected addObject(): void {
    const id = freeId(
      'object',
      this.documents().map((document) => document.id),
    );
    this.drafts.add({
      id,
      schemaVersion: OBJECT_SCHEMA_VERSION,
      name: id,
      kind: 'other',
      nameKey: `game.object.${id}.name`,
      frames: [],
      resolution: { ...DEFAULT_ICON_RESOLUTION },
    });
    this.selectFrame(0);
  }

  /**
   * Removes the open definition from the editor and from the manifest.
   *
   * The file is left on disk: deleting content is a decision an author makes
   * with their own tools, and a manifest that no longer lists it is enough to
   * take it out of the game.
   */
  protected removeObject(): void {
    const document = this.document();
    if (document !== null) {
      this.drafts.remove(document.id);
      this.selectFrame(0);
    }
  }

  /**
   * Drops the painted pixels of an object nobody is editing any more.
   *
   * Without this the editor keeps claiming unwritten work — and warns on the
   * way out about it — for frames that belong to a definition that no longer
   * exists. A path another object still names is kept, because that one does.
   */
  private forgetFrames(removed: ObjectDefinition): void {
    const kept = new Set(
      this.documents()
        .filter((document) => document.id !== removed.id)
        .flatMap((document) => document.frames ?? []),
    );
    for (const asset of removed.frames ?? []) {
      if (!kept.has(asset)) {
        this.sessions.delete(asset);
      }
    }
    this.touchSprites();
  }

  protected setId(id: string): void {
    this.edit((draft) => {
      draft.id = id.trim();
    });
  }

  protected setName(name: string): void {
    this.edit((draft) => {
      draft.name = name;
    });
  }

  protected setKind(kind: string): void {
    this.edit((draft) => {
      draft.kind = kind as ObjectKind;
    });
  }

  protected setKey(field: 'nameKey' | 'descriptionKey', key: string): void {
    this.edit((draft) => {
      draft[field] = key.trim();
    });
  }

  protected setSlot(slot: string): void {
    this.edit((draft) => {
      draft.slot = slot.trim();
    });
  }

  protected setStackSize(raw: string): void {
    const value = Number.parseInt(raw, 10);
    this.edit((draft) => {
      draft.stackSize = Number.isFinite(value) ? Math.min(MAX_STACK_SIZE, Math.max(1, value)) : 1;
    });
  }

  protected setTags(raw: string): void {
    const tags = raw
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    this.edit((draft) => {
      draft.tags = tags;
    });
  }

  /**
   * Resizes the canvas the frames are drawn on.
   *
   * The images are **not** resampled with it: the canvas says how big the icon
   * is meant to be, and stretching an author's pixels to match would move every
   * one of them.
   */
  protected setResolution(side: 'width' | 'height', raw: string): void {
    const value = clampResolution(Number.parseFloat(raw));
    this.edit((draft) => {
      const current = draft.resolution ?? DEFAULT_ICON_RESOLUTION;
      draft.resolution =
        side === 'width'
          ? { width: value, height: current.height }
          : { width: current.width, height: value };
    });
  }

  // ----------------------------------------------------------------- frames

  protected selectFrame(index: number): void {
    this.clock.seek(index);
    this.repose();
  }

  protected addFrame(): void {
    if (this.frames().length >= MAX_FLIPBOOK_FRAMES) {
      return;
    }
    this.edit((draft) => {
      draft.frames = [...(draft.frames ?? []), ''];
      // The first frame added to a still icon is what turns it into a
      // flipbook, so that is where a rate starts meaning something.
      draft.frameDurationMs ??= DEFAULT_FRAME_DURATION_MS;
    });
    this.selectFrame(this.frames().length - 1);
  }

  protected removeFrame(index: number): void {
    this.edit((draft) => {
      draft.frames = (draft.frames ?? []).filter((_frame, at) => at !== index);
    });
    this.selectFrame(Math.max(0, index - 1));
  }

  protected moveFrame(index: number, delta: number): void {
    this.edit((draft) => {
      draft.frames = [...(draft.frames ?? [])];
      move(draft.frames, index, delta);
    });
    this.selectFrame(index + delta);
  }

  protected setFrame(index: number, asset: string): void {
    const path = asset.trim();
    this.edit((draft) => {
      const frames = [...(draft.frames ?? [])];
      // A path typed into the last row of an icon that has none appends it,
      // which is what "name the image" means when there is nothing to replace.
      if (index < frames.length) {
        frames[index] = path;
      } else {
        frames.push(path);
      }
      draft.frames = frames;
    });
    this.clock.seek(index);
    this.requireSprite(path);
  }

  /**
   * `true` when a frame names a file the content directory does not hold.
   *
   * A frame whose pixels are open in this session is **not** missing: it was
   * just painted here and owes the disk a write, which the file bar already
   * says. Calling it missing would tell an author their new icon is broken.
   */
  protected frameMissing(asset: string): boolean {
    const files = this.files();
    if (asset.length === 0 || files.length === 0 || this.sessions.has(asset)) {
      return false;
    }
    return !files.some((file) => file.path === asset);
  }

  /**
   * Creates a blank image at the declared canvas size and points a frame at it.
   *
   * This is the door that means an object needs **no PNG from anywhere else**:
   * a new object is a canvas to paint, exactly as a decoration frame is
   * (`docs/adr/ADR-0036-an-object-is-carried-not-placed.md`).
   */
  protected createFrame(index: number): void {
    const document = this.document();
    if (document === null) {
      return;
    }
    const { width, height } = this.resolution();
    // A still icon is `small_potion.png`; the frames of an animated one are
    // numbered after it. The common case reads as a file, not as a sequence.
    const path = `${ASSET_DIR}/${document.id}${index === 0 ? '' : `_${index}`}.png`;
    const sprite = SpriteDocument.blank(width, height);
    // It exists nowhere else, so it owes the disk a write from the moment it is
    // created rather than from its first stroke.
    sprite.markUnsaved();
    this.sessions.set(path, sprite);
    this.touchSprites();
    this.setFrame(index, path);
  }

  /**
   * Uploads an image into the content directory and points a frame at it.
   *
   * The same door the character editor opens, at the same convention: an author
   * with a PNG should not have to leave the editor to use it
   * (`docs/adr/ADR-0019-authoring-content-workspace.md`).
   */
  protected async uploadFrame(event: Event, index: number): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file === undefined) {
      return;
    }
    input.value = '';

    this.drafts.setBusy(true);
    this.drafts.clearError();
    try {
      const path = `${ASSET_DIR}/${file.name}`;
      await this.workspace.write(path, file);
      await this.refreshFiles();
      // The decoded copy holds the bytes this path used to have.
      this.sessions.delete(path);
      this.setFrame(index, path);
      this.drafts.announce(this.i18n.t('ui.editor.object.uploaded', { file: path }));
    } catch (cause) {
      this.drafts.fail(cause);
    } finally {
      this.drafts.setBusy(false);
    }
  }

  // --------------------------------------------------------------- playback

  protected setFrameDuration(raw: string): void {
    const value = Number.parseInt(raw, 10);
    this.edit((draft) => {
      draft.frameDurationMs = Number.isFinite(value) ? Math.max(0, value) : undefined;
    });
  }

  protected setLooping(looping: boolean): void {
    this.edit((draft) => {
      draft.looping = looping;
    });
  }

  /** Plays the icon, which only moves which frame is on the surface. */
  protected togglePlay(): void {
    this.clock.togglePlay();
  }

  protected onPainted(): void {
    this.touchSprites();
  }

  /**
   * Undo and redo, wherever the pointer is — but never while typing.
   *
   * The screen's only keyboard listener. The chord is parsed in one place
   * (`core/keyboard-shortcuts.ts`); acting on it is the screen's, because only
   * the screen knows which surface is open
   * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
   */
  protected onKeyDown(event: KeyboardEvent): void {
    routeUndoRedo(event, { undo: () => this.undo(), redo: () => this.redo() });
  }

  protected undo(): void {
    if (this.sprite()?.undo() === true) {
      this.touchSprites();
    }
  }

  protected redo(): void {
    if (this.sprite()?.redo() === true) {
      this.touchSprites();
    }
  }

  protected zoomBy(delta: number): void {
    this.zoom.set(zoomBy(this.zoom(), delta));
  }

  /** Back to the zoom a 32-pixel icon is workable at. */
  protected fitZoom(): void {
    this.zoom.set(DEFAULT_ZOOM);
  }

  /** Opens a frame for editing, at most once per path. */
  private requireSprite(asset: string): void {
    if (asset.length === 0 || this.sessions.has(asset) || this.opening.has(asset)) {
      return;
    }
    this.opening.add(asset);
    void this.openSprite(asset);
  }

  private async openSprite(asset: string): Promise<void> {
    try {
      const image = await loadImage(asset);
      const sprite = image === null ? null : SpriteDocument.fromImage(image);
      if (sprite === null) {
        // A path naming nothing is already reported as a missing frame.
        return;
      }
      this.sessions.set(asset, sprite);
      this.touchSprites();
    } finally {
      this.opening.delete(asset);
    }
  }

  /** Tells the view that the pixels moved. */
  private touchSprites(): void {
    this.strokes.update((count) => count + 1);
    // The session decides what "unsaved" means, and a stroke is half of it.
    this.drafts.touchSprites();
  }

  /**
   * Writes the edited frames, one PNG each.
   *
   * @returns how many were written
   */
  private async writeSprites(): Promise<number> {
    const pending = [...this.sessions].filter(([, sprite]) => sprite.unsaved);
    for (const [asset, sprite] of pending) {
      await this.workspace.write(asset, await sprite.toBlob());
      sprite.markSaved();
    }
    if (pending.length > 0) {
      await this.refreshFiles();
      this.touchSprites();
    }
    return pending.length;
  }

  // --------------------------------------------------------------- validate

  /** Re-validates and re-resolves the open definition. */
  protected refresh(): void {
    this.drafts.refresh();
  }

  /**
   * Re-resolves the icon at the clock's time.
   *
   * Through Rust: the resolver is the one an inventory panel will draw with, so
   * the frame on screen is not this screen's opinion
   * (`docs/adr/ADR-0012-shared-content-validation.md`).
   */
  private repose(): void {
    const document = this.document();
    if (document === null || !this.engine.isReady) {
      this.resolved.set(null);
      return;
    }
    try {
      this.resolved.set(this.engine.previewObject(document, this.clock.timeMs()));
    } catch {
      // A definition being typed into may not parse; the verdict reports it.
    }
  }

  /** The text a key currently resolves to, so the form reads as prose. */
  protected preview(key: string): string {
    return key.length === 0 ? '' : this.i18n.t(key);
  }

  /** `true` when no language defines this key — the language editor's job. */
  protected missingKey(key: string): boolean {
    return key.length > 0 && !this.i18n.has(key);
  }

  /** Writes the open definition into the content directory. */
  protected save(): Promise<void> {
    return this.drafts.save();
  }

  /** Pixels and definitions both live in memory until they are written. */
  protected onUnload(event: BeforeUnloadEvent): void {
    if (this.drafts.anyUnsaved() || this.unsavedSprites().length > 0) {
      event.preventDefault();
    }
  }
}

/** Every locale key this definition names. */
function referencedKeys(object: ObjectDefinition | null): string[] {
  if (object === null) {
    return [];
  }
  return [object.nameKey ?? '', object.descriptionKey ?? ''].filter((key) => key.length > 0);
}

function loadImage(asset: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.addEventListener('load', () => resolve(image));
    image.addEventListener('error', () => resolve(null));
    image.src = assetUrl(`${CONTENT_ROOT}/${asset}`);
  });
}
