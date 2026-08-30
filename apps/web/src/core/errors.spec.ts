import { describe, expect, it } from 'vitest';

import { describeError } from './errors';

describe('describeError', () => {
  it('reads the message off an Error rather than stringifying it', () => {
    expect(describeError(new Error('the manifest names no tile set'))).toBe(
      'the manifest names no tile set',
    );
  });

  it('keeps the subclass message, which is what a DOMException carries', () => {
    expect(describeError(new TypeError('failed to fetch'))).toBe('failed to fetch');
  });

  it('falls back to text for the things a promise may reject with instead', () => {
    expect(describeError('permission denied')).toBe('permission denied');
    expect(describeError(404)).toBe('404');
    expect(describeError(null)).toBe('null');
    expect(describeError(undefined)).toBe('undefined');
  });
});
