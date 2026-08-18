/**
 * `{{ 'ui.play.controls.wait' | t }}` — the template side of {@link I18nService}.
 *
 * With parameters: `{{ 'ui.play.log.tick' | t: { tick: 12 } }}`.
 *
 * # Why it is impure
 *
 * A pure pipe caches by input, so switching language would leave every template
 * showing the text it computed for the previous one — the key does not change,
 * only the answer does. Marking it impure costs a map lookup per change
 * detection cycle, which is nothing next to a screen that lies about its
 * language.
 */

import { Pipe, PipeTransform, inject } from '@angular/core';

import { I18nService } from './i18n.service';

@Pipe({ name: 't', pure: false })
export class TranslatePipe implements PipeTransform {
  private readonly i18n = inject(I18nService);

  transform(key: string, params?: Readonly<Record<string, string | number>>): string {
    return this.i18n.t(key, params);
  }
}
