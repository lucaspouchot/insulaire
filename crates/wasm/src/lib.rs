//! WebAssembly bindings for the hex engine.
//!
//! This crate contains **no game logic and no boundary logic**. The string
//! contract — JSON in, JSON out, errors as serialised `EngineErrorPayload` —
//! lives in [`insulaire_engine::JsonEngine`], where it is covered by ordinary
//! `cargo test`. Everything here is a one-line pass-through that converts
//! `String` errors into `JsValue`.
//!
//! That split is deliberate: a bug in the boundary should be catchable without
//! a browser. See `docs/wasm-api.md` and
//! `docs/adr/ADR-0013-engine-api.md`.

#![forbid(unsafe_code)]

use insulaire_engine::JsonEngine;
use wasm_bindgen::prelude::*;

/// Installs a panic hook so Rust panics surface as readable console errors
/// instead of `unreachable executed`.
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

fn to_js(error: String) -> JsValue {
    JsValue::from_str(&error)
}

/// The engine, as seen from JavaScript.
///
/// One instance owns one content registry and at most one running game.
/// Every method that can fail rejects with a JSON string of the shape
/// `{ "code": "...", "message": "...", "report"?: { ... } }`.
#[wasm_bindgen]
#[derive(Debug, Default)]
pub struct InsulaireEngine {
    inner: JsonEngine,
}

#[wasm_bindgen]
impl InsulaireEngine {
    /// Creates an engine with an empty content registry.
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Build identity: name, version, target architecture, pointer width and
    /// supported schema versions.
    ///
    /// # Errors
    ///
    /// A JSON error payload; not reachable for this type in practice.
    #[wasm_bindgen(js_name = engineInfo)]
    pub fn engine_info(&self) -> Result<String, JsValue> {
        self.inner.engine_info().map_err(to_js)
    }

    /// Parses, validates and registers a tile set. Returns a `LoadOutcome`.
    ///
    /// # Errors
    ///
    /// `parse` or `invalidContent`.
    #[wasm_bindgen(js_name = loadTileSet)]
    pub fn load_tile_set(&mut self, json: &str) -> Result<String, JsValue> {
        self.inner.load_tile_set(json).map_err(to_js)
    }

    /// Parses, validates and registers a world. Returns a `LoadOutcome`.
    ///
    /// # Errors
    ///
    /// `parse` or `invalidContent`; the payload carries the validation report.
    #[wasm_bindgen(js_name = loadWorld)]
    pub fn load_world(&mut self, json: &str) -> Result<String, JsValue> {
        self.inner.load_world(json).map_err(to_js)
    }

    /// Parses, validates and registers the project manifest — the list of
    /// content files that make up the game, and the world it starts on. Returns
    /// a `LoadOutcome`.
    ///
    /// Call it after the content it lists has been loaded.
    ///
    /// # Errors
    ///
    /// `parse` or `invalidContent`.
    #[wasm_bindgen(js_name = loadProject)]
    pub fn load_project(&mut self, json: &str) -> Result<String, JsValue> {
        self.inner.load_project(json).map_err(to_js)
    }

    /// Registers one locale file under a language and a namespace. Returns a
    /// `LoadOutcome`.
    ///
    /// # Errors
    ///
    /// `parse` when the file is not a nested object of strings, or redefines a
    /// key.
    #[wasm_bindgen(js_name = loadLocale)]
    pub fn load_locale(
        &mut self,
        language: &str,
        namespace: &str,
        json: &str,
    ) -> Result<String, JsValue> {
        self.inner
            .load_locale(language, namespace, json)
            .map_err(to_js)
    }

    /// Returns a `LocaleView`: one language's text, gaps filled by the default
    /// language.
    ///
    /// # Errors
    ///
    /// `unknownContent` when no file was loaded for that language.
    #[wasm_bindgen(js_name = locale)]
    pub fn locale(&self, language: &str) -> Result<String, JsValue> {
        self.inner.locale(language).map_err(to_js)
    }

    /// Compares the loaded languages against the manifest and each other.
    /// Returns a `ValidationReport`.
    ///
    /// # Errors
    ///
    /// A JSON error payload on serialisation failure.
    #[wasm_bindgen(js_name = validateLocales)]
    pub fn validate_locales(&self) -> Result<String, JsValue> {
        self.inner.validate_locales().map_err(to_js)
    }

    /// Registers the title screen a client opens on. Returns a `LoadOutcome`.
    ///
    /// # Errors
    ///
    /// `parse` or `invalidContent`.
    #[wasm_bindgen(js_name = loadTitleScreen)]
    pub fn load_title_screen(&mut self, json: &str) -> Result<String, JsValue> {
        self.inner.load_title_screen(json).map_err(to_js)
    }

