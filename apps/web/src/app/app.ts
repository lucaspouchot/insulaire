import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { EngineService } from './services/engine.service';

/**
 * Application shell: navigation plus a badge that reports what the engine
 * actually is.
 *
 * The badge is not decoration. It shows the engine's own `targetArch` and
 * `pointerWidth`, read out of the running WebAssembly module, so "the
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

  constructor() {
    // Start loading the engine as early as possible: both modes need it, and
    // the download is a couple of hundred kilobytes.
    void this.engine.ready().catch(() => {
      // Surfaced through engine.failure(); nothing to do here.
    });
  }
}
