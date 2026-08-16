# apps/web — Angular UI and world editor

The Angular half of Hex Engine. **Build and run it from the repository root**,
not from here: the WebAssembly engine and the authored content both live
outside this directory.

```bash
cd ../..
npm install
npm run wasm:build
npm run dev
```

See the [root README](../../README.md) for the full walkthrough and
[`docs/wasm-api.md`](../../docs/wasm-api.md) for the engine boundary.

## Layout

| Directory | Contents | Depends on Angular? |
|---|---|---|
| `src/core/hex/` | Offset ↔ axial transforms, pointy-top pixel layout | no |
| `src/content/` | Authored document model, canonical serialiser | no |
| `src/renderer/` | Canvas renderer, camera, sprite registry, input plumbing | no |
| `src/engine/` | Boundary types, runtime WASM loader | no |
| `src/app/` | Shell, services, editor page, play page | yes |

Only `src/app/` knows Angular exists. Everything else is plain TypeScript, which
is what keeps the renderer and the content model testable without a component
fixture — and reusable if the UI framework ever changes.

None of it contains game rules; those live in `crates/` and are reached through
`EngineService`.

## Generated directories

Both are git-ignored and rebuilt on demand:

- `public/wasm/` — written by `npm run wasm:build` from the repository root.
- `public/content/` — mirrored from `/content` by `scripts/sync-content.mjs`,
  which runs automatically before `start`, `build` and `test`.

## Scripts

Run these from the repository root so the content mirror stays fresh.

| Script | Purpose |
|---|---|
| `npm start` | Dev server on <http://localhost:4200>. |
| `npm run build` | Production bundle into `dist/web/browser/`. |
| `npm test` | Vitest, via `@angular/build:unit-test`. |