    /// Validates a title screen *without* registering it, keys included.
    /// Returns a `ValidationReport`.
    ///
    /// # Errors
    ///
    /// `parse` when the JSON is malformed.
    #[wasm_bindgen(js_name = validateTitleScreen)]
    pub fn validate_title_screen(&self, json: &str) -> Result<String, JsValue> {
        self.inner.validate_title_screen(json).map_err(to_js)
    }

    /// Returns the registered `TitleScreenDefinition`.
    ///
    /// # Errors
    ///
    /// `unknownContent` when the project ships no title screen.
    #[wasm_bindgen(js_name = titleScreen)]
    pub fn title_screen(&self) -> Result<String, JsValue> {
        self.inner.title_screen().map_err(to_js)
    }

    /// Forgets every loaded tile set, world, locale and project.
    ///
    /// Hosts call this before re-loading a whole project, so content removed in
    /// the editor stops answering for itself. A running game is unaffected.
    #[wasm_bindgen(js_name = resetContent)]
    pub fn reset_content(&mut self) {
        self.inner.reset_content();
    }

    /// Forgets every loaded language, keeping worlds, tile sets and project.
    ///
    /// The language editor calls this before registering the files it just
    /// wrote: loading is additive and refuses a key twice, so edited text can
    /// only replace the old text once the old bundles are gone.
    #[wasm_bindgen(js_name = resetLocales)]
    pub fn reset_locales(&mut self) {
        self.inner.reset_locales();
    }

    /// Resolves every map link across the loaded worlds. Returns a
    /// `ValidationReport`.
    ///
    /// # Errors
    ///
    /// A JSON error payload on serialisation failure.
    #[wasm_bindgen(js_name = validateLinks)]
    pub fn validate_links(&self) -> Result<String, JsValue> {
        self.inner.validate_links().map_err(to_js)
    }

    /// Validates a world *without* registering it — the editor's pre-export
    /// check. Returns a `ValidationReport`.
    ///
    /// # Errors
    ///
    /// `parse` when the JSON is malformed.
    #[wasm_bindgen(js_name = validateWorld)]
    pub fn validate_world(&self, json: &str) -> Result<String, JsValue> {
        self.inner.validate_world(json).map_err(to_js)
    }

    /// Returns a `ContentSummary`: loaded tile sets, worlds and templates.
    ///
    /// # Errors
    ///
    /// A JSON error payload on serialisation failure.
    #[wasm_bindgen(js_name = contentSummary)]
    pub fn content_summary(&self) -> Result<String, JsValue> {
        self.inner.content_summary().map_err(to_js)
    }

    /// Returns a `WorldView`: dimensions, tile palette and locations.
    ///
    /// # Errors
    ///
    /// `unknownContent`.
    #[wasm_bindgen(js_name = worldView)]
    pub fn world_view(&self, world_id: &str) -> Result<String, JsValue> {
        self.inner.world_view(world_id).map_err(to_js)
    }

    /// Returns the packed terrain buffer as a `Uint8Array`: one palette index
    /// per cell, row-major in offset coordinates.
    ///
    /// This is one of the two bulk transfers in the API, and the reason the
    /// renderer never calls into WASM per tile.
    ///
    /// # Errors
    ///
    /// `unknownContent`.
    #[wasm_bindgen(js_name = terrainBuffer)]
    pub fn terrain_buffer(&self, world_id: &str) -> Result<Vec<u8>, JsValue> {
        self.inner.terrain_buffer(world_id).map_err(to_js)
    }

    /// Returns the packed elevation buffer as an `Int8Array`: one signed byte
    /// per cell, in the same layout as `terrainBuffer`.
    ///
    /// Presentation only; the renderer uses it in isometric mode
    /// (`docs/adr/ADR-0016-isometric-projection.md`).
    ///
    /// # Errors
    ///
    /// `unknownContent`.
    #[wasm_bindgen(js_name = elevationBuffer)]
    pub fn elevation_buffer(&self, world_id: &str) -> Result<Vec<i8>, JsValue> {
        self.inner.elevation_buffer(world_id).map_err(to_js)
    }

    /// Starts a game on a registered world. Returns the initial `GameSnapshot`.
    ///
    /// # Errors
    ///
    /// `unknownContent` or `setup`.
    #[wasm_bindgen(js_name = createGame)]
    pub fn create_game(
        &mut self,
        world_id: &str,
        seed: u32,
        settings_json: &str,
    ) -> Result<String, JsValue> {
        self.inner
            .create_game(world_id, seed, settings_json)
            .map_err(to_js)
    }

    /// Registers the game's settings declaration. Returns a `LoadOutcome`.
    ///
    /// # Errors
    ///
    /// `parse` or `invalidContent`.
    #[wasm_bindgen(js_name = loadSettings)]
    pub fn load_settings(&mut self, json: &str) -> Result<String, JsValue> {
        self.inner.load_settings(json).map_err(to_js)
    }

