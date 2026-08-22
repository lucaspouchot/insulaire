//! The engine facade.
//!
//! [`Engine`] is the whole public surface of the simulation: content in,
//! commands in, compact snapshots out. It is host-agnostic — the WASM bindings
//! in `insulaire-wasm` add no logic of their own, and the same facade drives the
//! native test suite.
//!
//! # Shape of the API
//!
//! ```text
//! load_tile_set(json)  ─┐
//! load_world(json)     ─┴─> content registry ──> create_game(worldId, seed, "{}")
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
//! use insulaire_engine::{Command, Engine};
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
//! let state = engine.create_game("w", 42, "{}")?;
//! assert_eq!(state.tick, 0);
//!
//! let target = state.legal_moves[0];
//! let result = engine.dispatch(Command::MoveTo { to: target })?;
//! assert!(result.accepted);
//! assert_eq!(result.state.tick, 1);
//! # Ok::<(), insulaire_engine::EngineError>(())
//! ```

#![forbid(unsafe_code)]

pub mod dto;
pub mod error;
pub mod json;
pub mod registry;

use std::collections::BTreeMap;

use insulaire_simulation::{rules, tick, GameState, PendingTransition, SimEvent};
use insulaire_world::{
    resolve_cell_art, resolve_tile_render, CharacterCreationDefinition, CharacterCreationResult,
    CharacterDefinition, Hex, PlacedTileArt, ProjectionMode, ResolvedCharacter, ResolvedTile,
    ResolvedTileRender, SettingsDefinition, TileArtGeometry, TitleScreenDefinition,
    WorldDefinition, WorldGrid,
};

