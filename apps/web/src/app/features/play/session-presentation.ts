/**
 * What a session *shows*, between the ticks that decide it.
 *
 * The engine owns the game (`docs/adr/ADR-0023-session-outlives-the-route.md`):
 * it says where every entity is, at whole hexes, once per tick. Nothing here
 * disputes that. What it does is fill the gap between two of those answers —
 * which drawing of the player is on screen, how far along a glide from the old
 * hex to the new one an entity is, and what the event log says happened — and
 * none of that is a rule (`docs/adr/ADR-0010-engine-api.md`): interpolating
 * between two engine-supplied positions is presentation, and asking the engine
 * for the same answer sixty times a second would not make it more authoritative.
 *
 * A snapshot and a time go in; the entities to draw come out. So it needs no
 * DOM, no canvas and no component, and its spec runs without any of the three —
 * which is the point, because this was the half of `play-page.ts` that could
 * only be reached by starting a browser.
 *
 * The **clock is not here**. The page drives it, because a page already knows
 * when it is on screen and this module would only be guessing; what it does own
 * is the rate ({@link PRESENTATION_FRAME_MS}) and the answer to whether another
 * sample would draw anything different ({@link SessionPresentation.changing}).
 */

import { Signal, signal } from '@angular/core';

import { AnimationRole, ResolvedCharacter } from '../../../content/generated/character';
import { EntitySnapshot, SimEvent } from '../../../engine/engine.types';
import { movementProgress, roleForMove } from '../../../renderer/character-animation';
import { RenderEntity } from '../../../renderer/render-model';

/** Character poses are sampled at 30 fps; authored sprite frames are slower. */
export const PRESENTATION_FRAME_MS = 1000 / 30;

/** Glide used when no authored player movement cycle supplies a duration. */
export const DEFAULT_ENTITY_MOVE_MS = 400;

/** How many lines the log keeps before the oldest fall off. */
export const MAX_LOG_ENTRIES = 60;

/**
 * One rendered line in the event log.
 *
 * A line is a **key and its values**, not a sentence: the log is on screen, so
 * it is translated like everything else, and switching language rewrites the
 * lines already logged (`docs/adr/ADR-0020-localised-content-keys.md`).
 */
export interface LogEntry {
  readonly id: number;
  readonly tick: number;
  readonly key: string;
  readonly params?: Readonly<Record<string, string | number>>;
  readonly kind: 'move' | 'hold' | 'tick' | 'reject';
}

/** The player's current semantic animation. */
interface PlayerAnimation {
  readonly role: AnimationRole;
  readonly startedAt: number;
  /** `null` for idle; movement returns to idle after one pass. */
  readonly endsAt: number | null;
}

/** Presentation-only interpolation of one authoritative movement event. */
interface EntityMotion {
  readonly from: readonly [number, number];
  readonly startedAt: number;
  readonly durationMs: number;
}

/**
 * What this module cannot answer for itself.
 *
 * Both cross a boundary a pure module has no business holding: **what** the
 * player looks like is the Rust resolver's answer, here as everywhere
 * (`docs/adr/ADR-0012-shared-content-validation.md`), and loading an image is
 * the host's cache. A spec supplies two functions instead.
 */
export interface CharacterSource {
  /** The player's appearance in `role`, `timeMs` into it. */
  resolve(role: AnimationRole, timeMs: number): ResolvedCharacter | null;
  /** Asks for images an appearance is about to draw. */
  preload(assets: readonly string[]): void;
}

/** The presentation of one session: its animation, its motion and its log. */
export class SessionPresentation {
  private readonly entries = signal<readonly LogEntry[]>([]);
  private readonly gliding = signal(false);

  /** The lines the session has said, newest first. */
  readonly log: Signal<readonly LogEntry[]> = this.entries.asReadonly();

  /** Whether any entity is mid-glide, and a command should therefore wait. */
  readonly moving: Signal<boolean> = this.gliding.asReadonly();

  private animation: PlayerAnimation | null = null;
  private player: ResolvedCharacter | null = null;
  private readonly motions = new Map<string, EntityMotion>();
  private readonly warmed = new Set<string>();
  private counter = 0;

  constructor(private readonly source: CharacterSource) {}

  /** What the player is drawn as, as of the last sample. */
  get character(): ResolvedCharacter | null {
    return this.player;
  }

  /** Whether there is anything on screen this module is presenting. */
  get presenting(): boolean {
    return this.player !== null || this.motions.size > 0;
  }

  /** Whether sampling again would draw something different. */
  get changing(): boolean {
    return this.player?.pose !== undefined || this.motions.size > 0;
  }

  /**
   * Plays `role` from `now`, and answers how long it lasts.
   *
   * Movement lasts one authored pass even when the source is marked looping;
   * after that the player returns to idle. Time stays presentation-only and no
   * tick is spent
   * (`docs/adr/ADR-0030-gameplay-selects-character-animations-by-role.md`).
   */
  play(role: AnimationRole, now: number): number {
    const first = this.source.resolve(role, 0);
    this.player = first;
    const duration = Math.max(first?.pose?.durationMs ?? 0, DEFAULT_ENTITY_MOVE_MS);
    this.animation = { role, startedAt: now, endsAt: role === 'idle' ? null : now + duration };
    this.preload(first);
    return duration;
  }

