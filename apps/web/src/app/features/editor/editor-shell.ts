/**
 * The editor shell: one tab per editor module, and the active module below.
 *
 * It owns no content state — the modules do — so switching tabs never touches
 * a document.
 *
 * It does name the **content directory being authored**, because that is the
 * one piece of context every module shares and the one mistake that is
 * expensive to notice late: editing the repository fixture while believing you
 * are editing your game (`docs/adr/ADR-0022-authoring-content-workspace.md`).
 */

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { TranslatePipe } from '../../i18n/translate.pipe';
import { ContentWorkspaceService } from '../../services/content-workspace.service';
import { EDITOR_MODULES } from './editor-modules';

@Component({
  selector: 'app-editor-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, TranslatePipe],
  templateUrl: './editor-shell.html',
  styleUrl: './editor-shell.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditorShell {
  protected readonly modules = EDITOR_MODULES;
  private readonly workspace = inject(ContentWorkspaceService);

  /** Absolute path of the directory being authored, once the server answers. */
  protected readonly workspaceRoot = computed(() => this.workspace.status()?.root ?? null);

  /** The last path segment, which is what identifies a workspace at a glance. */
  protected readonly workspaceName = computed(() => {
    const root = this.workspaceRoot();
    return root === null ? null : (root.split('/').filter(Boolean).pop() ?? root);
  });

  constructor() {
    void this.workspace.ensureProbed();
  }
}
