#!/usr/bin/env node
/**
 * Smoke harness: runs the real engine in a real browser and records what it did.
 *
 * Unit tests prove that a rule is right in isolation. This proves that the
 * whole chain still works end to end — WASM artefacts, content files, the
 * Angular shell, the renderer — and that it produces *the same* result as
 * before the change.
 *
 * Two independent signals come out of one run:
 *
 *   1. **A transcript.** The scenario loads the shipped content, starts a game
 *      on a fixed seed and dispatches a fixed command sequence straight at the
 *      WASM module — no UI in the way. Ticks, positions, events, rejections and
 *      RNG draws are recorded. The engine is deterministic (ADR-0011), so this
 *      transcript is byte-stable unless a rule, the content or the RNG changed
 *      — the version string it also carries is a note, not behaviour, see
 *      `NOT_BEHAVIOUR`.
 *
 *   2. **Screenshots.** Each page of the app is opened, left to settle and
 *      captured, together with a 32x32 grayscale signature of its canvas. The
 *      PNG is for a human (or Claude) to look at; the signature turns "the map
 *      stopped drawing" into a number the script can fail on.
 *
 * Console errors and uncaught exceptions are collected throughout and are a
 * failure on their own.
 *
 * No new dependency: Chromium is driven over the DevTools protocol using the
 * `WebSocket` client built into Node 22, and the browser is whichever cached
 * Playwright/Chrome binary the machine already has.
 *
 * Usage:
 *   node .claude/skills/verify-no-regression/scripts/smoke.mjs [options]
 *
 *   --base-url <url>   Use an already-running server instead of starting one.
 *   --scenario <path>  Scenario file (default: ../scenario.json next to this).
 *   --out <dir>        Run output   (default: .smoke/current).
 *   --baseline <dir>   Reference    (default: .smoke/baseline).
 *   --accept           Copy this run over the baseline and exit 0.
 *   --no-compare       Record only; do not diff against the baseline.
 *   --port <n>         Port for the server this script starts (default 4399).
 *   --timeout <ms>     How long to wait for that server (default 180000).
 *
 * Exit codes: 0 = no regression · 1 = regression · 2 = the harness itself failed.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');

/** Above this mean per-pixel difference (0-255) a canvas counts as changed. */
const SIGNATURE_TOLERANCE = 4;

/**
 * Transcript paths that record what ran rather than how it behaved. They are
 * reported as notes and never count as a regression: the engine version moves
 * on every release bump without a rule, a tick or a pixel following it, and
 * diffing it only forced a second full run of this harness to accept one line.
 */
const NOT_BEHAVIOUR = new Set(['engine.version']);

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    baseUrl: null,
    scenario: resolve(HERE, '../scenario.json'),
    out: join(REPO, '.smoke/current'),
    baseline: join(REPO, '.smoke/baseline'),
    accept: false,
    compare: true,
    port: 4399,
    timeout: 180_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      i += 1;
      return next;
    };
    switch (flag) {
      case '--base-url': options.baseUrl = value().replace(/\/+$/, ''); break;
      case '--scenario': options.scenario = resolve(value()); break;
      case '--out': options.out = resolve(value()); break;
      case '--baseline': options.baseline = resolve(value()); break;
      case '--accept': options.accept = true; break;
      case '--no-compare': options.compare = false; break;
      case '--port': options.port = Number(value()); break;
      case '--timeout': options.timeout = Number(value()); break;
      default: throw new Error(`unknown option: ${flag}`);
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// The dev server
// ---------------------------------------------------------------------------

/** Resolves once the server answers, or rejects when it never does. */
async function waitForServer(url, timeoutMs, isAlive) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isAlive && !isAlive()) throw new Error('the server exited before it was ready');
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status < 500) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`server did not answer on ${url} within ${timeoutMs}ms`);
}

/**
 * Starts `ng serve` and waits for it. Returns the base URL and a stop function.
 *
 * The dev server is used rather than a production build because it is what the
 * developer is looking at.
 *
 * `INSULAIRE_CONTENT_DIR` is pinned to the repository fixture, overriding any
 * `.env`: the transcript below is a byte-for-byte comparison against a
 * baseline, so it must run on the content this repository ships and never on
 * whichever game the developer happens to be authoring
 * (`docs/adr/ADR-0022-authoring-content-workspace.md`).
 */
