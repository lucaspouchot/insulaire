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
 * (`docs/adr/ADR-0025-characters-animate-by-hierarchy-and-offsets.md`). A
 * preview with an evaluator of its own would be a second answer, and the one an
 * author trusted would be the wrong one.
 *
 * The distinction the interface has to keep visible is **local against
 * global**: the numbers an author types are what this node does *on top of*
 * what it inherits, and the number beside them is what the hierarchy made of
 * that. They are different questions and they are shown as different things.
 *
 * The second one it has to keep visible is **moving against redrawing**. A
 * track moves a node; a *pose* says what the character is drawn as, and it is
 * read by whichever layers have something to say about it rather than aimed at
 * one (`docs/adr/ADR-0025-characters-animate-by-hierarchy-and-offsets.md`). So the pose has its
 * own row at the top of the timeline, above every node, and its own editor —
 * because it belongs to the animation and not to a node.
 */

import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import {
  ANIMATION_ROLES,
  Animation,
  AnimationRole,
  AnimationTrack,
  CharacterDefinition,
  CharacterLayer,
  Interpolation,
  Keyframe,
  PixelOffset,
  PoseKey,
  ResolvedCharacter,
  SettingValue,
  blankAnimation,
  clampDuration,
  clampFrames,
  heldOffset,
  keyframeAt,
  heldPose,
  poseAt,
  poseValue,
  MAX_ANIMATION_FRAMES,
} from './character-editor.types';
import { TranslatePipe } from '../../../i18n/translate.pipe';
import { freeId } from '../../../editing/ids';

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

/** One cell of the pose row: what the animation sets at that frame. */
interface PoseCell {
  readonly frame: number;
  /** `true` when the animation sets a pose at exactly this frame. */
  readonly key: boolean;
  /** `true` when an earlier frame's pose is still in force here. */
  readonly held: boolean;
  /** What is in force, shortened to fit a cell. Empty when nothing is. */
  readonly label: string;
}

/** One editable line of a pose: a key and the value it holds. */
interface PoseRow {
  readonly key: string;
  readonly value: string;
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

  /**
   * Whether the transport and the timeline stay in view while the rest scrolls.
   *
   * On by default: an author reading a keyframe scrolls to the pose editor and
   * back constantly, and the grid is what they are reading against. Off is
   * there because a tall timeline pinned to the top of a short column is the
   * opposite of helpful (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
   */
  protected readonly pinned = signal(true);

  protected togglePinned(): void {
    this.pinned.update((on) => !on);
  }

  /** A whole new definition, for the page to apply. */
  readonly changed = output<CharacterDefinition>();
  readonly animationPicked = output<string | null>();
  readonly framePicked = output<number>();
  readonly nodePicked = output<string>();
  readonly playToggled = output<void>();
  readonly speedPicked = output<number>();

  protected readonly speeds = PLAYBACK_SPEEDS;
  protected readonly maxFrames = MAX_ANIMATION_FRAMES;
  protected readonly animationRoles = ANIMATION_ROLES;

  protected readonly animations = computed<readonly Animation[]>(
    () => this.document().animations ?? [],
  );

  protected readonly animation = computed<Animation | null>(() => {
    const id = this.animationId();
    return this.animations().find((animation) => animation.id === id) ?? null;
  });

  /** `true` when the open animation is another one seen the other way round. */
  protected readonly isMirror = computed(() => this.animation()?.mirrorOf != null);

  /**
   * The animation whose timing and tracks are actually being edited.
   *
   * A mirror has none of its own — it borrows its source's — so a mirror shows
   * no timeline at all rather than an editable copy of somebody else's.
   */
  protected readonly played = computed<Animation | null>(() => {
    const open = this.animation();
    if (open === null || !open.mirrorOf) {
      return open;
    }
    const source = this.animations().find((entry) => entry.id === open.mirrorOf);
    return source === undefined || source.mirrorOf ? null : source;
  });

  /** The animations a mirror may reflect: every real one but itself. */
  protected readonly mirrorSources = computed<readonly Animation[]>(() => {
    const open = this.animationId();
    return this.animations().filter((entry) => entry.id !== open && !entry.mirrorOf);
  });

  /** `0 … frames - 1`, for the timeline's header and every row. */
  protected readonly frames = computed<readonly number[]>(() => {
    const count = this.played()?.frames ?? 1;
    return Array.from({ length: count }, (_value, index) => index);
  });

