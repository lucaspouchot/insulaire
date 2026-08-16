/**
 * The editor shell: one tab per editor module, and the active module below.
 *
 * It owns no content state — the modules do — so switching tabs never touches
 * a document.
 */

import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { EDITOR_MODULES } from './editor-modules';

@Component({
  selector: 'app-editor-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './editor-shell.html',
  styleUrl: './editor-shell.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditorShell {
  protected readonly modules = EDITOR_MODULES;
}
