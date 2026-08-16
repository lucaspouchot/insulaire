/**
 * The shape of {@link BuildFeatures}, kept apart from the value.
 *
 * The value's file is swapped at build time (`build-features.ts` →
 * `build-features.deliver.ts`), so the two variants cannot import the type from
 * each other without importing themselves.
 */
export interface BuildFeatures {
  /** `true` when the editor is part of this build. */
  readonly editor: boolean;
  /** Short label shown next to the product name. */
  readonly label: string;
}
