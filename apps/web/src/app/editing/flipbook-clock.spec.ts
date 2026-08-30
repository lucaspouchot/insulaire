import { describe, expect, it } from 'vitest';

import { Flipbook } from '../../content/flipbook';
import { FlipbookClock, Ticker } from './flipbook-clock';

/** A ticker the test drives by hand, so playback has no real time in it. */
function handCranked(): Ticker & { advance(ms: number): void; readonly scheduled: boolean } {
  let step: ((now: number) => void) | null = null;
  let time = 1_000;
  let next = 1;

  return {
    request(callback: (now: number) => void): number {
      step = callback;
      return next++;
    },
    cancel(): void {
      step = null;
    },
    now(): number {
      return time;
    },
    advance(ms: number): void {
      time += ms;
      const due = step;
      step = null;
      due?.(time);
    },
    get scheduled(): boolean {
      return step !== null;
    },
  };
}

const FLAME: Flipbook = {
  frames: ['a.png', 'b.png', 'c.png', 'd.png'],
  frameDurationMs: 100,
  looping: true,
};

describe('FlipbookClock', () => {
  it('starts stopped at the beginning', () => {
    const clock = new FlipbookClock(
      () => FLAME,
      () => {},
      handCranked(),
    );

    expect(clock.playing()).toBe(false);
    expect(clock.timeMs()).toBe(0);
    expect(clock.frame()).toBe(0);
  });

  it('walks the frames while it plays', () => {
    const ticker = handCranked();
    const clock = new FlipbookClock(
      () => FLAME,
      () => {},
      ticker,
    );

    clock.togglePlay();
    expect(clock.playing()).toBe(true);

    ticker.advance(100);
    expect(clock.frame()).toBe(1);

    ticker.advance(250);
    expect(clock.timeMs()).toBe(350);
    expect(clock.frame()).toBe(3);
  });

  it('tells its host on every tick, so the preview keeps up', () => {
    const ticker = handCranked();
    let ticks = 0;
    const clock = new FlipbookClock(
      () => FLAME,
      () => (ticks += 1),
      ticker,
    );

    clock.togglePlay();
    ticker.advance(16);
    ticker.advance(16);

    expect(ticks).toBe(2);
  });

  it('stops where it is, and starts again from there', () => {
    const ticker = handCranked();
    const clock = new FlipbookClock(
      () => FLAME,
      () => {},
      ticker,
    );

    clock.togglePlay();
    ticker.advance(250);
    clock.togglePlay();

    expect(clock.playing()).toBe(false);
    expect(ticker.scheduled).toBe(false);
    expect(clock.timeMs()).toBe(250);

    clock.togglePlay();
    ticker.advance(50);

    expect(clock.timeMs()).toBe(300);
  });

  it('does not count the time it was paused for', () => {
    const ticker = handCranked();
    const clock = new FlipbookClock(
      () => FLAME,
      () => {},
      ticker,
    );

    clock.togglePlay();
    ticker.advance(100);
    clock.togglePlay();
    ticker.advance(10_000);
    clock.togglePlay();
    ticker.advance(100);

    expect(clock.timeMs()).toBe(200);
  });

  it('refuses to play a flipbook with nothing to flip through', () => {
    const ticker = handCranked();
    const clock = new FlipbookClock(
      () => ({ frames: ['only.png'] }),
      () => {},
      ticker,
    );

    clock.togglePlay();

    expect(clock.playing()).toBe(false);
    expect(ticker.scheduled).toBe(false);
  });

  it('gives up when the flipbook it was playing goes away', () => {
    const ticker = handCranked();
    let open: Flipbook | null = FLAME;
    const clock = new FlipbookClock(
      () => open,
      () => {},
      ticker,
    );

    clock.togglePlay();
    ticker.advance(100);
    open = null;
    ticker.advance(100);

    expect(clock.playing()).toBe(false);
    expect(ticker.scheduled).toBe(false);
  });

  it('parks on the frame a scrub asked for, and stops', () => {
    const ticker = handCranked();
    const clock = new FlipbookClock(
      () => FLAME,
      () => {},
      ticker,
    );

    clock.togglePlay();
    clock.seek(2);

    expect(clock.playing()).toBe(false);
    expect(clock.timeMs()).toBe(200);
    expect(clock.frame()).toBe(2);
  });

  it('never parks before the start', () => {
    const clock = new FlipbookClock(
      () => FLAME,
      () => {},
      handCranked(),
    );

    clock.seek(-3);

    expect(clock.timeMs()).toBe(0);
  });

  it('lets go of its ticker when the screen closes', () => {
    const ticker = handCranked();
    const clock = new FlipbookClock(
      () => FLAME,
      () => {},
      ticker,
    );

    clock.togglePlay();
    clock.stop();

    expect(ticker.scheduled).toBe(false);
    expect(clock.playing()).toBe(false);
  });
});
