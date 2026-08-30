/**
 * The title screen editor.
 *
 * It edits one content file — `menu/title-screen.json` — and everything about
 * it follows from that: the form writes a `TitleScreenDefinition`, the Rust
 * validator judges it (ADR-0012), and the preview is the **real**
 * {@link TitlePage}, not a mock-up, so what an author sees is what a player
 * gets (`docs/adr/ADR-0021-authored-title-screen.md`).
 *
 * Images and music are uploaded straight into the content directory through the
 * authoring server (ADR-0019) — dropping a file here puts it on disk, which is
 * the whole point of having that server.
 *
 * Labels are keys: this screen picks and **creates** them — saving writes every
 * key the screen names into every language, empty — and the language editor is
 * where their text is written (ADR-0020,
 * `docs/adr/ADR-0020-localised-content-keys.md`).
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import {
  TitleAction,
  TitleScreenDefinition,
  ValidationReportLike,
} from './title-editor.types';
import { I18nService } from '../../../i18n/i18n.service';
import { TranslatePipe } from '../../../i18n/translate.pipe';
import { ContentWorkspaceService, WorkspaceFile } from '../../../services/content-workspace.service';
import { EngineService } from '../../../services/engine.service';
import { LocaleAuthoringService } from '../../../services/locale-authoring.service';
import { CONTENT_ROOT, ProjectStoreService } from '../../../services/project-store.service';
import { assetUrl } from '../../../../core/asset-url';
import { TitleScreenService } from '../../../services/title-screen.service';
import { TitlePage } from '../../title/title-page';

/** Where an uploaded file goes, by kind. */
const UPLOAD_DIR = { image: 'assets/images', audio: 'assets/audio' } as const;

/** Every action a button may carry, in the order the picker offers them. */
const ACTIONS: readonly TitleAction[] = ['newGame', 'continue', 'settings', 'credits', 'quit'];

