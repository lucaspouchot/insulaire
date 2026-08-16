//! The engine facade.
//!
//! [`Engine`] is the whole public surface of the simulation: content in,
//! commands in, compact snapshots out. It is host-agnostic — the WASM bindings
//! in `hex-wasm` add no logic of their own, and the same facade drives the
//! native test suite.
//!
//! # Shape of the API
//!
//! ```text
//! load_tile_set(json)  ─┐
//! load_world(json)     ─┴─> content registry ──> create_game(worldId, seed)
//!                                                      │
//!                       world_view(worldId) ───────────┤  once per world
//!                       terrain_buffer(worldId) ───────┤  (packed Uint8Array)
//!                       elevation_buffer(worldId) ─────┘  (packed Int8Array)
//!                                                      │
//!                       dispatch(command) ─────────────┴─> CommandResult
//! ```
//!
//! Two rules keep the boundary cheap:
//!
//! * the map crosses **once** per world, as a packed byte buffer, not per tile;
//! * a [`CommandResult`] carries only what changed plus a few hundred bytes of
//!   runtime state — never the map.
//!
//! See `docs/wasm-api.md` and `docs/adr/ADR-0013-engine-api.md`.
//!
//! # Example
//!
//! ```
//! use hex_engine::{Command, Engine};
//! # let tile_set = r#"{"id":"t","schemaVersion":1,"tiles":[
//! #   {"id":"grass","terrain":"grass","movementCost":1,
//! #    "visual":{"visualId":"terrain.grass","fallbackColor":"green"}}]}"#;
//! # let world = r#"{"id":"w","schemaVersion":1,"width":8,"height":8,
//! #   "tileSetId":"t","defaultTile":"grass","entities":[
//! #     {"id":"p","templateId":"player","at":[2,2]},
//! #     {"id":"m","templateId":"monster","at":[6,2]}]}"#;
//! let mut engine = Engine::new();
//! engine.load_tile_set(tile_set)?;
//! engine.load_world(world)?;
//!
//! let state = engine.create_game("w", 42)?;
//! assert_eq!(state.tick, 0);
//!
//! let target = state.legal_moves[0];
//! let result = engine.dispatch(Command::MoveTo { to: target })?;
//! assert!(result.accepted);
//! assert_eq!(result.state.tick, 1);
//! # Ok::<(), hex_engine::EngineError>(())
//! ```

#![forbid(unsafe_code)]

pub mod dto;
pub mod error;
pub mod json;
pub mod registry;

use hex_simulation::{rules, tick, GameState};
use hex_world::{Hex, ProjectionMode, WorldDefinition, WorldGrid};

pub use dto::{
    AxialDto, Command, CommandResult, ContentSummary, EngineInfo, EntitySnapshot, GameSnapshot,
    LoadOutcome, LocationView, PaletteEntry, RngSnapshot, TemplateView, WorldSummary, WorldView,
};
pub use error::{EngineError, EngineErrorPayload};
pub use json::{JsonEngine, JsonResult};
pub use registry::ContentRegistry;

/// A loaded world together with its flattened grid.
#[derive(Debug, Clone)]
struct PreparedWorld {
    view: WorldView,
    grid: WorldGrid,
}

/// The engine facade.
#[derive(Debug, Default)]
pub struct Engine {
    content: ContentRegistry,
    game: Option<GameState>,
}

impl Engine {
    /// Creates an engine with an empty content registry.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Build identity of this engine.
    #[must_use]
    pub fn info() -> EngineInfo {
        EngineInfo::current()
    }

    /// Parses, validates and registers a tile set.
    ///
    /// # Errors
    ///
    /// See [`ContentRegistry::load_tile_set`].
    pub fn load_tile_set(&mut self, json: &str) -> Result<LoadOutcome, EngineError> {
        let (id, report) = self.content.load_tile_set(json)?;
        Ok(LoadOutcome { id, report })
    }

