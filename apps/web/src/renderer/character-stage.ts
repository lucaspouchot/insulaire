/**
 * The character editor's drawing surface, framework-free.
 *
 * `HexMapRenderer`'s shape: a `CanvasRenderingContext2D` in the constructor,
 * {@link setModel} then {@link draw}, and the pointer maths beside the drawing
 * that produced it. It is handed a resolved character and a box, and it draws —
 * every appearance decision was the Rust resolver's, and {@link drawCharacter}
 * is the same function the running game draws with
 * (`docs/adr/ADR-0024-character-definitions.md`).
 *
 * What it adds is what only an *editor* needs: the transparency checker under
 * the canvas, a dashed outline of the authored canvas, the pixel grid once the
 * zoom is large enough to aim at, a box around the layer being edited, and the
 * skeleton of bones and joints. All of it is switched by
 * {@link CharacterStageChrome}; a plain preview passes {@link NO_STAGE_CHROME}
 * and gets the character and nothing else
 * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
 *
 * The caller owns the backing store — density, size, the device-pixel-ratio
 * transform — exactly as `CanvasView` does for the map renderer
 * (`renderer/canvas-surface.ts`). This class draws in CSS pixels into whatever
 * it is given.
 */

import { CharacterLayer, ResolvedCharacter } from '../content/generated/character';
import { PixelRect, SpriteResolution } from '../content/generated/shared';
import {
  CharacterBox,
  SpriteSource,
  drawCharacter,
  pixelUnder,
  placement,
} from './character-renderer';

/** From this zoom up, the grid is worth drawing over the pixels. */
const GRID_ZOOM = 6;

/** Smallest a transparency square may get on screen, in CSS pixels. */
const MIN_CHECKER = 6;

/** Colour of the bones drawn between a node and its parent. */
const BONE_COLOR = 'rgba(122, 192, 255, 0.75)';

/** Colour of an attachment point, and of the selected node's own marker. */
const JOINT_COLOR = '#7ac0ff';

/** One line per authored pixel. */
const GRID_COLOR = 'rgba(147, 161, 177, 0.16)';

/** The dashed outline of the authored canvas. */
const CANVAS_BOUNDS_COLOR = 'rgba(147, 161, 177, 0.35)';

/** The box around the layer open in the form. */
const OPEN_LAYER_COLOR = '#ffd166';

/** The transparency checker's greys when the caller names none. */
const DEFAULT_CHECKER: readonly [string, string] = ['#0d1117', '#1c242f'];

/**
 * Which editor overlays the stage draws this frame.
 *
 * An options bag on the model rather than five methods, so a preview pane can
 * ask for the character alone with {@link NO_STAGE_CHROME} and the extraction
 * is not merely cosmetic — the chrome is the bulk of the drawing code.
 */
export interface CharacterStageChrome {
  /** Draw the bones and joints over the character. */
  readonly showSkeleton: boolean;
  /** Draw one line per authored pixel, once the zoom is large enough. */
  readonly showGrid: boolean;
  /** Paint the transparency checker under the authored canvas. */
  readonly showTransparency: boolean;
  /** Outline the authored canvas with a dashed rectangle. */
  readonly canvasBounds: boolean;
  /**
   * Id of the layer open in the form, boxed on the canvas and shown untinted,
   * or `null` to box none.
   */
  readonly openLayerId: string | null;
}

/** Every overlay off: what a plain preview pane draws with. */
export const NO_STAGE_CHROME: CharacterStageChrome = {
  showSkeleton: false,
  showGrid: false,
  showTransparency: false,
  canvasBounds: false,
  openLayerId: null,
};

/** Everything the stage needs to draw one frame. */
export interface CharacterStageModel {
  /** The resolver's answer, drawn back to front. */
  readonly character: ResolvedCharacter;
  /** Where on the canvas to draw it, in CSS pixels. */
  readonly box: CharacterBox;
  /** Which overlays to add. */
  readonly chrome: CharacterStageChrome;
  /**
   * The layers as authored — parentage and anchors — for the skeleton. Needed
   * only when {@link CharacterStageChrome.showSkeleton} is set; a plain preview
   * omits it.
   */
  readonly layers?: readonly CharacterLayer[];
  /**
   * The transparency checker's two greys, taken from the theme by the caller
   * so this class never reads computed style. Needed only when
   * {@link CharacterStageChrome.showTransparency} is set.
   */
  readonly transparencyColors?: readonly [string, string];
}

/**
 * The character as the stage shows it while a layer is being painted: that
 * layer loses its tint.
 *
 * What the pencil writes is the file, and a file seen through a multiply is not
 * the thing being edited — an author matching two greys would be matching them
 * through a colour that is in neither
 * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`). Pure, so the
 * component can hand it to the stage and a test can check it alone.
 */
export function paintedFor(
  character: ResolvedCharacter,
  openLayerId: string | null,
): ResolvedCharacter {
  const target = character.layers.find((drawn) => drawn.layer === openLayerId) ?? null;
  if (target === null || target.tint.length === 0) {
    return character;
  }
  return {
    ...character,
    layers: character.layers.map((drawn) => (drawn === target ? { ...drawn, tint: '' } : drawn)),
  };
}

