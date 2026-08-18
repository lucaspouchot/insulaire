/**
 * Renders one setting, whatever it is.
 *
 * This component is the reason the application's settings and the game's use one
 * vocabulary: a `slider` is drawn the same way whether it is the music volume or
 * a starting population, so a game gets a settings screen without a line of code
 * (`docs/adr/ADR-0025-settings.md`).
 *
 * It holds no policy — what a value *means*, whether it may change, where it
 * ends up — only how a `ControlDefinition` becomes an input and back.
 */

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { ControlDefinition, SettingValue } from '../../content/content-types';
import { TranslatePipe } from '../i18n/translate.pipe';

@Component({
  selector: 'app-control-field',
  imports: [TranslatePipe],
  templateUrl: './control-field.html',
  styleUrl: './control-field.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ControlField {
  /** The setting to render. */
  readonly field = input.required<ControlDefinition>();
  /** Its current value. */
  readonly value = input.required<SettingValue>();
  /** `true` when it may not be changed right now — a `newGame` setting in play. */
  readonly locked = input(false);

  /** Emitted with the new value whenever the player changes it. */
  readonly changed = output<SettingValue>();
  /**
   * Emitted when the player has *finished* changing it.
   *
   * For every control but the slider this is the same moment as
   * {@link changed} — a select changes once, when it is picked. A slider
   * reports continuously while it is dragged and again on release, which is
   * what lets a setting whose effect moves the interface itself wait for the
   * hand to come off (`settings.service.ts`).
   */
  readonly committed = output<SettingValue>();

  protected readonly asBoolean = computed(() => this.value() === true);
  protected readonly asNumber = computed(() =>
    typeof this.value() === 'number' ? (this.value() as number) : 0,
  );
  protected readonly asText = computed(() =>
    typeof this.value() === 'string' ? (this.value() as string) : '',
  );
  protected readonly asList = computed(() =>
    Array.isArray(this.value()) ? (this.value() as string[]) : [],
  );

  /** The number shown next to a slider, with its unit. */
  protected readonly readout = computed(() => `${this.asNumber()}${this.field().unit ?? ''}`);

  protected toggle(checked: boolean): void {
    this.emit(checked);
  }

  /** `live` is the slider being dragged: reported, but not yet let go of. */
  protected setNumber(raw: string, live = false): void {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed)) {
      this.emit(parsed, live);
    }
  }

  protected setText(raw: string): void {
    this.emit(raw);
  }

  /** Adds or removes one option of a `multiSelect`, keeping author order. */
  protected setInList(option: string, checked: boolean): void {
    const declared = (this.field().options ?? []).map((entry) => entry.value);
    const chosen = new Set(this.asList());
    if (checked) {
      chosen.add(option);
    } else {
      chosen.delete(option);
    }
    this.emit(declared.filter((value) => chosen.has(value)));
  }

  private emit(value: SettingValue, live = false): void {
    this.changed.emit(value);
    if (!live) {
      this.committed.emit(value);
    }
  }

  protected isChosen(option: string): boolean {
    return this.asList().includes(option);
  }
}
