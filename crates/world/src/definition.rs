//! The authored [`WorldDefinition`] and its parts.
//!
//! A world definition is *immutable reference data*. It is never mutated by the
//! simulation: the runtime derives a [`crate::WorldGrid`] plus a
//! `GameState` from it (see `docs/adr/ADR-0003-authored-world.md`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::hex::OffsetCoord;

/// Highest world schema version this build understands.
pub const WORLD_SCHEMA_VERSION: u32 = 1;

/// Hex orientation of an authored map.
///
/// Only [`HexOrientation::Pointy`] is implemented in the MVP; the enum exists so
/// that flat-top support is a content-format addition rather than a breaking
/// change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HexOrientation {
    /// Pointy-top hexagons with an odd-r offset layout.
    #[default]
    Pointy,
    /// Flat-top hexagons. Reserved; rejected by validation for now.
    Flat,
}

/// An authored hexagonal world.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldDefinition {
    /// Stable content id.
    pub id: String,
    /// Schema version of this file.
    pub schema_version: u32,
    /// Human readable name.
    #[serde(default)]
    pub name: String,
    /// Number of columns.
    pub width: u32,
    /// Number of rows.
    pub height: u32,
    /// Hex orientation.
    #[serde(default)]
    pub orientation: HexOrientation,
    /// Id of the [`crate::TileSetDefinition`] this world paints with.
    pub tile_set_id: String,
    /// Tile id used for every cell not listed in [`tiles`](Self::tiles).
    ///
    /// Worlds are stored **sparsely**: only cells that differ from the default
    /// are written out. This keeps authored files small and Git diffs readable.
    pub default_tile: String,
    /// Explicitly painted cells.
    #[serde(default)]
    pub tiles: Vec<PlacedTile>,
    /// Authored entities (player, monsters, ...).
    #[serde(default)]
    pub entities: Vec<EntityDefinition>,
    /// Authored points of interest.
    #[serde(default)]
    pub locations: Vec<LocationDefinition>,
    /// Free-form authoring metadata; never read by the simulation.
    #[serde(default)]
    pub metadata: WorldMetadata,
}

impl WorldDefinition {
    /// Number of cells in the map.
    #[must_use]
    pub fn cell_count(&self) -> usize {
        self.width as usize * self.height as usize
    }
}

/// A cell whose tile differs from [`WorldDefinition::default_tile`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacedTile {
    /// Offset position `[col, row]`.
    pub at: OffsetCoord,
    /// Referenced [`crate::TileDefinition::id`].
    pub tile: String,
    /// Authored elevation. Carried through but unused by the MVP rules.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub elevation: i32,
    /// Per-cell gameplay tags, in addition to the tile's own tags.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

/// An authored entity placed on the map.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityDefinition {
    /// Stable content id, unique within the world.
    pub id: String,
    /// Referenced [`crate::EntityTemplate::id`].
    pub template_id: String,
    /// Offset position `[col, row]`.
    pub at: OffsetCoord,
    /// Free-form gameplay tags.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// Authored properties. Opaque to the MVP rules, carried into the runtime.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub properties: BTreeMap<String, Value>,
}

/// An authored point of interest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationDefinition {
    /// Stable content id, unique within the world.
    pub id: String,
    /// Offset position `[col, row]`.
    pub at: OffsetCoord,
    /// Display name.
    #[serde(default)]
    pub name: String,
    /// Free-form gameplay tags.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

/// Authoring metadata attached to a world.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldMetadata {
    /// Free text author name.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub author: String,
    /// Free text description.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// ISO-8601 timestamp of the last editor export.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub updated_at: String,
    /// Anything else the editor wants to keep alongside the world.
    #[serde(default, flatten, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, Value>,
}

#[allow(clippy::trivially_copy_pass_by_ref)] // required shape for `skip_serializing_if`
fn is_zero(value: &i32) -> bool {
    *value == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = r#"{
        "id": "tiny",
        "schemaVersion": 1,
        "width": 3,
        "height": 2,
        "tileSetId": "mvp_terrain",
        "defaultTile": "grass",
        "tiles": [{ "at": [1, 1], "tile": "water" }],
        "entities": [
            { "id": "player", "templateId": "player", "at": [0, 0] }
        ]
    }"#;

    #[test]
    fn optional_fields_default_sensibly() {
        let world: WorldDefinition = serde_json::from_str(MINIMAL).expect("parse");
        assert_eq!(world.orientation, HexOrientation::Pointy);
        assert_eq!(world.cell_count(), 6);
        assert!(world.locations.is_empty());
        assert_eq!(world.metadata, WorldMetadata::default());
        assert_eq!(world.tiles[0].at, OffsetCoord::new(1, 1));
        assert_eq!(world.entities[0].template_id, "player");
    }

    #[test]
    fn world_round_trips_through_json() {
        let world: WorldDefinition = serde_json::from_str(MINIMAL).expect("parse");
        let serialised = serde_json::to_string(&world).expect("serialise");
        let reparsed: WorldDefinition = serde_json::from_str(&serialised).expect("reparse");
        assert_eq!(world, reparsed);
    }

    #[test]
    fn empty_optional_collections_are_omitted_when_serialising() {
        // Keeps exported files small and diffs meaningful.
        let world: WorldDefinition = serde_json::from_str(MINIMAL).expect("parse");
        let serialised = serde_json::to_string(&world).expect("serialise");
        assert!(!serialised.contains("\"elevation\""));
        assert!(!serialised.contains("\"properties\""));
    }
}
