import { signal } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { ContentRef } from '../../content/generated/project';
import { ValidationReport } from '../../engine/engine.types';
import { DraftSet } from './draft-set';
import { Draft, DraftServices, DraftSource } from './draft-source';

/**
 * The editing session, driven with no DOM and no `TestBed`.
 *
 * Which is the point of the module: 6,303 lines of workspace were unreachable
 * without a canvas, and the load and save choreography inside them was written
 * out three times. What is pinned here is the choreography — the order, the
 * bail-outs, what a rename takes with it — not what any one kind means by it
 * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
 */

interface Thing extends Draft {
  id: string;
  name: string;
}

/** Every call the pipeline made, in order, so the sequence itself is testable. */
type Trace = string[];

interface Harness {
  readonly set: DraftSet<Thing>;
  readonly trace: Trace;
  readonly written: Map<string, string>;
  readonly declared: Map<string, string>;
  /** Verdicts the fake engine returns, by draft id. */
  readonly verdicts: Map<string, ValidationReport>;
  /** Unwritten image paths, by draft id. */
  readonly dirtySprites: Map<string, string[]>;
  readonly manifestDirty: { value: boolean };
  readonly createdKeys: { value: string[] };
  readonly files: Map<string, Thing | null>;
  readonly refreshed: (Thing | null)[];
}

function report(errors: number, warnings = 0): ValidationReport {
  return {
    issues: [
      ...Array.from({ length: errors }, (_unused, index) => ({
        code: `thing.broken${index}`,
        severity: 'error' as const,
        message: 'broken',
      })),
      ...Array.from({ length: warnings }, (_unused, index) => ({
        code: `thing.odd${index}`,
        severity: 'warning' as const,
        message: 'odd',
      })),
    ],
  } as ValidationReport;
}

/** What the harness is told to break, so the failure paths are real. */
interface Faults {
  readonly prepare?: string;
  readonly writeJson?: string;
  /** What to open when nothing is declared, for a single-document kind. */
  readonly blank?: Thing;
  /** Whether saving this kind may rewrite the manifest. Defaults to true. */
  readonly declaredInManifest?: boolean;
  /** Drop the messages a kind with no art and no manifest entry cannot say. */
  readonly silentAboutSpritesAndManifest?: boolean;
}

