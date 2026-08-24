---
description: After changing anything, prove nothing broke — run the gates, drive the real engine with a scripted command sequence in a browser, capture screenshots and diff them against the accepted baseline.
name: verify-no-regression
---

# Verify: no regression

Run this after a change and before committing it. It answers one question with
evidence rather than confidence: **does the game still do exactly what it did
before, apart from what I meant to change?**

Three layers, from cheapest to most convincing:

| Layer | Command | Catches |
|---|---|---|
| Static + unit | `npm run check` | broken build, clippy/rustfmt, Rust and web unit tests |
| Engine transcript | the smoke harness | a rule, the RNG, the AI or the content behaving differently |
| Screens | the same harness | a page that no longer loads, draws, or reacts to a click |

The transcript is the one that makes this worth running: the engine is
deterministic (ADR-0011), so the same seed and the same commands must produce
the same ticks, positions, events and rejections. Any difference is either your
change or a regression — never noise.

## 1. Scope the change

```bash
git status --short
git diff --stat
```

Note which of these moved, because it decides what must be rebuilt:

- `crates/**` → the WASM artefacts are stale: rebuild them (step 2).
- `apps/web/**` → the dev server rebuilds on its own.
- `content/**` → mirrored into `public/` by the server's `prestart`.
- `apps/desktop/**` → also run `npm run check:desktop` (needs the GTK/WebKit dev packages).

## 2. Rebuild the engine when Rust changed

```bash
npm run wasm:build          # release, what the delivery ships
# npm run wasm:build:dev    # faster, use while iterating
```

Skipping this is the classic false pass: the tests exercise the new Rust, the
browser keeps running the old `.wasm`.

## 3. Run the gates

```bash
npm run check               # clippy -D warnings, rustfmt, cargo test, web tests
```

While iterating you may narrow it (`cargo test -p insulaire-simulation`, `npm run
test:web`), but the full gate has to pass before anything is committed.

## 4. Run the smoke harness

```bash
node .claude/skills/verify-no-regression/scripts/smoke.mjs
```

It starts the dev server itself (port 4399), launches headless Chromium, then:

1. imports `/wasm/insulaire_engine.js` in the page, loads the shipped tile sets,
   worlds and project, validates the map links;
2. starts a game on the scenario's fixed seed and dispatches its command
   sequence — legal moves, waits, and deliberately illegal moves — recording
   tick, positions, events, rejection codes and RNG draws at every step;
3. opens each page of the app, waits for a painted canvas, captures a PNG plus a
   32x32 grayscale signature of the canvas, and clicks the play canvas to
   exercise the whole click → `dispatch` → render loop;
4. compares everything with `.smoke/baseline/` and writes `.smoke/current/`.

Useful flags: `--base-url http://127.0.0.1:4200` (reuse a server you already
have running — much faster), `--port`, `--scenario`, `--accept`, `--no-compare`.

Exit codes: `0` no regression · `1` regression · `2` the harness itself failed.

## 5. Look at the results yourself

The script's verdict is necessary, not sufficient. Always:

```bash
cat .smoke/current/report.json
```

then **open every PNG in `.smoke/current/screens/` with the Read tool** and
compare it with the same file in `.smoke/baseline/screens/`. The signature only
guards the canvas; a broken side panel, a missing button, an error banner or an
empty event log shows up as `similar` and only a look catches it.

Reading the report:

| Field | Meaning |
|---|---|
| `verdict: clean` | transcript identical, canvases identical, no console errors |
| `verdict: regression` | at least one of those three moved |
| `verdict: no-baseline` | first run on this machine — record one (step 6) |
| `problems[]` | console errors or uncaught exceptions — **always a real defect** |
| `transcriptDiff[]` | `path: before -> after`, e.g. `steps[3].state.player.at[0]: 5 -> 4` |
| `transcriptNotes[]` | recorded but not behaviour, so never a regression — today only `engine.version`, which moves on a release bump (`NOT_BEHAVIOUR` in `smoke.mjs`) |
| `screens[].status` | `identical` · `similar` (pixels differ, canvas does not) · `changed` · `new` · `missing` |

