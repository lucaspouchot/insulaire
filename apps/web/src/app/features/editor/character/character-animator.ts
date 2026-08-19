/**
 * The animation editor: the timeline, the playback controls and the transform
 * of one node at one frame.
 *
 * It edits the **animations** of the character definition the page holds, and
 * nothing else. What it produces is a whole new definition, emitted through
 * {@link CharacterAnimator.changed} — the same copy-per-edit the page already
 * applies to every other change, so undoing, saving and validating are the
 * page's job here exactly as they are for a layer or a parameter.
 *
 * It draws nothing. The preview belongs to the page, which resolves the
 * definition through the Rust engine at the moment this component names, so an
 * author watches the *runtime's* answer rather than a mock-up of one
 * (`docs/adr/ADR-0031-characters-animate-by-hierarchy-and-offsets.md`, §18 of
 * `docs/implementing-character-animator.md`).
 *
 * The distinction the interface has to keep visible is **local against
 * global**: the numbers an author types are what this node does *on top of*
 * what it inherits, and the number beside them is what the hierarchy made of
 * that. They are different questions and they are shown as different things.
 */

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import {
  Animation,
  AnimationTrack,
  CharacterDefinition,
  CharacterLayer,
  Interpolation,
  Keyframe,
  PixelOffset,
  ResolvedCharacter,
  blankAnimation,
  clampDuration,
  clampFrames,
  freeId,
  heldOffset,
  keyframeAt,
  MAX_ANIMATION_FRAMES,
} from './character-editor.types';
import { TranslatePipe } from '../../../i18n/translate.pipe';

/** The speeds the playback picker offers, as a multiple of real time. */
const PLAYBACK_SPEEDS: readonly number[] = [0.25, 0.5, 1, 2];

/** One cell of the timeline: a node, a frame, and what is written there. */
interface TimelineCell {
  readonly frame: number;
  /** `true` when this track writes a keyframe at exactly this frame. */
  readonly key: boolean;
  /** `true` when the track holds a value here because of an earlier keyframe. */
  readonly held: boolean;
}

/** One row of the timeline: a node and its frames. */
interface TimelineRow {
  readonly node: string;
  /** `true` when the node has a track at all — an empty row is still shown. */
  readonly tracked: boolean;
  /** How many parents it has, for the indent that shows the hierarchy. */
  readonly depth: number;
  readonly cells: readonly TimelineCell[];
}

