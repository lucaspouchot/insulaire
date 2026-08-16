//! Tile palette content.
//!
//! A [`TileSetDefinition`] is an authored content file describing the tiles a
//! world may paint with. Worlds reference tiles by stable id, never by file
//! path or array index (see `docs/adr/ADR-0009-assets-tilesets.md`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Highest tile-set schema version this build understands.
pub const TILE_SET_SCHEMA_VERSION: u32 = 1;

/// A palette of authored tiles.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileSetDefinition {
    /// Stable content id, referenced by [`crate::WorldDefinition::tile_set_id`].
    pub id: String,
    /// Schema version of this file.
    pub schema_version: u32,
    /// Human readable name shown in the editor.
    #[serde(default)]
    pub name: String,
    /// The tiles available in this palette.
    #[serde(default)]
    pub tiles: Vec<TileDefinition>,
}

impl TileSetDefinition {
    /// Looks a tile up by id.
    #[must_use]
    pub fn tile(&self, id: &str) -> Option<&TileDefinition> {
        self.tiles.iter().find(|tile| tile.id == id)
    }
}

/// A single authored tile (a palette entry, not a placed map cell).
///
/// Placed map cells are [`crate::PlacedTile`] and only carry a position plus a
/// reference to one of these ids.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileDefinition {
    /// Stable id, e.g. `"grass"`.
    pub id: String,
    /// Human readable name shown in the editor palette.
    #[serde(default)]
    pub name: String,
    /// Terrain family this tile belongs to, e.g. `"water"`.
    ///
    /// Terrain is a gameplay grouping: several tiles may share one terrain.
    pub terrain: String,
    /// Cost of entering this tile.
    ///
    /// **`0` means impassable.** Keeping a single field avoids the classic bug
    /// where `passable` and `movementCost` disagree. The MVP movement rule only
    /// consumes the passability bit; the numeric cost is already carried through
    /// the engine for future pathfinding.
    pub movement_cost: u32,
    /// Free-form gameplay tags.
    #[serde(default)]
    pub tags: Vec<String>,
    /// How this tile should be drawn.
    pub visual: TileVisual,
}

impl TileDefinition {
    /// Returns `true` when an entity may enter this tile.
    #[must_use]
    pub const fn is_passable(&self) -> bool {
        self.movement_cost > 0
    }

    /// Returns `true` when this tile carries `tag`.
    #[must_use]
    pub fn has_tag(&self, tag: &str) -> bool {
        self.tags.iter().any(|candidate| candidate == tag)
    }
}

/// Visual description of a tile.
///
/// The world data never contains rendering *logic*: it carries a stable
/// [`visual_id`](TileVisual::visual_id) that the renderer resolves through its
/// sprite registry. `fallback_color` exists so the MVP can ship without an asset
/// pipeline, and stays useful later as the colour drawn while a texture loads or
/// at low levels of detail.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileVisual {
    /// Stable visual id resolved by the renderer, e.g. `"terrain.grass"`.
    pub visual_id: String,
    /// CSS colour used when no texture is registered for `visual_id`.
    pub fallback_color: String,
    /// Renderer hints (opacity, decoration layer, ...) kept open for growth.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub hints: BTreeMap<String, String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_movement_cost_means_impassable() {
        let mut tile = TileDefinition {
            id: "water".into(),
            name: "Water".into(),
            terrain: "water".into(),
            movement_cost: 0,
            tags: vec!["blocks_movement".into()],
            visual: TileVisual {
                visual_id: "terrain.water".into(),
                fallback_color: "#1d4e79".into(),
                hints: BTreeMap::new(),
            },
        };
        assert!(!tile.is_passable());
        assert!(tile.has_tag("blocks_movement"));

        tile.movement_cost = 1;
        assert!(tile.is_passable());
    }

    #[test]
    fn tile_set_round_trips_through_json() {
        let json = r##"{
            "id": "mvp_terrain",
            "schemaVersion": 1,
            "name": "MVP Terrain",
            "tiles": [
                {
                    "id": "grass",
                    "name": "Grass",
                    "terrain": "grass",
                    "movementCost": 1,
                    "tags": [],
                    "visual": { "visualId": "terrain.grass", "fallbackColor": "#4f7a3a" }
                }
            ]
        }"##;
        let set: TileSetDefinition = serde_json::from_str(json).expect("parse");
        assert_eq!(set.id, "mvp_terrain");
        assert_eq!(set.tile("grass").map(|tile| tile.movement_cost), Some(1));
        assert!(set.tile("missing").is_none());

        let reparsed: TileSetDefinition =
            serde_json::from_str(&serde_json::to_string(&set).expect("serialise"))
                .expect("reparse");
        assert_eq!(set, reparsed);
    }
}