async function startServer(options, log) {
  const child = spawn(
    'npm',
    [
      'run',
      'start',
      '--workspace',
      'web',
      '--',
      '--host',
      '127.0.0.1',
      '--port',
      String(options.port),
    ],
    {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NG_CLI_ANALYTICS: 'false',
        INSULAIRE_CONTENT_DIR: resolve(REPO, 'content'),
      },
    },
  );
  let exited = false;
  let tail = '';
  const keep = (chunk) => {
    tail = (tail + chunk).slice(-4000);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('exit', () => {
    exited = true;
  });

  const baseUrl = `http://127.0.0.1:${options.port}`;
  log(`starting the dev server on ${baseUrl} …`);
  try {
    await waitForServer(`${baseUrl}/`, options.timeout, () => !exited);
  } catch (cause) {
    child.kill('SIGTERM');
    throw new Error(`${cause.message}\n--- server output ---\n${tail}`);
  }
  log('dev server is up');
  return { baseUrl, stop: () => child.kill('SIGTERM') };
}

// ---------------------------------------------------------------------------
// Chromium over the DevTools protocol
// ---------------------------------------------------------------------------

const BROWSER_CANDIDATES = [
  process.env.SMOKE_CHROME,
  ...glob(`${process.env.HOME}/.cache/ms-playwright`, 'chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell'),
  ...glob(`${process.env.HOME}/.cache/ms-playwright`, 'chromium-*/chrome-linux64/chrome'),
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
];

/**
 * Tiny glob: expands a single `*` in the first segment under `root`.
 *
 * Newest version first, so a machine holding several cached Chromium builds
 * uses the most recent one.
 */
function glob(root, pattern) {
  if (!root || !existsSync(root)) return [];
  const [head, ...rest] = pattern.split('/');
  const prefix = head.replace('*', '');
  return readdirSync(root)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .reverse()
    .map((name) => join(root, name, ...rest))
    .filter((candidate) => existsSync(candidate));
}

function findBrowser() {
  const found = BROWSER_CANDIDATES.filter(Boolean).find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      'no Chromium found. Install one (`npx playwright install chromium`) ' +
        'or point SMOKE_CHROME at a Chrome/Chromium binary.',
    );
  }
  return found;
}

/** A CDP connection to a freshly launched headless browser. */
async function launchBrowser(viewport, log) {
  const binary = findBrowser();
  log(`browser: ${binary}`);
  const child = spawn(
    binary,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--disable-dev-shm-usage',
      '--force-device-scale-factor=1',
      `--window-size=${viewport.width},${viewport.height}`,
      '--remote-debugging-port=0',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const wsUrl = await new Promise((resolvePromise, rejectPromise) => {
    let buffer = '';
    const timer = setTimeout(() => rejectPromise(new Error(`browser never printed a DevTools URL:\n${buffer}`)), 30_000);
    child.stderr.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/ws:\/\/[^\s]+/);
      if (match) {
        clearTimeout(timer);
        resolvePromise(match[0]);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`browser exited with code ${code}:\n${buffer}`));
    });
  });

  const socket = new WebSocket(wsUrl);
  await new Promise((ok, ko) => {
    socket.addEventListener('open', ok, { once: true });
    socket.addEventListener('error', () => ko(new Error('could not connect to the browser')), { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined && pending.has(message.id)) {
      const { ok, ko } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) ko(new Error(`${message.error.message} (${message.method ?? ''})`));
      else ok(message.result);
      return;
    }
    for (const listener of listeners) listener(message);
  });

  const send = (method, params = {}, sessionId) =>
    new Promise((ok, ko) => {
      const id = (nextId += 1);
      pending.set(id, { ok, ko });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  return {
    send,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      try {
        socket.close();
      } finally {
        child.kill('SIGTERM');
      }
    },
  };
}

/**
 * Opens a page and returns handles on it.
 *
 * Every page collects its own console errors and uncaught exceptions: a stack
 * trace in the devtools console is a regression even when the pixels look fine.
 */
