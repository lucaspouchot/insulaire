/**
 * The editor's module registry.
 *
 * The editor is not one screen but a family of them: maps today, characters,
 * assets and scenarios later. They are declared here once and read by both the
 * routes (`editor.routes.ts`) and the shell's tab bar, so adding an editor is
 * one entry plus one component — never a second list to keep in step
 * (`docs/adr/ADR-0019-editor-modules.md`).
 *
 * Entries marked `planned` route to the placeholder page. They are listed on
 * purpose rather than hidden: the shell is the map of what the tool will be.
 */

export type EditorModuleStatus = 'available' | 'planned';

export interface EditorModule {
  /** Stable id, also the route segment under `/editor`. */
  readonly id: string;
  /** Tab label. */
  readonly title: string;
  /** One line describing what the module edits. */
  readonly summary: string;
  /** Whether the module is implemented. */
  readonly status: EditorModuleStatus;
  /** For planned modules: what it will be responsible for. */
  readonly plans?: readonly string[];
}

export const EDITOR_MODULES: readonly EditorModule[] = [
  {
    id: 'map',
    title: 'Maps',
    summary: 'Paint terrain and elevation, place entities and points of interest, link maps together.',
    status: 'available',
  },
  {
    id: 'character',
    title: 'Characters',
    summary: 'Entity templates: stats, behaviour, visuals, starting deck.',
    status: 'planned',
    plans: [
      'edit the entity templates the engine exposes through contentSummary()',
      'author per-character decks once combat content exists',
      'validate through the same Rust validator the map editor uses',
    ],
  },
  {
    id: 'asset',
    title: 'Assets',
    summary: 'Tile sets, sprites and visual ids resolved by the renderer.',
    status: 'planned',
    plans: [
      'import images and bind them to visualIds',
      'edit tile sets in place instead of by hand in JSON',
      'preview a tile set against a map without leaving the editor',
    ],
  },
  {
    id: 'scenario',
    title: 'Scenario',
    summary: 'Acts, phases, objectives, triggers, timers and consequences.',
    status: 'planned',
    plans: [
      'author the data-driven scenario runtime of ADR-0005',
      'wire triggers to map links, locations and gameplay tags',
      'no scenario-specific logic in the engine — only content',
    ],
  },
];

/** The module with this id, if it is registered. */
export function editorModule(id: string): EditorModule | undefined {
  return EDITOR_MODULES.find((module) => module.id === id);
}
