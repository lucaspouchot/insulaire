//! Content validation shared by the editor and the runtime.
//!
//! There is exactly one implementation of "is this world loadable?", and it
//! lives here in Rust. The Angular editor calls it through WASM before
//! exporting, so a world that the editor accepts is a world the runtime accepts
//! (see `docs/adr/ADR-0015-shared-content-validation.md`).

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::definition::{HexOrientation, WorldDefinition, WORLD_SCHEMA_VERSION};
use crate::template::{EntityKind, TemplateRegistry};
use crate::tileset::{TileSetDefinition, TILE_SET_SCHEMA_VERSION};

/// Upper bound on map size accepted by the MVP loader.
///
/// The packed tile buffer is `width * height` bytes, so this caps a world at
/// 4 MiB of terrain data.
pub const MAX_MAP_DIMENSION: u32 = 2048;

/// Maximum number of distinct tiles in one palette.
///
/// The runtime grid stores one `u8` per cell, so the palette must fit in a byte.
pub const MAX_PALETTE_SIZE: usize = 256;

/// How badly a validation issue breaks the content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    /// The content cannot be loaded.
    Error,
    /// The content loads but something is probably wrong.
    Warning,
}

/// A single validation finding.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    /// Machine-readable code, e.g. `"tile.unknownReference"`.
    pub code: String,
    /// Severity of the finding.
    pub severity: Severity,
    /// JSON-ish path to the offending value, e.g. `"tiles[12].tile"`.
    pub path: String,
    /// Human readable explanation.
    pub message: String,
}

impl ValidationIssue {
    fn error(code: &str, path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            severity: Severity::Error,
            path: path.into(),
            message: message.into(),
        }
    }

    fn warning(code: &str, path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            severity: Severity::Warning,
            path: path.into(),
            message: message.into(),
        }
    }
}

/// The outcome of validating one content file.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationReport {
    /// `true` when no [`Severity::Error`] issue was found.
    pub valid: bool,
    /// Every finding, errors first in discovery order.
    pub issues: Vec<ValidationIssue>,
}

impl ValidationReport {
    fn from_issues(issues: Vec<ValidationIssue>) -> Self {
        let valid = !issues.iter().any(|issue| issue.severity == Severity::Error);
        Self { valid, issues }
    }

    /// Issues that prevent loading.
    pub fn errors(&self) -> impl Iterator<Item = &ValidationIssue> {
        self.issues
            .iter()
            .filter(|issue| issue.severity == Severity::Error)
    }

    /// A single-line summary suitable for an error message.
    #[must_use]
    pub fn summary(&self) -> String {
        let errors: Vec<String> = self
            .errors()
            .map(|issue| format!("{} ({})", issue.message, issue.path))
            .collect();
        if errors.is_empty() {
            "content is valid".to_owned()
        } else {
            errors.join("; ")
        }
    }
}

/// Validates a tile set in isolation.
#[must_use]
pub fn validate_tile_set(tile_set: &TileSetDefinition) -> ValidationReport {
    let mut issues = Vec::new();

    if tile_set.id.trim().is_empty() {
        issues.push(ValidationIssue::error(
            "tileSet.missingId",
            "id",
            "tile set id must not be empty",
        ));
    }
    if tile_set.schema_version == 0 || tile_set.schema_version > TILE_SET_SCHEMA_VERSION {
        issues.push(ValidationIssue::error(
            "tileSet.unsupportedSchemaVersion",
            "schemaVersion",
            format!(
                "unsupported tile set schemaVersion {}; this build supports up to {TILE_SET_SCHEMA_VERSION}",
                tile_set.schema_version
            ),
        ));
    }
    if tile_set.tiles.is_empty() {
        issues.push(ValidationIssue::error(
            "tileSet.empty",
            "tiles",
            "a tile set must define at least one tile",
        ));
    }
    if tile_set.tiles.len() > MAX_PALETTE_SIZE {
        issues.push(ValidationIssue::error(
            "tileSet.paletteTooLarge",
            "tiles",
            format!("a tile set may define at most {MAX_PALETTE_SIZE} tiles"),
        ));
    }

    let mut seen = BTreeSet::new();
    for (index, tile) in tile_set.tiles.iter().enumerate() {
        let path = format!("tiles[{index}]");
        if tile.id.trim().is_empty() {
            issues.push(ValidationIssue::error(
                "tile.missingId",
                format!("{path}.id"),
                "tile id must not be empty",
            ));
        } else if !seen.insert(tile.id.as_str()) {
            issues.push(ValidationIssue::error(
                "tile.duplicateId",
                format!("{path}.id"),
                format!("duplicate tile id `{}`", tile.id),
            ));
        }
        if tile.visual.visual_id.trim().is_empty() {
            issues.push(ValidationIssue::error(
                "tile.missingVisualId",
                format!("{path}.visual.visualId"),
                "tile must reference a visual id",
            ));
        }
    }

    ValidationReport::from_issues(issues)
}

