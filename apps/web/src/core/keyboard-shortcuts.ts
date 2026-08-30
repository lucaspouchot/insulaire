/**
 * Browser-keyboard helpers shared by shortcut capture, gameplay and the map view.
 *
 * A shortcut stores `KeyboardEvent.code`, the physical position. `key` is only
 * a label: on AZERTY the event `{ code: 'KeyW', key: 'z' }` still means the
 * north-west position (`docs/adr/ADR-0032-shortcuts-use-physical-keys.md`).
 *
 * In `core/` rather than beside the settings screen because the framework-free
 * canvas view reads a binding too: it holds one down to look through relief
 * (`docs/adr/ADR-0034-relief-never-hides-a-hex.md`), and `renderer/` may not
 * reach into `app/`.
 */

/** Codes that are modifiers rather than standalone player actions. */
const MODIFIER_CODES: ReadonlySet<string> = new Set([
  'AltLeft',
  'AltRight',
  'ControlLeft',
  'ControlRight',
  'MetaLeft',
  'MetaRight',
  'ShiftLeft',
  'ShiftRight',
]);

/** Whether a string has the stable shape of a modifier-free keyboard code. */
export function isKeyboardCode(code: string): boolean {
  return (
    code.length > 0 &&
    code !== 'Unidentified' &&
    code !== 'Escape' &&
    /^[A-Z][A-Za-z0-9]*$/.test(code) &&
    !MODIFIER_CODES.has(code)
  );
}

/**
 * The physical code captured by one keydown, or `null` for a chord/modifier.
 *
 * Shift is excluded too: storing only `Digit1` after a player entered `!`
 * would silently make the shortcut fire without Shift.
 */
export function capturedKeyboardCode(event: KeyboardEvent): string | null {
  if (
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.isComposing ||
    event.repeat ||
    !isKeyboardCode(event.code)
  ) {
    return null;
  }
  return event.code;
}

/** A gameplay key belongs to the focused form rather than to the map. */
export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))
  );
}

/** Whether a gameplay listener must leave this keydown alone. */
export function ignoresGameplayShortcut(event: KeyboardEvent): boolean {
  return (
    event.defaultPrevented || isEditableTarget(event.target) || capturedKeyboardCode(event) === null
  );
}

/**
 * What an editor chord asks for: to undo, to redo, or nothing.
 *
 * `event.key`, not `event.code` — and that is not an inconsistency with
 * {@link capturedKeyboardCode} above, it is the other half of the same rule.
 * A game action is a *position* on the keyboard, so it stores `code`
 * (`docs/adr/ADR-0032-shortcuts-use-physical-keys.md`). An editor chord is the
 * **printed letter**: an author on AZERTY presses the key marked Z to undo,
 * wherever the hardware puts it, because Ctrl+Z is a name and not a place.
 * ADR-0032's scope is rebindable one-key game actions and does not govern this.
 *
 * Ctrl and Cmd both, Shift+Z and Y both — the two spellings of redo every
 * platform's users arrive with. Nothing while a form field holds the caret.
 */
export function undoRedoIntent(event: KeyboardEvent): 'undo' | 'redo' | null {
  if (isEditableTarget(event.target) || !(event.ctrlKey || event.metaKey)) {
    return null;
  }
  const key = event.key.toLowerCase();
  if (key === 'y') {
    return 'redo';
  }
  if (key === 'z') {
    return event.shiftKey ? 'redo' : 'undo';
  }
  return null;
}

/** Readable fallback when the browser cannot expose its keyboard layout map. */
export function fallbackKeyboardLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) {
    return code.slice(3);
  }
  if (/^Digit[0-9]$/.test(code)) {
    return code.slice(5);
  }
  if (/^Numpad[0-9]$/.test(code)) {
    return `Num ${code.slice(6)}`;
  }
  const labels: Readonly<Record<string, string>> = {
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Space: 'Space',
    ArrowUp: '↑',
    ArrowRight: '→',
    ArrowDown: '↓',
    ArrowLeft: '←',
  };
  return labels[code] ?? code;
}
