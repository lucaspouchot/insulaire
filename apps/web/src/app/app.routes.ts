import { Routes } from '@angular/router';

/**
 * Two modes, lazily loaded so the editor's code does not sit in the play
 * bundle and vice versa.
 */
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'editor' },
  {
    path: 'editor',
    title: 'Hex Engine — Editor',
    loadComponent: () => import('./features/editor/editor-page').then((m) => m.EditorPage),
  },
  {
    path: 'play',
    title: 'Hex Engine — Play',
    loadComponent: () => import('./features/play/play-page').then((m) => m.PlayPage),
  },
  { path: '**', redirectTo: 'editor' },
];
