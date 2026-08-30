/**
 * The editor's door to the content directory on disk.
 *
 * A game is authored against real files — worlds, images, music — that live
 * outside this repository, in the directory `INSULAIRE_CONTENT_DIR` names. A
 * browser cannot write there, so the dev server proxies `/api/content` to a
 * small authoring server that can
 * (`docs/adr/ADR-0019-authoring-content-workspace.md`).
 *
 * **This is editor-only.** The game never calls it: content is read as static
 * files through {@link contentUrl}, exactly as the delivered executable reads
 * the files embedded next to it. Nothing in `app.routes.deliver.ts`'s import
 * graph may reach this service, or the client build would ship a call to a
 * server that is not there (`docs/adr/ADR-0015-client-delivery-build.md`).
 */

import { Injectable, signal } from '@angular/core';

import { assetUrl } from '../../core/asset-url';
import { BUILD_FEATURES } from '../build-features';

/** One file the authoring server is willing to serve. */
export interface WorkspaceFile {
  /** Path relative to the content directory, with `/` separators. */
  readonly path: string;
  readonly size: number;
  /** ISO 8601 timestamp of the last write. */
  readonly modifiedAt: string;
}

/** What the authoring server reports about itself. */
export interface WorkspaceStatus {
  /** Absolute path of the directory being served, for the editor to display. */
  readonly root: string;
  readonly readOnly: boolean;
}

/** URL of an authoring endpoint, resolved against the document base. */
function apiUrl(path = ''): string {
  return assetUrl(`api/content/${path.replace(/^\/+/, '')}`);
}

@Injectable({ providedIn: 'root' })
export class ContentWorkspaceService {
  /** The directory being authored, once probed; `null` when there is no server. */
  readonly status = signal<WorkspaceStatus | null>(null);
  /** Why the last call failed, for the editor to show. */
  readonly failure = signal<string | null>(null);

  private probe: Promise<WorkspaceStatus | null> | null = null;

  /**
   * Asks the authoring server what it is serving, at most once.
   *
   * A missing server is not an error: someone may be running the editor against
   * a plain static build. It resolves to `null`, and every write refuses.
   */
  async ensureProbed(): Promise<WorkspaceStatus | null> {
    this.probe ??= this.runProbe();
    return this.probe;
  }

  private async runProbe(): Promise<WorkspaceStatus | null> {
    if (!BUILD_FEATURES.editor) {
      return null;
    }
    try {
      const response = await fetch(apiUrl('health'));
      if (!response.ok) {
        return null;
      }
      const status = (await response.json()) as WorkspaceStatus;
      this.status.set(status);
      return status;
    } catch {
      // No authoring server on this origin; the editor stays usable read-only.
      return null;
    }
  }

  /** `true` once a writable authoring server has answered. */
  get isWritable(): boolean {
    const status = this.status();
    return status !== null && !status.readOnly;
  }

  /** Every content file in the directory, sorted by path. */
  async list(): Promise<readonly WorkspaceFile[]> {
    const payload = await this.json<{ files: WorkspaceFile[] }>(apiUrl('tree'));
    return payload.files;
  }

  /** Writes bytes to `path`, creating directories as needed. */
  async write(path: string, body: Blob | ArrayBuffer | string): Promise<void> {
    await this.json(apiUrl(path), { method: 'PUT', body: body as BodyInit });
  }

  /** Writes a content document, in the canonical layout the serialisers produce. */
  async writeJson(path: string, json: string): Promise<void> {
    await this.write(path, json);
  }

  /** Removes a file. Removing one that is not there is not an error. */
  async remove(path: string): Promise<void> {
    await this.json(apiUrl(path), { method: 'DELETE' });
  }

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    this.failure.set(null);
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (cause) {
      const message =
        'The authoring content server is not answering. Start the editor with "npm run dev".';
      this.failure.set(message);
      throw new Error(message, { cause });
    }
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) {
      const message = payload.error ?? `HTTP ${response.status}`;
      this.failure.set(message);
      throw new Error(message);
    }
    return payload;
  }
}