function harness(
  seed: readonly Thing[] = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ],
  faults: Faults = {},
): Harness {
  const trace: Trace = [];
  const written = new Map<string, string>();
  const declared = new Map<string, string>(
    seed.map((thing) => [thing.id, `things/${thing.id}.json`]),
  );
  const verdicts = new Map<string, ValidationReport>();
  const dirtySprites = new Map<string, string[]>();
  const manifestDirty = { value: false };
  const createdKeys = { value: [] as string[] };
  const files = new Map<string, Thing | null>(seed.map((thing) => [thing.id, thing]));
  const refreshed: (Thing | null)[] = [];
  /** Bumped by a fake brush stroke, so `dirtySprites` is reactive like the real one. */
  const strokes = signal(0);

  const source: DraftSource<Thing> = {
    declaredInManifest: faults.declaredInManifest ?? true,
    blank: () => faults.blank ?? null,
    messages: faults.silentAboutSpritesAndManifest
      ? { invalid: 'thing.invalid', saved: 'thing.saved' }
      : {
          invalid: 'thing.invalid',
          saved: 'thing.saved',
          spritesSaved: 'thing.spritesSaved',
          savedManifest: 'thing.savedManifest',
        },
    async prepare(): Promise<void> {
      trace.push('prepare');
      if (faults.prepare !== undefined) {
        throw new Error(faults.prepare);
      }
    },
    declared(): readonly ContentRef[] {
      return [...declared].map(([id, path]) => ({ id, path }));
    },
    async read(entry: ContentRef): Promise<Thing | null> {
      trace.push(`read ${entry.id}`);
      return files.get(entry.id) ?? null;
    },
    pathOf(id: string): string {
      return `things/${id}.json`;
    },
    serialize(draft: Thing): string {
      return JSON.stringify(draft);
    },
    validate(draft: Thing): ValidationReport {
      return verdicts.get(draft.id) ?? report(0);
    },
    adopt(id: string, json: string): void {
      trace.push(`adopt ${id}`);
      written.set(id, json);
    },
    forget(id: string): void {
      trace.push(`forget ${id}`);
      written.delete(id);
    },
    declare(id: string, path: string): void {
      trace.push(`declare ${id}`);
      declared.set(id, path);
    },
    undeclare(id: string): void {
      trace.push(`undeclare ${id}`);
      declared.delete(id);
    },
    dirtySprites(draft: Thing): readonly string[] {
      strokes();
      return dirtySprites.get(draft.id) ?? [];
    },
    async writeSprites(draft: Thing): Promise<number> {
      trace.push(`writeSprites ${draft.id}`);
      const pending = dirtySprites.get(draft.id) ?? [];
      dirtySprites.set(draft.id, []);
      strokes.update((count) => count + 1);
      return pending.length;
    },
    keysOf(draft: Thing): readonly string[] {
      return [`game.thing.${draft.id}.name`];
    },
    removed(draft: Thing): void {
      trace.push(`removed ${draft.id}`);
    },
    refresh(draft: Thing | null): void {
      refreshed.push(draft);
    },
  };

  const services: DraftServices = {
    i18n: {
      t: (key, params) =>
        params === undefined ? key : `${key}(${Object.values(params).join(',')})`,
    },
    workspace: {
      async writeJson(path: string, json: string): Promise<void> {
        trace.push(`writeJson ${path}`);
        if (faults.writeJson !== undefined) {
          throw new Error(faults.writeJson);
        }
        written.set(path, json);
      },
    },
    ledger: {
      manifestNeedsWriting: () => manifestDirty.value,
      projectJson: () => '{"project":true}',
      markManifestWritten: () => {
        manifestDirty.value = false;
      },
      refreshDirty: () => trace.push('refreshDirty'),
    },
    locales: {
      ensureKeys: (keys) => {
        const created = [...keys].filter((key) => !createdKeys.value.includes(key));
        createdKeys.value.push(...created);
        return created;
      },
      save: async () => {
        trace.push('locales.save');
      },
    },
  };

  return {
    set: new DraftSet(source, services),
    trace,
    written,
    declared,
    verdicts,
    dirtySprites,
    manifestDirty,
    createdKeys,
    files,
    refreshed,
  };
}

describe('DraftSet load', () => {
  it('reads every declared draft and opens the first', async () => {
    const held = harness();

    await held.set.load();

    expect(held.set.drafts().map((draft) => draft.id)).toEqual(['a', 'b']);
    expect(held.set.openId()).toBe('a');
    expect(held.set.open()?.name).toBe('A');
    expect(held.set.loading()).toBe(false);
  });

  it('prepares everything before it reads anything', async () => {
    const held = harness();

    await held.set.load();

    expect(held.trace.slice(0, 3)).toEqual(['prepare', 'read a', 'read b']);
  });

  it('names the files it could not read instead of dropping them silently', async () => {
    const held = harness();
    held.files.set('b', null);

    await held.set.load();

    expect(held.set.drafts().map((draft) => draft.id)).toEqual(['a']);
    expect(held.set.unreadable()).toEqual(['things/b.json']);
  });

  it('opens nothing when the project declares nothing and the kind is a list', async () => {
    const held = harness([]);

    await held.set.load();

    expect(held.set.open()).toBeNull();
    expect(held.set.openId()).toBeNull();
  });

  it('opens a blank for a single-document kind, already owing the disk a write', async () => {
    const held = harness([], { blank: { id: 'settings', name: 'Settings' } });

    await held.set.load();

    expect(held.set.open()?.id).toBe('settings');
    expect(held.set.dirty()).toBe(true);
  });

  it('does not reach for the blank when the project declared something', async () => {
    const held = harness(undefined, { blank: { id: 'settings', name: 'Settings' } });

    await held.set.load();

    expect(held.set.drafts().map((draft) => draft.id)).toEqual(['a', 'b']);
    expect(held.set.dirty()).toBe(false);
  });

  it('reports a failure to prepare and still stops loading', async () => {
    // Not one file failing to open, which is survivable, but the engine or the
    // project itself: there is nothing to read at all.
    const held = harness(undefined, { prepare: 'the engine did not start' });

    await held.set.load();

    expect(held.set.error()).toBe('the engine did not start');
    expect(held.set.loading()).toBe(false);
    expect(held.set.drafts()).toEqual([]);
  });

  it('draws the kind-specific preview once the drafts are in', async () => {
    const held = harness();

    await held.set.load();

    expect(held.refreshed.at(-1)?.id).toBe('a');
  });
});

