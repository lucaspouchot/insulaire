/**
 * Repairs the test environment before any spec runs.
 *
 * **Web Storage.** Node 25 ships Web Storage on by default, so
 * `globalThis.localStorage` already exists when jsdom sets up the window — and
 * unless Node was started with `--localstorage-file` pointing somewhere real,
 * what it exposes is an object carrying none of the `Storage` API. jsdom does
 * not replace a global that is already there, so every spec touching
 * `localStorage` fails on `clear is not a function` before reaching what it
 * meant to test.
 *
 * The application keeps the chosen language and every setting there
 * (`i18n.service.ts`, `settings.service.ts`), so those specs need a store that
 * behaves like one. This installs a per-process in-memory `Storage` **only when
 * the environment did not provide a usable one**, so on a Node version where
 * jsdom's own storage survives, this file changes nothing.
 *
 * Persisting to a file instead — which is what `--localstorage-file` would do —
 * would carry state between runs and between the worker processes vitest
 * spreads the suites across, which is the opposite of what a test needs.
 */

/** A `Storage` backed by a map, with the whole interface, including `key`. */
function inMemoryStorage(): Storage {
  const entries = new Map<string, string>();

  return {
    get length(): number {
      return entries.size;
    },
    key(index: number): string | null {
      return [...entries.keys()][index] ?? null;
    },
    getItem(key: string): string | null {
      return entries.get(String(key)) ?? null;
    },
    setItem(key: string, value: string): void {
      entries.set(String(key), String(value));
    },
    removeItem(key: string): void {
      entries.delete(String(key));
    },
    clear(): void {
      entries.clear();
    },
  };
}

/** `true` when what the environment provided actually implements `Storage`. */
function isUsable(candidate: unknown): boolean {
  return typeof (candidate as Storage | undefined)?.clear === 'function';
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  if (isUsable(globalThis[name])) {
    continue;
  }
  Object.defineProperty(globalThis, name, {
    value: inMemoryStorage(),
    configurable: true,
    writable: true,
  });
}
