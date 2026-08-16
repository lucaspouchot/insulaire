//! The string-in / string-out facade.
//!
//! This is the *exact* contract the WASM bindings expose, expressed without any
//! dependency on `wasm-bindgen`. Structured payloads cross as JSON strings and
//! errors as serialised [`EngineErrorPayload`]s; the one bulk payload, the
//! terrain buffer, stays a plain byte vector.
//!
//! Keeping the contract here rather than in `hex-wasm` means the whole boundary
//! is covered by ordinary `cargo test`, and the WASM crate reduces to a pass-
//! through that cannot hide a bug.
//!
//! # Why JSON strings
//!
//! Snapshots are a few hundred bytes, so the parse cost is irrelevant, and a
//! string boundary is trivially inspectable from devtools and from tests. The
//! payload that *is* large never uses JSON. See `docs/wasm-api.md`.

use crate::dto::Command;
use crate::error::EngineError;
use crate::Engine;

/// The result of a facade call: JSON on success, a serialised
/// [`EngineErrorPayload`](crate::EngineErrorPayload) on failure.
pub type JsonResult<T = String> = Result<T, String>;

/// Serialises `value`, or reports the failure in the same error shape.
fn ok<T: serde::Serialize>(value: &T) -> JsonResult {
    serde_json::to_string(value).map_err(|error| {
        let message =
            serde_json::to_string(&error.to_string()).unwrap_or_else(|_| "\"unknown\"".to_owned());
        format!(r#"{{"code":"serialise","message":{message}}}"#)
    })
}

/// Renders an engine error as its JSON payload.
fn err(error: &EngineError) -> String {
    serde_json::to_string(&error.to_payload())
        .unwrap_or_else(|_| r#"{"code":"unknown","message":"engine error"}"#.to_owned())
}

/// [`Engine`] with a string boundary.
#[derive(Debug, Default)]
pub struct JsonEngine {
    inner: Engine,
}

impl JsonEngine {
    /// Creates an engine with an empty content registry.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns an [`EngineInfo`](crate::EngineInfo) as JSON.
    ///
    /// # Errors
    ///
    /// Only on serialisation failure.
    pub fn engine_info(&self) -> JsonResult {
        ok(&Engine::info())
    }

    /// Registers a tile set; returns a [`LoadOutcome`](crate::LoadOutcome).
    ///
    /// # Errors
    ///
    /// `parse` for malformed JSON, `invalidContent` for a failing tile set.
    pub fn load_tile_set(&mut self, json: &str) -> JsonResult {
        let outcome = self
            .inner
            .load_tile_set(json)
            .map_err(|error| err(&error))?;
        ok(&outcome)
    }

    /// Registers a world; returns a [`LoadOutcome`](crate::LoadOutcome).
    ///
    /// # Errors
    ///
    /// `parse` for malformed JSON, `invalidContent` for a failing world. The
    /// error payload carries the full validation report.
    pub fn load_world(&mut self, json: &str) -> JsonResult {
        let outcome = self.inner.load_world(json).map_err(|error| err(&error))?;
        ok(&outcome)
    }

    /// Validates a world without registering it; returns a `ValidationReport`.
    ///
    /// # Errors
    ///
    /// `parse` for malformed JSON. An unusable world yields an invalid report,
    /// not an error.
    pub fn validate_world(&self, json: &str) -> JsonResult {
        let report = self
            .inner
            .validate_world(json)
            .map_err(|error| err(&error))?;
        ok(&report)
    }

    /// Returns a [`ContentSummary`](crate::ContentSummary).
    ///
    /// # Errors
    ///
    /// Only on serialisation failure.
    pub fn content_summary(&self) -> JsonResult {
        ok(&self.inner.content_summary())
    }

    /// Returns a [`WorldView`](crate::WorldView).
    ///
    /// # Errors
    ///
    /// `unknownContent` when the world is not registered.
    pub fn world_view(&self, world_id: &str) -> JsonResult {
        let view = self
            .inner
            .world_view(world_id)
            .map_err(|error| err(&error))?;
        ok(&view)
    }

    /// Returns the packed terrain buffer: one palette index per cell.
    ///
    /// # Errors
    ///
    /// `unknownContent` when the world is not registered.
    pub fn terrain_buffer(&self, world_id: &str) -> JsonResult<Vec<u8>> {
        self.inner
            .terrain_buffer(world_id)
            .map_err(|error| err(&error))
    }

    /// Starts a game; returns the initial [`GameSnapshot`](crate::GameSnapshot).
    ///
    /// # Errors
    ///
    /// `unknownContent` or `setup`.
    pub fn create_game(&mut self, world_id: &str, seed: u32) -> JsonResult {
        let snapshot = self
            .inner
            .create_game(world_id, seed)
            .map_err(|error| err(&error))?;
        ok(&snapshot)
    }

    /// Returns the current [`GameSnapshot`](crate::GameSnapshot).
    ///
    /// # Errors
    ///
    /// `noGame` when nothing is running.
    pub fn snapshot(&self) -> JsonResult {
        let snapshot = self.inner.snapshot().map_err(|error| err(&error))?;
        ok(&snapshot)
    }

    /// Applies a JSON command; returns a [`CommandResult`](crate::CommandResult).
    ///
    /// An *illegal* command is not an error: it comes back with
    /// `accepted: false` and a `rejection`.
    ///
    /// # Errors
    ///
    /// `parse` for an unknown command shape, `noGame` when nothing is running.
    pub fn dispatch(&mut self, command_json: &str) -> JsonResult {
        let command: Command = serde_json::from_str(command_json).map_err(|error| {
            err(&EngineError::Parse {
                what: "command".to_owned(),
                message: error.to_string(),
            })
        })?;
        let result = self.inner.dispatch(command).map_err(|error| err(&error))?;
        ok(&result)
    }

    /// Discards the running game; content stays loaded.
    pub fn end_game(&mut self) {
        self.inner.end_game();
    }

    /// `true` when a game is in progress.
    #[must_use]
    pub const fn has_game(&self) -> bool {
        self.inner.has_game()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const TILE_SET: &str = r##"{
        "id": "t", "schemaVersion": 1, "tiles": [
            { "id": "grass", "terrain": "grass", "movementCost": 1,
              "visual": { "visualId": "terrain.grass", "fallbackColor": "#4f7a3a" } },
            { "id": "water", "terrain": "water", "movementCost": 0,
              "visual": { "visualId": "terrain.water", "fallbackColor": "#1d4e79" } }
        ]}"##;

    const WORLD: &str = r#"{
        "id": "w", "schemaVersion": 1, "width": 8, "height": 8,
        "tileSetId": "t", "defaultTile": "grass",
        "tiles": [{ "at": [4, 4], "tile": "water" }],
        "entities": [
            { "id": "p", "templateId": "player", "at": [2, 2] },
            { "id": "m", "templateId": "monster", "at": [6, 2] }
        ]}"#;

    fn json(text: &str) -> Value {
        serde_json::from_str(text).expect("valid JSON")
    }

    fn code(error: &str) -> String {
        json(error)["code"].as_str().expect("code field").to_owned()
    }

    fn loaded() -> JsonEngine {
        let mut engine = JsonEngine::new();
        engine.load_tile_set(TILE_SET).expect("tile set loads");
        engine.load_world(WORLD).expect("world loads");
        engine
    }

    #[test]
    fn the_full_load_play_loop_works_through_the_string_api() {
        let mut engine = loaded();

        let view = json(&engine.world_view("w").expect("view"));
        assert_eq!(view["width"], 8);
        assert_eq!(view["cellCount"], 64);
        assert_eq!(view["palette"].as_array().expect("palette").len(), 2);

        assert_eq!(engine.terrain_buffer("w").expect("buffer").len(), 64);

        let snapshot = json(&engine.create_game("w", 7).expect("game"));
        assert_eq!(snapshot["tick"], 0);
        assert!(engine.has_game());

        let target = &snapshot["legalMoves"][0];
        let result = json(
            &engine
                .dispatch(&format!(r#"{{"type":"moveTo","to":{target}}}"#))
                .expect("dispatch"),
        );

        assert_eq!(result["accepted"], true);
        assert_eq!(result["state"]["tick"], 1);
        assert_eq!(result["state"]["player"]["at"], *target);
    }

    #[test]
    fn errors_cross_the_boundary_as_json_payloads() {
        let mut engine = JsonEngine::new();
        assert_eq!(code(&engine.load_world("{").unwrap_err()), "parse");
        assert_eq!(
            code(&engine.load_world(WORLD).unwrap_err()),
            "invalidContent"
        );
        assert_eq!(code(&engine.snapshot().unwrap_err()), "noGame");
        assert_eq!(
            code(&engine.world_view("nope").unwrap_err()),
            "unknownContent"
        );
        assert_eq!(
            code(&engine.terrain_buffer("nope").expect_err("unknown world")),
            "unknownContent"
        );
        assert_eq!(
            code(&engine.dispatch(r#"{"type":"fly"}"#).unwrap_err()),
            "parse"
        );
        assert_eq!(
            code(&engine.create_game("nope", 1).unwrap_err()),
            "unknownContent"
        );
    }

    #[test]
    fn an_illegal_command_is_a_result_not_an_error() {
        let mut engine = loaded();
        engine.create_game("w", 1).expect("game");

        let result = json(
            &engine
                .dispatch(r#"{"type":"moveTo","to":[7,7]}"#)
                .expect("the call itself succeeds"),
        );

        assert_eq!(result["accepted"], false);
        assert_eq!(result["rejection"]["code"], "notAdjacent");
        assert_eq!(result["state"]["tick"], 0);
    }

    #[test]
    fn invalid_content_errors_carry_the_validation_report() {
        let mut engine = JsonEngine::new();
        engine.load_tile_set(TILE_SET).expect("tile set loads");

        let broken = WORLD.replace(
            r#"{ "id": "p", "templateId": "player", "at": [2, 2] },"#,
            "",
        );
        let payload = json(&engine.load_world(&broken).unwrap_err());

        assert_eq!(payload["code"], "invalidContent");
        let codes: Vec<&str> = payload["report"]["issues"]
            .as_array()
            .expect("issues")
            .iter()
            .filter_map(|issue| issue["code"].as_str())
            .collect();
        assert!(codes.contains(&"world.missingPlayer"), "got {codes:?}");
    }

    #[test]
    fn the_editor_validation_path_does_not_register_worlds() {
        let mut engine = JsonEngine::new();
        engine.load_tile_set(TILE_SET).expect("tile set loads");

        assert_eq!(
            json(&engine.validate_world(WORLD).expect("validates"))["valid"],
            true
        );

        let summary = json(&engine.content_summary().expect("summary"));
        assert_eq!(summary["worlds"].as_array().expect("worlds").len(), 0);
        assert_eq!(summary["tileSets"].as_array().expect("tileSets").len(), 1);
        assert_eq!(summary["templates"].as_array().expect("templates").len(), 2);
    }

    #[test]
    fn engine_info_reports_the_build() {
        let info = json(&JsonEngine::new().engine_info().expect("info"));
        assert_eq!(info["name"], "hex-engine");
        assert_eq!(info["worldSchemaVersion"], 1);
        assert!(info["version"].is_string());
    }

    #[test]
    fn waiting_advances_the_tick_and_the_monster() {
        let mut engine = loaded();
        let before = json(&engine.create_game("w", 3).expect("game"));
        let monster_before = before["entities"][1]["at"].clone();

        let result = json(&engine.dispatch(r#"{"type":"wait"}"#).expect("dispatch"));

        assert_eq!(result["state"]["tick"], 1);
        assert_ne!(result["state"]["entities"][1]["at"], monster_before);
    }

    #[test]
    fn ending_a_game_leaves_content_loaded() {
        let mut engine = loaded();
        engine.create_game("w", 1).expect("game");
        engine.end_game();

        assert!(!engine.has_game());
        assert_eq!(code(&engine.snapshot().unwrap_err()), "noGame");
        assert!(engine.world_view("w").is_ok());
    }
}
