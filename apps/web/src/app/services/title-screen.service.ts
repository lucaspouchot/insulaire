/**
 * Holds the authored title screen, and puts it back after a content reset.
 *
 * The screen is content like any other: fetched once, validated by Rust, held
 * by the engine (`docs/adr/ADR-0024-authored-title-screen.md`). What it needs a
 * service for is the same thing the locales and the game's settings need one
 * for — **re-registration**. `resetContent()` forgets every loaded file, and
 * `loadProject` refuses a manifest naming a title screen that is not loaded, so
 * anything that reloads a project has to put this back with the rest or the
 * project stops loading (`project.unloadedTitleScreen`).
 *
 * It keeps the file's own JSON rather than re-serialising the parsed screen:
 * what goes back in is byte-for-byte what the engine already accepted.
 */

import { Injectable, inject, signal } from '@angular/core';

import { TitleScreenDefinition } from '../../content/content-types';
import { EngineService } from './engine.service';
import { ProjectStoreService, contentUrl } from './project-store.service';

@Injectable({ providedIn: 'root' })
export class TitleScreenService {
  private readonly engine = inject(EngineService);
  private readonly store = inject(ProjectStoreService);

  /** The registered screen, defaults filled in by the engine; `null` when none. */
  readonly screen = signal<TitleScreenDefinition | null>(null);

  /** The file as authored, kept so it can be registered again. */
  private json: string | null = null;
  private loading: Promise<TitleScreenDefinition | null> | null = null;

  /**
   * Loads the screen the manifest names, at most once.
   *
   * A project that declares none is normal: it resolves to `null` and the title
   * page falls back to a plain menu carrying the same actions.
   */
  async ensureLoaded(): Promise<TitleScreenDefinition | null> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<TitleScreenDefinition | null> {
    await this.engine.ready();
    const declared = this.store.project()?.titleScreen;
    if (declared === undefined) {
      return null;
    }

    const response = await fetch(contentUrl(declared.path));
    if (!response.ok) {
      throw new Error(`Could not load ${declared.path} (HTTP ${response.status}).`);
    }
    this.json = await response.text();
    this.engine.loadTitleScreen(this.json);
    const screen = this.engine.titleScreen();
    this.screen.set(screen);
    return screen;
  }

  /** Registers the screen again, after something ran `resetContent()`. */
  register(): void {
    if (this.json === null) {
      return;
    }
    try {
      this.engine.loadTitleScreen(this.json);
    } catch {
      // A screen the engine refuses is reported where it was loaded; the
      // manifest will say so again on the next `loadProject`.
    }
  }

  /** Takes on a screen the editor has just written, so it survives a reset. */
  adopt(json: string): void {
    this.json = json;
    this.engine.loadTitleScreen(json);
    this.screen.set(this.engine.titleScreen());
  }
}
