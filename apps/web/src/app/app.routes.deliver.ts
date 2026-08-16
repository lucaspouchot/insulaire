import { Routes } from '@angular/router';

/**
 * Routes of the **client** delivery: the game, and nothing else.
 *
 * This file is substituted for `app.routes.ts` by the `deliver` build
 * configuration. It deliberately contains no reference to the editor — not a
 * guarded import, not a dead branch — because a dynamic `import()` inside dead
 * code still makes the bundler emit the chunk. Absence here is what makes the
 * editor absent from the delivered bundle
 * (`docs/adr/ADR-0018-client-delivery-build.md`).
 */
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'play' },
  {
    path: 'play',
    title: 'Play',
    loadComponent: () => import('./features/play/play-page').then((m) => m.PlayPage),
  },
  { path: '**', redirectTo: 'play' },
];