async function openPage(browser, viewport) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const problems = [];

  const off = browser.onEvent((message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      problems.push({ kind: 'exception', text: details.exception?.description ?? details.text });
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      problems.push({ kind: 'console', text: message.params.args.map(describe).join(' ') });
    }
  });

  await browser.send('Runtime.enable', {}, sessionId);
  await browser.send('Page.enable', {}, sessionId);
  await browser.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false }, sessionId);

  return {
    problems,
    goto: async (url) => {
      await browser.send('Page.navigate', { url }, sessionId);
      await waitForLoad(browser, sessionId);
    },
    evaluate: async (expression) => {
      const result = await browser.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true },
        sessionId,
      );
      if (result.exceptionDetails) {
        const { exception, text } = result.exceptionDetails;
        // The engine rejects with a JSON *string*, which CDP reports as a value
        // with no `description` — without it the failure reads "page threw:
        // Uncaught (in promise)" and says nothing at all.
        const thrown = exception?.description ?? exception?.value ?? text;
        throw new Error(`page threw: ${typeof thrown === 'string' ? thrown : JSON.stringify(thrown)}`);
      }
      return result.result.value;
    },
    click: async (x, y) => {
      const base = { x, y, button: 'left', clickCount: 1, buttons: 1 };
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, buttons: 0 }, sessionId);
      await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, sessionId);
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 }, sessionId);
    },
    key: async (code, key) => {
      const event = { code, key, text: '', unmodifiedText: '' };
      await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', ...event }, sessionId);
      await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event }, sessionId);
    },
    screenshot: async () => {
      const shot = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
      return Buffer.from(shot.data, 'base64');
    },
    close: async () => {
      off();
      await browser.send('Target.closeTarget', { targetId });
    },
  };
}

function describe(argument) {
  if (argument.value !== undefined) return String(argument.value);
  return argument.description ?? argument.type;
}

async function waitForLoad(browser, sessionId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ready = await browser.send(
      'Runtime.evaluate',
      { expression: 'document.readyState', returnByValue: true },
      sessionId,
    );
    if (ready.result.value === 'complete') return;
    await sleep(200);
  }
  throw new Error('page never finished loading');
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// ---------------------------------------------------------------------------
// Phase 1 — the engine transcript
// ---------------------------------------------------------------------------

/**
 * Drives the WASM module directly, with no Angular in the picture.
 *
 * Running this in the page rather than in Node is not a detour: `wasm-pack
 * --target web` output is a browser ES module, and this is the same import the
 * app performs (`apps/web/src/engine/load-engine-module.ts`). What it skips is
 * the UI, so a diff here always means the *engine* or the *content* moved.
 */
async function recordTranscript(page, baseUrl, scenario) {
  await page.goto(`${baseUrl}/`);
  const script = `(async () => {
    const scenario = ${JSON.stringify(scenario)};
    const module = await import('/wasm/insulaire_engine.js');
    await module.default({ module_or_path: '/wasm/insulaire_engine_bg.wasm' });
    const engine = new module.InsulaireEngine();
    const parse = (json) => JSON.parse(json);
    const text = async (path) => {
      const response = await fetch(path);
      if (!response.ok) throw new Error(path + ' -> HTTP ' + response.status);
      return response.text();
    };

    const manifestJson = await text('/content/project.json');
    const manifest = JSON.parse(manifestJson);
    const content = { tileSets: [], worlds: [] };
    for (const entry of manifest.tileSets ?? []) {
      content.tileSets.push(parse(engine.loadTileSet(await text('/content/' + entry.path))));
    }
    for (const entry of manifest.worlds ?? []) {
      content.worlds.push(parse(engine.loadWorld(await text('/content/' + entry.path))));
    }
    // Languages are content like the rest, and a language the manifest declares
    // without a loaded file makes loadProject fail — exactly as it does for a
    // world (docs/adr/ADR-0023-localised-content-keys.md).
    content.locales = [];
    for (const language of manifest.locales?.languages ?? []) {
      for (const file of language.files ?? []) {
        content.locales.push(
          parse(engine.loadLocale(language.id, file.id, await text('/content/' + file.path))),
        );
      }
    }
    // The menu is content too, and the manifest will not load without the
    // screen it names (docs/adr/ADR-0024-authored-title-screen.md).
    content.titleScreen = null;
    if (manifest.titleScreen) {
      content.titleScreen = parse(
        engine.loadTitleScreen(await text('/content/' + manifest.titleScreen.path)),
      );
    }
    // Character definitions are content the manifest lists, so the project will
    // not load without them either
    // (docs/adr/ADR-0028-character-definitions.md).
    content.characters = [];
    for (const entry of manifest.characters ?? []) {
      content.characters.push(parse(engine.loadCharacter(await text('/content/' + entry.path))));
    }
    // Creation binds into those definitions, so it is loaded after them and
    // before the manifest that requires it (ADR-0042).
    content.characterCreation = null;
    if (manifest.characterCreation) {
      content.characterCreation = parse(
        engine.loadCharacterCreation(await text('/content/' + manifest.characterCreation.path)),
      );
    }
    content.settings = null;
    if (manifest.settings) {
      content.settings = parse(
        engine.loadSettings(await text('/content/' + manifest.settings.path)),
      );
    }
    content.project = parse(engine.loadProject(manifestJson));
    const links = parse(engine.validateLinks());
    const localeReport = parse(engine.validateLocales());

    const trim = (snapshot) => ({
      worldId: snapshot.worldId,
      tick: snapshot.tick,
      player: snapshot.player ? { contentId: snapshot.player.contentId, at: snapshot.player.at } : null,
      entities: snapshot.entities.map((entity) => ({ contentId: entity.contentId, at: entity.at })),
      legalMoves: snapshot.legalMoves,
      rngDraws: snapshot.rng?.draws ?? null,
    });

    let state = parse(
      engine.createGame(scenario.world, scenario.seed, JSON.stringify(scenario.settings ?? {})),
    );
    const steps = [{ label: 'createGame', command: null, accepted: true, rejection: null, events: [], state: trim(state) }];

    for (const step of scenario.steps) {
      // A step may name a legal move by rank instead of by coordinates: that
      // keeps the scenario readable, and makes a change in the engine's
      // canonical move order show up as a diff rather than as a rejection.
      let command = step.cmd;
      if (step.legal !== undefined) {
        const target = state.legalMoves[step.legal];
        if (!target) throw new Error(step.label + ': no legal move #' + step.legal);
        command = { type: 'moveTo', to: target };
      }
      const result = parse(engine.dispatch(JSON.stringify(command)));
      state = result.state;
      steps.push({
        label: step.label,
        command,
        accepted: result.accepted,
        rejection: result.rejection ? result.rejection.code : null,
        events: result.events.map((event) => event.type),
        state: trim(state),
      });
    }

    const summary = parse(engine.contentSummary());
    return {
      engine: parse(engine.engineInfo()),
      content: {
        project: content.project,
        tileSets: content.tileSets.map((outcome) => outcome.id),
        worlds: content.worlds.map((outcome) => ({ id: outcome.id, valid: outcome.report.valid })),
        tileSetIds: summary.tileSetIds,
        links,
        locales: content.locales.map((outcome) => outcome.id),
        localeReport,
        titleScreen: content.titleScreen ? content.titleScreen.id : null,
        settings: content.settings ? content.settings.id : null,
      },
      steps,
    };
  })()`;
  return page.evaluate(script);
}

