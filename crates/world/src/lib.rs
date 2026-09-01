//! Hex world content: coordinates, authored definitions, validation and the
//! flattened runtime grid.
//!
//! This crate is deliberately free of simulation rules and of any browser
//! dependency. It answers three questions:
//!
//! 1. *Where is a hex?* — [`hex`]
//! 2. *What did the author write?* — [`definition`], [`tileset`], [`template`],
//!    [`character`], [`animation`], [`decoration`], [`object`]
//! 3. *Is it loadable, and what does it look like once loaded?* —
//!    [`validation`], [`grid`]
//!
//! # Example
//!
//! ```
//! use insulaire_world::{validate_world, TemplateRegistry, WorldGrid};
//! # use insulaire_world::{TileSetDefinition, WorldDefinition};
//! # let tile_set: TileSetDefinition = serde_json::from_str(r#"{
//! #   "id": "mvp_terrain", "schemaVersion": 1, "tiles": [
//! #     { "id": "grass", "terrain": "grass", "movementCost": 1,
//! #       "visual": { "visualId": "terrain.grass", "fallbackColor": "green" } }]}"#).unwrap();
//! # let world: WorldDefinition = serde_json::from_str(r#"{
//! #   "id": "w", "schemaVersion": 1, "width": 4, "height": 4,
//! #   "tileSetId": "mvp_terrain", "defaultTile": "grass",
//! #   "entities": [{ "id": "p", "templateId": "player", "at": [0, 0] }]}"#).unwrap();
//! let report = validate_world(&world, Some(&tile_set), &TemplateRegistry::builtin());
//! assert!(report.valid);
//!
//! let grid = WorldGrid::build(&world, &tile_set)?;
//! assert_eq!(grid.cells().len(), 16);
//! # Ok::<(), insulaire_world::GridError>(())
//! ```

#![forbid(unsafe_code)]

pub mod animation;
pub mod character;
pub mod character_creation;
pub mod decoration;
pub mod definition;
pub mod grid;
pub mod hex;
pub mod locale;
pub mod object;
pub mod project;
pub mod settings;
pub mod template;
pub mod tile_art;
pub mod tileset;
pub mod title_screen;
// The mirror's generators, and the table that keeps them honest. Test-only:
// `export_bindings_*` and `export_boundary_values` are how it runs, and nothing
// in a shipped build has anything to ask it.
#[cfg(test)]
mod ts_export;
pub mod validation;

/// `true` when a value is exactly what an absent key would have meant.
///
/// The `skip_serializing_if` half of `#[serde(default)]`: together they say
/// that a key carrying the default is the same file as one without it, which
/// is what lets the generated TypeScript mark the field optional
/// (`docs/adr/ADR-0012-shared-content-validation.md`). Whether an absent value
/// is *acceptable* stays with the validator, which is why this is spelled on
/// the field rather than in the schema.
pub(crate) fn is_default<T: Default + PartialEq>(value: &T) -> bool {
    value == &T::default()
}

#[cfg(feature = "testing")]
pub mod testing;

// Tests inside this crate use the fixtures directly; the feature only controls
// whether *other* crates can see them.
#[cfg(all(test, not(feature = "testing")))]
mod testing;

