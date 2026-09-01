/** Canonical writer for a generic character-creation declaration. */

import { CharacterCreationDefinition } from './generated/character-creation';

/**
 * The workflow is a nested authored document whose array order is meaningful.
 * Two-space JSON keeps that structure explicit and produces stable diffs; the
 * editor keeps omitted optional fields omitted rather than round-tripping an
 * engine-normalised copy.
 */
export function serializeCharacterCreation(definition: CharacterCreationDefinition): string {
  return `${JSON.stringify(definition, omitIgnoredScope, 2)}\n`;
}

/** `scope` belongs to settings and is ignored by creation choices and stats. */
function omitIgnoredScope(key: string, value: unknown): unknown {
  return key === 'scope' ? undefined : value;
}
