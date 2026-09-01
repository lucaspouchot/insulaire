/**
 * The settings screen: the application's settings and the game's, one list.
 *
 * The screen itself is generic — it walks sections, groups and fields and hands
 * each one to {@link ControlField}. Nothing here knows what "difficulty" means,
 * which is what lets a game declare its own settings and get a screen for them
 * (`docs/adr/ADR-0022-settings.md`).
 *
 * A `newGame` setting is shown **locked** while a game is running, rather than
 * hidden: the value is part of the game in progress, and a player looking for it
 * deserves to see it and be told why it cannot move. That covers the seed and
 * the game's own world settings alike — they are what the running game was
 * created with.
 *
 * The screen fills the window: the application bar is dropped for it, as it is
 * for the title screen, so **Back** is the way out and it has to lead somewhere
 * sensible. `?from=` carries that, set by whoever opened the screen; the title
 * screen is the fallback.
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import { ControlDefinition, SettingValue } from '../../content/generated/settings';
import { TranslatePipe } from '../i18n/translate.pipe';
import { EngineService } from '../services/engine.service';
import { ControlField } from './control-field';
import { ENGINE_SHORTCUT } from './engine-settings.schema';
import { SettingsService } from './settings.service';
import { describeError } from '../../core/errors';

const MOVEMENT_SLOT: Readonly<Record<string, string>> = {
  [ENGINE_SHORTCUT.moveNorthWest]: 'north-west',
  [ENGINE_SHORTCUT.moveNorthEast]: 'north-east',
  [ENGINE_SHORTCUT.moveWest]: 'west',
  [ENGINE_SHORTCUT.moveEast]: 'east',
  [ENGINE_SHORTCUT.moveSouthWest]: 'south-west',
  [ENGINE_SHORTCUT.moveSouthEast]: 'south-east',
};

@Component({
  selector: 'app-settings-page',
  imports: [ControlField, TranslatePipe],
  templateUrl: './settings-page.html',
  styleUrl: './settings-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPage {
  private readonly settings = inject(SettingsService);
  private readonly engine = inject(EngineService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /** Every section, application first, then whatever the game declares. */
  protected readonly sections = this.settings.sections;
  /** Why the game's settings could not be loaded, if they could not. */
  protected readonly error = signal<string | null>(null);
  /**
   * The section being shown; the first one until the player picks another.
   *
   * Seeded from `?section=`, which makes a tab addressable — useful for a link
   * straight to the audio settings, and for a screenshot of one tab.
   */
  protected readonly activeSection = signal<string | null>(
    this.route.snapshot.queryParamMap.get('section'),
  );

  protected readonly section = computed(() => {
    const sections = this.sections();
    const active = this.activeSection();
    return sections.find((candidate) => candidate.id === active) ?? sections.at(0) ?? null;
  });

  /**
   * `true` while a game is running.
   *
   * What it locks is the `newGame` settings: the game was created with them.
   */
  protected readonly inGame = this.engine.hasGame;

  /** Where **Back** leads: where the screen was opened from, else the title. */
  private readonly returnTo = computed(() => {
    const from = this.route.snapshot.queryParamMap.get('from') ?? '';
    // Only an in-application path, and never a protocol-relative one: this
    // value comes off the URL bar, so it is not trusted to name a destination.
    return /^\/(?!\/)/.test(from) ? from : '/title';
  });

  constructor() {
    void this.settings.ensureLoaded().catch((cause: unknown) => {
      this.error.set(describeError(cause));
    });
  }

  protected value(field: ControlDefinition): SettingValue {
    return this.settings.value(field);
  }

  protected isVisible(field: ControlDefinition): boolean {
    return this.settings.isVisible(field);
  }

  protected isLocked(field: ControlDefinition): boolean {
    return field.scope === 'newGame' && this.inGame();
  }

  /** The engine's six spatial controls get a map-like presentation of their own. */
  protected isMovementKeypad(sectionId: string, groupId: string): boolean {
    return sectionId === 'application-controls' && groupId === 'movement';
  }

  /** CSS grid slot occupied by one universal movement action. */
  protected movementSlot(fieldId: string): string {
    return MOVEMENT_SLOT[fieldId] ?? '';
  }

  protected change(field: ControlDefinition, value: SettingValue): void {
    this.settings.set(field, value);
  }

  /** The player let go: what waits for that is applied now. */
  protected commit(field: ControlDefinition, value: SettingValue): void {
    this.settings.commit(field, value);
  }

  protected select(sectionId: string): void {
    this.activeSection.set(sectionId);
    // Reflected in the URL so the tab survives a refresh and can be linked to.
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { section: sectionId },
      // Merged, or picking a tab would forget where Back has to lead.
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  protected reset(): void {
    this.settings.reset();
  }

  protected async back(): Promise<void> {
    await this.router.navigateByUrl(this.returnTo());
  }
}