export class CharacterStage {
  private model: CharacterStageModel | null = null;
  /**
   * What the last {@link draw} put on the canvas, for turning a client point
   * back into a pixel. The box is kept with the placement because a pointer
   * arrives in the box the *element* occupies, which the interface scale has
   * multiplied (`app/app.css`).
   */
  private view: {
    zoom: number;
    originX: number;
    originY: number;
    box: CharacterBox;
  } = { zoom: 1, originX: 0, originY: 0, box: { x: 0, y: 0, width: 1, height: 1 } };

  constructor(
    private readonly context: CanvasRenderingContext2D,
    private readonly source: SpriteSource,
  ) {}

  /** The whole-number zoom the last {@link draw} settled on, for a readout. */
  get zoom(): number {
    return this.view.zoom;
  }

  /** Replaces what the next {@link draw} draws. */
  setModel(model: CharacterStageModel): void {
    this.model = model;
  }

  /**
   * Draws the resolved character into the box, then the editor chrome the model
   * asks for.
   *
   * The overlays are drawn in canvas coordinates, so a mirrored character needs
   * them reflected too — a selection box on the wrong side of the figure is
   * worse than none.
   */
  draw(): void {
    const model = this.model;
    if (model === null) {
      return;
    }
    const { character, chrome } = model;
    const resolution = character.resolution;
    const { zoom, originX, originY } = placement(resolution, model.box);
    this.view = { zoom, originX, originY, box: model.box };

    const context = this.context;
    if (chrome.showTransparency) {
      this.paintTransparency(
        resolution,
        zoom,
        originX,
        originY,
        model.transparencyColors ?? DEFAULT_CHECKER,
      );
    }
    if (chrome.canvasBounds) {
      this.strokeCanvasBounds(resolution, zoom, originX, originY);
    }

    drawCharacter(context, paintedFor(character, chrome.openLayerId), model.box, this.source);
    if (chrome.showGrid && zoom >= GRID_ZOOM) {
      this.strokeGrid(resolution, zoom, originX, originY);
    }

    context.save();
    if (character.mirrored) {
      context.translate(originX * 2 + character.resolution.width * zoom, 0);
      context.scale(-1, 1);
    }
    if (chrome.showSkeleton) {
      this.strokeSkeleton(zoom, originX, originY);
    }
    if (chrome.openLayerId !== null) {
      this.strokeOpenLayer(chrome.openLayerId, zoom, originX, originY);
    }
    context.restore();
  }

  /**
   * The canvas pixel a client point is over, in the character's own
   * coordinates.
   *
   * Un-mirrored on the way back: the stage may be showing the character
   * flipped, and a click means the pixel it *points at*, not the one that would
   * be there if it were facing the other way. May be outside the canvas — the
   * caller decides what that means.
   */
  pixelAt(clientX: number, clientY: number): { x: number; y: number } | null {
    const at = pixelUnder(
      { x: clientX, y: clientY },
      this.context.canvas.getBoundingClientRect(),
      this.view.box,
      this.view,
    );
    const character = this.model?.character;
    if (at === null || character?.mirrored !== true) {
      return at;
    }
    return { x: character.resolution.width - 1 - at.x, y: at.y };
  }

  /**
   * Where a client point is in the open layer's edited sprite, in that
   * sprite's own pixels.
   *
   * Deliberately unbounded: a drag that leaves the sprite and comes back is one
   * stroke. `null` when no layer is open, or the open layer drew nothing.
   */
  layerPixelAt(clientX: number, clientY: number): { x: number; y: number } | null {
    // The **resolved** box, not the authored one: a child's `rect` is measured
    // from the joint it hangs off, so the file's numbers are not where the
    // sprite is (`docs/adr/ADR-0024-character-definitions.md`).
    const box = this.openLayerRect();
    if (box === null) {
      return null;
    }
    const at = this.pixelAt(clientX, clientY);
    return at === null ? null : { x: at.x - box[0], y: at.y - box[1] };
  }

  /** Where the open layer's sprite actually landed, animation included. */
  private openLayerRect(): PixelRect | null {
    const open = this.model?.chrome.openLayerId;
    return this.model?.character.layers.find((drawn) => drawn.layer === open)?.rect ?? null;
  }

