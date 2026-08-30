import { describe, expect, it } from 'vitest';

import { DecorationDefinition, DECORATION_SCHEMA_VERSION } from './content-types';
import { serializeDecoration } from './decoration-serializer';

/**
 * The claim these tests make is the serialiser's whole job: the file an author
 * would have written, and one that parses back to the definition it came from
 * (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
 */
describe('serializeDecoration', () => {
  const torch: DecorationDefinition = {
    id: 'torch',
    schemaVersion: DECORATION_SCHEMA_VERSION,
    name: 'Wall torch',
    category: 'prop',
    resolution: { width: 16, height: 32 },
    anchor: [8, 31],
    plane: 'front',
    order: 2,
    animations: [
      {
        id: 'burning',
        frames: ['assets/decorations/torch_0.png', 'assets/decorations/torch_1.png'],
        frameDurationMs: 100,
        looping: true,
      },
      { id: 'out', frames: ['assets/decorations/torch_out.png'] },
    ],
  };

  it('writes one frame per line, under its animation', () => {
    expect(serializeDecoration(torch)).toBe(
      `{
  "id": "torch",
  "schemaVersion": 2,
  "name": "Wall torch",
  "category": "prop",
  "resolution": { "width": 16, "height": 32 },
  "anchor": [8, 31],
  "plane": "front",
  "order": 2,
  "animations": [
    {
      "id": "burning",
      "frameDurationMs": 100,
      "looping": true,
      "frames": [
        "assets/decorations/torch_0.png",
        "assets/decorations/torch_1.png"
      ]
    },
    {
      "id": "out",
      "frameDurationMs": 120,
      "looping": false,
      "frames": [
        "assets/decorations/torch_out.png"
      ]
    }
  ]
}
`,
    );
  });

  it('round-trips through JSON', () => {
    expect(JSON.parse(serializeDecoration(torch))).toEqual({
      ...torch,
      animations: [
        torch.animations?.[0],
        { ...torch.animations?.[1], frameDurationMs: 120, looping: false },
      ],
    });
  });

  /**
   * The placement fields are written even at their defaults: a reader looking
   * at a tree should see where it anchors without knowing what absent means.
   */
  it('always writes the placement, and drops what says nothing', () => {
    const written = serializeDecoration({
      id: 'rock',
      schemaVersion: DECORATION_SCHEMA_VERSION,
      // A default that names the first animation is what absent already means.
      defaultAnimation: 'idle',
      animations: [{ id: 'idle', frames: ['assets/decorations/rock.png'] }],
    });

    expect(written).toContain('"anchor": [0, 0]');
    expect(written).toContain('"plane": "behind"');
    expect(written).toContain('"order": 0');
    expect(written).not.toContain('"name"');
    expect(written).not.toContain('"tags"');
    expect(written).not.toContain('"defaultAnimation"');
  });

  it('writes a defaultAnimation that is not the first one', () => {
    const written = serializeDecoration({
      id: 'chest',
      schemaVersion: DECORATION_SCHEMA_VERSION,
      defaultAnimation: 'closed',
      animations: [
        { id: 'open', frames: ['open.png'] },
        { id: 'closed', frames: ['closed.png'] },
      ],
    });

    expect(written).toContain('"defaultAnimation": "closed"');
  });

  /** A decoration with no appearance yet is still a valid file to write. */
  it('closes cleanly when there is no animation at all', () => {
    const written = serializeDecoration({ id: 'blank', schemaVersion: DECORATION_SCHEMA_VERSION });

    expect(written.trimEnd().endsWith('"order": 0\n}')).toBe(true);
    expect(() => JSON.parse(written)).not.toThrow();
  });
});
