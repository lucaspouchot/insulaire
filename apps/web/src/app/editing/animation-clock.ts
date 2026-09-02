/**
 * Play, pause, scrub and set the speed of a skeletal animation being edited.
 *
 * The character editor hand-rolled this a third time, past the two copies
 * `FlipbookClock` was extracted to kill: a `requestAnimationFrame` handle, a
 * `lastTick`, and a `timeMs` that accumulates deltas — here multiplied by a
 * speed the author sets, and parked one millisecond before the end of an
 * animation that does not loop.
 *
 * It is not a `FlipbookClock`. A flipbook is a list of images played at a fixed
 * rate, and its clock yields a frame *index*; a skeletal animation is a frame
 * *count* with tracks over it, played at the author's speed, that stops itself
 * when a non-looping run is over
 * (`docs/adr/ADR-0025-characters-animate-by-hierarchy-and-offsets.md`). The two
 * share only the injected `Ticker` — so a spec advances time by hand instead of
 * waiting for frames — and nothing else was worth a base class.
 */

import { signal } from '@angular/core';

import { Ticker, animationFrames } from './flipbook-clock';

/** How long the played animation runs, and whether it repeats. */
export interface AnimationBounds {
  /** The animation's whole length, in milliseconds. */
  readonly durationMs: number;
  /** Whether it restarts at the end instead of stopping there. */
  readonly loop: boolean;
}

export class AnimationClock {
  private readonly playingSignal = signal(false);
  private readonly timeMsSignal = signal(0);
  private readonly speedSignal = signal(1);
  private handle: number | null = null;
  private lastTick = 0;

  /**
   * @param bounds the played animation's length and loop flag, read afresh
   *   every tick — switching the open animation mid-play changes where the
   *   clock stops without a fresh `togglePlay()`; `null` is a rest pose, with
   *   nothing to run
   * @param onTick called after each advance, for a host that re-resolves its
   *   preview at the new time
   */
  constructor(
    private readonly bounds: () => AnimationBounds | null,
    private readonly onTick: () => void = () => {},
    private readonly ticker: Ticker = animationFrames,
  ) {}

  /** Whether the animation is running. */
  readonly playing = this.playingSignal.asReadonly();

  /** How far into the animation the clock is, in milliseconds. */
  readonly timeMs = this.timeMsSignal.asReadonly();

  /** Playback rate, as a multiple of real time. */
  readonly speed = this.speedSignal.asReadonly();

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

  /** Sets the playback rate; it takes effect on the next advance. */
  setSpeed(speed: number): void {
    this.speedSignal.set(speed);
  }

  /**
   * Stops, and parks the clock at `ms` — never before the start.
   *
   * What clicking a frame in the timeline means, once the caller has turned
   * that frame into a moment.
   */
  scrubTo(ms: number): void {
    this.stop();
    this.timeMsSignal.set(Math.max(0, ms));
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
    return (this.bounds()?.durationMs ?? 0) > 0;
  }

  private schedule(): void {
    this.handle = this.ticker.request((now) => {
      this.handle = null;
      if (!this.playingSignal()) {
        return;
      }
      const bounds = this.bounds();
      if (bounds === null || bounds.durationMs <= 0) {
        this.stop();
        return;
      }

      this.timeMsSignal.update((time) => time + (now - this.lastTick) * this.speedSignal());
      this.lastTick = now;

      // A run that does not loop is over when it is over; leaving the loop
      // going would burn a frame a tick redrawing the same picture.
      if (!bounds.loop && this.timeMsSignal() >= bounds.durationMs) {
        this.timeMsSignal.set(Math.max(0, bounds.durationMs - 1));
        this.stop();
        this.onTick();
        return;
      }

      this.onTick();
      this.schedule();
    });
  }
}
