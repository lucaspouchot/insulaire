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

import {
  ChangeDetectionStrategy,
  Component,
  Signal,
  computed,
  inject,
  signal,
} from '@angular/core';

import { TitleAction, TitleScreenDefinition, ValidationReportLike } from './title-editor.types';
import { I18nService } from '../../../i18n/i18n.service';
import { TranslatePipe } from '../../../i18n/translate.pipe';
import { ContentWorkspaceService } from '../../../services/content-workspace.service';
import { WorkspaceFiles } from '../../../services/workspace-files';
import { EngineService } from '../../../services/engine.service';
import { LocaleAuthoringService } from '../../../services/locale-authoring.service';
import { ProjectManifest } from '../../../project/project-manifest';
import { WriteLedger } from '../../../project/write-ledger';
import { CONTENT_ROOT } from '../../../services/project-store.service';
import { assetUrl } from '../../../../core/asset-url';
import { TitleScreenService } from '../../../services/title-screen.service';
import { TitlePage } from '../../title/title-page';
import { DraftSet } from '../../../editing/draft-set';
import { DraftSource } from '../../../editing/draft-source';

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
  private readonly manifest = inject(ProjectManifest);
  private readonly ledger = inject(WriteLedger);
  private readonly engine = inject(EngineService);
  private readonly i18n = inject(I18nService);
  private readonly workspace = inject(ContentWorkspaceService);
  private readonly workspaceFiles = inject(WorkspaceFiles);
  private readonly titleScreen = inject(TitleScreenService);
  private readonly locales = inject(LocaleAuthoringService);

  /**
   * The editing session, holding exactly one draft.
   *
   * A title screen is a list of length one: the manifest names one path and
   * there is no "add" button, so what is left of the session is the load and
   * save choreography — which is the whole of what was copied
   * (`app/editing/draft-set.ts`).
   */
  private readonly drafts = new DraftSet<TitleScreenDefinition>(this.draftSource(), {
    i18n: this.i18n,
    workspace: this.workspace,
    ledger: this.ledger,
    locales: this.locales,
  });

  /** The document being edited. */
  protected readonly screen = this.drafts.open;
  /** What the Rust validator says about it. */
  protected readonly report: Signal<ValidationReportLike | null> = this.drafts.report;
  protected readonly message = this.drafts.message;
  protected readonly error = this.drafts.error;
  protected readonly dirty = this.drafts.dirty;
  protected readonly busy = this.drafts.busy;
  /** Bumped to force the preview to re-read the document. */
  protected readonly previewRevision = signal(0);

  protected readonly actions = ACTIONS;

  /** Path the manifest gives the title screen, or the conventional one. */
  protected readonly path = computed(
    () => this.manifest.titleScreen()?.path ?? 'menu/title-screen.json',
  );

  protected readonly images = this.workspaceFiles.pictures;
  protected readonly tracks = this.workspaceFiles.tracks;

  /** `true` when files can actually be written — the editor is honest about it. */
  protected readonly writable = computed(() => this.workspace.status() !== null);

  constructor() {
    void this.drafts.load();
  }

  /**
   * What the *title screen* means by reading, validating and writing.
   *
   * Everything else about the session is `DraftSet`'s. There is no manifest
   * entry to add and no art to write: the file is at one path, so saving it
   * cannot move `project.json`.
   */
  private draftSource(): DraftSource<TitleScreenDefinition> {
    return {
      declaredInManifest: false,
      // Nothing authored yet: start from a screen that already validates.
      blank: () => blankScreen(),
      messages: {
        invalid: 'ui.editor.title.invalid',
        saved: 'ui.editor.title.saved',
      },
      prepare: async () => {
        await this.i18n.ensureAdopted();
        await this.workspace.ensureProbed();
        await this.locales.ensureLoaded();
        await this.workspaceFiles.refresh();
      },
      declared: () => {
        const declared = this.manifest.titleScreen();
        return declared === null ? [] : [declared];
      },
      read: async (entry) => {
        const response = await fetch(assetUrl(`${CONTENT_ROOT}/${entry.path}`));
        const json = await response.text();
        this.engine.loadTitleScreen(json);
        return this.engine.titleScreen() as TitleScreenDefinition;
      },
      pathOf: () => this.path(),
      // Two spaces and a trailing newline: this file is read by people.
      serialize: (screen) => `${JSON.stringify(screen, null, 2)}\n`,
      validate: (screen) => this.engine.validateTitleScreen(JSON.stringify(screen)),
      // Adopting it is what makes the preview and the real title screen agree
      // from here on — and what a later content reset puts back.
      adopt: (_id, json) => this.titleScreen.adopt(json),
      forget: () => {},
      declare: () => {},
      undeclare: () => {},
      dirtySprites: () => [],
      writeSprites: async () => 0,
      keysOf: (screen) => referencedKeys(screen),
      removed: () => {},
      refresh: () => {},
    };
  }

  // ------------------------------------------------------------------ edits

  /** Applies a change to the document and re-validates it. */
  protected patch(change: Partial<TitleScreenDefinition>): void {
    this.drafts.edit((draft) => Object.assign(draft, change));
    this.previewRevision.update((value) => value + 1);
  }

  protected patchButton(
    index: number,
    change: Partial<TitleScreenDefinition['buttons'][number]>,
  ): void {
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
  protected async upload(
    event: Event,
    kind: 'image' | 'audio',
    apply: (path: string) => void,
  ): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file === undefined) {
      return;
    }
    input.value = '';

    this.drafts.setBusy(true);
    this.drafts.clearError();
    try {
      const path = await this.workspaceFiles.upload(file, UPLOAD_DIR[kind]);
      apply(path);
      this.drafts.announce(this.i18n.t('ui.editor.title.uploaded', { file: path }));
    } catch (cause) {
      this.drafts.fail(cause);
    } finally {
      this.drafts.setBusy(false);
    }
  }

  // --------------------------------------------------------------- validate

  /** Asks Rust whether this document is usable — the same check the runtime runs. */
  protected validate(): void {
    this.drafts.refresh();
  }

  /** Writes the document into the content directory. */
  protected save(): Promise<void> {
    return this.drafts.save();
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
