/**
 * Loads the WebAssembly engine at runtime.
 *
 * # Why a runtime import rather than a build-time one
 *
 * `wasm-pack build --target web` emits an ES module plus a sibling `.wasm`
 * file. Importing that module through the bundler drags the `.wasm` into the
 * Angular build graph, which is exactly the kind of tooling coupling that makes
 * "rebuild the engine" a fragile step.
 *
 * Instead the whole `pkg/` directory is published as a **static asset** under
 * `public/wasm/`, and loaded here with a dynamic `import()` of a runtime URL.
 * The bundler cannot analyse the specifier, so it leaves it alone; the browser
 * resolves it, and the glue's own `new URL('hex_engine_bg.wasm',
 * import.meta.url)` then resolves relative to `/wasm/`. Rebuilding the engine is
 * `npm run wasm:build` and a refresh — no Angular rebuild required.
 *
 * The cost is that generated typings are not used; {@link HexEngineModule} in
 * `engine.types.ts` states the contract by hand instead, which is also what
 * `docs/wasm-api.md` documents.
 */

import { assetUrl } from '../core/asset-url';
import { HexEngineModule } from './engine.types';

/**
 * Where `npm run wasm:build` writes the generated package, relative to the
 * document base — so a delivered bundle works from any subdirectory.
 */
export const ENGINE_MODULE_PATH = 'wasm/hex_engine.js';
export const ENGINE_WASM_PATH = 'wasm/hex_engine_bg.wasm';

let cached: Promise<HexEngineModule> | null = null;

/**
 * Loads and initialises the engine module exactly once per page.
 *
 * @throws Error with a build hint when the artefacts are missing.
 */
export function loadEngineModule(): Promise<HexEngineModule> {
  cached ??= importAndInit();
  return cached;
}

async function importAndInit(): Promise<HexEngineModule> {
  // Held in a variable so the bundler treats this as an external runtime import.
  const specifier = assetUrl(ENGINE_MODULE_PATH);

  let module: HexEngineModule;
  try {
    module = (await import(/* @vite-ignore */ specifier)) as HexEngineModule;
  } catch (cause) {
    throw new Error(
      `Could not load the WebAssembly engine from ${specifier}. ` +
        'Build it first with "npm run wasm:build".',
      { cause },
    );
  }

  // Passing the URL explicitly keeps initialisation working no matter how the
  // glue was served or rewritten.
  await module.default({ module_or_path: assetUrl(ENGINE_WASM_PATH) });
  return module;
}

/** Test seam: forgets the cached module so a fresh load can be exercised. */
export function resetEngineModuleCache(): void {
  cached = null;
}
