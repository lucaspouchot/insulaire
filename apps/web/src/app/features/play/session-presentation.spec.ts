import { beforeEach, describe, expect, it } from 'vitest';

import { AnimationRole, ResolvedCharacter } from '../../../content/generated/character';
import { EntitySnapshot, SimEvent } from '../../../engine/engine.types';
import {
  CharacterSource,
  DEFAULT_ENTITY_MOVE_MS,
  MAX_LOG_ENTRIES,
  SessionPresentation,
} from './session-presentation';

/**
 * The session's presentation, driven with no DOM, no canvas and no component.
 *
 * Which is the point of the module: this half of `play-page.ts` decided which
 * drawing was on screen and how far along a glide an entity was, and none of it
 * could be reached without starting a browser. Time is supplied here rather
 * than read from a clock, so "half way through the step" is a number in a test
 * (`docs/adr/ADR-0023-session-outlives-the-route.md`).
 */

/** A resolved appearance, with an authored pass when one is asked for. */
function appearance(role: AnimationRole, durationMs: number | null): ResolvedCharacter {
  return {
    character: 'hero',
    category: 'player',
    resolution: { width: 64, height: 128 },
    values: {},
    layers: [{ layer: 'body', variant: 'default', rect: [0, 0, 8, 8], origin: [0, 0], offset: [0, 0], asset: `${role}.png`, tint: '' }],
    mirrored: false,
    ...(durationMs === null
      ? {}
      : { pose: { animation: role, frame: 0, timeMs: 0, durationMs } }),
  };
}

interface Harness {
  readonly session: SessionPresentation;
  /** Every role resolved, in order, with the time it was asked at. */
  readonly asked: string[];
  /** Every image the presentation asked the host to load. */
  readonly loaded: string[];
}

function harness(durationMs: number | null = 600): Harness {
  const asked: string[] = [];
  const loaded: string[] = [];
  const source: CharacterSource = {
    resolve: (role, timeMs) => {
      asked.push(`${role}@${timeMs}`);
      return appearance(role, durationMs);
    },
    preload: (assets) => loaded.push(...assets),
  };
  return { session: new SessionPresentation(source), asked, loaded };
}

function entity(contentId: string, at: [number, number], kind: 'player' | 'monster'): EntitySnapshot {
  return {
    id: 1,
    contentId,
    templateId: kind,
    kind,
    at,
    axial: { q: 0, r: 0 },
    visualId: `entity.${kind}`,
    fallbackColor: '#ffffff',
    blocksMovement: true,
    tags: [],
  };
}

function moved(contentId: string, from: [number, number], to: [number, number]): SimEvent {
  return { type: 'entityMoved', entity: 1, contentId, from, to };
}