## 6. Decide, then report

- **Clean** → say so, and say what was covered (gates, N commands, which pages).
- **Diff you intended** (you changed a movement rule, retuned the AI, edited
  `content/`) → explain *why each line of the diff follows from the change*,
  then refresh the reference:
  ```bash
  node .claude/skills/verify-no-regression/scripts/smoke.mjs --accept
  ```
- **Diff you did not intend** → that is the regression. Fix the code and re-run.
  Never accept a baseline to make a red run go green, and never accept one you
  have not explained line by line — the baseline is the memory of what "working"
  means.

When a transcript diff touches engine behaviour and you are not certain it was
intended, ask the user before accepting it.

Report back in this shape:

```
gates      npm run check — passed (or: what failed)
engine     12 commands, tick 10, transcript identical to baseline
screens    editor-map identical · play similar · play-click-1/2 identical — looked at, nothing broken
verdict    no regression
```

## The scenario

`.claude/skills/verify-no-regression/scenario.json` — extend it whenever a
feature lands that the current sequence would not notice.

```jsonc
{
  "world": "demo_world",          // world the game starts on
  "seed": 2026,                   // fixed: the RNG lives in Rust (ADR-0011)
  "viewport": { "width": 1440, "height": 900 },
  "steps": [
    { "label": "wait one tick", "cmd": { "type": "wait" } },
    { "label": "first legal move", "legal": 0 },          // nth entry of snapshot.legalMoves
    { "label": "illegal: off the map", "cmd": { "type": "moveTo", "to": [-1, -1] } }
  ],
  "pages": [
    { "name": "play", "path": "/play", "settleMs": 2000, "clicks": [[0.268, 0.511]] }
  ]
}
```

`"legal": n` names a move by its rank in the engine's canonical order, so a
change in that order surfaces as a diff instead of as a rejection. `clicks` are
fractions of the canvas box. A page that has no canvas needs `"canvas": false`.

`press` clicks **named controls** in order, capturing a screen after each, for a
page whose interesting part is behind one — a tab, a mode switch, a panel that
starts shut. Fractions of a canvas cannot reach those, and a module nobody opens
is a module this harness does not guard:

```jsonc
"press": [
  { "name": "editor-character-animation", "selector": ".form .tabs button:nth-of-type(4)" }
]
```

A `press` may set a native input or select deterministically instead of clicking
it by adding `"value": "..."`; it dispatches `input` by default, or the event
named by `"event"`. This exercises colour and range controls without opening a
browser-native picker.

`keys` sends physical keyboard events and captures after each one. `code` is
the persisted physical position and `key` is the layout label, so an AZERTY
case can deliberately state both:

```jsonc
"keys": [
  { "name": "play-north-west", "code": "KeyW", "key": "z" }
]
```

Rules for the scenario: it must stay deterministic (no wall-clock, no random),
it must keep at least one rejected command (the rejection path is a rule too),
and a new page or mode is not covered until it is listed in `pages`.

**A `press` that changes content must undo itself.** The editor persists a
working copy to `localStorage`, which survives the navigation to the next page —
so a press that toggles a map's projection, or paints, leaves the *later* pages
drawing something else, and the diff lands on a page you did not touch. Either
press again to put it back, or do not press it.

## Troubleshooting

- *no Chromium found* → `npx playwright install chromium`, or point
  `SMOKE_CHROME` at a Chrome/Chromium binary.
- *server did not answer* → the printed tail of the server output says why;
  usually a compile error in the Angular app, or port 4399 already taken
  (`--port`).
- *`Could not load the WebAssembly engine`* → `npm run wasm:build`.
- *`no canvas appeared`* → the page threw while starting; check `problems[]` in
  the report, and open the app by hand.
- The baseline is local and gitignored (`.smoke/`). A fresh clone starts with
  `no-baseline`: record one on a known-good commit before trusting a comparison.