    /// Parses, validates and registers a world.
    ///
    /// # Errors
    ///
    /// See [`ContentRegistry::load_world`].
    pub fn load_world(&mut self, json: &str) -> Result<LoadOutcome, EngineError> {
        let (id, report) = self.content.load_world(json)?;
        Ok(LoadOutcome { id, report })
    }

    /// Validates a world without registering it — the editor's pre-export check.
    ///
    /// # Errors
    ///
    /// [`EngineError::Parse`] when the JSON is malformed.
    pub fn validate_world(&self, json: &str) -> Result<hex_world::ValidationReport, EngineError> {
        self.content.validate_world_json(json)
    }

    /// What the registry currently holds.
    #[must_use]
    pub fn content_summary(&self) -> ContentSummary {
        ContentSummary {
            tile_sets: self.content.tile_set_ids(),
            worlds: self
                .content
                .worlds()
                .map(|world| WorldSummary {
                    id: world.id.clone(),
                    name: world.name.clone(),
                    width: world.width,
                    height: world.height,
                    tile_set_id: world.tile_set_id.clone(),
                    valid: true, // only valid worlds are ever registered
                })
                .collect(),
            templates: self
                .content
                .templates()
                .all()
                .iter()
                .map(|template| TemplateView {
                    id: template.id.clone(),
                    name: template.name.clone(),
                    kind: template.kind,
                    visual_id: template.visual_id.clone(),
                    fallback_color: template.fallback_color.clone(),
                })
                .collect(),
        }
    }

    /// Everything the renderer needs about a world except its tile indices.
    ///
    /// # Errors
    ///
    /// [`EngineError::UnknownContent`] when `world_id` is not registered.
    pub fn world_view(&self, world_id: &str) -> Result<WorldView, EngineError> {
        Ok(self.prepare(world_id)?.view)
    }

    /// The packed palette indices of a world: one byte per cell, row-major in
    /// offset coordinates.
    ///
    /// This is the only bulk transfer in the whole API. A 2048x2048 world costs
    /// one 4 MiB copy instead of four million calls.
    ///
    /// # Errors
    ///
    /// [`EngineError::UnknownContent`] when `world_id` is not registered.
    pub fn terrain_buffer(&self, world_id: &str) -> Result<Vec<u8>, EngineError> {
        Ok(self.prepare(world_id)?.grid.cells().to_vec())
    }

    /// The packed elevations of a world: one signed byte per cell, row-major in
    /// offset coordinates and the same length as
    /// [`terrain_buffer`](Self::terrain_buffer).
    ///
    /// Presentation only — the renderer lifts cells by this much in isometric
    /// mode (`docs/adr/ADR-0016-isometric-projection.md`). No rule reads it.
    ///
    /// # Errors
    ///
    /// [`EngineError::UnknownContent`] when `world_id` is not registered.
    pub fn elevation_buffer(&self, world_id: &str) -> Result<Vec<i8>, EngineError> {
        Ok(self.prepare(world_id)?.grid.elevations().to_vec())
    }

    fn prepare(&self, world_id: &str) -> Result<PreparedWorld, EngineError> {
        let world = self.world_or_err(world_id)?;
        let tile_set =
            self.content
                .tile_set_for(world)
                .ok_or_else(|| EngineError::UnknownContent {
                    kind: "tile set".to_owned(),
                    id: world.tile_set_id.clone(),
                })?;

        // Registered worlds are validated, so this cannot fail in practice; the
        // error is mapped rather than unwrapped so a future validation gap
        // surfaces as a message instead of a panic inside WASM.
        let grid = WorldGrid::build(world, tile_set).map_err(|source| {
            EngineError::Setup(hex_simulation::GameSetupError::Grid {
                world_id: world.id.clone(),
                source,
            })
        })?;

        Ok(PreparedWorld {
            view: Self::build_view(world, &grid),
            grid,
        })
    }