pub use animation::{
    flipbook_duration_ms, flipbook_index_at, Animation, AnimationRole, AnimationTrack,
    Interpolation, Keyframe, PixelOffset, Transform, DEFAULT_FRAME_DURATION_MS,
    MAX_ANIMATION_FRAMES, MAX_FLIPBOOK_FRAMES,
};
pub use character::{
    AttachmentPoint, CharacterCategory, CharacterDefinition, CharacterLayer, ColorSource,
    LayerVariant, PixelRect, ResolvedCharacter, ResolvedLayer, ResolvedPose, Sprite,
    SpriteResolution, CHARACTER_SCHEMA_VERSION, MAX_SPRITE_RESOLUTION, UNRESOLVED_COLOR,
};
pub use character_creation::{
    CharacterCreationDefinition, CharacterCreationResult, CharacteristicDefinition,
    CreationBinding, CreationBlock, CreationChoice, CreationScreen, ScreenTransition,
    CHARACTER_CREATION_SCHEMA_VERSION,
};
pub use decoration::{
    DecorationAnimation, DecorationCategory, DecorationDefinition, DecorationPlane,
    ResolvedDecoration, DECORATION_SCHEMA_VERSION, DEFAULT_DECORATION_RESOLUTION,
    MAX_DECORATION_ORDER,
};
pub use definition::{
    CellPresence, EntityDefinition, GridStyle, HexOrientation, LinkTrigger, LocationDefinition,
    MapLinkDefinition, MapShape, PlacedDecoration, PlacedTile, PlacedTileArt, ProjectionMode,
    RevealStyle, WorldDefinition, WorldMetadata, DEFAULT_CHARACTER_HEIGHT_TILES,
    DEFAULT_GRID_ALPHA, DEFAULT_GRID_COLOR, DEFAULT_GRID_LINE_WIDTH,
    DEFAULT_REVEAL_NEIGHBOUR_OPACITY, DEFAULT_REVEAL_OPACITY, DEFAULT_REVEAL_RADIUS,
    MAX_CHARACTER_HEIGHT_TILES, MAX_DECORATION_OFFSET, MAX_ELEVATION, MAX_GRID_LINE_WIDTH,
    MAX_REVEAL_RADIUS, MIN_CHARACTER_HEIGHT_TILES, MIN_ELEVATION, MIN_GRID_LINE_WIDTH,
    WORLD_SCHEMA_VERSION,
};
pub use grid::{resolve_cell_art, CellArtChoice, GridError, ResolvedTile, WorldGrid};
pub use hex::{Hex, HexDirection, MapBounds, OffsetCoord, DIRECTIONS};
pub use locale::{missing_keys, LocaleBundle, LocaleError, LocaleNode};
pub use object::{
    ObjectDefinition, ObjectKind, ResolvedObject, DEFAULT_ICON_RESOLUTION, MAX_STACK_SIZE,
    OBJECT_SCHEMA_VERSION,
};
pub use project::{
    ContentRef, LanguageDefinition, LocalesDefinition, ProjectDefinition, ZoneDefinition,
    DEFAULT_ZONE_ID, PROJECT_SCHEMA_VERSION,
};
pub use settings::{
    resolve_controls, ControlDefinition, ControlKind, ControlOption, SettingScope,
    SettingsDefinition, SettingsGroup, SettingsSection, ShowIf, SETTINGS_SCHEMA_VERSION,
};
pub use template::{Behavior, EntityKind, EntityTemplate, TemplateRegistry};
pub use tile_art::{
    resolve_tile_render, variant_index, variant_roll, CellArt, ElevationLevel, ElevationRepeat,
    ResolvedTileLayer, ResolvedTileRender, TileArt, TileArtGeometry, TileArtVariant, TileElevation,
    DEFAULT_ELEVATION_HEIGHT, DEFAULT_ELEVATION_STEP, DEFAULT_FLAT_HEIGHT, DEFAULT_SURFACE_HEIGHT,
    DEFAULT_TILE_WIDTH, MAX_ELEVATION_LEVELS, MAX_STACKED_LEVELS, MAX_TILE_IMAGE_SIZE,
    MAX_TILE_VARIANTS,
};
pub use tileset::{TileDefinition, TileSetDefinition, TileVisual, TILE_SET_SCHEMA_VERSION};
pub use title_screen::{
    BackgroundFit, TitleAction, TitleBackground, TitleButton, TitleLayout, TitleLogo, TitleMusic,
    TitleScreenDefinition, TitleSplash, TitleTheme, TITLE_SCREEN_SCHEMA_VERSION,
};
pub use validation::{
    validate_character, validate_character_creation, validate_decoration, validate_locales,
    validate_object, validate_placed_decorations, validate_project, validate_project_links,
    validate_project_zones, validate_referenced_keys, validate_settings, validate_tile_set,
    validate_title_screen, validate_world, LoadedContent, Severity, ValidationIssue,
    ValidationReport,
};
