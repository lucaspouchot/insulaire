/** Presentation helpers for selecting a character's semantic movement role. */

import { AnimationRole } from '../content/generated/character';
import { offsetToAxial } from '../core/hex/hex-coords';

/** The exact axial direction of an accepted one-hex movement event. */
export function roleForMove(
  from: readonly [number, number],
  to: readonly [number, number],
): AnimationRole {
  const start = offsetToAxial({ col: from[0], row: from[1] });
  const end = offsetToAxial({ col: to[0], row: to[1] });
  switch (`${end.q - start.q},${end.r - start.r}`) {
    case '1,0':
      return 'moveEast';
    case '1,-1':
      return 'moveNorthEast';
    case '0,-1':
      return 'moveNorthWest';
    case '-1,0':
      return 'moveWest';
    case '-1,1':
      return 'moveSouthWest';
    case '0,1':
      return 'moveSouthEast';
    default:
      // Simulation only emits adjacent moves. Keep a deterministic facing if a
      // malformed event reaches presentation rather than turning drawing into
      // another command-validation path.
      return end.q < start.q ? 'moveWest' : 'moveEast';
  }
}

/** Linear presentation progress of an accepted entity movement. */
export function movementProgress(startedAt: number, durationMs: number, now: number): number {
  if (durationMs <= 0) {
    return 1;
  }
  return Math.max(0, Math.min(1, (now - startedAt) / durationMs));
}
