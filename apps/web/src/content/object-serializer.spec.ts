import { describe, expect, it } from 'vitest';

import { ObjectDefinition, OBJECT_SCHEMA_VERSION } from './content-types';
import { serializeObject } from './object-serializer';

describe('serializeObject', () => {
  const potion: ObjectDefinition = {
    id: 'small_potion',
    schemaVersion: OBJECT_SCHEMA_VERSION,
    name: 'Small potion',
    kind: 'consumable',
    nameKey: 'game.object.smallPotion.name',
    descriptionKey: 'game.object.smallPotion.description',
    frames: ['assets/objects/small_potion.png'],
    resolution: { width: 16, height: 16 },
    stackSize: 10,
    tags: ['healing'],
  };

  it('writes the file an author would have written', () => {
    expect(serializeObject(potion)).toBe(
      `{
  "id": "small_potion",
  "schemaVersion": 2,
  "name": "Small potion",
  "kind": "consumable",
  "nameKey": "game.object.smallPotion.name",
  "descriptionKey": "game.object.smallPotion.description",
  "frames": [
    "assets/objects/small_potion.png"
  ],
  "resolution": { "width": 16, "height": 16 },
  "stackSize": 10,
  "tags": ["healing"]
}
`,
    );
  });

  it('round-trips through JSON', () => {
    expect(JSON.parse(serializeObject(potion))).toEqual(potion);
  });

  /** One frame per line, so a changed drawing is a changed line. */
  it('writes an animated icon one frame to a line, with its playback', () => {
    const gem: ObjectDefinition = {
      id: 'gem',
      schemaVersion: OBJECT_SCHEMA_VERSION,
      kind: 'material',
      nameKey: 'game.object.gem.name',
      frames: ['assets/objects/gem_0.png', 'assets/objects/gem_1.png'],
      frameDurationMs: 100,
      looping: true,
      resolution: { width: 16, height: 16 },
    };

    expect(serializeObject(gem)).toContain(
      `  "frames": [
    "assets/objects/gem_0.png",
    "assets/objects/gem_1.png"
  ],
  "frameDurationMs": 100,
  "looping": true,`,
    );
    expect(JSON.parse(serializeObject(gem))).toEqual(gem);
  });

  /**
   * A quest item stacks to one and wears nothing, and neither of those is worth
   * a line in every file that has them. A still icon has no rate to state.
   */
  it('drops a stack of one, an empty slot, empty tags and a still icon playback', () => {
    const written = serializeObject({
      id: 'letter',
      schemaVersion: OBJECT_SCHEMA_VERSION,
      kind: 'quest',
      nameKey: 'game.object.letter.name',
      frames: ['assets/objects/letter.png'],
      stackSize: 1,
    });

    expect(written).not.toContain('"stackSize"');
    expect(written).not.toContain('"slot"');
    expect(written).not.toContain('"tags"');
    expect(written).not.toContain('"descriptionKey"');
    expect(written).not.toContain('"frameDurationMs"');
    expect(written).not.toContain('"looping"');
  });

  /**
   * An object still being blocked out shows the fields it owes rather than
   * hiding them, which is why `nameKey` and `frames` are written even when empty.
   */
  it('writes the empty key and frames of an object that has neither yet', () => {
    const written = serializeObject({ id: 'draft', schemaVersion: OBJECT_SCHEMA_VERSION });

    expect(written).toContain('"nameKey": ""');
    expect(written).toContain('"frames": []');
    expect(written).toContain('"kind": "other"');
    expect(written).toContain('"resolution": { "width": 32, "height": 32 }');
    expect(() => JSON.parse(written)).not.toThrow();
  });
});