@Component({
  selector: 'app-title-editor-page',
  imports: [TranslatePipe, TitlePage],
  templateUrl: './title-editor-page.html',
  styleUrl: './title-editor-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TitleEditorPage {
  private readonly store = inject(ProjectStoreService);
  private readonly engine = inject(EngineService);
  private readonly i18n = inject(I18nService);
  private readonly workspace = inject(ContentWorkspaceService);
  private readonly titleScreen = inject(TitleScreenService);
  private readonly locales = inject(LocaleAuthoringService);

  /** The document being edited. */
  protected readonly screen = signal<TitleScreenDefinition | null>(null);
  /** What the Rust validator says about it. */
  protected readonly report = signal<ValidationReportLike | null>(null);
  protected readonly message = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly dirty = signal(false);
  protected readonly busy = signal(false);
  /** Content files that can be picked as an image or a track. */
  protected readonly files = signal<readonly WorkspaceFile[]>([]);
  /** Bumped to force the preview to re-read the document. */
  protected readonly previewRevision = signal(0);

  protected readonly actions = ACTIONS;

  /** Path the manifest gives the title screen, or the conventional one. */
  protected readonly path = computed(
    () => this.store.project()?.titleScreen?.path ?? 'menu/title-screen.json',
  );

  protected readonly images = computed(() =>
    this.files().filter((file) => /\.(png|jpe?g|webp|gif|svg)$/i.test(file.path)),
  );
  protected readonly tracks = computed(() =>
    this.files().filter((file) => /\.(ogg|mp3|wav|m4a)$/i.test(file.path)),
  );

  /** `true` when files can actually be written — the editor is honest about it. */
  protected readonly writable = computed(() => this.workspace.status() !== null);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      await this.i18n.ensureAdopted();
      await this.workspace.ensureProbed();
      await this.locales.ensureLoaded();
      await this.refreshFiles();

      const declared = this.store.project()?.titleScreen;
      if (declared === undefined) {
        // Nothing authored yet: start from a screen that already validates.
        this.screen.set(blankScreen());
        this.dirty.set(true);
        return;
      }

      const response = await fetch(assetUrl(`${CONTENT_ROOT}/${declared.path}`));
      const json = await response.text();
      this.engine.loadTitleScreen(json);
      this.screen.set(this.engine.titleScreen() as TitleScreenDefinition);
      this.validate();
    } catch (cause) {
      this.error.set(describe(cause));
    }
  }

  private async refreshFiles(): Promise<void> {
    if (this.workspace.status() === null) {
      return;
    }
    this.files.set(await this.workspace.list());
  }

  // ------------------------------------------------------------------ edits

  /** Applies a change to the document and re-validates it. */
  protected patch(change: Partial<TitleScreenDefinition>): void {
    const screen = this.screen();
    if (screen === null) {
      return;
    }
    this.screen.set({ ...screen, ...change });
    this.dirty.set(true);
    this.message.set(null);
    this.previewRevision.update((value) => value + 1);
    this.validate();
  }

  protected patchButton(index: number, change: Partial<TitleScreenDefinition['buttons'][number]>): void {
    const screen = this.screen();
    if (screen === null) {
      return;
    }
    const buttons = screen.buttons.map((button, at) =>
      at === index ? { ...button, ...change } : button,
    );
    this.patch({ buttons });
  }

  protected addButton(action: string): void {
    const screen = this.screen();
    if (screen === null || !ACTIONS.includes(action as TitleAction)) {
      return;
    }
    this.patch({
      buttons: [
        ...screen.buttons,
        { action: action as TitleAction, labelKey: `menu.buttons.${action}`, hidden: false },
      ],
    });
  }

  protected removeButton(index: number): void {
    const screen = this.screen();
    if (screen !== null) {
      this.patch({ buttons: screen.buttons.filter((_, at) => at !== index) });
    }
  }

  /** Moves a button up or down; the order is what a player reads. */
  protected moveButton(index: number, delta: number): void {
    const screen = this.screen();
    const target = index + delta;
    if (screen === null || target < 0 || target >= screen.buttons.length) {
      return;
    }
    const buttons = [...screen.buttons];
    const [moved] = buttons.splice(index, 1);
    if (moved !== undefined) {
      buttons.splice(target, 0, moved);
      this.patch({ buttons });
    }
  }

  /** The text a key currently resolves to, so the form reads as prose. */
  protected preview(key: string): string {
    return key.length === 0 ? '' : this.i18n.t(key);
  }

  // ---------------------------------------------------------------- uploads

  /**
   * Uploads a file into the content directory and points a field at it.
   *
   * The path is `assets/images/<name>` or `assets/audio/<name>`: a convention,
   * not a rule — the content server accepts any path inside the directory.
   */
  protected async upload(event: Event, kind: 'image' | 'audio', apply: (path: string) => void): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file === undefined) {
      return;
    }
    input.value = '';

    this.busy.set(true);
    this.error.set(null);
    try {
      const path = `${UPLOAD_DIR[kind]}/${file.name}`;
      await this.workspace.write(path, file);
      await this.refreshFiles();
      apply(path);
      this.message.set(this.i18n.t('ui.editor.title.uploaded', { file: path }));
    } catch (cause) {
      this.error.set(describe(cause));
    } finally {
      this.busy.set(false);
    }
  }

  // --------------------------------------------------------------- validate

  /** Asks Rust whether this document is usable — the same check the runtime runs. */
  protected validate(): void {
    const screen = this.screen();
    if (screen === null || !this.engine.isReady) {
      return;
    }
    try {
      this.report.set(this.engine.validateTitleScreen(JSON.stringify(screen)));
    } catch (cause) {
      this.error.set(describe(cause));
    }
  }

  /** Writes the document into the content directory. */
  protected async save(): Promise<void> {
    const screen = this.screen();
    if (screen === null) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.message.set(null);

    try {
      const report = this.engine.validateTitleScreen(JSON.stringify(screen));
      this.report.set(report);
      if (!report.valid) {
        this.error.set(this.i18n.t('ui.editor.title.invalid'));
        return;
      }

      const json = `${JSON.stringify(screen, null, 2)}\n`;
      await this.workspace.writeJson(this.path(), json);
      // Adopting it is what makes the preview and the real title screen agree
      // from here on — and what a later content reset puts back.
      this.titleScreen.adopt(json);

      // Every label this screen names now exists as a key, in every language,
      // for the Languages tab to fill in; until then it shows as itself.
      const created = this.locales.ensureKeys(referencedKeys(screen));
      if (created.length > 0) {
        await this.locales.save();
      }

      this.dirty.set(false);
      this.validate();
      this.message.set(
        this.i18n.t('ui.editor.title.saved', { file: this.path() }) +
          (created.length === 0
            ? ''
            : ` · ${this.i18n.t('ui.editor.locale.created', { count: created.length })}`),
      );
    } catch (cause) {
      this.error.set(describe(cause));
    } finally {
      this.busy.set(false);
    }
  }
}

/**
 * Every locale key a title screen names.
 *
 * The same set the Rust validator walks: the title, the subtitle when there is
 * one, and every button's label.
 */
function referencedKeys(screen: TitleScreenDefinition): string[] {
  return [
    screen.titleKey,
    screen.subtitleKey,
    ...screen.buttons.map((button) => button.labelKey),
  ].filter((key) => key.length > 0);
}

/** A title screen that is valid the moment it is created. */
function blankScreen(): TitleScreenDefinition {
  return {
    id: 'main',
    schemaVersion: 1,
    titleKey: 'menu.title.title',
    subtitleKey: '',
    background: { image: '', fit: 'cover', tint: '#0b1016' },
    logo: null,
    splash: null,
    music: null,
    theme: { accent: '#ffd166', text: '#e8eef5', panel: 'rgba(12, 16, 22, 0.72)', font: '' },
    layout: 'left',
    buttons: [
      { action: 'newGame', labelKey: 'menu.buttons.newGame', hidden: false },
      { action: 'settings', labelKey: 'menu.buttons.settings', hidden: false },
    ],
  };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
