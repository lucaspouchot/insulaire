import { inject } from '@angular/core';
import { Routes } from '@angular/router';

import { I18nService } from './i18n/i18n.service';

/** Document title for a route, resolved in the language in use (ADR-0020). */
function pageTitle(key: string): () => string {
  return () => inject(I18nService).t(key);
}

/**
 * Routes of the **dev** build: the game plus the editor.
 *
 * The client build replaces this file with `app.routes.deliver.ts`, which does
 * not import `editor.routes` at all — so the editor is absent from the bundle
 * rather than merely unreachable (`docs/adr/ADR-0015-client-delivery-build.md`).
 *
 * Everything is lazily loaded, so the editor's code does not sit in the play
 * bundle and vice versa.
 */
export const routes: Routes = [
  // Both builds open on the title screen: the player's first screen is the one
  // developers should be looking at too (`docs/adr/ADR-0021-authored-title-screen.md`).
  { path: '', pathMatch: 'full', redirectTo: 'title' },
  {
    path: 'title',
    title: pageTitle('ui.title.documentTitle'),
    loadComponent: () => import('./features/title/title-page').then((m) => m.TitlePage),
  },
  {
    path: 'editor',
    loadChildren: () => import('./features/editor/editor.routes').then((m) => m.EDITOR_ROUTES),
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