  /**
   * Every key some variant of this character waits on, and the values it waits
   * for, so the pose editor can offer them instead of asking an author to
   * retype a string that has to match exactly.
   *
   * A pose is only ever felt through a `when`, so this list is precisely the
   * vocabulary a pose can usefully speak.
   */
  protected readonly conditionKeys = computed<readonly string[]>(() =>
    [
      ...new Set(
        this.rows().flatMap(({ layer }) =>
          (layer.variants ?? []).flatMap((variant) => Object.keys(variant.when ?? {})),
        ),
      ),
    ].sort(),
  );

  /** The values some variant waits for, across every key. */
  protected readonly conditionValues = computed<readonly string[]>(() =>
    [
      ...new Set(
        this.rows().flatMap(({ layer }) =>
          (layer.variants ?? []).flatMap((variant) =>
            Object.values(variant.when ?? {}).map((value) => String(value)),
          ),
        ),
      ),
    ].sort(),
  );

  /** The pose the animation holds for its whole length, as editable lines. */
  protected readonly animationPose = computed<readonly PoseRow[]>(() =>
    rowsOf(this.played()?.pose ?? {}),
  );

  /** The pose written at the selected frame, if the animation writes one. */
  protected readonly framePose = computed<readonly PoseRow[]>(() => {
    const key = poseAt(this.played(), this.frame());
    return key === undefined ? [] : rowsOf(withoutFrame(key));
  });

  /** `true` when the selected frame sets a pose of its own. */
  protected readonly hasFramePose = computed(
    () => poseAt(this.played(), this.frame()) !== undefined,
  );

  /**
   * The pose row of the timeline: what is in force at each frame.
   *
   * It sits above every node because it is not a node's — a pose is read by
   * whichever layers have something to say about it, which may be all of them
   * or none.
   */
  protected readonly poseRow = computed<readonly PoseCell[]>(() => {
    const animation = this.played();
    if (animation === null) {
      return [];
    }
    const written = new Set((animation.poses ?? []).map((key) => key.frame));
    return this.frames().map((frame) => {
      const held = heldPose(animation, frame);
      return {
        frame,
        key: written.has(frame),
        held: held !== undefined && !written.has(frame),
        label: Object.values(held === undefined ? {} : withoutFrame(held))
          .map((value) => String(value))
          .join(' '),
      };
    });
  });

