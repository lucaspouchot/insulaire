/**
 * Types for `sprite-bundle.mjs`, so the web specs can drive the **real** writer.
 *
 * The bundle format has two implementations — a Node writer and a browser
 * reader (`apps/web/src/content/sprite-bundle.ts`) — and the only way to keep
 * them honest is a test that runs both. That test is TypeScript, so the writer
 * needs a shape. Nothing in the application imports this: the scripts are plain
 * ESM and stay that way (`docs/adr/ADR-0040-tile-art-travels-as-one-bundle.md`).
 */

/** One file on its way into a bundle. */
export interface SpriteFile {
  path: string;
  type: string;
  bytes: Buffer;
}

export declare const MAGIC: string;
export declare const FORMAT_VERSION: number;
export declare const TILE_ART_BUNDLE: string;
export declare const TILE_ART_DIR: string;

export declare function packSpriteBundle(files: SpriteFile[]): Buffer;
export declare function collectSprites(root: string, directory: string): Promise<SpriteFile[]>;
export declare function spriteSignature(root: string, directory: string): Promise<string>;