@Component({
  selector: 'app-character-animator',
  imports: [TranslatePipe],
  templateUrl: './character-animator.html',
  styleUrl: './character-animator.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CharacterAnimator {
  /** The definition being edited. Never mutated: edits come back as a copy. */
  readonly document = input.required<CharacterDefinition>();
  /** The layer rows, in hierarchy order, so the timeline reads as the tree. */
  readonly rows = input<readonly { layer: CharacterLayer; depth: number }[]>([]);
  /** Id of the animation open in the timeline. */
  readonly animationId = input<string | null>(null);
  /** The frame the preview is showing. */
  readonly frame = input(0);
  /** Id of the layer whose transform is being edited. */
  readonly node = input<string | null>(null);
  readonly playing = input(false);
  readonly speed = input(1);
  /** What the engine made of it, for the *global* readout. */
  readonly resolved = input<ResolvedCharacter | null>(null);
  readonly writable = input(true);

  /** A whole new definition, for the page to apply. */
  readonly changed = output<CharacterDefinition>();
  readonly animationPicked = output<string | null>();
  readonly framePicked = output<number>();
  readonly nodePicked = output<string>();
  readonly playToggled = output<void>();
  readonly speedPicked = output<number>();

  protected readonly speeds = PLAYBACK_SPEEDS;
  protected readonly maxFrames = MAX_ANIMATION_FRAMES;

  protected readonly animations = computed<readonly Animation[]>(
    () => this.document().animations ?? [],
  );

  protected readonly animation = computed<Animation | null>(() => {
    const id = this.animationId();
    return this.animations().find((animation) => animation.id === id) ?? null;
  });

  /** `0 … frames - 1`, for the timeline's header and every row. */
  protected readonly frames = computed<readonly number[]>(() => {
    const count = this.animation()?.frames ?? 0;
    return Array.from({ length: count }, (_value, index) => index);
  });

  /**
   * The timeline: one row per layer, in the order the hierarchy reads.
   *
   * Every layer gets a row, not only the ones that move. A node with no track
   * is exactly the thing an author is about to give one, and hiding it would
   * mean adding a track before being able to see where it goes.
   */
  protected readonly timeline = computed<readonly TimelineRow[]>(() => {
    const animation = this.animation();
    if (animation === null) {
      return [];
    }
    const frames = this.frames();
    return this.rows().map(({ layer, depth }) => {
      const track = trackOf(animation, layer.id);
      const written = new Set((track?.keyframes ?? []).map((keyframe) => keyframe.frame));
      const first = Math.min(...(written.size > 0 ? [...written] : [Number.POSITIVE_INFINITY]));
      return {
        node: layer.id,
        tracked: track !== undefined,
        depth,
        cells: frames.map((frame) => ({
          frame,
          key: written.has(frame),
          // Held, not written: the track is in force here because of an
          // earlier keyframe, which is what a step animation *is*.
          held: written.size > 0 && frame >= first && !written.has(frame),
        })),
      };
    });
  });

  /** The track driving the selected node in the open animation. */
  protected readonly track = computed<AnimationTrack | undefined>(() => {
    const animation = this.animation();
    const node = this.node();
    return animation === null || node === null ? undefined : trackOf(animation, node);
  });

  /** The keyframe at the selected frame, if the selected node writes one. */
  protected readonly keyframe = computed<Keyframe | undefined>(() =>
    keyframeAt(this.track(), this.frame()),
  );

  /**
   * The **local** offset the form shows: what this node does on its own.
   *
   * The keyframe's value when there is one, and otherwise what a new keyframe
   * here would start from — so typing into the field never makes the node jump
   * before it moves.
   */
  protected readonly local = computed<PixelOffset>(
    () => this.keyframe()?.offset ?? heldOffset(this.track(), this.frame()),
  );

  /**
   * The **global** offset: what the hierarchy made of that.
   *
   * Read off the resolved character rather than recomputed, because the engine
   * is what composed it, and a preview that agreed with a second calculation
   * instead of with the engine would be a preview that lies.
   */
  protected readonly global = computed<PixelOffset | null>(() => {
    const node = this.node();
    const drawn = this.resolved()?.layers.find((layer) => layer.layer === node);
    return drawn?.offset ?? null;
  });

  /** `true` when the node inherits movement it did not ask for. */
  protected readonly inherited = computed<PixelOffset | null>(() => {
    const global = this.global();
    if (global === null) {
      return null;
    }
    const local = this.local();
    const difference: PixelOffset = [global[0] - local[0], global[1] - local[1]];
    return difference[0] === 0 && difference[1] === 0 ? null : difference;
  });

  // ------------------------------------------------------------- animations

  protected addAnimation(): void {
    const id = freeId(
      'idle',
      this.animations().map((animation) => animation.id),
    );
    this.edit((draft) => {
      draft.animations = [...(draft.animations ?? []), blankAnimation(id)];
    });
    this.animationPicked.emit(id);
    this.framePicked.emit(0);
  }

  protected removeAnimation(): void {
    const id = this.animationId();
    if (id === null) {
      return;
    }
    this.edit((draft) => {
      draft.animations = (draft.animations ?? []).filter((animation) => animation.id !== id);
    });
    this.animationPicked.emit(this.animations().find((animation) => animation.id !== id)?.id ?? null);
  }

  protected pick(id: string): void {
    this.animationPicked.emit(id);
    this.framePicked.emit(0);
  }

  protected setAnimationId(raw: string): void {
    const id = raw.trim();
    const current = this.animationId();
    if (id.length === 0 || current === null) {
      return;
    }
    this.patchAnimation((animation) => {
      animation.id = id;
    });
    this.animationPicked.emit(id);
  }

  protected setName(name: string): void {
    this.patchAnimation((animation) => {
      animation.name = name;
    });
  }

  protected setLooping(looping: boolean): void {
    this.patchAnimation((animation) => {
      animation.looping = looping;
    });
  }

  /**
   * Changes how long the animation is.
   *
   * Shortening it leaves keyframes past the end, which validation reports
   * (`character.keyframeOutOfRange`) rather than this silently deleting an
   * author's work. Lengthening it costs nothing: the tracks simply hold.
   */
  protected setFrames(raw: string): void {
    const frames = clampFrames(Number.parseFloat(raw));
    this.patchAnimation((animation) => {
      animation.frames = frames;
    });
    if (this.frame() >= frames) {
      this.framePicked.emit(frames - 1);
    }
  }

  protected setFrameDuration(raw: string): void {
    const duration = clampDuration(Number.parseFloat(raw));
    this.patchAnimation((animation) => {
      animation.frameDurationMs = duration;
    });
  }

  // --------------------------------------------------------------- timeline

  /** Selecting a cell is selecting both a node and a moment. */
  protected select(node: string, frame: number): void {
    this.nodePicked.emit(node);
    this.framePicked.emit(frame);
  }

  protected step(delta: number): void {
    const frames = this.animation()?.frames ?? 0;
    if (frames === 0) {
      return;
    }
    // Wraps in both directions, whether or not the animation loops: stepping
    // off the end of a timeline should land on the other end of it, and
    // whether the *game* loops is a different question.
    this.framePicked.emit((this.frame() + delta + frames) % frames);
  }

  protected setSpeed(raw: string): void {
    const speed = Number.parseFloat(raw);
    if (Number.isFinite(speed) && speed > 0) {
      this.speedPicked.emit(speed);
    }
  }

  // -------------------------------------------------------------- keyframes

  /** Sets one component of the selected node's local offset at this frame. */
  protected setOffset(axis: 0 | 1, raw: string): void {
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) {
      return;
    }
    const offset: PixelOffset = [...this.local()];
    // Rounded on the way in, for the reason every other coordinate here is:
    // half a pixel of offset is a seam between two layers drawn to touch.
    offset[axis] = Math.round(parsed);
    this.writeKeyframe(offset);
  }

  protected setInterpolation(interpolation: string): void {
    const node = this.node();
    const frame = this.frame();
    if (node === null) {
      return;
    }
    this.patchAnimation((animation) => {
      const keyframe = keyframeAt(trackOf(animation, node), frame);
      if (keyframe !== undefined) {
        keyframe.interpolation = interpolation as Interpolation;
      }
    });
  }

  /** Writes the value the node currently holds as a keyframe of its own. */
  protected addKeyframe(): void {
    this.writeKeyframe(this.local());
  }

  protected removeKeyframe(): void {
    const node = this.node();
    const frame = this.frame();
    if (node === null) {
      return;
    }
    this.patchAnimation((animation) => {
      const track = trackOf(animation, node);
      if (track === undefined) {
        return;
      }
      track.keyframes = track.keyframes.filter((keyframe) => keyframe.frame !== frame);
      // A track with nothing in it is noise in the file and a warning in the
      // report, so removing the last keyframe removes the track.
      if (track.keyframes.length === 0) {
        animation.tracks = (animation.tracks ?? []).filter(
          (candidate) => candidate.node !== node,
        );
      }
    });
  }

  /** Drops everything the selected node does across the whole animation. */
  protected removeTrack(): void {
    const node = this.node();
    if (node === null) {
      return;
    }
    this.patchAnimation((animation) => {
      animation.tracks = (animation.tracks ?? []).filter((track) => track.node !== node);
    });
  }

  /**
   * Writes this offset as the selected node's keyframe at the selected frame,
   * creating the track if the node did not move before.
   */
  private writeKeyframe(offset: PixelOffset): void {
    const node = this.node();
    const frame = this.frame();
    if (node === null) {
      return;
    }
    this.patchAnimation((animation) => {
      const tracks = animation.tracks ?? [];
      let track = tracks.find((candidate) => candidate.node === node);
      if (track === undefined) {
        track = { node, keyframes: [] };
        tracks.push(track);
        animation.tracks = tracks;
      }
      const existing = track.keyframes.find((keyframe) => keyframe.frame === frame);
      if (existing === undefined) {
        track.keyframes.push({ frame, offset });
        // Kept in frame order, so the file reads as a sequence rather than as
        // the order an author happened to click in.
        track.keyframes.sort((left, right) => left.frame - right.frame);
      } else {
        existing.offset = offset;
      }
    });
  }

  // --------------------------------------------------------------- plumbing

  /** Edits the open animation in a copy of the definition. */
  private patchAnimation(mutate: (animation: Animation) => void): void {
    const id = this.animationId();
    this.edit((draft) => {
      const animation = (draft.animations ?? []).find((candidate) => candidate.id === id);
      if (animation !== undefined) {
        mutate(animation);
      }
    });
  }

  /** A copy per edit: the page owns the document, this only proposes one. */
  private edit(mutate: (draft: CharacterDefinition) => void): void {
    const draft = structuredClone(this.document()) as CharacterDefinition;
    mutate(draft);
    this.changed.emit(draft);
  }
}

/** The track driving this node, if the animation has one. */
function trackOf(animation: Animation, node: string): AnimationTrack | undefined {
  return (animation.tracks ?? []).find((track) => track.node === node);
}
