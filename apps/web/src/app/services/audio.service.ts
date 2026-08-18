/**
 * Music and sound, and the browser rule that shapes both.
 *
 * A page may not make noise before the visitor has interacted with it: every
 * modern browser refuses `play()` until a real gesture has happened, and a
 * refused promise is the *normal* first outcome, not an error. So this service
 * never assumes it started — it remembers what it was asked to play and starts
 * it at the first gesture, which on the title screen is the click or key that
 * skips the splash (`docs/adr/ADR-0024-authored-title-screen.md`).
 *
 * Volumes come from the settings and are applied to whatever is already
 * playing, so a slider moves the music under the player's hand.
 */

import { Injectable, signal } from '@angular/core';

/** A track the title screen or a scene asked for. */
export interface MusicRequest {
  /** Absolute URL of the audio file. */
  readonly url: string;
  readonly loop: boolean;
  /** Track volume relative to the music setting, `0..=1`. */
  readonly gain: number;
  readonly fadeInMs: number;
}

/** How often the fade-in steps, in milliseconds. */
const FADE_STEP_MS = 50;

@Injectable({ providedIn: 'root' })
export class AudioService {
  /** Master volume, `0..=1`. */
  readonly master = signal(1);
  /** Music volume, `0..=1`, multiplied by the master and the track's own gain. */
  readonly music = signal(0.7);
  /** Sound effects volume. Nothing uses it yet; settings already set it. */
  readonly effects = signal(0.8);

  /** `true` once a gesture has unblocked playback. */
  readonly unlocked = signal(false);

  private element: HTMLAudioElement | null = null;
  private request: MusicRequest | null = null;
  private fade: ReturnType<typeof setInterval> | null = null;

  /**
   * Plays `request`, replacing whatever was playing.
   *
   * Returns immediately; if the browser refuses, the track is remembered and
   * {@link unlock} starts it.
   */
  playMusic(request: MusicRequest): void {
    if (this.request?.url === request.url && this.element !== null) {
      // Same track already going: keep it, so navigating back to the title
      // screen does not restart the music mid-phrase.
      this.request = request;
      this.applyVolume();
      return;
    }

    this.stopMusic();
    this.request = request;

    const element = new Audio(request.url);
    element.loop = request.loop;
    element.volume = request.fadeInMs > 0 ? 0 : this.volumeFor(request);
    this.element = element;

    void element.play().then(
      () => {
        this.unlocked.set(true);
        this.startFade();
      },
      () => {
        // Autoplay refused; `unlock()` will try again after a gesture.
      },
    );
  }

  /**
   * Called on the first user gesture: starts anything that was refused.
   *
   * Safe to call on every click — it does nothing once playback is running.
   */
  unlock(): void {
    if (this.element === null || !this.element.paused) {
      this.unlocked.set(true);
      return;
    }
    void this.element.play().then(
      () => {
        this.unlocked.set(true);
        this.startFade();
      },
      () => undefined,
    );
  }

  /** Stops the music and forgets it. */
  stopMusic(): void {
    this.clearFade();
    if (this.element !== null) {
      this.element.pause();
      this.element.src = '';
      this.element = null;
    }
    this.request = null;
  }

  /** Applies the current volumes to whatever is playing. */
  applyVolume(): void {
    if (this.element !== null && this.fade === null && this.request !== null) {
      this.element.volume = this.volumeFor(this.request);
    }
  }

  /** Master × music × the track's own gain, clamped. */
  private volumeFor(request: MusicRequest): number {
    return clamp(this.master() * this.music() * request.gain);
  }

  private startFade(): void {
    this.clearFade();
    const element = this.element;
    const request = this.request;
    if (element === null || request === null || request.fadeInMs <= 0) {
      this.applyVolume();
      return;
    }

    const steps = Math.max(1, Math.round(request.fadeInMs / FADE_STEP_MS));
    let step = 0;
    this.fade = setInterval(() => {
      step += 1;
      const target = this.volumeFor(request);
      element.volume = clamp((target * step) / steps);
      if (step >= steps) {
        this.clearFade();
      }
    }, FADE_STEP_MS);
  }

  private clearFade(): void {
    if (this.fade !== null) {
      clearInterval(this.fade);
      this.fade = null;
    }
  }
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}
