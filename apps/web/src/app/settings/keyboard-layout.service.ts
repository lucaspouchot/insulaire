/** Resolves physical keyboard codes to the labels printed by the active layout. */

import { Injectable, signal } from '@angular/core';

import { fallbackKeyboardLabel } from '../../core/keyboard-shortcuts';

interface KeyboardLayoutMapLike {
  get(code: string): string | undefined;
}

interface NavigatorWithKeyboardLayout extends Navigator {
  keyboard?: {
    getLayoutMap(): Promise<KeyboardLayoutMapLike>;
  };
}

@Injectable({ providedIn: 'root' })
export class KeyboardLayoutService {
  private readonly labels = signal<ReadonlyMap<string, string>>(new Map());

  constructor() {
    void this.load();
  }

  /** The current layout's printed label, with a deterministic code fallback. */
  label(code: string): string {
    return this.labels().get(code) ?? fallbackKeyboardLabel(code);
  }

  /** Remembers the label from the event that captured a binding. */
  remember(code: string, key: string): void {
    if (key.length === 0 || key === 'Unidentified') {
      return;
    }
    this.labels.update((labels) => new Map(labels).set(code, key));
  }

  private async load(): Promise<void> {
    if (typeof navigator === 'undefined') {
      return;
    }
    const keyboard = (navigator as NavigatorWithKeyboardLayout).keyboard;
    if (keyboard === undefined) {
      return;
    }
    try {
      const layout = await keyboard.getLayoutMap();
      const labels = new Map<string, string>();
      // The API exposes only `get`, not a consistently typed iterator in every
      // browser declaration. Resolve lazily used codes plus the whole ordinary
      // typing surface that authors are most likely to bind.
      for (const code of commonKeyboardCodes()) {
        const label = layout.get(code);
        if (label !== undefined && label.length > 0) {
          labels.set(code, label);
        }
      }
      this.labels.set(labels);
    } catch {
      // Permission and API support differ by host. The physical binding still
      // works; only its untouched fallback label is less specific.
    }
  }
}

function commonKeyboardCodes(): string[] {
  return [
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => `Key${letter}`),
    ...'0123456789'.split('').map((digit) => `Digit${digit}`),
    'Backquote',
    'Minus',
    'Equal',
    'BracketLeft',
    'BracketRight',
    'Backslash',
    'Semicolon',
    'Quote',
    'Comma',
    'Period',
    'Slash',
    'IntlBackslash',
    'IntlRo',
    'IntlYen',
    'Space',
  ];
}
