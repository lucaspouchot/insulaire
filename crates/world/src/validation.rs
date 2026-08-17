//! Content validation shared by the editor and the runtime.
//!
//! There is exactly one implementation of "is this world loadable?", and it
//! lives here in Rust. The Angular editor calls it through WASM before
//! exporting, so a world that the editor accepts is a world the runtime accepts
//! (see `docs/adr/ADR-0015-shared-content-validation.md`).

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::definition::{
    HexOrientation, LinkTrigger, WorldDefinition, MAX_ELEVATION, MIN_ELEVATION,
    WORLD_SCHEMA_VERSION,
};
use crate::hex::OffsetCoord;
use crate::project::{ProjectDefinition, PROJECT_SCHEMA_VERSION};
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

    /// Combines two reports, keeping every issue and the stricter verdict.
    ///
    /// Loading a project runs several checks that answer different questions;
    /// the caller reports them as one outcome.
    #[must_use]
    pub fn merge(mut self, other: Self) -> Self {
        self.valid = self.valid && other.valid;
        self.issues.extend(other.issues);
        self
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
    validate_links(world, tile_set, &mut issues);

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
        // Elevation is packed as one signed byte per cell for the renderer
        // (`docs/adr/ADR-0016-isometric-projection.md`), so the schema cannot
        // carry more than a byte's worth of relief.
        if !(MIN_ELEVATION..=MAX_ELEVATION).contains(&placed.elevation) {
            issues.push(ValidationIssue::error(
                "tile.elevationOutOfRange",
                format!("{path}.elevation"),
                format!(
                    "elevation {} at {} is outside {MIN_ELEVATION}..={MAX_ELEVATION}",
                    placed.elevation, placed.at
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
        } else if !tile_at_is_passable(world, tile_set, entity.at) {
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

/// Validates the links of one world, as far as a single file allows.
///
/// Everything here is intra-file: ids, bounds, duplicates, trigger support. The
/// *target* of a link lives in another file and is checked by
/// [`validate_project_links`] once every world is loaded
/// (`docs/adr/ADR-0017-map-links.md`).
fn validate_links(
    world: &WorldDefinition,
    tile_set: &TileSetDefinition,
    issues: &mut Vec<ValidationIssue>,
) {
    let mut ids: BTreeSet<&str> = BTreeSet::new();
    let mut positions: BTreeSet<(i32, i32)> = BTreeSet::new();

    for (index, link) in world.links.iter().enumerate() {
        let path = format!("links[{index}]");

        if link.id.trim().is_empty() {
            issues.push(ValidationIssue::error(
                "link.missingId",
                format!("{path}.id"),
                "link id must not be empty",
            ));
        } else if !ids.insert(link.id.as_str()) {
            issues.push(ValidationIssue::error(
                "link.duplicateId",
                format!("{path}.id"),
                format!("duplicate link id `{}`", link.id),
            ));
        }

        if !link.at.is_within(world.width, world.height) {
            issues.push(ValidationIssue::error(
                "link.outOfBounds",
                format!("{path}.at"),
                format!("link `{}` is outside the map at {}", link.id, link.at),
            ));
        } else {
            if !positions.insert((link.at.col, link.at.row)) {
                issues.push(ValidationIssue::error(
                    "link.duplicatePosition",
                    format!("{path}.at"),
                    format!("two links share the position {}", link.at),
                ));
            }
            // An `enter` link on an impassable cell can never fire: the player
            // is not allowed to step there in the first place.
            if !tile_at_is_passable(world, tile_set, link.at) {
                issues.push(ValidationIssue::error(
                    "link.onImpassableTile",
                    format!("{path}.at"),
                    format!(
                        "link `{}` sits on an impassable tile at {}, so it can never be entered",
                        link.id, link.at
                    ),
                ));
            }
        }

        if link.target_world.trim().is_empty() {
            issues.push(ValidationIssue::error(
                "link.missingTarget",
                format!("{path}.targetWorld"),
                format!("link `{}` names no target world", link.id),
            ));
        } else if link.target_world == world.id
            && !link.target_at.is_within(world.width, world.height)
        {
            // Only a self-link can be resolved here; cross-world targets wait
            // for `validate_project_links`.
            issues.push(ValidationIssue::error(
                "link.targetOutOfBounds",
                format!("{path}.targetAt"),
                format!(
                    "link `{}` arrives at {}, outside its own {}x{} map",
                    link.id, link.target_at, world.width, world.height
                ),
            ));
        }

        if link.trigger != LinkTrigger::Enter {
            issues.push(ValidationIssue::error(
                "link.unsupportedTrigger",
                format!("{path}.trigger"),
                format!(
                    "link `{}` uses trigger `{:?}`, which this build does not implement",
                    link.id, link.trigger
                ),
            ));
        }
    }
}

/// Resolves every map link across a whole set of loaded worlds.
///
/// This is the half of link validation that no single file can perform: it
/// checks that each `targetWorld` exists and that each `targetAt` lands on a
/// cell the player can occupy. Call it after loading a project's worlds; the
/// engine exposes it as `validateLinks` (`docs/wasm-api.md`).
///
/// `worlds` and `tile_sets` are lookups over everything currently loaded.
#[must_use]
pub fn validate_project_links<'a>(
    worlds: impl IntoIterator<Item = &'a WorldDefinition>,
    tile_set_for: impl Fn(&str) -> Option<&'a TileSetDefinition>,
) -> ValidationReport {
    let worlds: Vec<&WorldDefinition> = worlds.into_iter().collect();
    let mut issues = Vec::new();

    for world in &worlds {
        for (index, link) in world.links.iter().enumerate() {
            let path = format!("{}.links[{index}]", world.id);
            let Some(target) = worlds
                .iter()
                .find(|candidate| candidate.id == link.target_world)
            else {
                issues.push(ValidationIssue::error(
                    "link.unknownTargetWorld",
                    format!("{path}.targetWorld"),
                    format!(
                        "link `{}` targets world `{}`, which is not loaded",
                        link.id, link.target_world
                    ),
                ));
                continue;
            };

            if !link.target_at.is_within(target.width, target.height) {
                issues.push(ValidationIssue::error(
                    "link.targetOutOfBounds",
                    format!("{path}.targetAt"),
                    format!(
                        "link `{}` arrives at {}, outside the {}x{} map `{}`",
                        link.id, link.target_at, target.width, target.height, target.id
                    ),
                ));
                continue;
            }

            if let Some(tile_set) = tile_set_for(&target.tile_set_id) {
                if !tile_at_is_passable(target, tile_set, link.target_at) {
                    issues.push(ValidationIssue::error(
                        "link.targetImpassable",
                        format!("{path}.targetAt"),
                        format!(
                            "link `{}` arrives on an impassable tile at {} in `{}`",
                            link.id, link.target_at, target.id
                        ),
                    ));
                    continue;
                }
            }

            // The arriving player takes the cell it lands on, so an authored
            // entity standing there would end up sharing a hex with it.
            if let Some(occupant) = target
                .entities
                .iter()
                .find(|entity| entity.at == link.target_at && entity.template_id != "player")
            {
                issues.push(ValidationIssue::error(
                    "link.targetOccupied",
                    format!("{path}.targetAt"),
                    format!(
                        "link `{}` arrives at {} in `{}`, where entity `{}` is placed",
                        link.id, link.target_at, target.id, occupant.id
                    ),
                ));
            }
        }
    }

    ValidationReport::from_issues(issues)
}

/// Resolves every world's zone against the project that declares them.
///
/// The other half of zone validation, and the half no single file can perform:
/// a world names a zone id, and only the project says whether that zone exists
/// (`docs/adr/ADR-0021-map-zones.md`). A world naming none is not an error —
/// it belongs to the project's default zone, which is what makes zones
/// mandatory in the model without making the field mandatory in the file.
#[must_use]
pub fn validate_project_zones<'a>(
    project: &ProjectDefinition,
    worlds: impl IntoIterator<Item = &'a WorldDefinition>,
) -> ValidationReport {
    let mut issues = Vec::new();

    for world in worlds {
        if !world.zone.is_empty() && !project.has_zone(&world.zone) {
            issues.push(ValidationIssue::error(
                "world.unknownZone",
                format!("{}.zone", world.id),
                format!(
                    "world `{}` is in zone `{}`, which the project does not declare",
                    world.id, world.zone
                ),
            ));
        }
    }

    ValidationReport::from_issues(issues)
}

/// Validates a project file, given the ids of everything currently loaded.
///
/// The project only *names* files; whether they exist on disk is the host's
/// business, so this checks the shape of the manifest and that its start world
/// and referenced ids are among the loaded content.
#[must_use]
pub fn validate_project(
    project: &ProjectDefinition,
    loaded_world_ids: &[String],
    loaded_tile_set_ids: &[String],
) -> ValidationReport {
    let mut issues = Vec::new();

    if project.id.trim().is_empty() {
        issues.push(ValidationIssue::error(
            "project.missingId",
            "id",
            "project id must not be empty",
        ));
    }
    if project.schema_version == 0 || project.schema_version > PROJECT_SCHEMA_VERSION {
        issues.push(ValidationIssue::error(
            "project.unsupportedSchemaVersion",
            "schemaVersion",
            format!(
                "unsupported project schemaVersion {}; this build supports up to {PROJECT_SCHEMA_VERSION}",
                project.schema_version
            ),
        ));
    }
    if project.worlds.is_empty() {
        issues.push(ValidationIssue::error(
            "project.noWorlds",
            "worlds",
            "a project must list at least one world",
        ));
    }

    let mut zone_ids: BTreeSet<&str> = BTreeSet::new();
    for (index, zone) in project.zones.iter().enumerate() {
        if zone.id.trim().is_empty() {
            issues.push(ValidationIssue::error(
                "project.missingZoneId",
                format!("zones[{index}].id"),
                "zone id must not be empty",
            ));
        } else if !zone_ids.insert(zone.id.as_str()) {
            issues.push(ValidationIssue::error(
                "project.duplicateZone",
                format!("zones[{index}].id"),
                format!("zone `{}` is declared twice", zone.id),
            ));
        }
    }

    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for (index, entry) in project.worlds.iter().enumerate() {
        if !seen.insert(entry.id.as_str()) {
            issues.push(ValidationIssue::error(
                "project.duplicateWorld",
                format!("worlds[{index}].id"),
                format!("world `{}` is listed twice", entry.id),
            ));
        }
        if !loaded_world_ids.iter().any(|id| id == &entry.id) {
            issues.push(ValidationIssue::error(
                "project.unloadedWorld",
                format!("worlds[{index}].id"),
                format!(
                    "world `{}` (`{}`) is listed by the project but not loaded",
                    entry.id, entry.path
                ),
            ));
        }
    }

    for (index, entry) in project.tile_sets.iter().enumerate() {
        if !loaded_tile_set_ids.iter().any(|id| id == &entry.id) {
            issues.push(ValidationIssue::error(
                "project.unloadedTileSet",
                format!("tileSets[{index}].id"),
                format!(
                    "tile set `{}` (`{}`) is listed by the project but not loaded",
                    entry.id, entry.path
                ),
            ));
        }
    }

    if !project
        .worlds
        .iter()
        .any(|entry| entry.id == project.start_world)
    {
        issues.push(ValidationIssue::error(
            "project.unknownStartWorld",
            "startWorld",
            format!(
                "startWorld `{}` is not among the project's worlds",
                project.start_world
            ),
        ));
    }

    ValidationReport::from_issues(issues)
}

/// Whether the cell at `at` can be stood on, as far as the tile set says.
fn tile_at_is_passable(
    world: &WorldDefinition,
    tile_set: &TileSetDefinition,
    at: OffsetCoord,
) -> bool {
    let tile_id = world
        .tiles
        .iter()
        .find(|placed| placed.at == at)
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
    fn elevation_outside_a_signed_byte_is_an_error() {
        let mut world = testing::sample_world();
        world.tiles[1].elevation = MAX_ELEVATION + 1;
        let report = validate_world(
            &world,
            Some(&testing::sample_tile_set()),
            &TemplateRegistry::builtin(),
        );
        assert!(!report.valid);
        assert!(codes(&report).contains(&"tile.elevationOutOfRange"));

        world.tiles[1].elevation = MIN_ELEVATION;
        let report = validate_world(
            &world,
            Some(&testing::sample_tile_set()),
            &TemplateRegistry::builtin(),
        );
        assert!(
            report.valid,
            "the bounds themselves are legal: {:?}",
            report.issues
        );
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

    // ------------------------------------------------------------------ links

    fn validate_linked(world: &WorldDefinition) -> ValidationReport {
        validate_world(
            world,
            Some(&testing::sample_tile_set()),
            &TemplateRegistry::builtin(),
        )
    }

    #[test]
    fn a_world_with_a_link_is_valid_on_its_own() {
        // The target lives in another file, so a single-world pass must not
        // complain about it — that is `validate_project_links`' job.
        let report = validate_linked(&testing::linked_world());
        assert!(report.valid, "unexpected issues: {:?}", report.issues);
    }

    #[test]
    fn links_outside_the_map_or_on_impassable_tiles_are_errors() {
        let mut world = testing::linked_world();
        world.links[0].at = OffsetCoord::new(99, 0);
        assert!(codes(&validate_linked(&world)).contains(&"link.outOfBounds"));

        let mut world = testing::linked_world();
        world.links[0].at = testing::WATER_CELL;
        assert!(codes(&validate_linked(&world)).contains(&"link.onImpassableTile"));
    }

    #[test]
    fn duplicate_link_ids_and_positions_are_errors() {
        let mut world = testing::linked_world();
        let duplicate = world.links[0].clone();
        world.links.push(duplicate);
        let report = validate_linked(&world);
        assert!(codes(&report).contains(&"link.duplicateId"));
        assert!(codes(&report).contains(&"link.duplicatePosition"));
    }

    #[test]
    fn a_self_link_has_its_arrival_checked_immediately() {
        let mut world = testing::linked_world();
        world.links[0].target_world = world.id.clone();
        world.links[0].target_at = OffsetCoord::new(50, 50);
        assert!(codes(&validate_linked(&world)).contains(&"link.targetOutOfBounds"));
    }

    #[test]
    fn a_missing_target_world_and_a_reserved_trigger_are_errors() {
        let mut world = testing::linked_world();
        world.links[0].target_world = String::new();
        assert!(codes(&validate_linked(&world)).contains(&"link.missingTarget"));

        let mut world = testing::linked_world();
        world.links[0].trigger = LinkTrigger::Interact;
        assert!(codes(&validate_linked(&world)).contains(&"link.unsupportedTrigger"));
    }

    #[test]
    fn project_links_resolve_when_every_world_is_loaded() {
        let tile_set = testing::sample_tile_set();
        let worlds = [testing::linked_world(), testing::interior_world()];
        let report =
            validate_project_links(worlds.iter(), |id| (id == tile_set.id).then_some(&tile_set));
        assert!(report.valid, "unexpected issues: {:?}", report.issues);
    }

    #[test]
    fn a_link_to_a_world_that_is_not_loaded_is_an_error() {
        let tile_set = testing::sample_tile_set();
        let worlds = [testing::linked_world()];
        let report =
            validate_project_links(worlds.iter(), |id| (id == tile_set.id).then_some(&tile_set));
        assert!(!report.valid);
        assert!(codes(&report).contains(&"link.unknownTargetWorld"));
    }

    #[test]
    fn a_link_arriving_outside_or_inside_a_wall_is_an_error() {
        let tile_set = testing::sample_tile_set();
        let lookup = |id: &str| (id == tile_set.id).then_some(&tile_set);

        let mut linked = testing::linked_world();
        linked.links[0].target_at = OffsetCoord::new(9, 9);
        let worlds = [linked, testing::interior_world()];
        assert!(codes(&validate_project_links(worlds.iter(), lookup))
            .contains(&"link.targetOutOfBounds"));

        let mut linked = testing::linked_world();
        let mut interior = testing::interior_world();
        interior.tiles.push(crate::definition::PlacedTile {
            at: OffsetCoord::new(1, 1),
            tile: "water".to_owned(),
            elevation: 0,
            tags: Vec::new(),
        });
        linked.links[0].target_at = OffsetCoord::new(1, 1);
        let worlds = [linked, interior];
        assert!(codes(&validate_project_links(worlds.iter(), lookup))
            .contains(&"link.targetImpassable"));
    }

    #[test]
    fn a_link_arriving_on_an_authored_entity_is_an_error() {
        // The arriving player takes the cell it lands on, so a monster standing
        // there would end up sharing a hex with it.
        let tile_set = testing::sample_tile_set();
        let lookup = |id: &str| (id == tile_set.id).then_some(&tile_set);

        let mut interior = testing::interior_world();
        interior.entities.push(crate::definition::EntityDefinition {
            id: "monster_1".to_owned(),
            template_id: "monster".to_owned(),
            at: testing::INTERIOR_ARRIVAL,
            tags: Vec::new(),
            properties: Default::default(),
        });

        let worlds = [testing::linked_world(), interior];
        assert!(
            codes(&validate_project_links(worlds.iter(), lookup)).contains(&"link.targetOccupied")
        );
    }

    // --------------------------------------------------------------- projects

    fn project() -> ProjectDefinition {
        ProjectDefinition {
            id: "demo".to_owned(),
            schema_version: PROJECT_SCHEMA_VERSION,
            name: "Demo".to_owned(),
            start_world: "linked_world".to_owned(),
            zones: vec![crate::project::ZoneDefinition {
                id: "valley".to_owned(),
                name: "Valley".to_owned(),
            }],
            tile_sets: vec![crate::project::ContentRef {
                id: "mvp_terrain".to_owned(),
                path: "tilesets/mvp_terrain.json".to_owned(),
            }],
            worlds: vec![
                crate::project::ContentRef {
                    id: "linked_world".to_owned(),
                    path: "worlds/linked_world.json".to_owned(),
                },
                crate::project::ContentRef {
                    id: "interior_world".to_owned(),
                    path: "worlds/interior_world.json".to_owned(),
                },
            ],
        }
    }

    fn loaded() -> (Vec<String>, Vec<String>) {
        (
            vec!["linked_world".to_owned(), "interior_world".to_owned()],
            vec!["mvp_terrain".to_owned()],
        )
    }

    #[test]
    fn a_project_listing_loaded_content_is_valid() {
        let (worlds, tile_sets) = loaded();
        let report = validate_project(&project(), &worlds, &tile_sets);
        assert!(report.valid, "unexpected issues: {:?}", report.issues);
    }

    #[test]
    fn a_project_start_world_must_be_one_of_its_worlds() {
        let (worlds, tile_sets) = loaded();
        let mut project = project();
        project.start_world = "elsewhere".to_owned();
        assert!(codes(&validate_project(&project, &worlds, &tile_sets))
            .contains(&"project.unknownStartWorld"));
    }

    #[test]
    fn a_project_referencing_content_that_never_loaded_is_an_error() {
        let mut project = project();
        project.worlds.push(crate::project::ContentRef {
            id: "ghost".to_owned(),
            path: "worlds/ghost.json".to_owned(),
        });
        let (worlds, tile_sets) = loaded();
        let report = validate_project(&project, &worlds, &tile_sets);
        assert!(codes(&report).contains(&"project.unloadedWorld"));

        project.worlds.pop();
        project.tile_sets[0].id = "absent".to_owned();
        assert!(codes(&validate_project(&project, &worlds, &tile_sets))
            .contains(&"project.unloadedTileSet"));
    }

    #[test]
    fn a_zone_declared_twice_or_without_an_id_is_an_error() {
        let (worlds, tile_sets) = loaded();
        let mut project = project();
        project.zones.push(crate::project::ZoneDefinition {
            id: "valley".to_owned(),
            name: "Valley Again".to_owned(),
        });
        project.zones.push(crate::project::ZoneDefinition {
            id: "  ".to_owned(),
            name: "Nameless".to_owned(),
        });

        let report = validate_project(&project, &worlds, &tile_sets);
        assert!(codes(&report).contains(&"project.duplicateZone"));
        assert!(codes(&report).contains(&"project.missingZoneId"));
    }

    /**
     * A zone id means nothing without the project that declares it, so this is
     * the check no single world file can make — the mirror of a map link's
     * `unknownTargetWorld`.
     */
    #[test]
    fn a_world_in_a_zone_the_project_does_not_declare_is_an_error() {
        let project = project();
        let mut world = crate::testing::sample_world();

        // No zone: the map belongs to the project's default one.
        assert!(validate_project_zones(&project, [&world]).valid);

        world.zone = "valley".to_owned();
        assert!(validate_project_zones(&project, [&world]).valid);

        world.zone = "caves".to_owned();
        let report = validate_project_zones(&project, [&world]);
        assert!(!report.valid);
        assert!(codes(&report).contains(&"world.unknownZone"));
    }

    #[test]
    fn a_project_declaring_no_zones_accepts_only_the_default_one() {
        use crate::project::DEFAULT_ZONE_ID;

        let mut project = project();
        project.zones.clear();
        let mut world = crate::testing::sample_world();

        world.zone = DEFAULT_ZONE_ID.to_owned();
        assert!(validate_project_zones(&project, [&world]).valid);

        world.zone = "valley".to_owned();
        assert!(!validate_project_zones(&project, [&world]).valid);
    }
}
