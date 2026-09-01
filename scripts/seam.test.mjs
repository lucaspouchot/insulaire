import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  SEAM_PATH,
  camelCase,
  loadSeam,
  renderJsonEngine,
  renderMethodTable,
  renderRawEngineInterface,
  renderWasmBindings,
  unwiredMethods,
} from './seam.mjs';

/** A declaration with one method, so a test states only what it is about. */
function seamOf(method, modules = {}) {
  return {
    modules: {
      json: { doc: ['The string facade.'] },
      wasm: { doc: ['The bindings.'] },
      typescript: { doc: ['The raw class.'] },
      ...modules,
    },
    methods: [
      {
        name: 'load_world',
        mutates: true,
        params: [{ name: 'json', type: 'str' }],
        returns: 'json',
        payload: 'LoadOutcome',
        doc: ['Registers a world.'],
        errors: ['`parse` or `invalidContent`.'],
        ...method,
      },
    ],
  };
}

describe('camelCase', () => {
  it('turns a snake_case seam method into its JavaScript name', () => {
    assert.equal(camelCase('load_tile_set'), 'loadTileSet');
    assert.equal(camelCase('engine_info'), 'engineInfo');
    assert.equal(camelCase('snapshot'), 'snapshot');
  });

  it('does not swallow a digit boundary', () => {
    assert.equal(camelCase('load_v2_world'), 'loadV2World');
  });
});

describe('loadSeam', () => {
  it('refuses a parameter type the three targets cannot render', () => {
    assert.throws(
      () => loadSeam(seamOf({ params: [{ name: 'at', type: 'f64' }] })),
      /unknown parameter type `f64`/,
    );
  });

  it('refuses a fallible method with no documented errors', () => {
    const seam = seamOf({});
    delete seam.methods[0].errors;
    assert.throws(() => loadSeam(seam), /load_world.*must document its errors/);
  });

  it('refuses an infallible method that documents errors anyway', () => {
    assert.throws(
      () => loadSeam(seamOf({ returns: 'void', payload: undefined })),
      /load_world.*returns `void`.*cannot fail/,
    );
  });

  it('refuses an expr on a return shape that cannot encode one', () => {
    const seam = seamOf({ returns: 'void', payload: undefined, expr: 'Engine::info()' });
    delete seam.methods[0].errors;
    assert.throws(() => loadSeam(seam), /only a `json` return can encode/);
  });

  it('refuses a payload on a return shape that already names itself', () => {
    assert.throws(
      () => loadSeam(seamOf({ returns: 'bytes_u8', payload: 'Uint8Array' })),
      /already names itself/,
    );
  });

  it('refuses two methods sharing a name', () => {
    const seam = seamOf({});
    seam.methods.push({ ...seam.methods[0] });
    assert.throws(() => loadSeam(seam), /declared twice/);
  });

  it('refuses a JSON method with no payload type', () => {
    const seam = seamOf({});
    delete seam.methods[0].payload;
    assert.throws(() => loadSeam(seam), /must name the payload/);
  });
});

