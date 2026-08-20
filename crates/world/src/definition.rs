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
///
/// Version 2 added [`PlacedTile::art`], the per-cell art choice
/// (`docs/adr/ADR-0036-a-cell-may-choose-its-tile-art.md`). Every field of it
/// is defaulted, so a version 1 file parses unchanged and rolls its art as it
/// always did; the shipped files say `2`.
pub const WORLD_SCHEMA_VERSION: u32 = 2;

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

/// How the hex plane is projected onto the screen.
///
/// This is *presentation* carried by content: the simulation never reads it, and
/// no rule may depend on it. The renderer turns it into an affine transform of
/// world-space points (`docs/adr/ADR-0016-isometric-projection.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectionMode {
    /// Straight down: the hex plane is the drawing plane.
    #[default]
    TopDown,
    /// Vertically foreshortened, with elevation lifting a cell off its row.
    Isometric,
}

/// Lowest authored elevation. Elevation is packed as one signed byte per cell.
pub const MIN_ELEVATION: i32 = i8::MIN as i32;

/// Highest authored elevation. Elevation is packed as one signed byte per cell.
pub const MAX_ELEVATION: i32 = i8::MAX as i32;

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
    /// Id of the [`crate::ZoneDefinition`] this map belongs to.
    ///
    /// Every map belongs to exactly one zone; empty names the project's default
    /// one rather than *no* zone (`ProjectDefinition::resolve_zone`). The field
    /// stays optional in the file so a map authored before zones existed loads
    /// into the default, and because a zone id only means something next to the
    /// project that declares it — like `targetWorld`, it is a cross-file
    /// reference the project-level validator resolves
    /// (`docs/adr/ADR-0021-map-zones.md`).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub zone: String,
    /// Number of columns.
    pub width: u32,
    /// Number of rows.
    pub height: u32,
    /// Hex orientation.
    #[serde(default)]
    pub orientation: HexOrientation,
    /// How the renderer projects this map. Never read by the simulation.
    #[serde(default)]
    pub projection: ProjectionMode,
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
    /// Cells that send the player to another map
    /// (`docs/adr/ADR-0017-map-links.md`).
    #[serde(default)]
    pub links: Vec<MapLinkDefinition>,
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

    /// The link triggered by entering `at`, if any.
    ///
    /// Validation rejects two links on the same cell, so at most one can match.
    #[must_use]
    pub fn link_entered_at(&self, at: OffsetCoord) -> Option<&MapLinkDefinition> {
        self.links
            .iter()
            .find(|link| link.at == at && link.trigger == LinkTrigger::Enter)
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
    /// Authored elevation, in whole steps.
    ///
    /// Unused by the MVP rules; the renderer lifts the cell by this much in
    /// isometric mode. Validation constrains it to [`MIN_ELEVATION`] ..=
    /// [`MAX_ELEVATION`] so it can be packed as one signed byte per cell.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub elevation: i32,
    /// Per-cell gameplay tags, in addition to the tile's own tags.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// What this cell is drawn with, when the roll is not what the author
    /// wanted.
    ///
    /// Presentation only, like [`elevation`](Self::elevation): no rule reads
    /// it. Empty — the usual case — leaves every choice to
    /// [`crate::variant_roll`].
    #[serde(default, skip_serializing_if = "PlacedTileArt::is_empty")]
    pub art: PlacedTileArt,
}

/// A cell's own answer to "which picture", by id rather than by index.
///
/// Ids, because they are what an author reads in the tile set and what survives
/// a variant being inserted above another one; the renderer wants indices, and
/// [`crate::WorldGrid`] resolves them once when it flattens the map
/// (`docs/adr/ADR-0036-a-cell-may-choose-its-tile-art.md`).
///
/// Three independent choices, all optional, because they answer three different
/// questions: what the top face shows, what the cut underneath is made of, and
/// which cut. An empty string is "roll it", which is what nearly every cell of
/// nearly every map says.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacedTileArt {
    /// Id of the surface variant of this cell's own tile.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub surface: String,
    /// Id of the [`crate::TileDefinition`] whose elevation ladder cuts the
    /// faces. Empty uses the cell's own tile.
    ///
    /// This is how a meadow stands on a rock cliff. The top face is unaffected:
    /// it always comes from the cell's own tile.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub elevation_tile: String,
    /// Id of the elevation variant, in whichever ladder ends up drawing.
    ///
    /// Empty follows [`surface`](Self::surface), so a cut matches the ground
    /// standing on it without anyone having to say so.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub elevation: String,
}

