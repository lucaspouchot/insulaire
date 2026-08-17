import { Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { BUILD_FEATURES } from './build-features';
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
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly engine = inject(EngineService);
  private readonly store = inject(ProjectStoreService);
  /** What this build contains; the client delivery has no editor. */
  protected readonly features = BUILD_FEATURES;

  /**
   * The authored project's name, from `content/project.json`.
   *
   * The engine's own name stands in until the manifest has been fetched, so the
   * bar never flickers through an empty slot on a cold load.
   */
  protected readonly projectName = computed(() => this.store.project()?.name ?? 'Insulaire');

  constructor() {
    // Start loading the engine as early as possible: both modes need it, and
    // the download is a couple of hundred kilobytes.
    void this.engine.ready().catch(() => {
      // Surfaced through engine.failure(); nothing to do here.
    });
    // The pages load the project too; `ensureLoaded` is memoised, so asking for
    // it here only means the name is on screen as early as it can be.
    void this.store.ensureLoaded().catch(() => {
      // The page that needs the content reports the failure; the bar just keeps
      // its fallback name.
    });
  }
}