  /**
   * The timeline: one row per layer, in the order the hierarchy reads.
   *
   * Every layer gets a row, not only the ones that move. A node with no track
   * is exactly the thing an author is about to give one, and hiding it would
   * mean adding a track before being able to see where it goes.
   */
  protected readonly timeline = computed<readonly TimelineRow[]>(() => {
    const animation = this.played();
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
    const animation = this.played();
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
    this.animationPicked.emit(
      this.animations().find((animation) => animation.id !== id)?.id ?? null,
    );
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

  protected setRole(raw: string): void {
    this.patchAnimation((animation) => {
      animation.role = raw.length === 0 ? undefined : (raw as AnimationRole);
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
    const frames = this.animation()?.frames ?? 1;
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
    this.patchPlayed((animation) => {
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

  // -------------------------------------------------------------------- pose

  /**
   * Adds a line to the pose — either the animation's own or this frame's.
   *
   * The first key a character already waits on, so the common case is one
   * click and then a value: an author who has written `when: { view: 'side' }`
   * on a layer has already said what the animation should set.
   */
  protected addPose(scope: 'animation' | 'frame'): void {
    const taken = (scope === 'animation' ? this.animationPose() : this.framePose()).map(
      (row) => row.key,
    );
    const suggested = this.conditionKeys().find((key) => !taken.includes(key));
    this.patchPose(scope, (values) => {
      values[freeId(suggested ?? 'view', taken)] = '';
    });
  }

  protected removePose(scope: 'animation' | 'frame', key: string): void {
    this.patchPose(scope, (values) => {
      delete values[key];
    });
  }

  /** Renames one line of the pose, keeping its place in the order. */
  protected setPoseKey(scope: 'animation' | 'frame', from: string, raw: string): void {
    const to = raw.trim();
    if (to.length === 0 || to === from || to === 'frame') {
      return;
    }
    this.patchPose(scope, (values) => {
      // Rebuilt rather than deleted and re-added, so renaming a key does not
      // move its line to the bottom of the file.
      for (const [id, value] of Object.entries({ ...values })) {
        delete values[id];
        values[id === from ? to : id] = value;
      }
    });
  }

  protected setPoseValue(scope: 'animation' | 'frame', key: string, raw: string): void {
    this.patchPose(scope, (values) => {
      values[key] = poseValue(raw);
    });
  }

  /** Gives this frame a pose of its own, or takes the one it had away. */
  protected toggleFramePose(): void {
    const frame = this.frame();
    this.patchPlayed((animation) => {
      const poses = animation.poses ?? [];
      const existing = poses.find((key) => key.frame === frame);
      animation.poses =
        existing === undefined
          ? [...poses, { frame }].sort((left, right) => left.frame - right.frame)
          : poses.filter((key) => key.frame !== frame);
    });
  }

  /** Edits one of the two pose maps: the animation's, or this frame's. */
  private patchPose(
    scope: 'animation' | 'frame',
    mutate: (values: Record<string, SettingValue>) => void,
  ): void {
    const frame = this.frame();
    this.patchPlayed((animation) => {
      if (scope === 'animation') {
        const pose = { ...(animation.pose ?? {}) };
        mutate(pose);
        animation.pose = pose;
        return;
      }
      const poses = [...(animation.poses ?? [])];
      const index = poses.findIndex((candidate) => candidate.frame === frame);
      const values = index === -1 ? {} : withoutFrame(poses[index] as PoseKey);
      mutate(values);

      const written: PoseKey = { frame, ...values };
      if (index === -1) {
        poses.push(written);
        poses.sort((left, right) => left.frame - right.frame);
      } else {
        poses[index] = written;
      }
      animation.poses = poses;
    });
  }

  /**
   * Turns the open animation into the mirror image of another, or back into
   * one of its own.
   *
   * Becoming a mirror drops the tracks and the pose it had: neither would ever
   * be read again, and a file carrying them says something about itself that
   * is not true.
   */
  protected setMirrorOf(source: string): void {
    this.patchAnimation((animation) => {
      if (source.length === 0) {
        delete animation.mirrorOf;
        animation.frames ??= 4;
        animation.tracks ??= [];
        return;
      }
      animation.mirrorOf = source;
      animation.tracks = [];
      delete animation.pose;
      delete animation.poses;
    });
    this.framePicked.emit(0);
  }

  protected removeKeyframe(): void {
    const node = this.node();
    const frame = this.frame();
    if (node === null) {
      return;
    }
    this.patchPlayed((animation) => {
      const track = trackOf(animation, node);
      if (track === undefined) {
        return;
      }
      track.keyframes = track.keyframes.filter((keyframe) => keyframe.frame !== frame);
      // A track with nothing in it is noise in the file and a warning in the
      // report, so removing the last keyframe removes the track.
      if (track.keyframes.length === 0) {
        animation.tracks = (animation.tracks ?? []).filter((candidate) => candidate.node !== node);
      }
    });
  }

  /** Drops everything the selected node does across the whole animation. */
  protected removeTrack(): void {
    const node = this.node();
    if (node === null) {
      return;
    }
    this.patchPlayed((animation) => {
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
    this.patchPlayed((animation) => {
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
    this.patchById(this.animationId(), mutate);
  }

  /**
   * Edits the animation whose tracks are actually playing.
   *
   * The same as {@link patchAnimation} unless a mirror is open, and a mirror
   * has no tracks — which is why every timeline action is disabled there
   * rather than quietly writing into the animation it reflects.
   */
  private patchPlayed(mutate: (animation: Animation) => void): void {
    if (this.isMirror()) {
      return;
    }
    this.patchById(this.played()?.id ?? null, mutate);
  }

  private patchById(id: string | null, mutate: (animation: Animation) => void): void {
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

/** A pose map as editable lines, in the order it was written. */
function rowsOf(values: Record<string, SettingValue>): PoseRow[] {
  return Object.entries(values).map(([key, value]) => ({ key, value: String(value) }));
}

/** A pose entry's values, without the frame number they sit beside. */
function withoutFrame(key: PoseKey): Record<string, SettingValue> {
  const { frame: _frame, ...values } = key;
  return values as Record<string, SettingValue>;
}

/** The track driving this node, if the animation has one. */
function trackOf(animation: Animation, node: string): AnimationTrack | undefined {
  return (animation.tracks ?? []).find((track) => track.node === node);
}