    fn build_view(world: &WorldDefinition, grid: &WorldGrid) -> WorldView {
        WorldView {
            world_id: world.id.clone(),
            name: world.name.clone(),
            width: grid.width(),
            height: grid.height(),
            orientation: "pointy".to_owned(),
            projection: match world.projection {
                ProjectionMode::TopDown => "topDown",
                ProjectionMode::Isometric => "isometric",
            }
            .to_owned(),
            tile_set_id: world.tile_set_id.clone(),
            palette: grid
                .palette()
                .iter()
                .enumerate()
                .map(|(index, tile)| PaletteEntry::new(index, tile))
                .collect(),
            locations: world
                .locations
                .iter()
                .map(|location| LocationView {
                    id: location.id.clone(),
                    name: location.name.clone(),
                    at: location.at,
                    tags: location.tags.clone(),
                })
                .collect(),
            cell_count: grid.cells().len() as u32,
        }
    }

    fn world_or_err(&self, world_id: &str) -> Result<&WorldDefinition, EngineError> {
        self.content
            .world(world_id)
            .ok_or_else(|| EngineError::UnknownContent {
                kind: "world".to_owned(),
                id: world_id.to_owned(),
            })
    }

    /// Starts a game on a registered world.
    ///
    /// Replaces any game already in progress. The seed is owned by the engine
    /// from this point on.
    ///
    /// # Errors
    ///
    /// [`EngineError::UnknownContent`] for an unknown world, or
    /// [`EngineError::Setup`] when the world cannot be instantiated.
    pub fn create_game(&mut self, world_id: &str, seed: u32) -> Result<GameSnapshot, EngineError> {
        let world = self.world_or_err(world_id)?;
        let tile_set =
            self.content
                .tile_set_for(world)
                .ok_or_else(|| EngineError::UnknownContent {
                    kind: "tile set".to_owned(),
                    id: world.tile_set_id.clone(),
                })?;

        let state = GameState::create(world, tile_set, self.content.templates(), u64::from(seed))?;
        let snapshot = Self::snapshot_of(&state);
        self.game = Some(state);
        Ok(snapshot)
    }

    /// Discards the running game, if any.
    pub fn end_game(&mut self) {
        self.game = None;
    }

    /// `true` when a game is in progress.
    #[must_use]
    pub const fn has_game(&self) -> bool {
        self.game.is_some()
    }

    /// The current runtime state.
    ///
    /// # Errors
    ///
    /// [`EngineError::NoGame`] when no game is running.
    pub fn snapshot(&self) -> Result<GameSnapshot, EngineError> {
        self.game
            .as_ref()
            .map(Self::snapshot_of)
            .ok_or(EngineError::NoGame)
    }

    /// Applies a command and returns what changed.
    ///
    /// # Errors
    ///
    /// [`EngineError::NoGame`] when no game is running. A command that is simply
    /// illegal is *not* an error: it comes back as an accepted-`false`
    /// [`CommandResult`] carrying the reason.
    pub fn dispatch(&mut self, command: Command) -> Result<CommandResult, EngineError> {
        let state = self.game.as_mut().ok_or(EngineError::NoGame)?;
        let outcome = tick::apply(state, command.into());
        Ok(CommandResult {
            accepted: outcome.accepted,
            rejection: outcome.rejection.map(Into::into),
            events: outcome.events,
            state: Self::snapshot_of(state),
        })
    }

