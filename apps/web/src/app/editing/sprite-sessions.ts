/**
 * The sprites an asset editor holds open, as one collection.
 *
 * The character, decoration, object and tile workspaces each carried their own
 * copy of this: a `Map<string, SpriteDocument>`, a decode-once guard, a private
 * `loadImage`, a batch `writeSprites`, an `unsaved` computed. Roughly 120 to 200
 * lines apiece, near-verbatim, reachable only through a `TestBed`. What differs
 * between the four is what a *path* names — a frame, an image, a variant — and
 * how its bytes are read and written; that is the {@link SpriteStore} port. The
 * collection is the same everywhere and is here.
 *
 * {@link SpriteDocument} keeps its own buffer, stroke and undo history
 * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`). This owns only the
 * set of them: which paths are open, which owe the disk a write, and the write
 * itself.
 *
 * # Scoped by the caller, not by a held id
 *
 * {@link unsavedIn} and {@link writeIn} take the paths to answer over rather
 * than reading an "open draft". The editing session asks whether *any* draft it
 * holds owes pixels — the unload guard sums it across all of them — not only the
 * one on screen (`app/editing/draft-set.ts`). A write is scoped for the
 * opposite reason: saving one draft must never write a sibling's PNG, which is
 * the looser "flush every unsaved buffer" the object editor shipped
 * (`.scratch/module-depth/issues/09-tile-editor-sprite-scope.md`).
 *
 * Signals, but no `inject()`: the store arrives through the constructor, so a
 * spec drives the whole of it with two object-literal methods and no DOM — the
 * bargain {@link import('./draft-set').DraftSet} and
 * {@link import('./flipbook-clock').FlipbookClock} make.
 *
 * Editor-only. The client build never reaches `app/editing/`
 * (`docs/adr/ADR-0015-client-delivery-build.md`).
 */

import { Signal, signal } from '@angular/core';

import { SpriteDocument } from '../../content/sprite-document';

/** The decoded pixels of one image, as {@link SpriteStore.load} returns them. */
export interface DecodedSprite {
  readonly width: number;
  readonly height: number;
  /** RGBA, row-major, `width * height * 4` bytes. */
  readonly pixels: Uint8ClampedArray;
}

/**
 * Where a collection's bytes come from and go.
 *
 * The one seam the collection is kept behind: `load` is the decode that has to
 * touch the DOM, and `write` is the content directory. A spec satisfies both
 * with plain functions.
 */
export interface SpriteStore {
  /** Reads the pixels a path names, or `null` when it names nothing readable. */
  load(path: string): Promise<DecodedSprite | null>;
  /** Writes a sprite's PNG bytes to a path. */
  write(path: string, blob: Blob): Promise<void>;
}

export class SpriteSessions {
  private readonly documents = new Map<string, SpriteDocument>();
  /**
   * Paths a load has been started for — decoded, in flight, or found missing.
   *
   * One set covers all three: it stops a second decode of an open sprite, a
   * duplicate fetch while the first is in flight, and a re-fetch every frame of
   * a path that names nothing. {@link discard} clears it so new bytes re-open.
   */
  private readonly attempted = new Set<string>();
  private readonly changes = signal(0);

  constructor(private readonly store: SpriteStore) {}

  /** Read in a `computed` to re-run it when the pixels, or the set, move. */
  readonly revision: Signal<number> = this.changes.asReadonly();

  /** The document open for a path, or `null` when none is. */
  get(path: string): SpriteDocument | null {
    this.changes();
    return this.documents.get(path) ?? null;
  }

  /** `true` when a document is open for this path. */
  has(path: string): boolean {
    this.changes();
    return this.documents.has(path);
  }

  /** Every open document with its path — for a palette drawn from the whole set. */
  entries(): readonly (readonly [string, SpriteDocument])[] {
    this.changes();
    return [...this.documents];
  }

  /**
   * Opens the document for a path, decoding its file the first time it is asked
   * for.
   *
   * Idempotent: a path already open, already loading, or already found missing
   * is left alone. Reads a signal only in the async continuation, so it is safe
   * to call from an `effect`.
   */
  open(path: string): void {
    if (path.length === 0 || this.attempted.has(path)) {
      return;
    }
    this.attempted.add(path);
    void this.decode(path);
  }

  /**
   * Holds a document made elsewhere under a path — a blank the size of a
   * layer's box, or a file dropped onto a variant.
   */
  add(path: string, document: SpriteDocument): void {
    this.documents.set(path, document);
    this.attempted.add(path);
    this.bump();
  }

  /** Drops the document for a path, so the next {@link open} decodes it afresh. */
  discard(path: string): void {
    const held = this.documents.delete(path);
    this.attempted.delete(path);
    if (held) {
      this.bump();
    }
  }

  /** Drops every open document. */
  clear(): void {
    this.documents.clear();
    this.attempted.clear();
    this.bump();
  }

  /** Records that a document's pixels moved, so views re-read them. */
  touched(): void {
    this.bump();
  }

  /**
   * The paths among `scope` whose document owes the disk a write.
   *
   * Takes the scope because the session asks this of every draft it holds, not
   * only the one on screen. `SpriteDocument.unsaved` is the single answer to
   * "is this sprite unwritten"; this aggregates it.
   */
  unsavedIn(scope: Iterable<string>): readonly string[] {
    this.changes();
    const open: string[] = [];
    for (const path of scope) {
      if (this.documents.get(path)?.unsaved === true) {
        open.push(path);
      }
    }
    return open;
  }

  /**
   * Writes the unsaved documents among `scope`, one PNG each, and marks them
   * saved.
   *
   * Scoped so a save of one draft never writes a sibling's pixels.
   *
   * @returns how many were written
   */
  async writeIn(scope: Iterable<string>): Promise<number> {
    const pending = this.unsavedIn(scope);
    for (const path of pending) {
      const document = this.documents.get(path);
      if (document === undefined) {
        continue;
      }
      await this.store.write(path, await document.toBlob());
      document.markSaved();
    }
    if (pending.length > 0) {
      this.bump();
    }
    return pending.length;
  }

  private async decode(path: string): Promise<void> {
    let decoded: DecodedSprite | null;
    try {
      decoded = await this.store.load(path);
    } catch {
      // The load itself threw rather than answering "no bytes" — an unexpected
      // failure, not a missing file. Clear the mark so the next `open` retries
      // it, the way the per-workspace `finally` used to.
      this.attempted.delete(path);
      return;
    }
    if (decoded === null) {
      // A path naming nothing is reported as a missing image by the screen; the
      // mark stays so it is not re-fetched until `discard` clears it.
      return;
    }
    this.documents.set(path, new SpriteDocument(decoded.width, decoded.height, decoded.pixels));
    this.bump();
  }

  private bump(): void {
    this.changes.update((count) => count + 1);
  }
}
