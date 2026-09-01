import { describe, expect, it } from 'vitest';

import {
  blockOf,
  canonicalJson,
  list,
  member,
  block,
  row,
  rowOf,
  Shape,
  value,
} from './canonical-json';

/** A definition of the shape these writers deal with, and nothing real. */
interface Thing {
  id: string;
  name?: string;
  kind?: string;
  count?: number;
  looping?: boolean;
  frames?: string[];
  at?: [number, number];
  scope?: string;
}

const THING_ABSENT = {
  name: '',
  kind: 'other',
  count: 1,
  looping: false,
  frames: [],
  at: [0, 0],
  scope: 'session',
};

const THING: Shape<Thing> = {
  absent: THING_ABSENT,
  fields: {
    id: 'always',
    name: 'unless-redundant',
    kind: 'always',
    count: 'unless-redundant',
    looping: { write: (thing) => (thing.frames?.length ?? 0) > 1 },
    frames: { write: 'always', as: (frames) => list(frames.map((frame) => value(frame))) },
    at: 'when-present',
    scope: 'never',
  },
};

describe('canonicalJson', () => {
  it('writes what an author would have written', () => {
    const thing: Thing = {
      id: 'lamp',
      name: 'Lamp',
      kind: 'prop',
      count: 4,
      frames: ['a.png', 'b.png'],
      looping: true,
      at: [3, -2],
    };

    expect(canonicalJson(blockOf(thing, THING))).toBe(
      `{
  "id": "lamp",
  "name": "Lamp",
  "kind": "prop",
  "count": 4,
  "looping": true,
  "frames": [
    "a.png",
    "b.png"
  ],
  "at": [3, -2]
}
`,
    );
  });

  /** The rule the seven writers each restated, in the one place it now lives. */
  it('puts a comma after every member but the last, whichever one that is', () => {
    const written = canonicalJson(blockOf({ id: 'bare', frames: [] }, THING));

    expect(written).toBe(
      `{
  "id": "bare",
  "kind": "other",
  "frames": []
}
`,
    );
    expect(written).not.toContain(',\n}');
  });

  it('drops what leaving it out already means, and keeps what the file is about', () => {
    const written = canonicalJson(
      blockOf({ id: 'plain', name: '', count: 1, frames: ['only.png'] }, THING),
    );

    expect(written).not.toContain('"name"');
    expect(written).not.toContain('"count"');
    // `kind` is written even absent: a reader should not have to know the default.
    expect(written).toContain('"kind": "other"');
    // A still thing states no `looping`: there is no second frame to loop to.
    expect(written).not.toContain('"looping"');
  });

  it('writes a field the definition does not hold as what an absent one means', () => {
    expect(canonicalJson(blockOf({ id: 'blank' }, THING))).toContain('"kind": "other"');
  });

  it('leaves out a field the definition does not hold when the rule reads presence', () => {
    expect(canonicalJson(blockOf({ id: 'here', at: [0, 0] }, THING))).toContain('"at": [0, 0]');
    expect(canonicalJson(blockOf({ id: 'nowhere' }, THING))).not.toContain('"at"');
  });

  it('never writes a field belonging to another vocabulary', () => {
    expect(canonicalJson(blockOf({ id: 'x', scope: 'session' }, THING))).not.toContain('"scope"');
  });

  it('refuses to drop a field nothing says the absence of', () => {
    const shape = { fields: { id: 'always', name: 'unless-redundant' } } as Shape<Thing>;

    expect(() => blockOf({ id: 'x' } as Thing, shape)).toThrow(/absent one would have meant/);
  });

  /**
   * `null` is a value these formats carry — a characteristic that starts empty
   * holds exactly that — so only `undefined` says the definition holds nothing.
   */
  it('writes a null the definition holds, rather than reading it as nothing', () => {
    const shape: Shape<{ id: string; note: string | null }> = {
      fields: { id: 'always', note: 'always' },
    };

    expect(canonicalJson(blockOf({ id: 'x', note: null }, shape))).toContain('"note": null');
  });

  it('spaces a value the way the rest of the format does', () => {
    expect(value([4, 10]).text).toBe('[4, 10]');
    expect(value({ surface: 'f' }).text).toBe('{ "surface": "f" }');
    expect(value({}).text).toBe('{}');
    expect(value(null).text).toBe('null');
  });

  it('writes an empty object and an empty array on their own line', () => {
    expect(canonicalJson(block([member('metadata', block([])), member('tiles', list([]))]))).toBe(
      `{
  "metadata": {},
  "tiles": []
}
`,
    );
  });

  it('indents a nested document by two spaces a level', () => {
    const nested = block([
      member('tiles', list([row([member('at', value([4, 1])), member('tile', value('rock'))])])),
      member(
        'art',
        block([member('flat', list([row([member('id', value('a'))])]))]),
      ),
    ]);

    expect(canonicalJson(nested)).toBe(
      `{
  "tiles": [
    { "at": [4, 1], "tile": "rock" }
  ],
  "art": {
    "flat": [
      { "id": "a" }
    ]
  }
}
`,
    );
  });

  it('lays a definition out on one line when the format reads it as a record', () => {
    expect(rowOf({ id: 'lamp', kind: 'prop', frames: [] }, THING).text).toBe(
      '{ "id": "lamp", "kind": "prop", "frames": [] }',
    );
  });
});
