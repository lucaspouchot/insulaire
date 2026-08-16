import { Routes } from '@angular/router';

/**
 * Routes of the **dev** build: the game plus the editor.
 *
 * The client build replaces this file with `app.routes.deliver.ts`, which does
 * not import `editor.routes` at all — so the editor is absent from the bundle
 * rather than merely unreachable (`docs/adr/ADR-0018-client-delivery-build.md`).
 *
 * Everything is lazily loaded, so the editor's code does not sit in the play
 * bundle and vice versa.
 */
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'editor' },
  {
    path: 'editor',
    loadChildren: () => import('./features/editor/editor.routes').then((m) => m.EDITOR_ROUTES),
  },
  {
    path: 'play',
    title: 'Hex Engine — Play',
    loadComponent: () => import('./features/play/play-page').then((m) => m.PlayPage),
  },
  { path: '**', redirectTo: 'editor' },
];
