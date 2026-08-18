/**
 * The few things only the native shell can do: close the window, go fullscreen,
 * resize, hold the screen in one orientation.
 *
 * The same bundle runs in a browser tab and inside the Tauri shell
 * (`docs/adr/ADR-0020-desktop-executable.md`), so this service answers "what is
 * hosting me?" and, when the answer is a browser, does nothing. A **Quit**
 * button in a browser tab is not a button that fails — it is a button that is
 * not offered.
 *
 * Two questions, not one, because Tauri also builds phone applications: a shell
 * is *present* (`isShell`), and that shell has a **window** (`hasWindow`). Only
 * the second may be asked "how big would you like to be" — a phone answers that
 * question by being a phone.
 *
 * `@tauri-apps/api` is imported dynamically and only when the shell is actually
 * there, so a browser build never downloads it.
 */

import { Injectable, computed, signal } from '@angular/core';

/** User agents of the platforms Tauri ships an application, not a window, on. */
const MOBILE_PLATFORM = /Android|iPhone|iPad|iPod/;

/** The window API this service uses, as a structural type. */
interface TauriWindow {
  close(): Promise<void>;
  setFullscreen(fullscreen: boolean): Promise<void>;
  setSize(size: unknown): Promise<void>;
  isFullscreen(): Promise<boolean>;
}

@Injectable({ providedIn: 'root' })
export class NativeShellService {
  /** `true` when a native shell hosts the page, of whatever kind. */
  readonly isShell = signal(detectShell());

  /**
   * `true` when that shell is a phone or tablet application.
   *
   * Read from the user agent rather than from `@tauri-apps/plugin-os`: the
   * plugin would answer the same question at the cost of an npm package and a
   * Rust plugin registered in the shell, and every Android and iOS webview
   * names itself in the one string that is already there.
   */
  readonly isMobile = computed(
    () =>
      this.isShell() &&
      typeof navigator !== 'undefined' &&
      MOBILE_PLATFORM.test(navigator.userAgent),
  );

  /**
   * `true` when the shell has a window whose size is the player's business.
   *
   * What the settings screen keys its display controls off: a phone has no
   * window to size and no way to leave fullscreen, so offering either would be
   * offering a control that does nothing (`engine-settings.schema.ts`).
   */
  readonly hasWindow = computed(() => this.isShell() && !this.isMobile());

  private window: Promise<TauriWindow | null> | null = null;

  constructor() {
    if (this.isMobile()) {
      void this.lockLandscape();
    }
  }

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

  /**
   * Holds a phone application in landscape.
   *
   * Best effort, and deliberately not the whole answer: an activity free to
   * rotate has already rotated by the time a script runs, so the binding
   * setting is `android:screenOrientation` in the Android manifest, which
   * `tauri android init` writes and a build then owns. This catches a webview
   * that allows the lock, and stays quiet on one that does not.
   */
  private async lockLandscape(): Promise<void> {
    try {
      // `lock` is not in the DOM typings — it is not implemented everywhere —
      // so it is declared structurally, like the shell's own window above.
      const orientation = screen.orientation as ScreenOrientation & {
        lock?(orientation: 'landscape'): Promise<void>;
      };
      await orientation?.lock?.('landscape');
    } catch {
      // Refused or unimplemented: the manifest is what decides, not this.
    }
  }

  private requireWindow(): Promise<TauriWindow | null> {
    if (!this.isShell()) {
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
function detectShell(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
