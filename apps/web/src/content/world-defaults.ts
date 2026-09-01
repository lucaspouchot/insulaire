/**
 * What an unauthored world looks like, composed from the generated bounds.
 *
 * `generated/world.ts` carries the bounds themselves, derived from
 * `crates/world/src/definition.rs`. These are the shapes those bounds add up
 * to — what `GridStyle::default()` and `RevealStyle::default()` mean, spelled
 * so the editor can seed a control with them. They are written here rather than
 * generated because they hold no information of their own: every value in them
 * is one of the constants above, so they cannot disagree with Rust unless a
 * constant does.
 */
import {
  DEFAULT_GRID_ALPHA,
  DEFAULT_GRID_COLOR,
  DEFAULT_GRID_LINE_WIDTH,
  DEFAULT_REVEAL_NEIGHBOUR_OPACITY,
  DEFAULT_REVEAL_OPACITY,
  DEFAULT_REVEAL_RADIUS,
  type GridStyle,
  type RevealStyle,
} from './generated/world';

/** The grid appearance a map with no authored {@link GridStyle} is drawn with. */
export const DEFAULT_GRID_STYLE: Readonly<GridStyle> = {
  lineWidth: DEFAULT_GRID_LINE_WIDTH,
  color: DEFAULT_GRID_COLOR,
  alpha: DEFAULT_GRID_ALPHA,
};

/** The reveal behaviour a map with no authored {@link RevealStyle} is drawn with. */
export const DEFAULT_REVEAL_STYLE: Readonly<RevealStyle> = {
  radius: DEFAULT_REVEAL_RADIUS,
  opacity: DEFAULT_REVEAL_OPACITY,
  neighbourOpacity: DEFAULT_REVEAL_NEIGHBOUR_OPACITY,
};

/** `true` when nothing but the defaults is authored. */
export function isDefaultRevealStyle(reveal: RevealStyle): boolean {
  return (
    reveal.radius === DEFAULT_REVEAL_RADIUS &&
    reveal.opacity === DEFAULT_REVEAL_OPACITY &&
    reveal.neighbourOpacity === DEFAULT_REVEAL_NEIGHBOUR_OPACITY
  );
}
