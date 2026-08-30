/**
 * A category the rail lists and this build cannot open.
 *
 * It wears the frame rather than replacing the screen, because the rail is how
 * you get back out: a placeholder that took the whole window would strand an
 * author who clicked *Objects* to see what was there
 * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
 */

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';

import { TranslatePipe } from '../../../i18n/translate.pipe';
import { AssetWorkspace } from './asset-workspace';
import { AssetCategory, assetCategory } from './asset-categories';

@Component({
  selector: 'app-planned-category',
  imports: [TranslatePipe, AssetWorkspace],
  templateUrl: './planned-category.html',
  styleUrl: './planned-category.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlannedCategory {
  private readonly data = toSignal(inject(ActivatedRoute).data, {
    initialValue: {} as Record<string, unknown>,
  });

  protected readonly category = computed<AssetCategory | undefined>(() =>
    assetCategory(String(this.data()['category'] ?? '')),
  );
}