/// Validates a world against the tile set it references.
///
/// Pass `None` for `tile_set` when the referenced tile set has not been loaded;
/// the report then contains a `world.unknownTileSet` error instead of panicking.
#[must_use]
pub fn validate_world(
    world: &WorldDefinition,
    tile_set: Option<&TileSetDefinition>,
    templates: &TemplateRegistry,
) -> ValidationReport {
    let mut issues = Vec::new();

    validate_world_header(world, &mut issues);

    let Some(tile_set) = tile_set else {
        issues.push(ValidationIssue::error(
            "world.unknownTileSet",
            "tileSetId",
            format!("tile set `{}` is not loaded", world.tile_set_id),
        ));
        return ValidationReport::from_issues(issues);
    };

    validate_tiles(world, tile_set, &mut issues);
    validate_entities(world, tile_set, templates, &mut issues);
    validate_locations(world, &mut issues);

    ValidationReport::from_issues(issues)
}

fn validate_world_header(world: &WorldDefinition, issues: &mut Vec<ValidationIssue>) {
    if world.id.trim().is_empty() {
        issues.push(ValidationIssue::error(
            "world.missingId",
            "id",
            "world id must not be empty",
        ));
    }
    if world.schema_version == 0 || world.schema_version > WORLD_SCHEMA_VERSION {
        issues.push(ValidationIssue::error(
            "world.unsupportedSchemaVersion",
            "schemaVersion",
            format!(
                "unsupported world schemaVersion {}; this build supports up to {WORLD_SCHEMA_VERSION}",
                world.schema_version
            ),
        ));
    }
    if world.width == 0 || world.height == 0 {
        issues.push(ValidationIssue::error(
            "world.emptyMap",
            "width/height",
            "world width and height must both be greater than zero",
        ));
    }
    if world.width > MAX_MAP_DIMENSION || world.height > MAX_MAP_DIMENSION {
        issues.push(ValidationIssue::error(
            "world.mapTooLarge",
            "width/height",
            format!("world dimensions must not exceed {MAX_MAP_DIMENSION}"),
        ));
    }
    if world.orientation != HexOrientation::Pointy {
        issues.push(ValidationIssue::error(
            "world.unsupportedOrientation",
            "orientation",
            "only the `pointy` orientation is implemented",
        ));
    }
}

fn validate_tiles(
    world: &WorldDefinition,
    tile_set: &TileSetDefinition,
    issues: &mut Vec<ValidationIssue>,
) {
    if tile_set.tile(&world.default_tile).is_none() {
        issues.push(ValidationIssue::error(
            "world.unknownDefaultTile",
            "defaultTile",
            format!(
                "default tile `{}` is not defined by tile set `{}`",
                world.default_tile, tile_set.id
            ),
        ));
    }

    let mut occupied: BTreeSet<(i32, i32)> = BTreeSet::new();
    for (index, placed) in world.tiles.iter().enumerate() {
        let path = format!("tiles[{index}]");
        if !placed.at.is_within(world.width, world.height) {
            issues.push(ValidationIssue::error(
                "tile.outOfBounds",
                format!("{path}.at"),
                format!(
                    "tile position {} is outside the {}x{} map",
                    placed.at, world.width, world.height
                ),
            ));
        }
        if !occupied.insert((placed.at.col, placed.at.row)) {
            issues.push(ValidationIssue::error(
                "tile.duplicatePosition",
                format!("{path}.at"),
                format!("more than one tile is painted at {}", placed.at),
            ));
        }
        if tile_set.tile(&placed.tile).is_none() {
            issues.push(ValidationIssue::error(
                "tile.unknownReference",
                format!("{path}.tile"),
                format!(
                    "tile `{}` is not defined by tile set `{}`",
                    placed.tile, tile_set.id
                ),
            ));
        }
    }
}