describe('DraftSet editing', () => {
  let held: Harness;

  beforeEach(async () => {
    held = harness();
    await held.set.load();
  });

  it('replaces the open draft with a copy rather than mutating it', () => {
    const before = held.set.open();

    held.set.edit((draft) => {
      draft.name = 'Renamed';
    });

    expect(before?.name).toBe('A');
    expect(held.set.open()?.name).toBe('Renamed');
  });

  it('marks the edited draft unwritten and nothing else', () => {
    held.set.edit((draft) => {
      draft.name = 'Renamed';
    });

    expect(held.set.dirty()).toBe(true);
    expect(held.set.isDirty('a')).toBe(true);
    expect(held.set.isDirty('b')).toBe(false);
    expect(held.set.anyUnsaved()).toBe(true);
  });

  it('follows a renamed draft and takes its manifest entry with it', () => {
    held.set.edit((draft) => {
      draft.id = 'renamed';
    });

    expect(held.set.openId()).toBe('renamed');
    expect(held.set.isDirty('renamed')).toBe(true);
    expect(held.set.isDirty('a')).toBe(false);
    expect(held.trace).toContain('undeclare a');
    expect(held.trace).toContain('forget a');
    expect(held.declared.has('a')).toBe(false);
  });

  it('adds a draft, marks it unwritten and opens it', () => {
    held.set.add({ id: 'c', name: 'C' });

    expect(held.set.openId()).toBe('c');
    expect(held.set.drafts().map((draft) => draft.id)).toEqual(['a', 'b', 'c']);
    expect(held.set.isDirty('c')).toBe(true);
  });

  it('removes a draft from the set and from the manifest, and opens what is left', () => {
    held.set.remove('a');

    expect(held.set.drafts().map((draft) => draft.id)).toEqual(['b']);
    expect(held.set.openId()).toBe('b');
    expect(held.trace).toContain('undeclare a');
    expect(held.trace).toContain('removed a');
    expect(held.set.anyUnsaved()).toBe(false);
  });

  it('selects another draft and clears the last message', async () => {
    await held.set.save();
    expect(held.set.message()).not.toBeNull();

    held.set.select('b');

    expect(held.set.openId()).toBe('b');
    expect(held.set.message()).toBeNull();
  });

  it('counts a draft whose pixels are unwritten as unsaved, definition or not', () => {
    expect(held.set.dirty()).toBe(false);

    held.dirtySprites.set('a', ['assets/a.png']);
    held.set.touchSprites();

    expect(held.set.dirty()).toBe(true);
    expect(held.set.anyUnsaved()).toBe(true);
  });
});

