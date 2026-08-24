import { describe, expect, it } from 'vitest';

import {
  capturedKeyboardCode,
  fallbackKeyboardLabel,
  ignoresGameplayShortcut,
  isKeyboardCode,
} from './keyboard-shortcuts';

describe('physical keyboard shortcuts', () => {
  it('keeps the physical code when an AZERTY event prints another letter', () => {
    const event = new KeyboardEvent('keydown', { code: 'KeyW', key: 'z' });

    expect(capturedKeyboardCode(event)).toBe('KeyW');
  });

  it('rejects chords, modifier-only keys and unidentified keys', () => {
    expect(
      capturedKeyboardCode(new KeyboardEvent('keydown', { code: 'KeyW', ctrlKey: true })),
    ).toBeNull();
    expect(
      capturedKeyboardCode(new KeyboardEvent('keydown', { code: 'ShiftLeft', shiftKey: true })),
    ).toBeNull();
    expect(isKeyboardCode('Unidentified')).toBe(false);
    expect(isKeyboardCode('Key W')).toBe(false);
  });

  it('leaves keys typed into a form control alone', () => {
    const input = document.createElement('input');
    let ignored = false;
    input.addEventListener('keydown', (event) => {
      ignored = ignoresGameplayShortcut(event);
    });

    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'z', bubbles: true }));

    expect(ignored).toBe(true);
  });

  it('formats common codes when the layout map is unavailable', () => {
    expect(fallbackKeyboardLabel('KeyW')).toBe('W');
    expect(fallbackKeyboardLabel('Digit1')).toBe('1');
    expect(fallbackKeyboardLabel('ArrowLeft')).toBe('←');
  });
});
