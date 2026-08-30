/**
 * The title screen: what a delivered game opens on.
 *
 * Everything visible here is authored — the background, the logo, the music,
 * the buttons, their order and their labels all come from the project's title
 * screen file (`docs/adr/ADR-0021-authored-title-screen.md`). The component
 * contributes three things content cannot:
 *
 * 1. **what a button does.** `TitleAction` is a closed set, and this is where
 *    each one is performed;
 * 2. **what is possible here.** `quit` only exists in the desktop shell,
 *    `continue` only once there is a save;
 * 3. **the first gesture.** Browsers refuse to play music until the visitor has
 *    interacted, so skipping the splash is what starts the theme.
 *
 * The splash belongs to **launching the game**, not to the route: coming back
 * here from a game or from the settings shows the menu straight away. One page
 * load is one launch, which is exactly what a delivered executable is.
 *
 * With no authored screen — which is the normal state of a bare project — it
 * falls back to a plain menu carrying the same actions, so the route is never a
 * blank page.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';

import { TitleAction, TitleButton } from '../../../content/content-types';
import { assetUrl } from '../../../core/asset-url';
import { describeError } from '../../../core/errors';
import { I18nService } from '../../i18n/i18n.service';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { AudioService } from '../../services/audio.service';
import { EngineService } from '../../services/engine.service';
import { NativeShellService } from '../../services/native-shell.service';
import { CONTENT_ROOT, ProjectStoreService } from '../../services/project-store.service';
import { SaveCatalogService } from '../../services/save-catalog.service';
import { TitleScreenService } from '../../services/title-screen.service';

/** A button as the template needs it: label, state and reason. */
interface MenuEntry {
  readonly action: TitleAction;
  readonly labelKey: string;
  readonly disabled: boolean;
  /** Key explaining why it is disabled, when it is. */
  readonly reasonKey: string | null;
}

/**
 * Whether this launch has already played its splash.
 *
 * Module-level on purpose: the state being tracked is the *application run*, and
 * a run ends when the page is unloaded. A service would say the same thing with
 * a lifetime that is harder to read.
 */
let splashPlayed = false;

/** The menu offered when a project authors no title screen. */
const FALLBACK_BUTTONS: readonly TitleButton[] = [
  { action: 'newGame', labelKey: 'ui.title.newGame' },
  { action: 'continue', labelKey: 'ui.title.continue' },
  { action: 'settings', labelKey: 'ui.title.settings' },
  { action: 'quit', labelKey: 'ui.title.quit' },
];

