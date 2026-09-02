/**
 * The content directory as a picker sees it: a list to choose from, split by
 * the kinds a field may name, and a way to drop a new file in.
 *
 * A screen that offers a file picker needs the whole listing (to tell a named
 * file that is missing from one that is merely unsaved), a kind-filtered view
 * of it, and an upload that lands a file and then re-reads the directory so the
 * picker shows it. None of that is screen-specific — what a picked or uploaded
 * path then *means* is (point a frame at it, announce it, drop a stale decode),
 * and that stays with the screen.
 *
 * {@link ContentWorkspaceService} is the door to the authoring server; this is
 * the little of that door a form uses, plus the derived views over it.
 */

import { Injectable, Signal, computed, inject, signal } from '@angular/core';

import { ContentWorkspaceService, WorkspaceFile } from './content-workspace.service';

@Injectable({ providedIn: 'root' })
export class WorkspaceFiles {
  private readonly workspace = inject(ContentWorkspaceService);

  private readonly listing = signal<readonly WorkspaceFile[]>([]);

  /** Every file the authoring server is serving, as of the last {@link refresh}. */
  readonly all: Signal<readonly WorkspaceFile[]> = this.listing;

  /** The subset a sprite frame or a character variant may name. */
  readonly images = this.matching(/\.(png|gif|webp)$/i);

  /** The subset a title screen's background may name — still art, wider set. */
  readonly pictures = this.matching(/\.(png|jpe?g|webp|gif|svg)$/i);

  /** The subset a music slot may name. */
  readonly tracks = this.matching(/\.(ogg|mp3|wav|m4a)$/i);

  /**
   * Re-reads the directory. A no-op when no authoring server has answered: the
   * editor stays usable read-only, and a listing of nothing is the honest state.
   */
  async refresh(): Promise<void> {
    if (this.workspace.status() === null) {
      return;
    }
    try {
      this.listing.set(await this.workspace.list());
    } catch {
      // Reported by ContentWorkspaceService; the editor stays usable without it.
    }
  }

  /**
   * Writes `file` into `dir` under its own name, refreshes the listing, and
   * returns the content-relative path it was written to.
   */
  async upload(file: File, dir: string): Promise<string> {
    const path = `${dir}/${file.name}`;
    await this.workspace.write(path, file);
    await this.refresh();
    return path;
  }

  private matching(pattern: RegExp): Signal<readonly WorkspaceFile[]> {
    return computed(() => this.listing().filter((file) => pattern.test(file.path)));
  }
}