describe('renderJsonEngine', () => {
  const bodyOf = (method) => renderJsonEngine(loadSeam(seamOf(method)));

  it('forwards a fallible method and encodes its result', () => {
    const out = bodyOf({});
    assert.match(out, /pub fn load_world\(&mut self, json: &str\) -> JsonResult \{/);
    assert.match(out, /let value = self\.inner\.load_world\(json\)\.map_err\(\|error\| err\(&error\)\)\?;/);
    assert.match(out, /ok\(&value\)/);
  });

  it('encodes an infallible method without a map_err', () => {
    const out = bodyOf({ infallible: true });
    assert.match(out, /ok\(&self\.inner\.load_world\(json\)\)/);
    assert.doesNotMatch(out, /let value =/);
  });

  it('returns a byte buffer unencoded', () => {
    const out = bodyOf({ returns: 'bytes_u8', payload: undefined });
    assert.match(out, /-> JsonResult<Vec<u8>>/);
    assert.match(out, /self\.inner\.load_world\(json\)\.map_err\(\|error\| err\(&error\)\)\s*\}/);
  });

  it('renders a void method with neither a result nor an errors section', () => {
    const seam = seamOf({ returns: 'void', payload: undefined });
    delete seam.methods[0].errors;
    const out = renderJsonEngine(loadSeam(seam));
    assert.match(out, /pub fn load_world\(&mut self, json: &str\) \{\s*self\.inner\.load_world\(json\);/);
    assert.doesNotMatch(out, /# Errors/);
  });

  it('renders a bool method as a const fn that must be used', () => {
    const seam = seamOf({ returns: 'bool', payload: undefined, params: [], mutates: false });
    delete seam.methods[0].errors;
    const out = renderJsonEngine(loadSeam(seam));
    assert.match(out, /#\[must_use\]\s*pub const fn load_world\(&self\) -> bool \{/);
  });

  it('calls the engine method the declaration names when it differs', () => {
    const out = bodyOf({ inner: 'loaded_world' });
    assert.match(out, /self\.inner\.loaded_world\(json\)/);
  });

  it('emits a declared expression instead of forwarding', () => {
    const out = bodyOf({ expr: 'Engine::info()', params: [] });
    assert.match(out, /ok\(&Engine::info\(\)\)/);
  });

  it('parses an adapted parameter before forwarding it', () => {
    const out = bodyOf({
      params: [
        {
          name: 'command_json',
          type: 'str',
          adapt: { type: 'Command', from: 'json', what: 'command', import: 'crate::dto::Command' },
        },
      ],
    });
    assert.match(out, /use crate::dto::Command;/);
    assert.match(out, /let command_json: Command = serde_json::from_str\(command_json\)/);
    assert.match(out, /what: "command"\.to_owned\(\)/);
  });

  it('allows the argument count on a method wide enough to trip clippy', () => {
    const params = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => ({ name, type: 'str' }));
    assert.match(bodyOf({ params }), /#\[allow\(clippy::too_many_arguments\)\]/);
    assert.doesNotMatch(bodyOf({}), /too_many_arguments/);
  });

  it('spells a parameter the way a Rust reader will see it', () => {
    const out = bodyOf({
      params: [{ name: 'choice_json', type: 'str' }],
      doc: ['`choiceJson` rolls everything, and `notAParam` is left alone.'],
    });
    assert.match(out, /`choice_json` rolls everything, and `notAParam` is left alone\./);
  });

  it('states the module documentation the declaration carries', () => {
    assert.match(bodyOf({}), /^\/\/! The string facade\./m);
  });

  it('says in the file that it is generated, and from where', () => {
    const out = bodyOf({});
    assert.match(out, /@generated/);
    assert.match(out, /crates\/engine\/seam\.json/);
  });
});

describe('renderWasmBindings', () => {
  const bodyOf = (method) => renderWasmBindings(loadSeam(seamOf(method)));

  it('names the JavaScript method in camelCase', () => {
    const out = bodyOf({});
    assert.match(out, /#\[wasm_bindgen\(js_name = loadWorld\)\]/);
  });

  it('takes an owned option and lends it to the facade', () => {
    const out = bodyOf({ params: [{ name: 'animation', type: 'str?' }] });
    assert.match(out, /animation: Option<String>/);
    assert.match(out, /\.load_world\(animation\.as_deref\(\)\)/);
  });

  it('allows the argument count on a method wide enough to trip clippy', () => {
    const params = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => ({ name, type: 'str' }));
    assert.match(bodyOf({ params }), /#\[allow\(clippy::too_many_arguments\)\]/);
    assert.doesNotMatch(bodyOf({}), /too_many_arguments/);
  });

  it('passes an adapted parameter through untouched — the facade owns the parsing', () => {
    const out = bodyOf({
      params: [
        {
          name: 'command_json',
          type: 'str',
          adapt: { type: 'Command', from: 'json', what: 'command', import: 'crate::dto::Command' },
        },
      ],
    });
    assert.match(out, /command_json: &str/);
    assert.doesNotMatch(out, /serde_json/);
  });
});

describe('renderRawEngineInterface', () => {
  const bodyOf = (method) => renderRawEngineInterface(loadSeam(seamOf(method)));

  it('maps each seam type to its JavaScript one', () => {
    assert.match(bodyOf({}), /loadWorld\(json: string\): string;/);
    assert.match(bodyOf({ returns: 'bytes_u8', payload: undefined }), /\): Uint8Array;/);
    assert.match(bodyOf({ returns: 'bytes_i8', payload: undefined }), /\): Int8Array;/);
    const seam = seamOf({ returns: 'void', payload: undefined });
    delete seam.methods[0].errors;
    assert.match(renderRawEngineInterface(loadSeam(seam)), /\): void;/);
  });

  it('renders an optional string as one', () => {
    const out = bodyOf({ params: [{ name: 'animation', type: 'str?' }] });
    assert.match(out, /loadWorld\(animation: string \| undefined\): string;/);
  });

  it('breaks a signature that does not fit the print width', () => {
    const params = ['first_argument', 'second_argument', 'third_argument', 'fourth_argument'].map(
      (name) => ({ name, type: 'str' }),
    );
    const out = bodyOf({ params });
    assert.match(out, /loadWorld\(\n {4}firstArgument: string,\n/);
    assert.match(out, /fourthArgument: string,\n {2}\): string;/);
  });

  it('carries a parameter own note into the interface', () => {
    const out = bodyOf({
      params: [
        { name: 'json', type: 'str' },
        { name: 'projection', type: 'str', doc: 'Isometric resolves the cliff.' },
        { name: 'choice_json', type: 'str' },
        { name: 'another_one', type: 'str' },
      ],
    });
    assert.match(out, /\/\*\* Isometric resolves the cliff\. \*\/\n {4}projection: string,/);
  });

  it('closes with the free method wasm-bindgen adds', () => {
    assert.match(bodyOf({}), /free\(\): void;\n\}/);
  });
});

