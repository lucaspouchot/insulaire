//! Hex world content: coordinates, authored definitions, validation and the
//! flattened runtime grid.
//!
//! This crate is deliberately free of simulation rules and of any browser
//! dependency. It answers three questions:
//!
//! 1. *Where is a hex?* — [`hex`]
//! 2. *What did the author write?* — [`definition`], [`tileset`], [`template`]
//! 3. *Is it loadable, and what does it look like once loaded?* —
//!    [`validation`], [`grid`]
//!
//! # Example
//!
//! ```
//! use hex_world::{validate_world, TemplateRegistry, WorldGrid};
//! # use hex_world::{TileSetDefinition, WorldDefinition};
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
//! # Ok::<(), hex_world::GridError>(())
//! ```

#![forbid(unsafe_code)]

pub mod definition;
pub mod grid;
pub mod hex;
pub mod project;
pub mod template;
pub mod tileset;
pub mod validation;

#[cfg(feature = "testing")]
pub mod testing;

// Tests inside this crate use the fixtures directly; the feature only controls
// whether *other* crates can see them.
#[cfg(all(test, not(feature = "testing")))]
mod testing;

pub use definition::{
    EntityDefinition, HexOrientation, LinkTrigger, LocationDefinition, MapLinkDefinition,
    PlacedTile, ProjectionMode, WorldDefinition, WorldMetadata, MAX_ELEVATION, MIN_ELEVATION,
    WORLD_SCHEMA_VERSION,
};
pub use grid::{GridError, ResolvedTile, WorldGrid};
pub use hex::{Hex, HexDirection, OffsetCoord, DIRECTIONS};
pub use project::{ContentRef, ProjectDefinition, PROJECT_SCHEMA_VERSION};
pub use template::{Behavior, EntityKind, EntityTemplate, TemplateRegistry};
pub use tileset::{TileDefinition, TileSetDefinition, TileVisual, TILE_SET_SCHEMA_VERSION};
pub use validation::{
    validate_project, validate_project_links, validate_tile_set, validate_world, Severity,
    ValidationIssue, ValidationReport,
};
