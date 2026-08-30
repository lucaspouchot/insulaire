import { inject } from '@angular/core';
import { Routes } from '@angular/router';

import { I18nService } from './i18n/i18n.service';

/** Document title for a route, resolved in the language in use (ADR-0020). */
function pageTitle(key: string): () => string {
  return () => inject(I18nService).t(key);
}

/**
 * Routes of the **client** delivery: the game, and nothing else.
 *
 * This file is substituted for `app.routes.ts` by the `deliver` build
 * configuration. It deliberately contains no reference to the editor — not a
 * guarded import, not a dead branch — because a dynamic `import()` inside dead
 * code still makes the bundler emit the chunk. Absence here is what makes the
 * editor absent from the delivered bundle
 * (`docs/adr/ADR-0015-client-delivery-build.md`).
 */
export const routes: Routes = [
  // A delivered game opens on its title screen, never on a map
  // (`docs/adr/ADR-0021-authored-title-screen.md`).
  { path: '', pathMatch: 'full', redirectTo: 'title' },
  {
    path: 'title',
    title: pageTitle('ui.title.documentTitle'),
    loadComponent: () => import('./features/title/title-page').then((m) => m.TitlePage),
  },
  {
    path: 'settings',
    title: pageTitle('ui.settings.settingsTitle'),
    loadComponent: () => import('./settings/settings-page').then((m) => m.SettingsPage),
  },
  {
    path: 'character-creation',
    title: pageTitle('ui.creation.documentTitle'),
    loadComponent: () =>
      import('./features/character-creation/character-creation-page').then(
        (m) => m.CharacterCreationPage,
      ),
  },
  {
    path: 'play',
    title: pageTitle('ui.app.title.play'),
    loadComponent: () => import('./features/play/play-page').then((m) => m.PlayPage),
  },
  { path: '**', redirectTo: 'title' },
];
