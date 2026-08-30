/**
 * What this build of the application contains.
 *
 * There are two builds from one source tree: the **dev** build, which carries
 * the editor, and the **client** build, which does not. The client build swaps
 * this file for `build-features.deliver.ts` and `app.routes.ts` for
 * `app.routes.deliver.ts` through `fileReplacements` in `angular.json`, so the
 * editor's code is not merely hidden — it is never imported, and the bundler
 * emits no chunk for it (`docs/adr/ADR-0015-client-delivery-build.md`).
 *
 * Read this flag to decide what the *shell* offers. Never use it to change game
 * rules or content handling: both builds must play a world identically.
 */
import { BuildFeatures } from './build-features.model';

export const BUILD_FEATURES: BuildFeatures = {
  editor: true,
  label: 'dev',
};
