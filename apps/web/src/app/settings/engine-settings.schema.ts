/**
 * The application's own settings: the ones that configure the shell, not the
 * game.
 *
 * Window size, interface scale, text speed, volumes, language, and the seed a
 * new game starts from. They are declared here rather than in content because
 * the *application* implements each one — a game cannot invent "make the text
 * faster" without code — and because the engine has no business knowing that a
 * screen has a size (`docs/adr/ADR-0025-settings.md`).
 *
 * They use the **same** {@link ControlDefinition} vocabulary the game's settings
 * use, so one component renders both and an author learns one set of concepts.
 * Labels are keys, like all displayed text; content may override any of them by
 * defining the same key (ADR-0023).
 */

import { ControlDefinition, SettingsSection, SettingValue } from '../../content/content-types';

/** Ids of the settings the application implements, for callers that read them. */
export const ENGINE_SETTING = {
  language: 'ui.language',
  scale: 'ui.scale',
  textSpeed: 'ui.textSpeed',
  fullscreen: 'display.fullscreen',
  windowSize: 'display.windowSize',
  master: 'audio.master',
  music: 'audio.music',
  effects: 'audio.effects',
  seedMode: 'game.seedMode',
  seed: 'game.seed',
} as const;

/**
 * Window sizes offered when the game runs in the desktop shell.
 *
 * A list rather than two number fields: a player picking a window size is
 * choosing a shape, and an arbitrary pair of numbers is how you end up with a
 * window taller than the screen.
 *
 * All 16:9, and the smallest is the shell's own minimum
 * (`apps/desktop/tauri.conf.json`). The interface scale divides the room the
 * layout has — at 150% a 1280-wide window is a 853-wide layout — so the shape
 * the screens are designed against is the one worth offering, and a floor under
 * it is what keeps a scaled-up interface from running out of width.
 */
export const WINDOW_SIZES: Readonly<Record<string, { width: number; height: number }>> = {
  '1280x720': { width: 1280, height: 720 },
  '1600x900': { width: 1600, height: 900 },
  '1920x1080': { width: 1920, height: 1080 },
};

/**
 * The application's settings, as sections the settings screen renders.
 *
 * `languages` is passed in because the choices come from the project: a game
 * that ships one language should not offer a picker with two.
 */
export function engineSettingsSections(
  languages: readonly { id: string; name: string }[],
  hasWindow: boolean,
): SettingsSection[] {
  const display: ControlDefinition[] = [
    {
      id: ENGINE_SETTING.scale,
      labelKey: 'ui.settings.scale',
      helpKey: 'ui.settings.scaleHelp',
      control: 'slider',
      default: 100,
      min: 75,
      max: 150,
      step: 5,
      unit: '%',
      scope: 'session',
    },
  ];

  // Only a shell with a window can resize it or leave fullscreen: in a browser
  // tab, and in a phone application, these would be controls that do nothing
  // (`docs/adr/ADR-0020-desktop-executable.md`). The interface scale above is
  // offered everywhere, because everywhere can zoom.
  if (hasWindow) {
    display.unshift(
      {
        id: ENGINE_SETTING.fullscreen,
        labelKey: 'ui.settings.fullscreen',
        control: 'toggle',
        default: false,
        scope: 'session',
      },
      {
        id: ENGINE_SETTING.windowSize,
        labelKey: 'ui.settings.windowSize',
        control: 'select',
        default: '1280x720',
        scope: 'session',
        showIf: { field: ENGINE_SETTING.fullscreen, equals: false },
        options: Object.keys(WINDOW_SIZES).map((value) => ({
          value,
          // The label is the size itself; no translation would improve "1280x720".
          labelKey: `ui.settings.windowSize.${value}`,
        })),
      },
    );
  }

  return [
    {
      id: 'application',
      labelKey: 'ui.settings.application',
      groups: [
        {
          id: 'display',
          labelKey: 'ui.settings.display',
          fields: display,
        },
        {
          id: 'language',
          labelKey: 'ui.settings.languageGroup',
          fields: [
            {
              id: ENGINE_SETTING.language,
              labelKey: 'ui.settings.language',
              control: 'select',
              default: languages[0]?.id ?? 'en',
              scope: 'session',
              // Named in their own language, which is how a picker is readable
              // to someone who cannot read the current one.
              options: languages.map((language) => ({
                value: language.id,
                labelKey: `ui.settings.languageName.${language.id}`,
              })),
            },
            {
              id: ENGINE_SETTING.textSpeed,
              labelKey: 'ui.settings.textSpeed',
              helpKey: 'ui.settings.textSpeedHelp',
              control: 'select',
              default: 'normal',
              scope: 'session',
              options: [
                { value: 'slow', labelKey: 'ui.settings.textSpeedSlow' },
                { value: 'normal', labelKey: 'ui.settings.textSpeedNormal' },
                { value: 'fast', labelKey: 'ui.settings.textSpeedFast' },
                { value: 'instant', labelKey: 'ui.settings.textSpeedInstant' },
              ],
            },
          ],
        },
        {
          id: 'audio',
          labelKey: 'ui.settings.audio',
          fields: [
            volume(ENGINE_SETTING.master, 'ui.settings.volumeMaster', 100),
            volume(ENGINE_SETTING.music, 'ui.settings.volumeMusic', 70),
            volume(ENGINE_SETTING.effects, 'ui.settings.volumeEffects', 80),
          ],
        },
        {
          id: 'determinism',
          labelKey: 'ui.settings.determinism',
          fields: [
            {
              id: ENGINE_SETTING.seedMode,
              labelKey: 'ui.settings.seedMode',
              helpKey: 'ui.settings.seedModeHelp',
              control: 'select',
              default: 'fixed',
              scope: 'newGame',
              options: [
                { value: 'fixed', labelKey: 'ui.settings.seedFixed' },
                { value: 'random', labelKey: 'ui.settings.seedRandom' },
              ],
            },
            {
              id: ENGINE_SETTING.seed,
              labelKey: 'ui.settings.seed',
              control: 'number',
              default: 2026,
              min: 0,
              max: 4294967295,
              step: 1,
              scope: 'newGame',
              showIf: { field: ENGINE_SETTING.seedMode, equals: 'fixed' },
            },
          ],
        },
      ],
    },
  ];
}

/** Every application setting's default, by id. */
export function engineSettingsDefaults(
  languages: readonly { id: string; name: string }[],
  hasWindow: boolean,
): Record<string, SettingValue> {
  const defaults: Record<string, SettingValue> = {};
  for (const section of engineSettingsSections(languages, hasWindow)) {
    for (const group of section.groups) {
      for (const field of group.fields) {
        defaults[field.id] = field.default;
      }
    }
  }
  return defaults;
}

function volume(id: string, labelKey: string, value: number): ControlDefinition {
  return {
    id,
    labelKey,
    control: 'slider',
    default: value,
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    scope: 'session',
  };
}