pub use dto::{
    AxialDto, Command, CommandResult, ContentSummary, EngineInfo, EntitySnapshot, GameSnapshot,
    LanguageView, LinkView, LoadOutcome, LocaleView, LocationView, PaletteEntry, ProjectView,
    RngSnapshot, TemplateView, WorldSummary, WorldView,
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
    /// The game settings the running game was created with, already resolved.
    ///
    /// They live here rather than in `GameState` because no rule reads them
    /// yet: the simulation gains them the day a scenario needs one, and until
    /// then keeping them out of the state keeps the state honest
    /// (`docs/adr/ADR-0025-settings.md`).
    game_settings: BTreeMap<String, serde_json::Value>,
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

    /// Validates a tile set *without* registering it.
    ///
    /// # Errors
    ///
    /// See [`ContentRegistry::validate_tile_set_json`].
    pub fn validate_tile_set(
        &self,
        json: &str,
    ) -> Result<insulaire_world::ValidationReport, EngineError> {
        self.content.validate_tile_set_json(json)
    }

    /// Resolves what to draw for one cell of a tile set **passed in** — the
    /// asset editor's preview, for content that is not registered yet.
    ///
    /// `projection` is the world's own — `"isometric"` draws the surface and
    /// the cliff, anything else draws the flat image
    /// (`docs/adr/ADR-0037-a-flat-map-is-drawn-from-flat-art.md`), which is the
    /// same fallback the renderer applies to a world that names a mode nobody
    /// knows. `base` is the height the cell's side faces reach down to, and
    /// `roll` is [`insulaire_world::variant_roll`] for the cell
    /// (`docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`).
    /// `choice_json` is a `PlacedTileArt` — what the cell picked by hand —
    /// resolved against the set that was passed in; `"{}"` rolls everything,
    /// which is what a preview of a plain tile wants
    /// (`docs/adr/ADR-0036-a-cell-may-choose-its-tile-art.md`).
    ///
    /// # Errors
    ///
    /// [`EngineError::Parse`] when either JSON is malformed, and
    /// [`EngineError::UnknownContent`] when the set defines no such tile.
    #[allow(clippy::too_many_arguments)] // a wire, not an API: every field the boundary carries is a parameter
    pub fn preview_tile_render(
        &self,
        tile_set_json: &str,
        tile_id: &str,
        projection: &str,
        elevation: i32,
        base: i32,
        roll: u32,
        choice_json: &str,
    ) -> Result<ResolvedTileRender, EngineError> {
        let tile_set: insulaire_world::TileSetDefinition = serde_json::from_str(tile_set_json)
            .map_err(|source| EngineError::Parse {
                what: "tile set".to_owned(),
                message: source.to_string(),
            })?;
        let choice: PlacedTileArt = if choice_json.trim().is_empty() {
            PlacedTileArt::default()
        } else {
            serde_json::from_str(choice_json).map_err(|source| EngineError::Parse {
                what: "tile art choice".to_owned(),
                message: source.to_string(),
            })?
        };
        let tile = tile_set
            .tile(tile_id)
            .ok_or_else(|| EngineError::UnknownContent {
                kind: "tile".to_owned(),
                id: tile_id.to_owned(),
            })?;
        // The ids are resolved against the same palette a loaded world would
        // build, so a preview and the map agree by construction.
        let palette: Vec<ResolvedTile> = tile_set.tiles.iter().map(ResolvedTile::of).collect();
        let cell = resolve_cell_art(&palette, tile_id, &choice);
        Ok(resolve_tile_render(
            &tile.id,
            &tile.art,
            projection_of(projection),
            elevation,
            base,
            roll,
            cell.against(&palette),
            tile_set.art.band_levels(),
        ))
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

    /// Parses, validates and registers the project manifest.
    ///
    /// # Errors
    ///
    /// See [`ContentRegistry::load_project`].
    pub fn load_project(&mut self, json: &str) -> Result<LoadOutcome, EngineError> {
        let (id, report) = self.content.load_project(json)?;
        Ok(LoadOutcome { id, report })
    }

    /// Parses and registers one locale file under a language and a namespace.
    ///
    /// The namespace prefixes every key in the file, so `menu.json` loaded as
    /// `menu` answers `menu.title.buttons.newGame`. Load a language's files in
    /// any order; a key defined twice is refused
    /// (`docs/adr/ADR-0023-localised-content-keys.md`).
    ///
    /// # Errors
    ///
    /// [`EngineError::Parse`] when the file is not a nested object of strings,
    /// or redefines a key.
    pub fn load_locale(
        &mut self,
        language: &str,
        namespace: &str,
        json: &str,
    ) -> Result<LoadOutcome, EngineError> {
        self.content.load_locale(language, namespace, json)?;
        Ok(LoadOutcome {
            id: format!("{language}/{namespace}"),
            // A locale file has no validation of its own: it is either a nested
            // object of strings or a parse error. What can go wrong between
            // languages is `validateLocales`'s answer, not this one's.
            report: insulaire_world::ValidationReport::clean(),
        })
    }

    /// Every translation of one language, with the default language's text
    /// filling the gaps.
    ///
    /// # Errors
    ///
    /// [`EngineError::UnknownContent`] when no file was loaded for `language`.
    pub fn locale(&self, language: &str) -> Result<LocaleView, EngineError> {
        let resolved =
            self.content
                .locale_bundle(language)
                .ok_or_else(|| EngineError::UnknownContent {
                    kind: "language".to_owned(),
                    id: language.to_owned(),
                })?;

        let own = self
            .content
            .locales()
            .find(|bundle| bundle.language == language);

        // A fallback is a key whose text came from *elsewhere*: one this
        // language does not have, or one it holds empty and another language
        // answered. A key that is empty everywhere is nobody's fallback — it is
        // this language's own, still unwritten, and an editor has to keep
        // showing it (`docs/adr/ADR-0027-authoring-creates-keys.md`).
        let fallbacks = resolved
            .entries
            .iter()
            .filter(|(key, text)| match own.and_then(|bundle| bundle.get(key)) {
                None => true,
                Some(authored) if authored.trim().is_empty() => !text.trim().is_empty(),
                Some(_) => false,
            })
            .map(|(key, _)| key.clone())
            .collect();

        Ok(LocaleView {
            language: resolved.language.clone(),
            entries: resolved.entries.clone(),
            fallbacks,
        })
    }

    /// Compares the loaded languages against the manifest and each other.
    ///
    /// The editor's translation report: which keys a language is missing, which
    /// it has that the default language does not, and which are empty.
    #[must_use]
    pub fn validate_locales(&self) -> insulaire_world::ValidationReport {
        self.content.validate_locales()
    }

    // ----------------------------------------------------------- title screen

    /// Parses, validates and registers the title screen a client opens on.
    ///
    /// # Errors
    ///
    /// See [`ContentRegistry::load_title_screen`].
    pub fn load_title_screen(&mut self, json: &str) -> Result<LoadOutcome, EngineError> {
        let (id, report) = self.content.load_title_screen(json)?;
        Ok(LoadOutcome { id, report })
    }

    /// Validates a title screen without registering it — the editor's check.
    ///
    /// Unlike the load, this also resolves the keys it references against the
    /// loaded languages, because an editor wants both answers at once
    /// (`docs/adr/ADR-0024-authored-title-screen.md`).
    ///
    /// # Errors
    ///
    /// [`EngineError::Parse`] when the JSON is malformed.
    pub fn validate_title_screen(
        &self,
        json: &str,
    ) -> Result<insulaire_world::ValidationReport, EngineError> {
        self.content.validate_title_screen_json(json)
    }

    /// The registered title screen.
    ///
    /// # Errors
    ///
    /// [`EngineError::UnknownContent`] when the project ships none — which is a
    /// legitimate state, and why this is a `Result` rather than an `Option` at
    /// the boundary: a host asking for a screen that does not exist has made a
    /// mistake worth reporting.
    pub fn title_screen(&self) -> Result<TitleScreenDefinition, EngineError> {
        self.content
            .title_screen()
            .cloned()
            .ok_or_else(|| EngineError::UnknownContent {
                kind: "title screen".to_owned(),
                id: "(none loaded)".to_owned(),
            })
    }

    /// Forgets every loaded tile set, world, locale and project.
    ///
    /// Call it before re-loading a whole project, so content that was removed
    /// in the editor stops answering for itself. A running game survives: it
    /// holds its own handle on the world it is playing.
    pub fn reset_content(&mut self) {
        self.content.clear();
    }

    /// Forgets every loaded language, keeping worlds, tile sets and project.
    ///
    /// What a host calls after *editing* locale files: loading is additive and
    /// refuses a key twice, so the edited files can only go back in once the
    /// old ones are gone (`docs/adr/ADR-0027-authoring-creates-keys.md`).
    pub fn reset_locales(&mut self) {
        self.content.clear_locales();
    }

    /// Validates a world without registering it — the editor's pre-export check.
    ///
    /// # Errors
    ///
    /// [`EngineError::Parse`] when the JSON is malformed.
    pub fn validate_world(
        &self,
        json: &str,
    ) -> Result<insulaire_world::ValidationReport, EngineError> {
        self.content.validate_world_json(json)
    }

    /// Resolves every map link across the loaded worlds.
    ///
    /// A world validates on its own without its link targets existing, so this
    /// is the check that a *set* of maps is coherent — the editor runs it after
    /// loading a project, the client runs it at boot
    /// (`docs/adr/ADR-0017-map-links.md`).
    #[must_use]
    pub fn validate_links(&self) -> insulaire_world::ValidationReport {
        self.content.validate_links()
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
            characters: self.content.character_ids(),
            character_creation: self
                .content
                .character_creation()
                .map(|creation| creation.id.clone()),
            project: self.content.project().map(Into::into),
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
            EngineError::Setup(insulaire_simulation::GameSetupError::Grid {
                world_id: world.id.clone(),
                source,
            })
        })?;

        Ok(PreparedWorld {
            view: Self::build_view(world, tile_set.art, &grid),
            grid,
        })
    }

    fn build_view(
        world: &WorldDefinition,
        tile_art: TileArtGeometry,
        grid: &WorldGrid,
    ) -> WorldView {
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
            tile_art,
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
            links: world.links.iter().map(Into::into).collect(),
            art_choices: grid.art_choices().to_vec(),
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
    pub fn create_game(
        &mut self,
        world_id: &str,
        seed: u32,
        settings_json: &str,
    ) -> Result<GameSnapshot, EngineError> {
        self.game_settings = self.resolve_settings(settings_json)?;
        let world = self.world_or_err(world_id)?;
        let tile_set =
            self.content
                .tile_set_for(world)
                .ok_or_else(|| EngineError::UnknownContent {
                    kind: "tile set".to_owned(),
                    id: world.tile_set_id.clone(),
                })?;

        let state = GameState::create(world, tile_set, self.content.templates(), u64::from(seed))?;
        let snapshot = self.snapshot_of(&state);
        self.game = Some(state);
        Ok(snapshot)
    }

    /// Fills in defaults, drops what is not declared, clamps what is.
    ///
    /// A project that declares no settings resolves everything to nothing:
    /// there is no schema to check against, so there is nothing to carry.
    ///
    /// # Errors
    ///
    /// [`EngineError::Parse`] when the values are not a JSON object.
    fn resolve_settings(
        &self,
        json: &str,
    ) -> Result<BTreeMap<String, serde_json::Value>, EngineError> {
        let values: serde_json::Value = if json.trim().is_empty() {
            serde_json::Value::Object(serde_json::Map::new())
        } else {
            serde_json::from_str(json).map_err(|source| EngineError::Parse {
                what: "settings values".to_owned(),
                message: source.to_string(),
            })?
        };

        Ok(self
            .content
            .settings()
            .map(|settings| settings.resolve(&values))
            .unwrap_or_default())
    }

    /// Parses, validates and registers the game's settings declaration.
    ///
    /// # Errors
    ///
    /// See [`ContentRegistry::load_settings`].
    pub fn load_settings(&mut self, json: &str) -> Result<LoadOutcome, EngineError> {
        let (id, report) = self.content.load_settings(json)?;
        Ok(LoadOutcome { id, report })
    }

    /// Validates a settings declaration without registering it, keys included.
    ///
    /// # Errors
    ///
    /// [`EngineError::Parse`] when the JSON is malformed.
    pub fn validate_settings(
        &self,
        json: &str,
    ) -> Result<insulaire_world::ValidationReport, EngineError> {
        self.content.validate_settings_json(json)
    }

    /// The registered settings declaration.
    ///
    /// # Errors
    ///
    /// [`EngineError::UnknownContent`] when the project declares none.
    pub fn settings(&self) -> Result<SettingsDefinition, EngineError> {
        self.content
            .settings()
            .cloned()
            .ok_or_else(|| EngineError::UnknownContent {
                kind: "settings".to_owned(),
                id: "(none loaded)".to_owned(),
            })
    }

    /// Resolves a set of values against the declaration, without a game.
    ///
    /// This is what a settings screen calls before starting one, so what it
    /// shows and what `create_game` receives cannot disagree.
    ///
    /// # Errors
    ///
    /// [`EngineError::Parse`] when the values are not a JSON object.
    pub fn resolved_settings(
        &self,
        json: &str,
    ) -> Result<BTreeMap<String, serde_json::Value>, EngineError> {
        self.resolve_settings(json)
    }

    // -------------------------------------------------------------- characters

    /// Parses, validates and registers a character definition.
    ///
    /// # Errors
    ///
    /// See [`ContentRegistry::load_character`].
    pub fn load_character(&mut self, json: &str) -> Result<LoadOutcome, EngineError> {
        let (id, report) = self.content.load_character(json)?;
        Ok(LoadOutcome { id, report })
    }

    /// Validates a character definition without registering it, keys included.
    ///
    /// # Errors
    ///
    /// [`EngineError::Parse`] when the JSON is malformed.
    pub fn validate_character(
        &self,
        json: &str,
    ) -> Result<insulaire_world::ValidationReport, EngineError> {
        self.content.validate_character_json(json)
    }

    /// A registered character definition.
    ///
    /// # Errors
    ///
    /// [`EngineError::UnknownContent`] when no definition has that id.
    pub fn character(&self, id: &str) -> Result<CharacterDefinition, EngineError> {
        self.content
            .character(id)
            .cloned()
            .ok_or_else(|| EngineError::UnknownContent {
                kind: "character".to_owned(),
                id: id.to_owned(),
            })
    }

    /// Ids of every registered character definition.
    #[must_use]
    pub fn character_ids(&self) -> Vec<String> {
        self.content.character_ids()
    }

    /// Parses, validates and registers the character-creation declaration.
    ///
    /// # Errors
    ///
    /// See [`ContentRegistry::load_character_creation`].
    pub fn load_character_creation(&mut self, json: &str) -> Result<LoadOutcome, EngineError> {
        let (id, report) = self.content.load_character_creation(json)?;
        Ok(LoadOutcome { id, report })
    }

    /// Validates a creation declaration without registering it.
    pub fn validate_character_creation(
        &self,
        json: &str,
    ) -> Result<insulaire_world::ValidationReport, EngineError> {
        self.content.validate_character_creation_json(json)
    }

    /// The registered character-creation declaration.
    ///
    /// # Errors
    ///
    /// [`EngineError::UnknownContent`] when the project declares none.
    pub fn character_creation(&self) -> Result<CharacterCreationDefinition, EngineError> {
        self.content
            .character_creation()
            .cloned()
            .ok_or_else(|| EngineError::UnknownContent {
                kind: "character creation".to_owned(),
                id: "(none loaded)".to_owned(),
            })
    }

    /// Resolves submitted creation values without giving their ids semantics.
    ///
    /// # Errors
    ///
    /// [`EngineError::Parse`] when either values payload is not JSON, or
    /// [`EngineError::UnknownContent`] when no declaration is loaded.
    pub fn resolved_character_creation(
        &self,
        choices_json: &str,
        characteristics_json: &str,
    ) -> Result<CharacterCreationResult, EngineError> {
        let choices: serde_json::Value =
            serde_json::from_str(choices_json).map_err(|source| EngineError::Parse {
                what: "character creation choices".to_owned(),
                message: source.to_string(),
            })?;
        let characteristics: serde_json::Value = serde_json::from_str(characteristics_json)
            .map_err(|source| EngineError::Parse {
                what: "character characteristics".to_owned(),
                message: source.to_string(),
            })?;
        self.content
            .resolve_character_creation(&choices, &characteristics)
            .ok_or_else(|| EngineError::UnknownContent {
                kind: "character creation".to_owned(),
                id: "(none loaded)".to_owned(),
            })
    }

    /// Resolves a creation definition passed in by the editor, including an
    /// unfinished one that has not been registered.
    pub fn preview_character_creation(
        &self,
        creation_json: &str,
        choices_json: &str,
        characteristics_json: &str,
    ) -> Result<CharacterCreationResult, EngineError> {
        let creation: CharacterCreationDefinition =
            serde_json::from_str(creation_json).map_err(|source| EngineError::Parse {
                what: "character creation".to_owned(),
                message: source.to_string(),
            })?;
        let choices: serde_json::Value =
            serde_json::from_str(choices_json).map_err(|source| EngineError::Parse {
                what: "character creation choices".to_owned(),
                message: source.to_string(),
            })?;
        let characteristics: serde_json::Value = serde_json::from_str(characteristics_json)
            .map_err(|source| EngineError::Parse {
                what: "character characteristics".to_owned(),
                message: source.to_string(),
            })?;
        Ok(creation.resolve(&choices, &characteristics))
    }

    /// Resolves a definition **passed in** against a customisation, at a moment
    /// of an animation.
    ///
    /// The editor's door: it holds a definition that is being written and is
    /// not registered — may not even be valid yet — and still has to show what
    /// it draws. Resolution is total, so an incomplete definition previews as
    /// whatever it currently is rather than as an error, and an animation id it
    /// no longer declares previews as the rest pose
    /// (`docs/adr/ADR-0028-character-definitions.md`).
    ///
    /// # Errors
    ///
    /// [`EngineError::Parse`] when the definition or the values are not JSON.
    pub fn preview_character(
        &self,
        character_json: &str,
        values_json: &str,
        animation: Option<&str>,
        time_ms: u32,
    ) -> Result<ResolvedCharacter, EngineError> {
        let character: CharacterDefinition =
            serde_json::from_str(character_json).map_err(|source| EngineError::Parse {
                what: "character".to_owned(),
                message: source.to_string(),
            })?;
        let values: serde_json::Value =
            serde_json::from_str(values_json).map_err(|source| EngineError::Parse {
                what: "character values".to_owned(),
                message: source.to_string(),
            })?;
        Ok(character.resolve_at(&values, animation, time_ms))
    }

    /// Turns a definition, a customisation and a moment of an animation into
    /// something drawable.
    ///
    /// The whole of character rendering that is not the renderer: the editor's
    /// preview and the game call this, so what an author sees while editing is
    /// what a player will see (`docs/adr/ADR-0028-character-definitions.md`,
    /// `docs/adr/ADR-0031-characters-animate-by-hierarchy-and-offsets.md`).
    ///
    /// `animation` of `None` is the rest pose, and `time_ms` counts from the
    /// moment the animation started.
    ///
    /// # Errors
    ///
    /// [`EngineError::Parse`] when the values are not JSON, or
    /// [`EngineError::UnknownContent`] when no definition has that id.
    pub fn resolve_character(
        &self,
        id: &str,
        values_json: &str,
        animation: Option<&str>,
        time_ms: u32,
    ) -> Result<ResolvedCharacter, EngineError> {
        let values: serde_json::Value =
            serde_json::from_str(values_json).map_err(|source| EngineError::Parse {
                what: "character values".to_owned(),
                message: source.to_string(),
            })?;
        self.content
            .resolve_character(id, &values, animation, time_ms)
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
            .map(|state| self.snapshot_of(state))
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
        let mut events = outcome.events;

        if let Some(transition) = outcome.transition {
            events.push(self.follow_link(&transition));
        }

        let state = self.game.as_ref().ok_or(EngineError::NoGame)?;
        Ok(CommandResult {
            accepted: outcome.accepted,
            rejection: outcome.rejection.map(Into::into),
            events,
            state: self.snapshot_of(state),
        })
    }

    /// Carries out a map change the tick asked for.
    ///
    /// The simulation names the target world; only the registry can produce it,
    /// which is why this step lives in the facade rather than in the tick
    /// pipeline (`docs/adr/ADR-0017-map-links.md`). A target that cannot be
    /// resolved leaves the session exactly where it was and comes back as a
    /// `linkUnresolved` event: content validation is supposed to have caught it
    /// (`link.unknownTargetWorld`), and a broken door must not end a session.
    fn follow_link(&mut self, transition: &PendingTransition) -> SimEvent {
        let unresolved = |reason: String| SimEvent::LinkUnresolved {
            link: transition.link_id.clone(),
            to_world: transition.target_world.clone(),
            reason,
        };

        let Some(target) = self.content.world(&transition.target_world).cloned() else {
            return unresolved(format!("world `{}` is not loaded", transition.target_world));
        };
        let Some(tile_set) = self.content.tile_set_for(&target).cloned() else {
            return unresolved(format!("tile set `{}` is not loaded", target.tile_set_id));
        };
        let Some(state) = self.game.as_mut() else {
            return unresolved("no game is running".to_owned());
        };

        let from_world = state.world_id().to_owned();
        match state.enter_world(
            &target,
            &tile_set,
            self.content.templates(),
            Hex::from_offset(transition.target_at),
        ) {
            Ok(()) => SimEvent::WorldEntered {
                from_world,
                to_world: target.id,
                at: transition.target_at,
            },
            Err(source) => unresolved(source.to_string()),
        }
    }

    fn snapshot_of(&self, state: &GameState) -> GameSnapshot {
        GameSnapshot {
            settings: self.game_settings.clone(),
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

/// The projection a wire string names.
///
/// Everything that is not `"isometric"` is top-down, which is what
/// `toProjectionMode` in `apps/web/src/renderer/projection.ts` does with the
/// same string and what `ProjectionMode::default` is. A preview of content the
/// caller is still editing should draw *something* rather than refuse
/// (`docs/adr/ADR-0016-isometric-projection.md`).
fn projection_of(mode: &str) -> ProjectionMode {
    if mode == "isometric" {
        ProjectionMode::Isometric
    } else {
        ProjectionMode::TopDown
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use insulaire_world::{testing, OffsetCoord};

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
        engine
            .create_game("sample_world", 42, "{}")
            .expect("game starts");
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
        let snapshot = engine
            .create_game("sample_world", 42, "{}")
            .expect("game starts");

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
                .find(|entity| entity.kind == insulaire_world::EntityKind::Monster)
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
                .create_game("sample_world", 2026, "{}")
                .expect("game starts");
            script
                .iter()
                .map(|command| engine.dispatch(*command).expect("dispatch"))
                .collect::<Vec<_>>()
        };

        assert_eq!(run(), run());
    }

    /// An engine holding both linked maps, playing the outdoor one.
    fn linked() -> Engine {
        let mut engine = Engine::new();
        engine
            .load_tile_set(&serde_json::to_string(&testing::sample_tile_set()).expect("serialise"))
            .expect("tile set loads");
        for world in [testing::linked_world(), testing::interior_world()] {
            engine
                .load_world(&serde_json::to_string(&world).expect("serialise"))
                .expect("world loads");
        }
        engine
            .create_game("linked_world", 7, "{}")
            .expect("game starts");
        engine
    }

    #[test]
    fn walking_onto_a_door_moves_the_session_to_the_other_map() {
        let mut engine = linked();
        let result = engine
            .dispatch(Command::MoveTo {
                to: testing::DOOR_CELL,
            })
            .expect("dispatch");

        assert!(result.accepted);
        assert_eq!(result.state.world_id, "interior_world");
        assert_eq!(
            result.state.player.as_ref().map(|player| player.at),
            Some(testing::INTERIOR_ARRIVAL)
        );
        assert_eq!(result.state.tick, 1, "a map change costs the same one tick");
        assert!(result.events.iter().any(|event| matches!(
            event,
            insulaire_simulation::SimEvent::WorldEntered { to_world, .. } if to_world == "interior_world"
        )));

        // The new map is the one the renderer will ask for, and it is loaded.
        let view = engine.world_view(&result.state.world_id).expect("view");
        assert_eq!(view.width, 5);
        assert_eq!(view.links.len(), 1);
        assert_eq!(view.links[0].target_world, "linked_world");
        assert_eq!(view.links[0].trigger, "enter");
    }

    #[test]
    fn a_door_to_an_unloaded_map_leaves_the_session_where_it_is() {
        // Validation is supposed to prevent this (`link.unknownTargetWorld`);
        // the runtime must degrade rather than end the session.
        let mut engine = Engine::new();
        engine
            .load_tile_set(&serde_json::to_string(&testing::sample_tile_set()).expect("serialise"))
            .expect("tile set loads");
        engine
            .load_world(&serde_json::to_string(&testing::linked_world()).expect("serialise"))
            .expect("world loads");
        engine
            .create_game("linked_world", 7, "{}")
            .expect("game starts");

        let result = engine
            .dispatch(Command::MoveTo {
                to: testing::DOOR_CELL,
            })
            .expect("dispatch");

        assert!(result.accepted);
        assert_eq!(result.state.world_id, "linked_world");
        assert_eq!(
            result.state.player.as_ref().map(|player| player.at),
            Some(testing::DOOR_CELL)
        );
        assert!(result.events.iter().any(|event| matches!(
            event,
            insulaire_simulation::SimEvent::LinkUnresolved { link, .. } if link == "door_house"
        )));
    }

    #[test]
    fn cross_world_links_are_only_resolvable_once_every_world_is_loaded() {
        let mut engine = Engine::new();
        engine
            .load_tile_set(&serde_json::to_string(&testing::sample_tile_set()).expect("serialise"))
            .expect("tile set loads");
        engine
            .load_world(&serde_json::to_string(&testing::linked_world()).expect("serialise"))
            .expect("a world with an outbound link is valid on its own");
        assert!(!engine.validate_links().valid);

        engine
            .load_world(&serde_json::to_string(&testing::interior_world()).expect("serialise"))
            .expect("world loads");
        assert!(engine.validate_links().valid);
    }

    #[test]
    fn a_project_manifest_names_the_start_world() {
        let mut engine = linked();
        let outcome = engine
            .load_project(
                r#"{"id":"demo","schemaVersion":1,"name":"Demo","startWorld":"linked_world",
                    "tileSets":[{"id":"mvp_terrain","path":"tilesets/mvp_terrain.json"}],
                    "worlds":[{"id":"linked_world","path":"worlds/linked_world.json"},
                              {"id":"interior_world","path":"worlds/interior_world.json"}]}"#,
            )
            .expect("project loads");

        assert_eq!(outcome.id, "demo");
        let project = engine.content_summary().project.expect("project");
        assert_eq!(project.start_world, "linked_world");
        assert_eq!(project.world_ids.len(), 2);
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
            engine
                .create_game("sample_world", 1, "{}")
                .unwrap_err()
                .code(),
            "unknownContent"
        );
    }
}
