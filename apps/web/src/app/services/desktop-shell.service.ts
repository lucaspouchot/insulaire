/**
 * The few things only the desktop shell can do: close the window, go
 * fullscreen, resize.
 *
 * The same bundle runs in a browser tab and inside the Tauri window
 * (`docs/adr/ADR-0020-desktop-executable.md`), so this service answers "am I in
 * the executable?" and, when the answer is no, does nothing. A **Quit** button
 * in a browser tab is not a button that fails — it is a button that is not
 * offered.
 *
 * `@tauri-apps/api` is imported dynamically and only when the shell is actually
 * there, so a browser build never downloads it.
 */

import { Injectable, signal } from '@angular/core';

/** The window API this service uses, as a structural type. */
interface TauriWindow {
  close(): Promise<void>;
  setFullscreen(fullscreen: boolean): Promise<void>;
  setSize(size: unknown): Promise<void>;
  isFullscreen(): Promise<boolean>;
}

@Injectable({ providedIn: 'root' })
export class DesktopShellService {
  /** `true` when the page is running inside the desktop shell. */
  readonly isDesktop = signal(detectDesktop());

  private window: Promise<TauriWindow | null> | null = null;

  /**
   * Closes the game window.
   *
   * @returns `false` in a browser, where there is nothing to close.
   */
  async quit(): Promise<boolean> {
    const window = await this.requireWindow();
    if (window === null) {
      return false;
    }
    await window.close();
    return true;
  }

  /** Switches the window between fullscreen and windowed. */
  async setFullscreen(fullscreen: boolean): Promise<boolean> {
    const window = await this.requireWindow();
    if (window === null) {
      return false;
    }
    await window.setFullscreen(fullscreen);
    return true;
  }

  /** Resizes the window, in logical pixels. */
  async setSize(width: number, height: number): Promise<boolean> {
    const window = await this.requireWindow();
    if (window === null) {
      return false;
    }
    const { LogicalSize } = await import('@tauri-apps/api/dpi');
    await window.setSize(new LogicalSize(width, height));
    return true;
  }

  /** `true` when the window is currently fullscreen; `false` in a browser. */
  async isFullscreen(): Promise<boolean> {
    const window = await this.requireWindow();
    return window === null ? false : window.isFullscreen();
  }

  private requireWindow(): Promise<TauriWindow | null> {
    if (!this.isDesktop()) {
      return Promise.resolve(null);
    }
    this.window ??= import('@tauri-apps/api/window')
      .then((module) => module.getCurrentWindow() as unknown as TauriWindow)
      .catch(() => null);
    return this.window;
  }
}

/**
 * Whether the Tauri runtime is present.
 *
 * The shell injects `__TAURI_INTERNALS__` into the page before any of our code
 * runs, so its presence is the check — no build flag, because the *same* bundle
 * is what the executable embeds.
 */
function detectDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
