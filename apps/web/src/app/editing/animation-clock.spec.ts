import { describe, expect, it } from 'vitest';

import { AnimationBounds, AnimationClock } from './animation-clock';
import { Ticker } from './flipbook-clock';

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

const WALK: AnimationBounds = { durationMs: 400, loop: true };
const NOD: AnimationBounds = { durationMs: 300, loop: false };

describe('AnimationClock', () => {
  it('starts paused at the beginning, at real-time speed', () => {
    const clock = new AnimationClock(
      () => WALK,
      () => {},
      handCranked(),
    );

    expect(clock.playing()).toBe(false);
    expect(clock.timeMs()).toBe(0);
    expect(clock.speed()).toBe(1);
  });

  it('accumulates elapsed time while it plays', () => {
    const ticker = handCranked();
    const clock = new AnimationClock(
      () => WALK,
      () => {},
      ticker,
    );

    clock.togglePlay();
    expect(clock.playing()).toBe(true);

    ticker.advance(100);
    expect(clock.timeMs()).toBe(100);

    ticker.advance(150);
    expect(clock.timeMs()).toBe(250);
  });

  it('scales the accumulation by the author-set speed', () => {
    const ticker = handCranked();
    const clock = new AnimationClock(
      () => WALK,
      () => {},
      ticker,
    );

    clock.setSpeed(2);
    clock.togglePlay();
    ticker.advance(100);

    expect(clock.timeMs()).toBe(200);
  });

  it('does not count the time it was paused for', () => {
    const ticker = handCranked();
    const clock = new AnimationClock(
      () => WALK,
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

  it('parks on the moment a scrub asked for, and stops', () => {
    const ticker = handCranked();
    const clock = new AnimationClock(
      () => WALK,
      () => {},
      ticker,
    );

    clock.togglePlay();
    clock.scrubTo(120);

    expect(clock.playing()).toBe(false);
    expect(ticker.scheduled).toBe(false);
    expect(clock.timeMs()).toBe(120);
  });

  it('never parks before the start', () => {
    const clock = new AnimationClock(
      () => WALK,
      () => {},
      handCranked(),
    );

    clock.scrubTo(-50);

    expect(clock.timeMs()).toBe(0);
  });

  it('stops one millisecond short of the end when the animation does not loop', () => {
    const ticker = handCranked();
    let reposed = 0;
    const clock = new AnimationClock(
      () => NOD,
      () => (reposed += 1),
      ticker,
    );

    clock.togglePlay();
    ticker.advance(200);
    ticker.advance(200);

    expect(clock.timeMs()).toBe(299);
    expect(clock.playing()).toBe(false);
    expect(ticker.scheduled).toBe(false);
    expect(reposed).toBe(2);
  });

  it('runs past the end when the animation loops', () => {
    const ticker = handCranked();
    const clock = new AnimationClock(
      () => WALK,
      () => {},
      ticker,
    );

    clock.togglePlay();
    ticker.advance(500);

    expect(clock.timeMs()).toBe(500);
    expect(clock.playing()).toBe(true);
    expect(ticker.scheduled).toBe(true);
  });

  it('stops at the new end when the bounds change mid-play', () => {
    const ticker = handCranked();
    let bounds: AnimationBounds = { durationMs: 1_000, loop: false };
    const clock = new AnimationClock(
      () => bounds,
      () => {},
      ticker,
    );

    clock.togglePlay();
    ticker.advance(200);
    bounds = { durationMs: 150, loop: false };
    ticker.advance(100);

    expect(clock.timeMs()).toBe(149);
    expect(clock.playing()).toBe(false);
  });

  it('gives up when the animation it was playing goes away', () => {
    const ticker = handCranked();
    let bounds: AnimationBounds | null = NOD;
    const clock = new AnimationClock(
      () => bounds,
      () => {},
      ticker,
    );

    clock.togglePlay();
    ticker.advance(100);
    bounds = null;
    ticker.advance(100);

    expect(clock.playing()).toBe(false);
    expect(ticker.scheduled).toBe(false);
  });

  it('refuses to play a rest pose, with nothing to run', () => {
    const ticker = handCranked();
    const clock = new AnimationClock(
      () => null,
      () => {},
      ticker,
    );

    clock.togglePlay();

    expect(clock.playing()).toBe(false);
    expect(ticker.scheduled).toBe(false);
  });

  it('tells its host on every advance, so the preview keeps up', () => {
    const ticker = handCranked();
    let reposed = 0;
    const clock = new AnimationClock(
      () => WALK,
      () => (reposed += 1),
      ticker,
    );

    clock.togglePlay();
    ticker.advance(16);
    ticker.advance(16);

    expect(reposed).toBe(2);
  });

  it('lets go of its ticker when the screen closes', () => {
    const ticker = handCranked();
    const clock = new AnimationClock(
      () => WALK,
      () => {},
      ticker,
    );

    clock.togglePlay();
    clock.stop();

    expect(ticker.scheduled).toBe(false);
    expect(clock.playing()).toBe(false);
  });
});
