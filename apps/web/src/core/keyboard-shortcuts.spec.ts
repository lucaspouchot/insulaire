import { describe, expect, it } from 'vitest';

import {
  capturedKeyboardCode,
  fallbackKeyboardLabel,
  ignoresGameplayShortcut,
  isKeyboardCode,
  routeUndoRedo,
  undoRedoIntent,
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

  it('reads an editor chord by its printed letter, not by its position', () => {
    // The other half of ADR-0032: an author on AZERTY presses the key marked Z
    // to undo, and the browser reports `{ code: 'KeyW', key: 'z' }` for it.
    const azerty = new KeyboardEvent('keydown', { code: 'KeyW', key: 'z', ctrlKey: true });

    expect(undoRedoIntent(azerty)).toBe('undo');
  });

  it('knows both spellings of redo, and both modifiers', () => {
    const chord = (init: KeyboardEventInit): KeyboardEvent =>
      new KeyboardEvent('keydown', { code: 'KeyZ', ...init });

    expect(undoRedoIntent(chord({ key: 'z', ctrlKey: true, shiftKey: true }))).toBe('redo');
    expect(undoRedoIntent(chord({ key: 'Z', metaKey: true, shiftKey: true }))).toBe('redo');
    expect(undoRedoIntent(chord({ key: 'y', ctrlKey: true }))).toBe('redo');
    expect(undoRedoIntent(chord({ key: 'z', metaKey: true }))).toBe('undo');
  });

  it('is nothing without a modifier, and nothing for another letter', () => {
    expect(undoRedoIntent(new KeyboardEvent('keydown', { key: 'z' }))).toBeNull();
    expect(undoRedoIntent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }))).toBeNull();
  });

  it('leaves an undo typed into a form to the form', () => {
    const input = document.createElement('input');
    let intent: 'undo' | 'redo' | null = 'undo';
    input.addEventListener('keydown', (event) => {
      intent = undoRedoIntent(event);
    });

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));

    expect(intent).toBeNull();
  });

  it('routes a chord to the surface holding the history, and prevents the default', () => {
    const acted: string[] = [];
    const target = { undo: () => acted.push('undo'), redo: () => acted.push('redo') };
    const chord = (init: KeyboardEventInit): KeyboardEvent =>
      new KeyboardEvent('keydown', { code: 'KeyZ', cancelable: true, ...init });

    const undone = chord({ key: 'z', ctrlKey: true });
    expect(routeUndoRedo(undone, target)).toBe(true);
    expect(undone.defaultPrevented).toBe(true);

    routeUndoRedo(chord({ key: 'z', ctrlKey: true, shiftKey: true }), target);

    expect(acted).toEqual(['undo', 'redo']);
  });

  it('leaves a keystroke it does not claim entirely alone', () => {
    const target = {
      undo: () => expect.unreachable('undid a key it should not have claimed'),
      redo: () => expect.unreachable('redid a key it should not have claimed'),
    };
    const plain = new KeyboardEvent('keydown', { key: 'z', cancelable: true });

    expect(routeUndoRedo(plain, target)).toBe(false);
    expect(plain.defaultPrevented).toBe(false);
  });

  it('formats common codes when the layout map is unavailable', () => {
    expect(fallbackKeyboardLabel('KeyW')).toBe('W');
    expect(fallbackKeyboardLabel('Digit1')).toBe('1');
    expect(fallbackKeyboardLabel('ArrowLeft')).toBe('←');
  });
});
