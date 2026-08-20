/**
 * The page every planned editor module *and* every planned asset category
 * routes to until it exists.
 *
 * One component for all of them, driven by what the route carries rather than
 * by a registry lookup: a module is declared in `editor-modules.ts` and a
 * category in `asset-categories.ts`, and this page has no business knowing
 * which of the two it is standing in for
 * (`docs/adr/ADR-0019-editor-modules.md`,
 * `docs/adr/ADR-0039-one-editor-for-everything-drawn.md`).
 */

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';

import { TranslatePipe } from '../../../i18n/translate.pipe';

/** What a route hands this page. */
export interface PlannedEntry {
  /** Key of the title. */
  readonly titleKey: string;
  /** Key of the one-line description of what it will edit. */
  readonly summaryKey: string;
  /** Keys describing what it will be responsible for, if any were written. */
  readonly planKeys?: readonly string[];
  /** File the entry is declared in, named on screen so the shape is findable. */
  readonly source: string;
}

@Component({
  selector: 'app-planned-page',
  imports: [TranslatePipe],
  templateUrl: './planned-page.html',
  styleUrl: './planned-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlannedPage {
  private readonly data = toSignal(inject(ActivatedRoute).data, {
    initialValue: {} as Record<string, unknown>,
  });

  protected readonly entry = computed<PlannedEntry | undefined>(() => {
    const planned = this.data()['planned'];
    return typeof planned === 'object' && planned !== null ? (planned as PlannedEntry) : undefined;
  });
}
