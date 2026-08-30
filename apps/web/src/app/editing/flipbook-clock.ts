/**
 * Play, pause and scrub, for a flipbook being edited.
 *
 * The decoration editor and the object editor each carried their own copy of
 * this: a `requestAnimationFrame` handle, a `lastTick`, a `timeMs` that
 * accumulates deltas, and a frame index derived from it. The two copies drifted
 * on when to give up — one stopped for a flipbook of fewer than two frames, the
 * other only when the animation went away.
 *
 * The arithmetic is `content/flipbook.ts`'s, which a running game shares; only
 * the *clock* is editor-only, because a running game is driven by the tick and
 * not by a play button (`docs/adr/ADR-0003-tick-simulation.md`).
 *
 * The ticker arrives through the constructor, so a spec advances time by hand
 * instead of waiting for frames.
 */

import { computed, signal } from '@angular/core';

import { Flipbook, frameAt, frameDurationOf } from '../../content/flipbook';

/** Whatever schedules the next frame and says what time it is. */
export interface Ticker {
  /** Schedules `step`, which is called with a monotonic time in milliseconds. */
  request(step: (now: number) => void): number;
  cancel(handle: number): void;
  /** The same clock `step` is called with. */
  now(): number;
}

/** The browser's own, which is what every screen uses. */
export const animationFrames: Ticker = {
  request: (step) => requestAnimationFrame(step),
  cancel: (handle) => cancelAnimationFrame(handle),
  now: () => performance.now(),
};

/** Below this there is nothing to play: one drawing held is a still picture. */
const PLAYABLE_FRAMES = 2;

export class FlipbookClock {
  private readonly playingSignal = signal(false);
  private readonly timeMsSignal = signal(0);
  private handle: number | null = null;
  private lastTick = 0;

  /**
   * @param flipbook what is being played, read afresh every tick — an author
   *   editing frames while it runs changes what it is playing
   * @param onTick called after each advance, for a host that has to re-resolve
   *   its preview at the new time
   */
  constructor(
    private readonly flipbook: () => Flipbook | null,
    private readonly onTick: () => void = () => {},
    private readonly ticker: Ticker = animationFrames,
  ) {}

  /** Whether the flipbook is running. */
  readonly playing = this.playingSignal.asReadonly();

  /** How far into the flipbook the clock is, in milliseconds. */
  readonly timeMs = this.timeMsSignal.asReadonly();

  /** Which frame that is. */
  readonly frame = computed(() => {
    const flipbook = this.flipbook();
    return flipbook === null ? 0 : frameAt(flipbook, this.timeMsSignal());
  });

  /** Runs it, or stops it where it is. */
  togglePlay(): void {
    if (this.playingSignal()) {
      this.stop();
      return;
    }
    if (!this.playable()) {
      return;
    }
    this.playingSignal.set(true);
    this.lastTick = this.ticker.now();
    this.schedule();
  }

  /**
   * Stops, and parks the clock at the start of `index`.
   *
   * What clicking a frame in the timeline means. Playback resuming from here
   * starts where the author left it rather than where it was paused.
   */
  seek(index: number): void {
    this.stop();
    this.timeMsSignal.set(Math.max(0, index) * frameDurationOf(this.flipbook()));
  }

  /** Stops where it is. Idempotent, and what a closing screen calls. */
  stop(): void {
    this.playingSignal.set(false);
    if (this.handle !== null) {
      this.ticker.cancel(this.handle);
      this.handle = null;
    }
  }

  private playable(): boolean {
    return (this.flipbook()?.frames?.length ?? 0) >= PLAYABLE_FRAMES;
  }

  private schedule(): void {
    this.handle = this.ticker.request((now) => {
      this.handle = null;
      if (!this.playingSignal() || !this.playable()) {
        this.stop();
        return;
      }
      this.timeMsSignal.update((time) => time + (now - this.lastTick));
      this.lastTick = now;
      this.onTick();
      this.schedule();
    });
  }
}
