/**
 * The asset editor's category registry.
 *
 * What `editor-modules.ts` is to the editor shell, this is to the asset module:
 * the one list the child routes, the rail and the placeholder page all read, so
 * a new kind of drawn thing is one entry now and one component later
 * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`,
 * `docs/adr/ADR-0016-editor-modules.md`).
 *
 * Every label is a **key**, not text
 * (`docs/adr/ADR-0020-localised-content-keys.md`).
 */

/** A family of assets the editor browses. */
export interface AssetCategory {
  /** Stable id, also the route segment under `/editor/asset`. */
  readonly id: string;
  /** Key of the label. */
  readonly titleKey: string;
  /** Key of the one-line description of what this category holds. */
  readonly summaryKey: string;
  /** Whether this build can open it. */
  readonly status: 'available' | 'planned';
}

/**
 * What the rail lists.
 *
 * Four open today, and the order is what an author walks through: the ground,
 * who stands on it, what is put on it, and what is carried away from it. The
 * rest are declared rather than hidden, for the reason the shell declares its
 * planned modules: the rail is the map of what the tool will hold.
 */
export const ASSET_CATEGORIES: readonly AssetCategory[] = [
  {
    id: 'tiles',
    titleKey: 'ui.editor.asset.categories.tiles',
    summaryKey: 'ui.editor.asset.categories.tilesSummary',
    status: 'available',
  },
  {
    id: 'characters',
    titleKey: 'ui.editor.asset.categories.characters',
    summaryKey: 'ui.editor.asset.categories.charactersSummary',
    status: 'available',
  },
  {
    id: 'decorations',
    titleKey: 'ui.editor.asset.categories.decorations',
    summaryKey: 'ui.editor.asset.categories.decorationsSummary',
    status: 'available',
  },
  {
    id: 'objects',
    titleKey: 'ui.editor.asset.categories.objects',
    summaryKey: 'ui.editor.asset.categories.objectsSummary',
    status: 'available',
  },
  {
    id: 'effects',
    titleKey: 'ui.editor.asset.categories.effects',
    summaryKey: 'ui.editor.asset.categories.effectsSummary',
    status: 'planned',
  },
];

/** The category with this id, if it is registered. */
export function assetCategory(id: string): AssetCategory | undefined {
  return ASSET_CATEGORIES.find((entry) => entry.id === id);
}
