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
 *
 * Every label here is a **key**, not text: the editor is translated like the
 * rest of the interface (`docs/adr/ADR-0023-localised-content-keys.md`).
 */

export type EditorModuleStatus = 'available' | 'planned';

export interface EditorModule {
  /** Stable id, also the route segment under `/editor`. */
  readonly id: string;
  /** Key of the tab label. */
  readonly titleKey: string;
  /** Key of the one-line description of what the module edits. */
  readonly summaryKey: string;
  /** Whether the module is implemented. */
  readonly status: EditorModuleStatus;
  /** For planned modules: keys describing what it will be responsible for. */
  readonly planKeys?: readonly string[];
}

export const EDITOR_MODULES: readonly EditorModule[] = [
  {
    id: 'map',
    titleKey: 'ui.editor.modules.map.title',
    summaryKey: 'ui.editor.modules.map.summary',
    status: 'available',
  },
  {
    id: 'title',
    titleKey: 'ui.editor.modules.title.title',
    summaryKey: 'ui.editor.modules.title.summary',
    status: 'available',
  },
  {
    id: 'settings',
    titleKey: 'ui.editor.modules.settings.title',
    summaryKey: 'ui.editor.modules.settings.summary',
    status: 'available',
  },
  {
    id: 'locale',
    titleKey: 'ui.editor.modules.locale.title',
    summaryKey: 'ui.editor.modules.locale.summary',
    status: 'available',
  },
  {
    id: 'character',
    titleKey: 'ui.editor.modules.character.title',
    summaryKey: 'ui.editor.modules.character.summary',
    status: 'planned',
    planKeys: [
      'ui.editor.modules.character.plans.templates',
      'ui.editor.modules.character.plans.decks',
      'ui.editor.modules.character.plans.validation',
    ],
  },
  {
    id: 'asset',
    titleKey: 'ui.editor.modules.asset.title',
    summaryKey: 'ui.editor.modules.asset.summary',
    status: 'planned',
    planKeys: [
      'ui.editor.modules.asset.plans.images',
      'ui.editor.modules.asset.plans.tileSets',
      'ui.editor.modules.asset.plans.preview',
    ],
  },
  {
    id: 'scenario',
    titleKey: 'ui.editor.modules.scenario.title',
    summaryKey: 'ui.editor.modules.scenario.summary',
    status: 'planned',
    planKeys: [
      'ui.editor.modules.scenario.plans.runtime',
      'ui.editor.modules.scenario.plans.triggers',
      'ui.editor.modules.scenario.plans.noLogic',
    ],
  },
];

/** The module with this id, if it is registered. */
export function editorModule(id: string): EditorModule | undefined {
  return EDITOR_MODULES.find((module) => module.id === id);
}