describe('SessionPresentation', () => {
  let session: SessionPresentation;

  beforeEach(() => {
    session = harness().session;
  });

  it('draws an entity on the hex the engine put it on', () => {
    const [drawn] = session.frame([entity('player_1', [4, 10], 'player')], 0);

    expect(drawn?.at).toEqual({ col: 4, row: 10 });
    expect(drawn?.motion).toBeUndefined();
    expect(drawn?.emphasised).toBe(true);
  });

  /** The whole reason this module exists: a position between two ticks. */
  it('glides an entity from the hex it left, half way at half the duration', () => {
    session.advance([moved('player_1', [4, 10], [5, 10])], 'player_1', 1_000);

    const [drawn] = session.frame([entity('player_1', [5, 10], 'player')], 1_300);

    // The cell is the engine's answer; only the glide is this module's.
    expect(drawn?.at).toEqual({ col: 5, row: 10 });
    expect(drawn?.motion).toEqual({ from: { col: 4, row: 10 }, progress: 0.5 });
  });

  it("takes its pace from the player's authored walk cycle", () => {
    // 600ms of authored pass, so half way is 300ms rather than the default's 200.
    session.advance([moved('player_1', [4, 10], [5, 10])], 'player_1', 0);

    expect(session.frame([entity('player_1', [5, 10], 'player')], 300)[0]?.motion?.progress).toBe(
      0.5,
    );
  });

  it('glides for the default pass when the player has no cycle to time it by', () => {
    const still = harness(null).session;
    still.advance([moved('monster_1', [1, 1], [2, 1])], 'player_1', 0);

    const half = DEFAULT_ENTITY_MOVE_MS / 2;
    expect(still.frame([entity('monster_1', [2, 1], 'monster')], half)[0]?.motion?.progress).toBe(
      0.5,
    );
  });

  it('puts everything one tick moved on the same clock', () => {
    session.advance(
      [moved('player_1', [4, 10], [5, 10]), moved('monster_1', [9, 9], [8, 9])],
      'player_1',
      0,
    );

    const drawn = session.frame(
      [entity('player_1', [5, 10], 'player'), entity('monster_1', [8, 9], 'monster')],
      300,
    );

    expect(drawn.map((one) => one.motion?.progress)).toEqual([0.5, 0.5]);
  });

  it('plays the direction that was moved, not a generic step', () => {
    const { session: east, asked } = harness();
    east.advance([moved('player_1', [4, 10], [5, 10])], 'player_1', 0);

    expect(asked[0]).toBe('moveEast@0');
  });

  it('hands back to idle when the movement has run its pass', () => {
    const { session: walking, asked } = harness();
    walking.advance([moved('player_1', [4, 10], [5, 10])], 'player_1', 0);

    walking.sample(300);
    expect(asked.at(-1)).toBe('moveEast@300');

    // The pass is over, so idle starts here — at zero of its own clock.
    walking.sample(600);
    expect(asked.at(-1)).toBe('idle@0');
  });

  it('stops moving once every glide has arrived', () => {
    session.advance([moved('player_1', [4, 10], [5, 10])], 'player_1', 0);
    expect(session.moving()).toBe(true);

    session.sample(300);
    expect(session.moving()).toBe(true);

    session.sample(600);
    expect(session.moving()).toBe(false);
    expect(session.frame([entity('player_1', [5, 10], 'player')], 600)[0]?.motion).toBeUndefined();
  });

  /** What tells the page whether to ask for another frame. */
  it('asks for frames while something is animated, and not once nothing is', () => {
    expect(session.presenting).toBe(false);
    expect(session.changing).toBe(false);

    // An authored idle keeps playing, so the page keeps asking.
    session.idle(0);
    expect(session.changing).toBe(true);

    // A character with no authored pass is drawn, but drawn the same each time.
    const still = harness(null).session;
    still.idle(0);
    expect(still.presenting).toBe(true);
    expect(still.changing).toBe(false);
  });

  it('asks for each image once, however often the appearance resolves', () => {
    const { session: walking, loaded } = harness();
    walking.idle(0);
    walking.sample(10);
    walking.sample(20);

    expect(loaded).toEqual(['idle.png']);
  });

  it('clears what is in flight without losing what the session said', () => {
    session.note(0, 'ui.play.log.started', 'tick');
    session.advance([moved('player_1', [4, 10], [5, 10])], 'player_1', 0);

    session.reset();

    expect(session.moving()).toBe(false);
    expect(session.character).toBeNull();
    expect(session.log()).toHaveLength(1);

    session.restart();
    expect(session.log()).toEqual([]);
  });

  describe('the log', () => {
    it('says what each engine event was, as a key and its values', () => {
      session.record(3, moved('monster_1', [9, 9], [8, 9]));
      session.record(3, { type: 'entityHeld', entity: 2, contentId: 'monster_2', at: [1, 1] });
      session.record(3, { type: 'tickAdvanced', tick: 4 });
      session.record(4, {
        type: 'actionRejected',
        reason: { code: 'blocked', message: 'A wall.' },
      });
      session.record(4, { type: 'linkTriggered', link: 'door', toWorld: 'refuge', to: [0, 0] });

      expect(session.log().map((entry) => [entry.key, entry.kind])).toEqual([
        ['ui.play.log.door', 'move'],
        ['ui.play.log.refused', 'reject'],
        ['ui.play.log.tick', 'tick'],
        ['ui.play.log.held', 'hold'],
        ['ui.play.log.moved', 'move'],
      ]);
      expect(session.log().at(-1)?.params).toEqual({
        entity: 'monster_1',
        fromCol: 9,
        fromRow: 9,
        toCol: 8,
        toRow: 9,
      });
    });

    /** The tick a `tickAdvanced` names is its own, not the one it was read at. */
    it('files a tick line under the tick it announces', () => {
      session.record(3, { type: 'tickAdvanced', tick: 4 });

      expect(session.log()[0]?.tick).toBe(4);
    });

    it('keeps the newest lines and drops the oldest', () => {
      for (let index = 0; index <= MAX_LOG_ENTRIES; index += 1) {
        session.note(index, 'ui.play.log.tick', 'tick', { tick: index });
      }

      expect(session.log()).toHaveLength(MAX_LOG_ENTRIES);
      expect(session.log()[0]?.tick).toBe(MAX_LOG_ENTRIES);
      expect(session.log().at(-1)?.tick).toBe(1);
    });

    it('gives every line an id of its own, so a rerender does not reorder them', () => {
      session.note(0, 'ui.play.log.tick', 'tick');
      session.note(0, 'ui.play.log.tick', 'tick');

      expect(new Set(session.log().map((entry) => entry.id)).size).toBe(2);
    });
  });
});