@Component({
  selector: 'app-title-page',
  imports: [TranslatePipe],
  templateUrl: './title-page.html',
  styleUrl: './title-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TitlePage implements OnDestroy {
  private readonly engine = inject(EngineService);
  private readonly store = inject(ProjectStoreService);
  private readonly i18n = inject(I18nService);
  private readonly audio = inject(AudioService);
  private readonly shell = inject(NativeShellService);
  private readonly saves = inject(SaveCatalogService);
  private readonly titleScreen = inject(TitleScreenService);
  private readonly router = inject(Router);

  /** The authored screen, or `null` while loading and when none is shipped. */
  protected readonly screen = this.titleScreen.screen;
  /**
   * `false` until the screen's content has been read and the splash decided.
   *
   * The menu is withheld until then. Without it the fallback menu paints on the
   * first frame and the splash covers it one fetch later, which reads as a
   * flash of the wrong screen — the splash is supposed to be the *first* thing
   * a launch shows, not the second.
   */
  protected readonly prepared = signal(false);
  /** `true` while the splash is on top. */
  protected readonly splashing = signal(false);
  /** Why the screen could not be prepared, if it could not. */
  protected readonly error = signal<string | null>(null);

  private splashTimer: ReturnType<typeof setTimeout> | null = null;

  /** The project's name, for the fallback title. */
  protected readonly projectName = computed(() => this.store.project()?.name ?? 'Insulaire');

  /** Buttons to draw, with what this build and this session make possible. */
  protected readonly entries = computed<readonly MenuEntry[]>(() => {
    const authored = this.screen()?.buttons ?? FALLBACK_BUTTONS;
    const native = this.shell.isShell();
    const hasSaves = this.saves.slots().length > 0;

    return (
      authored
        .filter((button) => button.hidden !== true)
        // A Quit button in a browser tab has nothing to close, so it is not shown
        // at all rather than shown broken. Any native shell has.
        .filter((button) => button.action !== 'quit' || native)
        .map((button) => ({
          action: button.action,
          labelKey: button.labelKey,
          disabled: button.action === 'continue' && !hasSaves,
          reasonKey: button.action === 'continue' && !hasSaves ? 'ui.title.noSave' : null,
        }))
    );
  });

  /** CSS custom properties carrying the authored theme. */
  protected readonly themeStyle = computed<Record<string, string>>(() => {
    const screen = this.screen();
    const style: Record<string, string> = {};
    if (screen === null) {
      return style;
    }
    if (screen.theme.accent) {
      style['--title-accent'] = screen.theme.accent;
    }
    if (screen.theme.text) {
      style['--title-text'] = screen.theme.text;
    }
    if (screen.theme.panel) {
      style['--title-panel'] = screen.theme.panel;
    }
    if (screen.theme.font) {
      style['--title-font'] = screen.theme.font;
    }
    if (screen.background.tint) {
      style['--title-tint'] = screen.background.tint;
    }
    if (screen.background.image) {
      style['--title-background'] = `url("${this.contentUrl(screen.background.image)}")`;
      style['--title-background-size'] =
        screen.background.fit === 'tile' ? 'auto' : screen.background.fit;
      style['--title-background-repeat'] =
        screen.background.fit === 'tile' ? 'repeat' : 'no-repeat';
    }
    return style;
  });

  /** Absolute URL of the logo, when one is authored. */
  protected readonly logoUrl = computed(() => {
    const logo = this.screen()?.logo ?? null;
    return logo === null ? null : this.contentUrl(logo.image);
  });

  /** Absolute URL of the splash image, when one is authored. */
  protected readonly splashUrl = computed(() => {
    const splash = this.screen()?.splash ?? null;
    return splash === null || splash.image.length === 0 ? null : this.contentUrl(splash.image);
  });

  constructor() {
    void this.prepare();
  }

  ngOnDestroy(): void {
    this.clearSplashTimer();
  }

  /**
   * Loads the content the screen is made of, then starts the splash.
   *
   * The engine holds the authored screen because it is content like any other:
   * validated by the same Rust validator, with its defaults already applied. A
   * project without one is a legitimate state — the fallback menu carries the
   * same actions.
   */
  private async prepare(): Promise<void> {
    try {
      await this.i18n.ensureAdopted();
      await this.saves.refresh();

      const screen = await this.titleScreen.ensureLoaded();
      if (screen !== null && screen.splash !== null && !splashPlayed) {
        splashPlayed = true;
        this.startSplash(screen.splash.durationMs);
      } else {
        this.startMusic();
      }
    } catch (cause) {
      this.error.set(describeError(cause));
    } finally {
      this.prepared.set(true);
    }
  }

  private startSplash(durationMs: number): void {
    this.splashing.set(true);
    this.splashTimer = setTimeout(() => this.endSplash(), Math.max(0, durationMs));
  }

  /**
   * Ends the splash — on its timer, or on the click or key that skips it.
   *
   * This is also the gesture the browser was waiting for, so it is where the
   * music actually starts.
   */
  protected endSplash(): void {
    const splash = this.screen()?.splash ?? null;
    if (this.splashing() && splash !== null && !splash.skippable && this.splashTimer !== null) {
      // An unskippable splash still ends on its own timer; a click does nothing
      // but unlock the audio.
      this.audio.unlock();
      return;
    }
    this.clearSplashTimer();
    this.splashing.set(false);
    this.startMusic();
  }

  /** Starts the authored theme, if there is one. */
  private startMusic(): void {
    this.audio.unlock();
    const music = this.screen()?.music ?? null;
    if (music === null) {
      return;
    }
    this.audio.playMusic({
      url: this.contentUrl(music.track),
      loop: music.loops,
      gain: music.gain,
      fadeInMs: music.fadeInMs,
    });
  }

  /** Performs a menu action. This is the whole vocabulary. */
  protected async activate(entry: MenuEntry): Promise<void> {
    if (entry.disabled) {
      return;
    }
    this.audio.unlock();

    switch (entry.action) {
      case 'newGame':
        // A *new* game: anything still running is discarded here rather than
        // resumed by the play screen, which is what makes the button honest.
        if (this.engine.hasGame()) {
          this.engine.endGame();
        }
        await this.router.navigate(['/character-creation']);
        break;
      case 'continue':
        // Unreachable while `hasSaves` is false; kept so the day saves exist,
        // the button already routes somewhere.
        await this.router.navigate(['/play']);
        break;
      case 'settings':
        // The settings screen drops the application bar, so it is told where
        // Back leads.
        await this.router.navigate(['/settings'], { queryParams: { from: '/title' } });
        break;
      case 'credits':
        await this.router.navigate(['/credits']);
        break;
      case 'quit':
        await this.shell.quit();
        break;
    }
  }

  /** The title to show: the authored key, else the project's name. */
  protected readonly titleText = computed(() => {
    const key = this.screen()?.titleKey;
    return key === undefined || key.length === 0 ? this.projectName() : this.i18n.t(key);
  });

  /** The subtitle, when the screen authors one. */
  protected readonly subtitleText = computed(() => {
    const key = this.screen()?.subtitleKey ?? '';
    return key.length === 0 ? null : this.i18n.t(key);
  });

  private contentUrl(path: string): string {
    return assetUrl(`${CONTENT_ROOT}/${path}`);
  }

  private clearSplashTimer(): void {
    if (this.splashTimer !== null) {
      clearTimeout(this.splashTimer);
      this.splashTimer = null;
    }
  }
}
