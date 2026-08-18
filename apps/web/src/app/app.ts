import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs/operators';

import { BUILD_FEATURES } from './build-features';
import { I18nService } from './i18n/i18n.service';
import { TranslatePipe } from './i18n/translate.pipe';
import { EngineService } from './services/engine.service';
import { ProjectStoreService } from './services/project-store.service';

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
 * (`docs/adr/ADR-0023-localised-content-keys.md`).
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, TranslatePipe],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly engine = inject(EngineService);
  private readonly store = inject(ProjectStoreService);
  private readonly i18n = inject(I18nService);
  private readonly router = inject(Router);

  /** What this build contains; the client delivery has no editor. */
  protected readonly features = BUILD_FEATURES;

  /**
   * The authored project's name, from `content/project.json`.
   *
   * The engine's own name stands in until the manifest has been fetched, so the
   * bar never flickers through an empty slot on a cold load.
   */
  protected readonly projectName = computed(() => this.store.project()?.name ?? 'Insulaire');

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
   * (`docs/adr/ADR-0024-authored-title-screen.md`). Every other screen keeps the
   * bar, which is also how a developer leaves the title screen.
   */
  protected readonly showChrome = computed(() => !this.url().startsWith('/title'));

  constructor() {
    // Starts the engine and the content as early as possible — both modes need
    // them — and adopts the project's languages once they are up. The pages ask
    // for the same thing; it happens once, whoever gets there first.
    void this.i18n.ensureAdopted().catch(() => {
      // Surfaced through engine.failure() and by the page that needs the
      // content; the bar keeps its fallback name and the built-in strings.
    });
  }
}