describe('renderMethodTable', () => {
  const headings = ['`loadWorld(json: string): LoadOutcome`'];

  it('gives one row per method, linking to its authored section', () => {
    const out = renderMethodTable(loadSeam(seamOf({})), headings);
    assert.match(out, /\| \[`loadWorld`\]\(#loadworldjson-string-loadoutcome\) \| `json` \| `LoadOutcome` \|/);
  });

  it('marks an optional argument as optional', () => {
    const out = renderMethodTable(
      loadSeam(seamOf({ params: [{ name: 'animation', type: 'str?' }] })),
      headings,
    );
    assert.match(out, /`animation\?`/);
  });

  it('keeps both hyphens where a section covers two methods', () => {
    const out = renderMethodTable(loadSeam(seamOf({})), [
      '`loadWorld(json: string): LoadOutcome` / `other(): void`',
    ]);
    assert.match(out, /#loadworldjson-string-loadoutcome--other-void/);
  });

  it('refuses a method the reference does not document', () => {
    assert.throws(
      () => renderMethodTable(loadSeam(seamOf({})), []),
      /`loadWorld` has no `###` section/,
    );
  });
});

describe('unwiredMethods', () => {
  it('names a method Angular never calls', () => {
    const seam = loadSeam(seamOf({}));
    assert.deepEqual(unwiredMethods(seam, 'const x = 1;'), ['loadWorld']);
  });

  it('accepts a method reached through a signal rather than a wrapper', () => {
    const seam = loadSeam(seamOf({}));
    assert.deepEqual(unwiredMethods(seam, 'this.running.set(this.instance?.loadWorld());'), []);
  });

  it('does not take a mention in a comment for a call', () => {
    const seam = loadSeam(seamOf({}));
    assert.deepEqual(unwiredMethods(seam, '/** mirrored from `.loadWorld()`. */'), ['loadWorld']);
    assert.deepEqual(unwiredMethods(seam, '// see .loadWorld()'), ['loadWorld']);
  });

  it('does not mistake a URL in code for a comment', () => {
    const seam = loadSeam(seamOf({}));
    assert.deepEqual(unwiredMethods(seam, "fetch('https://x/y'); this.e.loadWorld(j);"), []);
  });
});

describe('a content kind', () => {
  /** A declaration whose only entry is one content kind. */
  const kindSeam = (row) => ({
    modules: {
      json: { doc: ['The string facade.'] },
      wasm: { doc: ['The bindings.'] },
      typescript: { doc: ['The raw class.'] },
    },
    methods: [
      {
        kind: 'character',
        noun: 'a character definition',
        payload: 'CharacterDefinition',
        read: 'by_id',
        methods: ['load', 'validate', 'get', 'ids'],
        ...row,
      },
    ],
  });

  it('expands one row into the four methods a keyed kind has', () => {
    const seam = loadSeam(kindSeam({}));
    assert.deepEqual(
      seam.methods.map((method) => method.name),
      ['load_character', 'validate_character', 'character', 'character_ids'],
    );
    assert.deepEqual(
      seam.methods.map((method) => method.jsName),
      ['loadCharacter', 'validateCharacter', 'character', 'characterIds'],
    );
  });

  it('reads a keyed kind by id and lists it', () => {
    const [, , get, ids] = loadSeam(kindSeam({})).methods;
    assert.deepEqual(
      get.params.map((param) => param.name),
      ['id'],
    );
    assert.equal(get.payload, 'CharacterDefinition');
    assert.deepEqual(ids.params, []);
    assert.equal(ids.payload, 'string[]');
  });

  it('reads a kind a project holds one of without an id', () => {
    const [, , get] = loadSeam(
      kindSeam({ kind: 'title_screen', noun: 'a title screen', read: 'sole', methods: ['load', 'validate', 'get'] }),
    ).methods;
    assert.equal(get.name, 'title_screen');
    assert.deepEqual(get.params, []);
  });

  it('calls the generic engine method with the kind as its type parameter', () => {
    const out = renderJsonEngine(loadSeam(kindSeam({})));
    assert.match(out, /self\.inner\.load::<crate::kinds::Character>\(json\)/);
    assert.match(out, /self\.inner\.validate::<crate::kinds::Character>\(json\)/);
    assert.match(out, /self\.inner\.definition::<crate::kinds::Character>\(id\)/);
    assert.match(out, /ok\(&self\.inner\.ids::<crate::kinds::Character>\(\)\)/);
  });

  it('reaches a kind a project holds one of through `only`', () => {
    const out = renderJsonEngine(
      loadSeam(kindSeam({ kind: 'settings', noun: 'a settings declaration', read: 'sole', methods: ['get'] })),
    );
    assert.match(out, /self\.inner\.only::<crate::kinds::Settings>\(\)/);
  });

  it('takes only the methods the row asks for', () => {
    const seam = loadSeam(kindSeam({ methods: ['load'] }));
    assert.deepEqual(
      seam.methods.map((method) => method.name),
      ['load_character'],
    );
  });

  it('says a kind names the keys it shows only when it has some', () => {
    const [, withKeys] = loadSeam(kindSeam({ keys: true })).methods;
    const [, without] = loadSeam(kindSeam({})).methods;
    assert.match(withKeys.doc[0], /keys included/);
    assert.doesNotMatch(without.doc[0], /keys included/);
  });

  it('lets a row override the prose a template cannot know', () => {
    const [load] = loadSeam(
      kindSeam({ load: { doc: ['Registers it, but the characters must be loaded first.'] } }),
    ).methods;
    assert.equal(load.doc[0], 'Registers it, but the characters must be loaded first.');
    assert.match(load.errors[0], /`invalidContent`/, 'the untouched half stays templated');
  });

  it('refuses a way of reading a kind back that the boundary has no method for', () => {
    assert.throws(() => loadSeam(kindSeam({ read: 'several' })), /unknown read shape `several`/);
  });

  it('refuses to list a kind a project holds one of', () => {
    assert.throws(
      () => loadSeam(kindSeam({ read: 'sole', methods: ['ids'] })),
      /is read `sole`, which has no `ids`/,
    );
  });

  it('refuses a row that says nothing about itself', () => {
    assert.throws(() => loadSeam(kindSeam({ noun: undefined })), /must say what prose calls it/);
    assert.throws(() => loadSeam(kindSeam({ payload: undefined })), /must name the definition/);
    assert.throws(() => loadSeam(kindSeam({ methods: [] })), /declares no methods/);
  });
});

describe('the declaration this repository ships', () => {
  const seam = loadSeam(JSON.parse(readFileSync(fileURLToPath(SEAM_PATH), 'utf8')));

  it('is the whole seam, stated once', () => {
    assert.equal(seam.methods.length, 54);
  });

  it('states its content kinds as kinds, not as methods four at a time', () => {
    const rows = JSON.parse(readFileSync(fileURLToPath(SEAM_PATH), 'utf8')).methods;
    const kinds = rows.filter((row) => row.kind);
    assert.equal(kinds.length, 9, 'every content kind the engine holds');
    assert.ok(
      rows.length < seam.methods.length,
      `${rows.length} rows declare ${seam.methods.length} methods`,
    );
  });

  it('documents every method', () => {
    for (const method of seam.methods) {
      assert.ok(method.doc.length > 0, `${method.name} has no documentation`);
    }
  });
});
