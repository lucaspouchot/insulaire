/**
 * Routes of the editor, derived from {@link EDITOR_MODULES}.
 *
 * Everything editor-related hangs off this one file, and `app.routes.ts` is the
 * only place that imports it. That is what lets the client build drop the whole
 * editor by swapping a single route file
 * (`docs/adr/ADR-0018-client-delivery-build.md`).
 */

import { Routes } from '@angular/router';

import { EDITOR_MODULES } from './editor-modules';

export const EDITOR_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./editor-shell').then((m) => m.EditorShell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'map' },
      {
        path: 'map',
        title: 'Hex Engine — Map editor',
        loadComponent: () => import('./map/map-editor-page').then((m) => m.MapEditorPage),
      },
      ...EDITOR_MODULES.filter((module) => module.status === 'planned').map((module) => ({
        path: module.id,
        title: `Hex Engine — ${module.title}`,
        data: { moduleId: module.id },
        loadComponent: () => import('./planned/planned-module-page').then((m) => m.PlannedModulePage),
      })),
      { path: '**', redirectTo: 'map' },
    ],
  },
];