describe('DraftSet save', () => {
  let held: Harness;

  beforeEach(async () => {
    held = harness();
    await held.set.load();
  });

  it('runs the pipeline in order', async () => {
    held.dirtySprites.set('a', ['assets/a.png']);
    held.set.touchSprites();
    held.manifestDirty.value = true;
    held.trace.length = 0;

    await held.set.save();

    expect(held.trace).toEqual([
      'writeJson things/a.json',
      'adopt a',
      'writeSprites a',
      'declare a',
      'writeJson project.json',
      'refreshDirty',
      'locales.save',
    ]);
  });

  it('never writes a draft the engine refuses', async () => {
    held.verdicts.set('a', report(1));
    held.trace.length = 0;

    await held.set.save();

    expect(held.trace).toEqual([]);
    expect(held.set.error()).toBe('thing.invalid');
    expect(held.set.errorCount()).toBe(1);
  });

  it('writes a draft the engine only warns about', async () => {
    held.verdicts.set('a', report(0, 2));
    held.trace.length = 0;

    await held.set.save();

    expect(held.trace).toContain('writeJson things/a.json');
    expect(held.set.error()).toBeNull();
  });

  it('leaves the draft dirty when it would not validate', async () => {
    held.set.edit((draft) => {
      draft.name = 'Renamed';
    });
    held.verdicts.set('a', report(1));

    await held.set.save();

    expect(held.set.dirty()).toBe(true);
  });

  it('clears the dirty mark once everything is written', async () => {
    held.set.edit((draft) => {
      draft.name = 'Renamed';
    });
    held.dirtySprites.set('a', ['assets/a.png']);
    held.set.touchSprites();

    await held.set.save();

    expect(held.set.dirty()).toBe(false);
    expect(held.set.anyUnsaved()).toBe(false);
  });

  it('leaves the manifest alone when it already matches the disk', async () => {
    held.manifestDirty.value = false;

    await held.set.save();

    expect(held.trace).not.toContain('writeJson project.json');
  });

  it('says nothing rather than nothing-shaped for a message the kind does not have', async () => {
    // An absent key must not become an empty part: `t('')` resolves to '', and
    // the message would end in a bare separator.
    const quiet = harness(undefined, { silentAboutSpritesAndManifest: true });
    await quiet.set.load();
    quiet.dirtySprites.set('a', ['assets/a.png']);
    quiet.set.touchSprites();
    quiet.manifestDirty.value = true;

    await quiet.set.save();

    expect(quiet.set.message()).toBe('thing.saved(things/a.json) · ui.editor.locale.created(1)');
  });

  it('never touches the manifest for a kind whose file is at a fixed path', async () => {
    // Even with a manifest another screen has left half-edited: flushing it
    // would publish a change this save had nothing to do with.
    const fixed = harness(undefined, { declaredInManifest: false });
    await fixed.set.load();
    fixed.manifestDirty.value = true;
    fixed.trace.length = 0;

    await fixed.set.save();

    expect(fixed.trace).not.toContain('writeJson project.json');
    expect(fixed.trace).not.toContain('declare a');
    expect(fixed.trace).toContain('writeJson things/a.json');
  });

  it('says what it did, in one line', async () => {
    held.dirtySprites.set('a', ['assets/a.png', 'assets/a2.png']);
    held.set.touchSprites();
    held.manifestDirty.value = true;

    await held.set.save();

    expect(held.set.message()).toBe(
      'thing.saved(things/a.json) · thing.spritesSaved(2) · thing.savedManifest · ui.editor.locale.created(1)',
    );
  });

  it('creates the keys the draft names, once', async () => {
    await held.set.save();
    expect(held.createdKeys.value).toEqual(['game.thing.a.name']);

    held.trace.length = 0;
    await held.set.save();

    expect(held.trace).not.toContain('locales.save');
  });

  it('reports a write that failed, stays dirty, and stops being busy', async () => {
    const failing = harness(undefined, { writeJson: 'the content directory is read-only' });
    await failing.set.load();
    failing.set.edit((draft) => {
      draft.name = 'Renamed';
    });

    await failing.set.save();

    expect(failing.set.error()).toBe('the content directory is read-only');
    expect(failing.set.busy()).toBe(false);
    expect(failing.set.dirty()).toBe(true);
    expect(failing.set.message()).toBeNull();
  });

  it('saves nothing when the project holds no drafts at all', async () => {
    const empty = harness([]);
    await empty.set.load();
    empty.trace.length = 0;

    await empty.set.save();

    expect(empty.trace).toEqual([]);
  });
});