fn validate_entities(
    world: &WorldDefinition,
    tile_set: &TileSetDefinition,
    templates: &TemplateRegistry,
    issues: &mut Vec<ValidationIssue>,
) {
    let mut ids: BTreeSet<&str> = BTreeSet::new();
    let mut positions: BTreeSet<(i32, i32)> = BTreeSet::new();
    let mut player_count = 0usize;
    let mut monster_count = 0usize;

    for (index, entity) in world.entities.iter().enumerate() {
        let path = format!("entities[{index}]");

        if entity.id.trim().is_empty() {
            issues.push(ValidationIssue::error(
                "entity.missingId",
                format!("{path}.id"),
                "entity id must not be empty",
            ));
        } else if !ids.insert(entity.id.as_str()) {
            issues.push(ValidationIssue::error(
                "entity.duplicateId",
                format!("{path}.id"),
                format!("duplicate entity id `{}`", entity.id),
            ));
        }

        if !entity.at.is_within(world.width, world.height) {
            issues.push(ValidationIssue::error(
                "entity.outOfBounds",
                format!("{path}.at"),
                format!(
                    "entity `{}` is placed outside the map at {}",
                    entity.id, entity.at
                ),
            ));
        } else if !tile_at_is_passable(world, tile_set, entity) {
            issues.push(ValidationIssue::error(
                "entity.onImpassableTile",
                format!("{path}.at"),
                format!(
                    "entity `{}` stands on an impassable tile at {}",
                    entity.id, entity.at
                ),
            ));
        }

        match templates.get(&entity.template_id) {
            None => issues.push(ValidationIssue::error(
                "entity.unknownTemplate",
                format!("{path}.templateId"),
                format!("unknown entity template `{}`", entity.template_id),
            )),
            Some(template) => {
                if template.blocks_movement && !positions.insert((entity.at.col, entity.at.row)) {
                    issues.push(ValidationIssue::error(
                        "entity.overlappingPlacement",
                        format!("{path}.at"),
                        format!("two blocking entities share the position {}", entity.at),
                    ));
                }
                match template.kind {
                    EntityKind::Player => player_count += 1,
                    EntityKind::Monster => monster_count += 1,
                }
            }
        }
    }

    match player_count {
        0 => issues.push(ValidationIssue::error(
            "world.missingPlayer",
            "entities",
            "a playable world must contain exactly one entity with the `player` template",
        )),
        1 => {}
        count => issues.push(ValidationIssue::error(
            "world.multiplePlayers",
            "entities",
            format!("a world must contain exactly one player entity, found {count}"),
        )),
    }

    if monster_count == 0 {
        issues.push(ValidationIssue::warning(
            "world.noMonsters",
            "entities",
            "the world contains no monsters, so nothing will chase the player",
        ));
    }
}

fn validate_locations(world: &WorldDefinition, issues: &mut Vec<ValidationIssue>) {
    let mut ids: BTreeSet<&str> = BTreeSet::new();
    for (index, location) in world.locations.iter().enumerate() {
        let path = format!("locations[{index}]");
        if location.id.trim().is_empty() {
            issues.push(ValidationIssue::error(
                "location.missingId",
                format!("{path}.id"),
                "location id must not be empty",
            ));
        } else if !ids.insert(location.id.as_str()) {
            issues.push(ValidationIssue::error(
                "location.duplicateId",
                format!("{path}.id"),
                format!("duplicate location id `{}`", location.id),
            ));
        }
        if !location.at.is_within(world.width, world.height) {
            issues.push(ValidationIssue::error(
                "location.outOfBounds",
                format!("{path}.at"),
                format!(
                    "location `{}` is outside the map at {}",
                    location.id, location.at
                ),
            ));
        }
    }
}