// ---------------------------------------------------------------------------
// Phase 2 — the screenshots
// ---------------------------------------------------------------------------

/**
 * A 32x32 grayscale fingerprint of the biggest canvas on the page.
 *
 * The PNG is what a human reads; this is what the script can compare. Reading
 * back the canvas rather than the screenshot keeps the number about *what the
 * renderer drew*, unaffected by the surrounding chrome.
 */
const CANVAS_SIGNATURE = `(() => {
  const canvases = Array.from(document.querySelectorAll('canvas'));
  if (canvases.length === 0) return null;
  const canvas = canvases.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const size = 32;
  const scratch = document.createElement('canvas');
  scratch.width = size;
  scratch.height = size;
  const context = scratch.getContext('2d');
  context.drawImage(canvas, 0, 0, size, size);
  const pixels = context.getImageData(0, 0, size, size).data;
  const grey = [];
  for (let i = 0; i < pixels.length; i += 4) {
    grey.push(Math.round(0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]));
  }
  return { width: canvas.width, height: canvas.height, grey };
})()`;

async function capturePages(browser, baseUrl, scenario, viewport, outDir, log) {
  const shots = [];
  const problems = [];
  for (const spec of scenario.pages) {
    const page = await openPage(browser, viewport);
    try {
      log(`capturing ${spec.path} …`);
      await page.goto(`${baseUrl}${spec.path}`);
      // The WASM module, the content files and the first frame all land after
      // `load`. Waiting for a drawn canvas rather than for a fixed delay is
      // what keeps a slow machine from recording a half-painted page as the
      // reference — the failure this harness exists to notice.
      if (spec.canvas !== false) await waitForCanvas(page, spec.canvasTimeoutMs ?? 20_000);
      await settle(page, spec.settleMs ?? 1500);
      shots.push(await capture(page, spec.name, outDir));

      // A named control, for a page whose interesting part is behind one.
      // Fractions of a canvas cannot reach a tab, and a module nobody opens is
      // a module this harness does not guard.
      for (const [index, press] of (spec.press ?? []).entries()) {
        const box = await page.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(press.selector)});
          if (!el) return null;
          el.scrollIntoView({ block: 'center' });
          const value = ${JSON.stringify(press.value ?? null)};
          if (value !== null) {
            if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) {
              throw new Error('value may only target an input or select');
            }
            el.value = value;
            el.dispatchEvent(new Event(${JSON.stringify(press.event ?? 'input')}, { bubbles: true }));
          }
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        })()`);
        if (!box) throw new Error(`${spec.name}: no element matching ${press.selector}`);
        if (press.value === undefined) {
          await page.click(Math.round(box.x), Math.round(box.y));
        }
        await settle(page, press.settleMs ?? 800);
        shots.push(await capture(page, press.name ?? `${spec.name}-press-${index + 1}`, outDir));
      }

      // Physical keyboard input can carry a printed key that differs from its
      // code (`KeyW` / `z` on AZERTY). Keep both in the scenario so the harness
      // proves the application listens to the physical position.
      for (const [index, key] of (spec.keys ?? []).entries()) {
        await page.key(key.code, key.key ?? key.code);
        await settle(page, key.settleMs ?? 800);
        shots.push(await capture(page, key.name ?? `${spec.name}-key-${index + 1}`, outDir));
      }

      for (const [index, [fx, fy]] of (spec.clicks ?? []).entries()) {
        const box = await canvasBox(page);
        if (!box) throw new Error(`${spec.name}: no canvas to click on`);
        await page.click(Math.round(box.x + box.width * fx), Math.round(box.y + box.height * fy));
        await settle(page, spec.clickSettleMs ?? 600);
        shots.push(await capture(page, `${spec.name}-click-${index + 1}`, outDir));
      }

      for (const problem of page.problems) problems.push({ page: spec.name, ...problem });
    } finally {
      await page.close();
    }
  }
  return { shots, problems };
}

/** The on-screen rectangle of the page's biggest canvas, or `null`. */
function canvasBox(page) {
  return page.evaluate(`(() => {
    const canvas = Array.from(document.querySelectorAll('canvas'))
      .filter((element) => element.width > 0 && element.height > 0)
      .sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  })()`);
}

/** Polls until the page has painted a canvas, or gives up loudly. */
async function waitForCanvas(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const box = await canvasBox(page);
    if (box && box.width > 0) return box;
    await sleep(250);
  }
  throw new Error(`no canvas appeared within ${timeoutMs}ms — the page failed to start`);
}

/** Waits for the page to stop moving: fonts, one animation frame, then a pause. */
async function settle(page, ms) {
  await page.evaluate(`(async () => {
    await (document.fonts ? document.fonts.ready : Promise.resolve());
    await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
  })()`);
  await sleep(ms);
}

async function capture(page, name, outDir) {
  const png = await page.screenshot();
  const signature = await page.evaluate(CANVAS_SIGNATURE);
  await writeFile(join(outDir, 'screens', `${name}.png`), png);
  return {
    name,
    file: `screens/${name}.png`,
    bytes: png.length,
    sha1: createHash('sha1').update(png).digest('hex'),
    signature,
  };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/** Structural diff, reported as `path: before -> after` lines. */
function diff(before, after, path = '', found = []) {
  if (found.length >= 40) return found;
  const alike = (value) => value !== null && typeof value === 'object';
  if (!alike(before) || !alike(after)) {
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      found.push({ path: path || '(root)', before: brief(before), after: brief(after) });
    }
    return found;
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const child = Array.isArray(before) ? `${path}[${key}]` : path ? `${path}.${key}` : key;
    diff(before[key], after[key], child, found);
  }
  return found;
}

const brief = (value) => {
  const json = JSON.stringify(value) ?? 'undefined';
  return json.length > 120 ? `${json.slice(0, 117)}…` : json;
};

/** Mean absolute difference between two canvas signatures, 0-255. */
function signatureDistance(before, after) {
  if (!before || !after) return before === after ? 0 : 255;
  if (before.grey.length !== after.grey.length) return 255;
  let total = 0;
  for (let i = 0; i < before.grey.length; i += 1) total += Math.abs(before.grey[i] - after.grey[i]);
  return total / before.grey.length;
}

function compare(current, baseline) {
  const changes = diff(baseline.transcript, current.transcript);
  const transcript = changes.filter((change) => !NOT_BEHAVIOUR.has(change.path));
  const noted = changes.filter((change) => NOT_BEHAVIOUR.has(change.path));
  const screens = [];
  const byName = new Map(baseline.shots.map((shot) => [shot.name, shot]));
  for (const shot of current.shots) {
    const reference = byName.get(shot.name);
    if (!reference) {
      screens.push({ name: shot.name, status: 'new' });
      continue;
    }
    const distance = signatureDistance(reference.signature, shot.signature);
    const identical = reference.sha1 === shot.sha1;
    screens.push({
      name: shot.name,
      status: identical ? 'identical' : distance > SIGNATURE_TOLERANCE ? 'changed' : 'similar',
      canvasDistance: Number(distance.toFixed(2)),
    });
  }
  for (const shot of baseline.shots) {
    if (!current.shots.some((candidate) => candidate.name === shot.name)) {
      screens.push({ name: shot.name, status: 'missing' });
    }
  }
  return { transcript, noted, screens };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const log = (message) => console.log(`[smoke] ${message}`);
  const scenario = JSON.parse(await readFile(options.scenario, 'utf8'));
  const viewport = scenario.viewport ?? { width: 1440, height: 900 };

  if (options.accept) {
    await rm(options.baseline, { recursive: true, force: true });
    await cp(options.out, options.baseline, { recursive: true });
    log(`baseline updated from ${options.out}`);
    return 0;
  }

  await rm(options.out, { recursive: true, force: true });
  await mkdir(join(options.out, 'screens'), { recursive: true });

  let server = null;
  let browser = null;
  try {
    const baseUrl = options.baseUrl ?? (server = await startServer(options, log)).baseUrl;
    if (options.baseUrl) {
      await waitForServer(`${baseUrl}/`, 30_000);
      log(`using the server already running on ${baseUrl}`);
    }

    browser = await launchBrowser(viewport, log);

    const enginePage = await openPage(browser, viewport);
    log('driving the engine …');
    const transcript = await recordTranscript(enginePage, baseUrl, scenario);
    const engineProblems = enginePage.problems.map((problem) => ({ page: 'engine', ...problem }));
    await enginePage.close();
    log(`engine ran ${transcript.steps.length - 1} commands, ending at tick ${transcript.steps.at(-1).state.tick}`);

    const { shots, problems } = await capturePages(browser, baseUrl, scenario, viewport, options.out, log);

    const run = {
      recordedAt: new Date().toISOString(),
      scenario: scenario.name ?? 'default',
      transcript,
      shots,
      problems: [...engineProblems, ...problems],
    };
    await writeFile(join(options.out, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);

    const hasBaseline = existsSync(join(options.baseline, 'run.json'));
    let comparison = null;
    if (options.compare && hasBaseline) {
      const baseline = JSON.parse(await readFile(join(options.baseline, 'run.json'), 'utf8'));
      comparison = compare(run, baseline);
    }

    const report = {
      verdict: verdictOf(run, comparison, hasBaseline, options),
      baseline: hasBaseline ? options.baseline : null,
      out: options.out,
      problems: run.problems,
      transcriptDiff: comparison?.transcript ?? [],
      transcriptNotes: comparison?.noted ?? [],
      screens: comparison?.screens ?? run.shots.map((shot) => ({ name: shot.name, status: 'recorded' })),
    };
    await writeFile(join(options.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

    print(report, log);
    return report.verdict === 'regression' ? 1 : 0;
  } finally {
    browser?.close();
    server?.stop();
  }
}

function verdictOf(run, comparison, hasBaseline, options) {
  if (run.problems.length > 0) return 'regression';
  if (!options.compare) return 'recorded';
  if (!hasBaseline) return 'no-baseline';
  if (comparison.transcript.length > 0) return 'regression';
  if (comparison.screens.some((screen) => screen.status === 'changed' || screen.status === 'missing')) {
    return 'regression';
  }
  return 'clean';
}

function print(report, log) {
  log(`verdict: ${report.verdict}`);
  for (const problem of report.problems) log(`  error on ${problem.page}: ${problem.text}`);
  for (const change of report.transcriptDiff) log(`  transcript ${change.path}: ${change.before} -> ${change.after}`);
  for (const note of report.transcriptNotes) log(`  note ${note.path}: ${note.before} -> ${note.after} (not behaviour)`);
  for (const screen of report.screens) {
    const distance = screen.canvasDistance === undefined ? '' : ` (canvas Δ ${screen.canvasDistance})`;
    log(`  screen ${screen.name}: ${screen.status}${distance}`);
  }
  log(`report: ${join(report.out, 'report.json')}`);
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`[smoke] harness failed: ${error.stack ?? error.message}`);
    process.exit(2);
  },
);