    /// Validates a settings declaration *without* registering it, keys
    /// included. Returns a `ValidationReport`.
    ///
    /// # Errors
    ///
    /// `parse` when the JSON is malformed.
    #[wasm_bindgen(js_name = validateSettings)]
    pub fn validate_settings(&self, json: &str) -> Result<String, JsValue> {
        self.inner.validate_settings(json).map_err(to_js)
    }

    /// Returns the registered `SettingsDefinition`.
    ///
    /// # Errors
    ///
    /// `unknownContent` when the project declares no settings.
    #[wasm_bindgen(js_name = settings)]
    pub fn settings(&self) -> Result<String, JsValue> {
        self.inner.settings().map_err(to_js)
    }

    /// Resolves values against the declaration: defaults filled, unknown keys
    /// dropped, numbers clamped.
    ///
    /// # Errors
    ///
    /// `parse` when the values are not a JSON object.
    #[wasm_bindgen(js_name = resolveSettings)]
    pub fn resolve_settings(&self, values_json: &str) -> Result<String, JsValue> {
        self.inner.resolve_settings(values_json).map_err(to_js)
    }

    /// Parses, validates and registers a character definition. Returns a
    /// `LoadOutcome`.
    ///
    /// # Errors
    ///
    /// `parse` or `invalidContent`.
    #[wasm_bindgen(js_name = loadCharacter)]
    pub fn load_character(&mut self, json: &str) -> Result<String, JsValue> {
        self.inner.load_character(json).map_err(to_js)
    }

    /// Validates a character definition *without* registering it, keys
    /// included. Returns a `ValidationReport`.
    ///
    /// # Errors
    ///
    /// `parse` when the JSON is malformed.
    #[wasm_bindgen(js_name = validateCharacter)]
    pub fn validate_character(&self, json: &str) -> Result<String, JsValue> {
        self.inner.validate_character(json).map_err(to_js)
    }

    /// Returns a registered `CharacterDefinition`.
    ///
    /// # Errors
    ///
    /// `unknownContent` when no definition has that id.
    #[wasm_bindgen(js_name = character)]
    pub fn character(&self, id: &str) -> Result<String, JsValue> {
        self.inner.character(id).map_err(to_js)
    }

    /// Returns the ids of every registered character definition.
    ///
    /// # Errors
    ///
    /// A JSON error payload; not reachable in practice.
    #[wasm_bindgen(js_name = characterIds)]
    pub fn character_ids(&self) -> Result<String, JsValue> {
        self.inner.character_ids().map_err(to_js)
    }

    /// Resolves a definition **passed in** against a customisation — the
    /// editor's preview, for content that is not registered yet. Returns a
    /// `ResolvedCharacter`.
    ///
    /// # Errors
    ///
    /// `parse` when either argument is not JSON.
    #[wasm_bindgen(js_name = previewCharacter)]
    pub fn preview_character(
        &self,
        character_json: &str,
        values_json: &str,
    ) -> Result<String, JsValue> {
        self.inner
            .preview_character(character_json, values_json)
            .map_err(to_js)
    }

    /// Resolves a definition against a customisation such as
    /// `{"hairColor":"#f2c14e"}`. Returns a `ResolvedCharacter`.
    ///
    /// # Errors
    ///
    /// `parse` or `unknownContent`.
    #[wasm_bindgen(js_name = resolveCharacter)]
    pub fn resolve_character(&self, id: &str, values_json: &str) -> Result<String, JsValue> {
        self.inner.resolve_character(id, values_json).map_err(to_js)
    }

    /// Returns the current `GameSnapshot`.
    ///
    /// # Errors
    ///
    /// `noGame` when nothing is running.
    #[wasm_bindgen(js_name = snapshot)]
    pub fn snapshot(&self) -> Result<String, JsValue> {
        self.inner.snapshot().map_err(to_js)
    }

    /// Applies a command such as `{"type":"moveTo","to":[3,4]}` or
    /// `{"type":"wait"}`. Returns a `CommandResult`.
    ///
    /// An *illegal* command is not an error: it comes back with
    /// `accepted: false` and a `rejection`.
    ///
    /// # Errors
    ///
    /// `parse` or `noGame`.
    #[wasm_bindgen(js_name = dispatch)]
    pub fn dispatch(&mut self, command_json: &str) -> Result<String, JsValue> {
        self.inner.dispatch(command_json).map_err(to_js)
    }

    /// Discards the running game. Content stays loaded.
    #[wasm_bindgen(js_name = endGame)]
    pub fn end_game(&mut self) {
        self.inner.end_game();
    }

    /// `true` when a game is in progress.
    #[wasm_bindgen(js_name = hasGame)]
    #[must_use]
    pub fn has_game(&self) -> bool {
        self.inner.has_game()
    }
}
