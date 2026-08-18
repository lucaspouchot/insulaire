/**
 * Routes of the editor, derived from {@link EDITOR_MODULES}.
 *
 * Everything editor-related hangs off this one file, and `app.routes.ts` is the
 * only place that imports it. That is what lets the client build drop the whole
 * editor by swapping a single route file
 * (`docs/adr/ADR-0018-client-delivery-build.md`).
 *
 * Document titles are **resolvers**, not literals: a title is text on a screen
 * like any other, so it goes through the same keys
 * (`docs/adr/ADR-0023-localised-content-keys.md`).
 */

import { inject } from '@angular/core';
import { Routes } from '@angular/router';

import { I18nService } from '../../i18n/i18n.service';
import { EDITOR_MODULES, EditorModule, editorModule } from './editor-modules';

/** The registered module with this id, or a build-time failure. */
function requireModule(id: string): EditorModule {
  const module = editorModule(id);
  if (module === undefined) {
    throw new Error(`Editor module "${id}" is routed but not registered in editor-modules.ts.`);
  }
  return module;
}

/** Resolves this module's document title in the language in use. */
function moduleTitle(module: EditorModule): () => string {
  return () => {
    const i18n = inject(I18nService);
    return i18n.t('ui.app.title.module', { module: i18n.t(module.titleKey) });
  };
}

export const EDITOR_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./editor-shell').then((m) => m.EditorShell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'map' },
      {
        path: 'map',
        title: moduleTitle(requireModule('map')),
        loadComponent: () => import('./map/map-editor-page').then((m) => m.MapEditorPage),
      },
      {
        path: 'title',
        title: moduleTitle(requireModule('title')),
        loadComponent: () => import('./title/title-editor-page').then((m) => m.TitleEditorPage),
      },
      {
        path: 'settings',
        title: moduleTitle(requireModule('settings')),
        loadComponent: () =>
          import('./settings/settings-editor-page').then((m) => m.SettingsEditorPage),
      },
      {
        path: 'character',
        title: moduleTitle(requireModule('character')),
        loadComponent: () =>
          import('./character/character-editor-page').then((m) => m.CharacterEditorPage),
      },
      {
        path: 'locale',
        title: moduleTitle(requireModule('locale')),
        loadComponent: () => import('./locale/locale-editor-page').then((m) => m.LocaleEditorPage),
      },
      ...EDITOR_MODULES.filter((module) => module.status === 'planned').map((module) => ({
        path: module.id,
        title: moduleTitle(module),
        data: { moduleId: module.id },
        loadComponent: () =>
          import('./planned/planned-module-page').then((m) => m.PlannedModulePage),
      })),
      { path: '**', redirectTo: 'map' },
    ],
  },
];