  /**
   * One tick's worth of movement, all of it on the same visual clock.
   *
   * The player's own step decides how long that clock runs: an authored walk
   * cycle sets the pace, and everything the tick moved arrives with it.
   */
  advance(events: readonly SimEvent[], playerId: string | null, now: number): void {
    const step = events.find(
      (event) => event.type === 'entityMoved' && event.contentId === playerId,
    );
    const durationMs =
      step?.type === 'entityMoved'
        ? this.play(roleForMove(step.from, step.to), now)
        : DEFAULT_ENTITY_MOVE_MS;

    this.motions.clear();
    for (const event of events) {
      if (event.type === 'entityMoved') {
        this.motions.set(event.contentId, { from: event.from, startedAt: now, durationMs });
      }
    }
    this.gliding.set(this.motions.size > 0);
  }

  /** Back to standing still, with nothing in flight. */
  idle(now: number): void {
    this.motions.clear();
    this.gliding.set(false);
    this.play('idle', now);
  }

  /**
   * Samples the presentation at `now`.
   *
   * A movement that has run its course hands back to idle here rather than at
   * the tick that started it, which is why a rejected command leaves the player
   * mid-step exactly as long as an accepted one would have.
   */
  sample(now: number): void {
    let state = this.animation;
    if (state !== null) {
      if (state.endsAt !== null && now >= state.endsAt) {
        state = { role: 'idle', startedAt: now, endsAt: null };
        this.animation = state;
      }
      const character = this.source.resolve(state.role, now - state.startedAt);
      this.player = character;
      this.preload(character);
    }

    for (const [id, motion] of this.motions) {
      if (movementProgress(motion.startedAt, motion.durationMs, now) >= 1) {
        this.motions.delete(id);
      }
    }
    if (this.motions.size === 0 && this.gliding()) {
      this.gliding.set(false);
    }
  }

  /** The entities to draw: authoritative cells, plus the glide between two. */
  frame(entities: readonly EntitySnapshot[], now: number): RenderEntity[] {
    return entities.map((entity) => {
      const motion = this.motions.get(entity.contentId);
      return {
        id: entity.contentId,
        at: { col: entity.at[0], row: entity.at[1] },
        visualId: entity.visualId,
        fallbackColor: entity.fallbackColor,
        character: entity.kind === 'player' ? this.player : undefined,
        ...(motion === undefined
          ? {}
          : {
              motion: {
                from: { col: motion.from[0], row: motion.from[1] },
                progress: movementProgress(motion.startedAt, motion.durationMs, now),
              },
            }),
        glyph: entity.kind === 'player' ? '@' : 'M',
        emphasised: entity.kind === 'player',
      };
    });
  }

  /** One line the session says for itself: started, resumed, an issue found. */
  note(
    tick: number,
    key: string,
    kind: LogEntry['kind'],
    params?: Readonly<Record<string, string | number>>,
  ): void {
    this.counter += 1;
    const entry: LogEntry = { id: this.counter, tick, key, params, kind };
    this.entries.update((entries) => [entry, ...entries].slice(0, MAX_LOG_ENTRIES));
  }

  /** One engine event as a line, when it is one a player should read. */
  record(tick: number, event: SimEvent): void {
    switch (event.type) {
      case 'entityMoved':
        this.note(tick, 'ui.play.log.moved', 'move', {
          entity: event.contentId,
          fromCol: event.from[0],
          fromRow: event.from[1],
          toCol: event.to[0],
          toRow: event.to[1],
        });
        break;
      case 'entityHeld':
        this.note(tick, 'ui.play.log.held', 'hold', {
          entity: event.contentId,
          col: event.at[0],
          row: event.at[1],
        });
        break;
      case 'tickAdvanced':
        this.note(event.tick, 'ui.play.log.tick', 'tick', { tick: event.tick });
        break;
      case 'actionRejected':
        // The reason comes from Rust already worded; it is quoted, not composed.
        this.note(tick, 'ui.play.log.refused', 'reject', { reason: event.reason.message });
        break;
      case 'linkTriggered':
        this.note(tick, 'ui.play.log.door', 'move', { link: event.link, world: event.toWorld });
        break;
      case 'worldEntered':
        this.note(tick, 'ui.play.log.entered', 'tick', {
          world: event.toWorld,
          col: event.at[0],
          row: event.at[1],
          from: event.fromWorld,
        });
        break;
      case 'linkUnresolved':
        this.note(tick, 'ui.play.log.doorUnresolved', 'reject', {
          link: event.link,
          reason: event.reason,
        });
        break;
    }
  }

  /** Clears what is drawn without touching the engine-owned session. */
  reset(): void {
    this.motions.clear();
    this.gliding.set(false);
    this.animation = null;
    this.player = null;
  }

  /** The same, plus the log: a game starting, or one being resumed onto. */
  restart(): void {
    this.reset();
    this.entries.set([]);
  }

  /** Asks for the images an appearance draws, each one once. */
  private preload(character: ResolvedCharacter | null): void {
    if (character === null) {
      return;
    }
    const fresh = character.layers
      .map((layer) => layer.asset)
      .filter((asset) => !this.warmed.has(asset));
    for (const asset of fresh) {
      this.warmed.add(asset);
    }
    if (fresh.length > 0) {
      this.source.preload(fresh);
    }
  }
}
