import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs/operators';

import { BUILD_FEATURES } from './build-features';
import { I18nService } from './i18n/i18n.service';
import { TranslatePipe } from './i18n/translate.pipe';
import { EngineService } from './services/engine.service';
import { ProjectManifest } from './project/project-manifest';
import { SettingsService } from './settings/settings.service';

/**
 * Application shell: the open project's name, navigation, and a badge that
 * reports what the engine actually is.
 *
 * The badge is not decoration. Its tooltip shows the engine's own `targetArch`
 * and `pointerWidth`, read out of the running WebAssembly module, so "the
 * simulation is really Rust in WASM" is verifiable from the UI rather than
 * asserted in a README.
 *
 * The shell is also where the project's **languages** are adopted: it is the
 * one place that needs both the engine and the content, and every screen below
 * it displays keys resolved against what it sets up
 * (`docs/adr/ADR-0020-localised-content-keys.md`).
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, TranslatePipe],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly engine = inject(EngineService);
  private readonly manifest = inject(ProjectManifest);
  private readonly i18n = inject(I18nService);
  private readonly router = inject(Router);
  /**
   * Injected for its effect, not for its API: constructing this service is what
   * puts the application's own settings in force — the interface scale the
   * shell zooms by (`app.css`), the volumes, the window
   * (`docs/adr/ADR-0022-settings.md`). They act on the shell, so they belong to
   * the shell's lifetime; asked for by a screen instead, they would only apply
   * once a player had happened to open that screen, and the title screen — the
   * first thing anyone sees — asks for none of them.
   */
  private readonly settings = inject(SettingsService);

  /** What this build contains; the client delivery has no editor. */
  protected readonly features = BUILD_FEATURES;

  /**
   * The authored project's name, from `content/project.json`.
   *
   * The engine's own name stands in until the manifest has been fetched, so the
   * bar never flickers through an empty slot on a cold load.
   */
  protected readonly projectName = computed(() => this.manifest.name() ?? 'Insulaire');

  /** The route being shown, so the shell can step out of a screen's way. */
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  /**
   * Whether to draw the application bar.
   *
   * The title screen is the game's own first impression and takes the whole
   * window: a navigation bar and an engine badge across the top of it would be
   * the development tooling leaking into the product
   * (`docs/adr/ADR-0021-authored-title-screen.md`). The settings screen is the
   * same argument — it is a screen a *player* opens, it fills the window, and
   * it carries its own way back to wherever it was opened from. Character
   * creation is also part of the game's own presentation and carries its own
   * workflow navigation. Every other screen keeps the bar.
   */
  protected readonly showChrome = computed(
    () =>
      !this.url().startsWith('/title') &&
      !this.url().startsWith('/settings') &&
      !this.url().startsWith('/character-creation'),
  );

  /** `true` while the Title link would throw a running game away. */
  protected readonly confirmingTitle = signal(false);

  /** The Title entry is a button, so it needs its own active state. */
  protected readonly onTitle = computed(() => this.url().startsWith('/title'));

  constructor() {
    // Starts the engine and the content as early as possible — both modes need
    // them — and adopts the project's languages once they are up. The pages ask
    // for the same thing; it happens once, whoever gets there first.
    void this.i18n.ensureAdopted().catch(() => {
      // Surfaced through engine.failure() and by the page that needs the
      // content; the bar keeps its fallback name and the built-in strings.
    });
  }

  /**
   * Goes back to the title screen, asking first when that costs a game.
   *
   * Leaving for the settings or the editor keeps the session — the engine holds
   * it, not the play component — but the title screen is where a game is
   * started, so arriving there ends the one in progress. Saves do not exist yet
   * (`docs/adr/ADR-0007-save-system.md`), so "unsaved" is currently everything.
   */
  protected async goToTitle(): Promise<void> {
    if (this.engine.hasGame()) {
      this.confirmingTitle.set(true);
      return;
    }
    await this.router.navigate(['/title']);
  }

  /** Discards the running game and goes to the title screen. */
  protected async abandonGame(): Promise<void> {
    this.confirmingTitle.set(false);
    this.engine.endGame();
    await this.router.navigate(['/title']);
  }

  protected keepPlaying(): void {
    this.confirmingTitle.set(false);
  }

  /** Where the settings screen should send the player back to. */
  protected readonly settingsReturn = computed(() => ({ from: this.url() }));
}