    fn snapshot_of(state: &GameState) -> GameSnapshot {
        GameSnapshot {
            world_id: state.world_id().to_owned(),
            seed: state.seed() as u32,
            tick: state.tick(),
            player: state.player().map(EntitySnapshot::from),
            entities: state
                .entities()
                .all()
                .iter()
                .map(EntitySnapshot::from)
                .collect(),
            legal_moves: rules::legal_moves(state)
                .into_iter()
                .map(Hex::to_offset)
                .collect(),
            rng: RngSnapshot::from(state.rng()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hex_world::{testing, OffsetCoord};

    fn engine() -> Engine {
        let mut engine = Engine::new();
        engine
            .load_tile_set(&serde_json::to_string(&testing::sample_tile_set()).expect("serialise"))
            .expect("tile set loads");
        engine
            .load_world(&serde_json::to_string(&testing::sample_world()).expect("serialise"))
            .expect("world loads");
        engine
    }

    fn started() -> Engine {
        let mut engine = engine();
        engine.create_game("sample_world", 42).expect("game starts");
        engine
    }

    #[test]
    fn a_fresh_engine_has_no_content_and_no_game() {
        let engine = Engine::new();
        assert!(!engine.has_game());
        assert_eq!(engine.snapshot().unwrap_err(), EngineError::NoGame);
        assert_eq!(engine.content_summary().worlds.len(), 0);
        assert_eq!(engine.content_summary().templates.len(), 2);
    }

    #[test]
    fn the_world_view_describes_the_map_without_containing_it() {
        let view = engine().world_view("sample_world").expect("view");
        assert_eq!(view.width, 10);
        assert_eq!(view.height, 10);
        assert_eq!(view.cell_count, 100);
        assert_eq!(view.orientation, "pointy");
        assert_eq!(view.projection, "topDown");
        assert_eq!(view.palette.len(), 3);
        assert_eq!(view.locations.len(), 1);

        let json = serde_json::to_string(&view).expect("serialise");
        assert!(
            json.len() < 2_000,
            "the view must stay small, got {} bytes",
            json.len()
        );
    }

    #[test]
    fn the_view_republishes_the_authored_projection() {
        let mut world = testing::sample_world();
        world.id = "iso_world".to_owned();
        world.projection = ProjectionMode::Isometric;

        let mut engine = engine();
        engine
            .load_world(&serde_json::to_string(&world).expect("serialise"))
            .expect("world loads");

        assert_eq!(
            engine.world_view("iso_world").expect("view").projection,
            "isometric"
        );
    }

    #[test]
    fn the_elevation_buffer_matches_the_terrain_buffer_cell_for_cell() {
        let engine = engine();
        let elevations = engine.elevation_buffer("sample_world").expect("buffer");
        let view = engine.world_view("sample_world").expect("view");

        assert_eq!(elevations.len(), view.cell_count as usize);

        let raised = testing::RAISED_CELL
            .index_in(view.width, view.height)
            .expect("in bounds");
        assert_eq!(elevations[raised], testing::RAISED_ELEVATION as i8);
        assert_eq!(elevations.iter().filter(|value| **value != 0).count(), 1);

        assert_eq!(
            engine.elevation_buffer("nope").unwrap_err().code(),
            "unknownContent"
        );
    }

    #[test]
    fn the_terrain_buffer_is_one_byte_per_cell() {
        let engine = engine();
        let buffer = engine.terrain_buffer("sample_world").expect("buffer");
        let view = engine.world_view("sample_world").expect("view");

        assert_eq!(buffer.len(), view.cell_count as usize);

        let water_index = testing::WATER_CELL
            .index_in(view.width, view.height)
            .expect("in bounds");
        let palette_index = usize::from(buffer[water_index]);
        assert_eq!(view.palette[palette_index].id, "water");
        assert!(!view.palette[palette_index].passable);
    }

    #[test]
    fn unknown_content_is_reported_rather_than_panicking() {
        let engine = engine();
        assert_eq!(
            engine.world_view("nope").unwrap_err().code(),
            "unknownContent"
        );
        assert_eq!(
            engine.terrain_buffer("nope").unwrap_err().code(),
            "unknownContent"
        );
    }

    #[test]
    fn creating_a_game_returns_the_initial_snapshot() {
        let mut engine = engine();
        let snapshot = engine.create_game("sample_world", 42).expect("game starts");

        assert_eq!(snapshot.tick, 0);
        assert_eq!(snapshot.seed, 42);
        assert_eq!(snapshot.world_id, "sample_world");
        assert_eq!(snapshot.entities.len(), 2);
        assert_eq!(
            snapshot.player.as_ref().map(|p| p.at),
            Some(testing::PLAYER_START)
        );
        assert_eq!(snapshot.legal_moves.len(), 6);
        assert!(engine.has_game());
    }

    #[test]
    fn dispatching_a_legal_move_advances_the_tick() {
        let mut engine = started();
        let target = engine.snapshot().expect("snapshot").legal_moves[0];

        let result = engine
            .dispatch(Command::MoveTo { to: target })
            .expect("dispatch");

        assert!(result.accepted);
        assert_eq!(result.rejection, None);
        assert_eq!(result.state.tick, 1);
        assert_eq!(result.state.player.as_ref().map(|p| p.at), Some(target));
        assert!(result.events.len() >= 2);
    }

    #[test]
    fn dispatching_an_illegal_move_is_a_result_not_an_error() {
        let mut engine = started();
        let before = engine.snapshot().expect("snapshot");

        let result = engine
            .dispatch(Command::MoveTo {
                to: OffsetCoord::new(9, 9),
            })
            .expect("an illegal move is still a successful call");

        assert!(!result.accepted);
        assert_eq!(
            result.rejection.as_ref().map(|r| r.code.as_str()),
            Some("notAdjacent")
        );
        assert_eq!(result.state.tick, 0);
        assert_eq!(
            result.state, before,
            "a rejection must leave the state untouched"
        );
    }

    #[test]
    fn dispatching_without_a_game_is_an_error() {
        let mut engine = engine();
        assert_eq!(
            engine.dispatch(Command::Wait).unwrap_err(),
            EngineError::NoGame
        );
    }

    #[test]
    fn snapshots_stay_small_regardless_of_map_size() {
        let engine = started();
        let json = serde_json::to_string(&engine.snapshot().expect("snapshot")).expect("serialise");
        assert!(json.len() < 1_500, "snapshot grew to {} bytes", json.len());
        assert!(
            !json.contains("palette"),
            "the map must not travel with the snapshot"
        );
    }

    #[test]
    fn the_monster_closes_in_over_successive_commands() {
        let mut engine = started();
        let player = engine
            .snapshot()
            .expect("snapshot")
            .player
            .expect("player")
            .at;
        let distance_to_player = |engine: &Engine| {
            let snapshot = engine.snapshot().expect("snapshot");
            let monster = snapshot
                .entities
                .iter()
                .find(|entity| entity.kind == hex_world::EntityKind::Monster)
                .expect("monster");
            Hex::from_offset(monster.at).distance(Hex::from_offset(player))
        };

        let before = distance_to_player(&engine);
        engine.dispatch(Command::Wait).expect("dispatch");
        assert_eq!(distance_to_player(&engine), before - 1);
    }

    #[test]
    fn ending_a_game_clears_the_runtime_state_but_keeps_content() {
        let mut engine = started();
        engine.end_game();
        assert!(!engine.has_game());
        assert_eq!(engine.content_summary().worlds.len(), 1, "content survives");
        assert!(engine.world_view("sample_world").is_ok());
    }

    #[test]
    fn replaying_the_same_commands_with_the_same_seed_is_identical() {
        let script = [
            Command::MoveTo {
                to: OffsetCoord::new(3, 2),
            },
            Command::Wait,
            Command::MoveTo {
                to: OffsetCoord::new(9, 9),
            }, // rejected
            Command::MoveTo {
                to: OffsetCoord::new(3, 3),
            },
        ];

        let run = || {
            let mut engine = engine();
            engine
                .create_game("sample_world", 2026)
                .expect("game starts");
            script
                .iter()
                .map(|command| engine.dispatch(*command).expect("dispatch"))
                .collect::<Vec<_>>()
        };

        assert_eq!(run(), run());
    }

    #[test]
    fn the_editors_validate_call_never_registers_content() {
        let mut engine = Engine::new();
        engine
            .load_tile_set(&serde_json::to_string(&testing::sample_tile_set()).expect("serialise"))
            .expect("tile set loads");

        let json = serde_json::to_string(&testing::sample_world()).expect("serialise");
        assert!(engine.validate_world(&json).expect("parses").valid);
        assert!(engine.content_summary().worlds.is_empty());
        assert_eq!(
            engine.create_game("sample_world", 1).unwrap_err().code(),
            "unknownContent"
        );
    }
}
