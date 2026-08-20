/**
 * Routes of the editor, derived from {@link EDITOR_MODULES} and, one level
 * down, from {@link ASSET_CATEGORIES}.
 *
 * Everything editor-related hangs off this one file, and `app.routes.ts` is the
 * only place that imports it. That is what lets the client build drop the whole
 * editor by swapping a single route file
 * (`docs/adr/ADR-0018-client-delivery-build.md`).
 *
 * The asset module is the one with children: every kind of drawn thing is a
 * category under `/editor/asset`, and a planned one routes to the same
 * placeholder a planned module does
 * (`docs/adr/ADR-0039-one-editor-for-everything-drawn.md`).
 *
 * Document titles are **resolvers**, not literals: a title is text on a screen
 * like any other, so it goes through the same keys
 * (`docs/adr/ADR-0023-localised-content-keys.md`).
 */

import { inject } from '@angular/core';
import { Route, Routes } from '@angular/router';

import { I18nService } from '../../i18n/i18n.service';
import { ASSET_CATEGORIES, AssetCategory } from './asset/asset-categories';
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

/** Resolves an asset category's document title in the language in use. */
function categoryTitle(category: AssetCategory): () => string {
  return () => {
    const i18n = inject(I18nService);
    return i18n.t('ui.app.title.module', { module: i18n.t(category.titleKey) });
  };
}

/**
 * The component each available category opens.
 *
 * Declared here rather than in the registry so `asset-categories.ts` stays a
 * list of plain data — the same reason `editor-modules.ts` carries no component
 * references.
 */
const WORKSPACES: Record<string, NonNullable<Route['loadComponent']>> = {
  tiles: () => import('./asset/tile-workspace').then((m) => m.TileWorkspace),
  characters: () => import('./asset/character-workspace').then((m) => m.CharacterWorkspace),
};

/** The route for one asset category: its workspace, or the placeholder. */
function categoryRoute(category: AssetCategory): Route {
  const common = { path: category.id, title: categoryTitle(category) };
  if (category.status === 'planned') {
    return {
      ...common,
      path: category.id,
      data: { category: category.id },
      loadComponent: () => import('./asset/planned-category').then((m) => m.PlannedCategory),
    };
  }
  const workspace = WORKSPACES[category.id];
  if (workspace === undefined) {
    throw new Error(
      `Asset category "${category.id}" is available but has no workspace in editor.routes.ts.`,
    );
  }
  return { ...common, loadComponent: workspace };
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
      // No component of its own: the categories *are* the module, and each
      // workspace draws the rail itself through `AssetWorkspace`. A shell here
      // would only be a second element between the editor and the screen.
      {
        path: 'asset',
        children: [
          { path: '', pathMatch: 'full', redirectTo: ASSET_CATEGORIES[0].id },
          ...ASSET_CATEGORIES.map(categoryRoute),
          { path: '**', redirectTo: ASSET_CATEGORIES[0].id },
        ],
      },
      {
        path: 'locale',
        title: moduleTitle(requireModule('locale')),
        loadComponent: () => import('./locale/locale-editor-page').then((m) => m.LocaleEditorPage),
      },
      ...EDITOR_MODULES.filter((module) => module.status === 'planned').map((module) => ({
        path: module.id,
        title: moduleTitle(module),
        data: {
          planned: {
            titleKey: module.titleKey,
            summaryKey: module.summaryKey,
            planKeys: module.planKeys,
            source: 'editor-modules.ts',
          },
        },
        loadComponent: () => import('./planned/planned-page').then((m) => m.PlannedPage),
      })),
      { path: '**', redirectTo: 'map' },
    ],
  },
];