impl PlacedTileArt {
    /// `true` when the cell chooses nothing, so the file may leave it out.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.surface.is_empty() && self.elevation_tile.is_empty() && self.elevation.is_empty()
    }
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

/// What makes a [`MapLinkDefinition`] fire.
///
/// Only [`LinkTrigger::Enter`] is implemented. [`LinkTrigger::Interact`] is
/// reserved so that adding an interaction command later is a content-format
/// addition rather than a breaking change; validation rejects it until then, on
/// the same principle as [`HexOrientation::Flat`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkTrigger {
    /// Fires when the player's move ends on the link's cell.
    #[default]
    Enter,
    /// Reserved: fires on an explicit interaction. Rejected by validation.
    Interact,
}

impl LinkTrigger {
    /// Whether this is the value a file may leave out.
    #[must_use]
    pub fn is_default(&self) -> bool {
        *self == Self::Enter
    }
}

/// A cell that sends the player to another authored map.
///
/// This is the only cross-file reference in the world schema, so it is also the
/// only one whose target a single-world validation pass cannot resolve: bounds
/// and duplicates are checked per world, and the target is checked by
/// [`crate::validate_project_links`] once every world is loaded
/// (`docs/adr/ADR-0017-map-links.md`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapLinkDefinition {
    /// Stable content id, unique within the world.
    pub id: String,
    /// The cell that triggers the link, in offset coordinates.
    pub at: OffsetCoord,
    /// Id of the [`WorldDefinition`] the player is sent to.
    ///
    /// May be this world's own id, which makes the link an intra-map teleport.
    pub target_world: String,
    /// Where the player arrives in the target world, in offset coordinates.
    pub target_at: OffsetCoord,
    /// What makes the link fire. Omitted from files when it is the default.
    #[serde(default, skip_serializing_if = "LinkTrigger::is_default")]
    pub trigger: LinkTrigger,
    /// Display name, e.g. `"Door"`. Presentation only.
    #[serde(default, skip_serializing_if = "String::is_empty")]
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
        "schemaVersion": 2,
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
        assert_eq!(world.projection, ProjectionMode::TopDown);
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
        // An unzoned map writes no zone, so files predating the field are
        // re-exported byte for byte.
        assert!(!serialised.contains("\"zone\""));
    }

    #[test]
    fn zone_is_optional_and_kept_when_authored() {
        let world: WorldDefinition = serde_json::from_str(MINIMAL).expect("parse");
        assert_eq!(world.zone, "");

        let zoned: WorldDefinition = serde_json::from_str(
            &MINIMAL.replace(r#""width": 3,"#, r#""width": 3, "zone": "Northern Reach","#),
        )
        .expect("parse");
        assert_eq!(zoned.zone, "Northern Reach");
        assert!(serde_json::to_string(&zoned)
            .expect("serialise")
            .contains(r#""zone":"Northern Reach""#));
    }

    #[test]
    fn a_cell_may_choose_its_art_and_most_do_not() {
        let world: WorldDefinition = serde_json::from_str(MINIMAL).expect("parse");
        assert!(world.tiles[0].art.is_empty());
        // Nothing chosen, nothing written: a map that rolls everything is
        // re-exported exactly as it was authored.
        assert!(!serde_json::to_string(&world)
            .expect("serialise")
            .contains("\"art\""));

        let chosen: WorldDefinition = serde_json::from_str(&MINIMAL.replace(
            r#""tile": "water""#,
            r#""tile": "water", "art": { "surface": "c", "elevationTile": "rock" }"#,
        ))
        .expect("parse");
        assert_eq!(chosen.tiles[0].art.surface, "c");
        assert_eq!(chosen.tiles[0].art.elevation_tile, "rock");
        assert_eq!(chosen.tiles[0].art.elevation, "");

        let serialised = serde_json::to_string(&chosen).expect("serialise");
        assert!(
            serialised.contains(r#""art":{"surface":"c","elevationTile":"rock"}"#),
            "{serialised}"
        );
    }

    #[test]
    fn projection_round_trips_by_its_camel_case_name() {
        let world: WorldDefinition = serde_json::from_str(&MINIMAL.replace(
            r#""width": 3,"#,
            r#""width": 3, "projection": "isometric","#,
        ))
        .expect("parse");
        assert_eq!(world.projection, ProjectionMode::Isometric);

        let serialised = serde_json::to_string(&world).expect("serialise");
        assert!(serialised.contains(r#""projection":"isometric""#));
    }
}
