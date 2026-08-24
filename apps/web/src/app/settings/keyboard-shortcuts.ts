/**
 * Browser-keyboard helpers shared by shortcut capture and gameplay.
 *
 * A shortcut stores `KeyboardEvent.code`, the physical position. `key` is only
 * a label: on AZERTY the event `{ code: 'KeyW', key: 'z' }` still means the
 * north-west position (`docs/adr/ADR-0045-shortcuts-use-physical-keys.md`).
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
