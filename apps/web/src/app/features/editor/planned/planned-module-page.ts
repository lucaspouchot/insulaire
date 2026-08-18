/**
 * The page every planned editor module routes to until it exists.
 *
 * One component for all of them, driven by the route's `moduleId` and the
 * registry entry — so a new planned module costs an entry in
 * `editor-modules.ts` and nothing else.
 */

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';

import { TranslatePipe } from '../../../i18n/translate.pipe';
import { EditorModule, editorModule } from '../editor-modules';

@Component({
  selector: 'app-planned-module-page',
  imports: [TranslatePipe],
  templateUrl: './planned-module-page.html',
  styleUrl: './planned-module-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlannedModulePage {
  private readonly data = toSignal(inject(ActivatedRoute).data, { initialValue: {} as Record<string, unknown> });

  protected readonly module = computed<EditorModule | undefined>(() =>
    editorModule(String(this.data()['moduleId'] ?? '')),
  );
}