fn tile_at_is_passable(
    world: &WorldDefinition,
    tile_set: &TileSetDefinition,
    entity: &crate::definition::EntityDefinition,
) -> bool {
    let tile_id = world
        .tiles
        .iter()
        .find(|placed| placed.at == entity.at)
        .map_or(world.default_tile.as_str(), |placed| placed.tile.as_str());
    // An unknown tile reference is reported separately; do not double-report here.
    tile_set
        .tile(tile_id)
        .is_none_or(super::tileset::TileDefinition::is_passable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hex::OffsetCoord;
    use crate::testing;

    fn codes(report: &ValidationReport) -> Vec<&str> {
        report
            .issues
            .iter()
            .map(|issue| issue.code.as_str())
            .collect()
    }

    #[test]
    fn a_well_formed_world_is_valid() {
        let report = validate_world(
            &testing::sample_world(),
            Some(&testing::sample_tile_set()),
            &TemplateRegistry::builtin(),
        );
        assert!(report.valid, "unexpected issues: {:?}", report.issues);
        assert_eq!(report.summary(), "content is valid");
    }

    #[test]
    fn unknown_tile_reference_is_an_error() {
        let mut world = testing::sample_world();
        world.tiles[0].tile = "lava".into();
        let report = validate_world(
            &world,
            Some(&testing::sample_tile_set()),
            &TemplateRegistry::builtin(),
        );
        assert!(!report.valid);
        assert!(codes(&report).contains(&"tile.unknownReference"));
    }

    #[test]
    fn out_of_bounds_placements_are_errors() {
        let mut world = testing::sample_world();
        world.tiles.push(crate::definition::PlacedTile {
            at: OffsetCoord::new(99, 0),
            tile: "grass".into(),
            elevation: 0,
            tags: Vec::new(),
        });
        world.entities[0].at = OffsetCoord::new(-1, 0);
        let report = validate_world(
            &world,
            Some(&testing::sample_tile_set()),
            &TemplateRegistry::builtin(),
        );
        assert!(!report.valid);
        assert!(codes(&report).contains(&"tile.outOfBounds"));
        assert!(codes(&report).contains(&"entity.outOfBounds"));
    }

    #[test]
    fn a_world_needs_exactly_one_player() {
        let mut world = testing::sample_world();
        world
            .entities
            .retain(|entity| entity.template_id != "player");
        let report = validate_world(
            &world,
            Some(&testing::sample_tile_set()),
            &TemplateRegistry::builtin(),
        );
        assert!(codes(&report).contains(&"world.missingPlayer"));

        let mut world = testing::sample_world();
        let mut clone = world.entities[0].clone();
        clone.id = "player_2".into();
        clone.at = OffsetCoord::new(3, 3);
        world.entities.push(clone);
        let report = validate_world(
            &world,
            Some(&testing::sample_tile_set()),
            &TemplateRegistry::builtin(),
        );
        assert!(codes(&report).contains(&"world.multiplePlayers"));
    }

    #[test]
    fn entities_may_not_stand_on_impassable_tiles() {
        let mut world = testing::sample_world();
        let player_at = world.entities[0].at;
        world.tiles.push(crate::definition::PlacedTile {
            at: player_at,
            tile: "water".into(),
            elevation: 0,
            tags: Vec::new(),
        });
        let report = validate_world(
            &world,
            Some(&testing::sample_tile_set()),
            &TemplateRegistry::builtin(),
        );
        assert!(codes(&report).contains(&"entity.onImpassableTile"));
    }

    #[test]
    fn unknown_template_and_duplicate_ids_are_errors() {
        let mut world = testing::sample_world();
        world.entities[1].template_id = "dragon".into();
        world.entities[1].id = world.entities[0].id.clone();
        let report = validate_world(
            &world,
            Some(&testing::sample_tile_set()),
            &TemplateRegistry::builtin(),
        );
        assert!(codes(&report).contains(&"entity.unknownTemplate"));
        assert!(codes(&report).contains(&"entity.duplicateId"));
    }

    #[test]
    fn a_missing_tile_set_is_reported_rather_than_panicking() {
        let report = validate_world(&testing::sample_world(), None, &TemplateRegistry::builtin());
        assert!(!report.valid);
        assert_eq!(codes(&report), vec!["world.unknownTileSet"]);
    }

    #[test]
    fn future_schema_versions_are_rejected() {
        let mut world = testing::sample_world();
        world.schema_version = WORLD_SCHEMA_VERSION + 1;
        let report = validate_world(
            &world,
            Some(&testing::sample_tile_set()),
            &TemplateRegistry::builtin(),
        );
        assert!(codes(&report).contains(&"world.unsupportedSchemaVersion"));
    }

    #[test]
    fn duplicate_painted_positions_are_rejected() {
        let mut world = testing::sample_world();
        let duplicate = world.tiles[0].clone();
        world.tiles.push(duplicate);
        let report = validate_world(
            &world,
            Some(&testing::sample_tile_set()),
            &TemplateRegistry::builtin(),
        );
        assert!(codes(&report).contains(&"tile.duplicatePosition"));
    }

    #[test]
    fn a_world_without_monsters_only_warns() {
        let mut world = testing::sample_world();
        world
            .entities
            .retain(|entity| entity.template_id == "player");
        let report = validate_world(
            &world,
            Some(&testing::sample_tile_set()),
            &TemplateRegistry::builtin(),
        );
        assert!(report.valid, "missing monsters must not block loading");
        assert!(codes(&report).contains(&"world.noMonsters"));
    }

    #[test]
    fn tile_set_validation_catches_duplicates_and_empty_palettes() {
        let mut tile_set = testing::sample_tile_set();
        let duplicate = tile_set.tiles[0].clone();
        tile_set.tiles.push(duplicate);
        let report = validate_tile_set(&tile_set);
        assert!(!report.valid);
        assert!(codes(&report).contains(&"tile.duplicateId"));

        let mut empty = testing::sample_tile_set();
        empty.tiles.clear();
        assert!(codes(&validate_tile_set(&empty)).contains(&"tileSet.empty"));
    }
}