  /**
   * The bones and joints, drawn over the character.
   *
   * A line runs from where a layer hangs — its parent's named attachment point,
   * or the parent's own origin — to the child's centre, and every attachment
   * point is marked. Both ends are read off the *resolved* boxes, so they move
   * with the animation. Nothing here exists in the runtime's renderer.
   */
  private strokeSkeleton(zoom: number, originX: number, originY: number): void {
    const context = this.context;
    const layers = this.model?.layers ?? [];
    const drawn = new Map(
      (this.model?.character.layers ?? []).map((layer) => [layer.layer, layer]),
    );
    const selected = this.model?.chrome.openLayerId;
    const point = (x: number, y: number): [number, number] => [
      originX + x * zoom + zoom / 2,
      originY + y * zoom + zoom / 2,
    ];

    context.save();
    context.lineWidth = Math.max(1, Math.round(zoom / 3));

    for (const layer of layers) {
      const child = drawn.get(layer.id);
      const parentId = layer.parent;
      if (child === undefined || !parentId) {
        continue;
      }
      const parent = drawn.get(parentId);
      if (parent === undefined) {
        continue;
      }
      const anchor = layers
        .find((candidate) => candidate.id === parentId)
        ?.anchors?.find((candidate) => candidate.id === layer.parentAnchor);
      const from = anchor
        ? point(parent.origin[0] + anchor.at[0], parent.origin[1] + anchor.at[1])
        : point(parent.origin[0], parent.origin[1]);
      const to = point(child.rect[0] + child.rect[2] / 2, child.rect[1] + child.rect[3] / 2);

      context.strokeStyle =
        layer.id === selected || parentId === selected ? JOINT_COLOR : BONE_COLOR;
      context.beginPath();
      context.moveTo(from[0], from[1]);
      context.lineTo(to[0], to[1]);
      context.stroke();
    }

    // The joints themselves, on top of the bones so they stay readable.
    const radius = Math.max(2, Math.round(zoom * 0.9));
    context.fillStyle = JOINT_COLOR;
    for (const layer of layers) {
      const placed = drawn.get(layer.id);
      if (placed === undefined) {
        continue;
      }
      for (const anchor of layer.anchors ?? []) {
        const [x, y] = point(placed.origin[0] + anchor.at[0], placed.origin[1] + anchor.at[1]);
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
      }
    }
    context.restore();
  }

  /** One line per authored pixel, once they are big enough to aim at. */
  private strokeGrid(
    resolution: SpriteResolution,
    zoom: number,
    originX: number,
    originY: number,
  ): void {
    const context = this.context;
    context.save();
    context.strokeStyle = GRID_COLOR;
    context.lineWidth = 1;
    context.beginPath();
    for (let x = 1; x < resolution.width; x += 1) {
      context.moveTo(originX + x * zoom + 0.5, originY);
      context.lineTo(originX + x * zoom + 0.5, originY + resolution.height * zoom);
    }
    for (let y = 1; y < resolution.height; y += 1) {
      context.moveTo(originX, originY + y * zoom + 0.5);
      context.lineTo(originX + resolution.width * zoom, originY + y * zoom + 0.5);
    }
    context.stroke();
    context.restore();
  }

  /**
   * The checkerboard that says "nothing is drawn here", on the canvas itself.
   *
   * Its squares are a whole number of **authored** pixels, so it reads as the
   * grid being painted on and zooms with it. It covers the authored canvas and
   * nothing else, which also makes the canvas visible as a region.
   */
  private paintTransparency(
    resolution: SpriteResolution,
    zoom: number,
    originX: number,
    originY: number,
    colors: readonly [string, string],
  ): void {
    const context = this.context;
    const [light, dark] = colors;
    const width = resolution.width * zoom;
    const height = resolution.height * zoom;

    context.save();
    context.fillStyle = light;
    context.fillRect(originX, originY, width, height);

    // How many authored pixels one square is: one, unless one would be too
    // small to read, in which case as few as still clear MIN_CHECKER.
    const step = Math.max(1, Math.ceil(MIN_CHECKER / zoom));
    const square = step * zoom;
    context.fillStyle = dark;
    for (let row = 0; row * step < resolution.height; row += 1) {
      for (let column = row % 2; column * step < resolution.width; column += 2) {
        context.fillRect(
          originX + column * square,
          originY + row * square,
          Math.min(square, width - column * square),
          Math.min(square, height - row * square),
        );
      }
    }
    context.restore();
  }

  /** The authored canvas, so an author sees what their pixels are measured in. */
  private strokeCanvasBounds(
    resolution: SpriteResolution,
    zoom: number,
    originX: number,
    originY: number,
  ): void {
    const context = this.context;
    context.save();
    context.strokeStyle = CANVAS_BOUNDS_COLOR;
    context.setLineDash([2, 3]);
    context.strokeRect(
      originX + 0.5,
      originY + 0.5,
      resolution.width * zoom - 1,
      resolution.height * zoom - 1,
    );
    context.restore();
  }

  /** A box around the layer open in the form, drawn over the character. */
  private strokeOpenLayer(
    openLayerId: string,
    zoom: number,
    originX: number,
    originY: number,
  ): void {
    const drawn = this.model?.character.layers.find((layer) => layer.layer === openLayerId);
    if (drawn === undefined) {
      return;
    }
    const context = this.context;
    const [x, y, layerWidth, layerHeight] = drawn.rect;
    context.save();
    context.strokeStyle = OPEN_LAYER_COLOR;
    context.lineWidth = 1;
    context.strokeRect(
      originX + x * zoom - 0.5,
      originY + y * zoom - 0.5,
      layerWidth * zoom + 1,
      layerHeight * zoom + 1,
    );
    context.restore();
  }
}
