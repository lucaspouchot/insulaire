//! Shared content fixtures.
//!
//! Enabled by the `testing` feature so that `insulaire-simulation` and `insulaire-engine`
//! can build their tests on the same small world instead of each inventing one.
//! The feature is off by default, so none of this reaches the WASM bundle.

use crate::definition::{
    EntityDefinition, HexOrientation, LinkTrigger, LocationDefinition, MapLinkDefinition,
    PlacedTile, ProjectionMode, WorldDefinition, WorldMetadata, WORLD_SCHEMA_VERSION,
};
use crate::hex::OffsetCoord;
use crate::tile_art::{
    ElevationLevel, ElevationRepeat, TileArt, TileArtGeometry, TileArtVariant, TileElevation,
};
use crate::tileset::{TileDefinition, TileSetDefinition, TileVisual, TILE_SET_SCHEMA_VERSION};

/// The single impassable cell in [`sample_world`].
pub const WATER_CELL: OffsetCoord = OffsetCoord::new(4, 4);

/// Where [`sample_world`] places the player.
pub const PLAYER_START: OffsetCoord = OffsetCoord::new(2, 2);

/// Where [`sample_world`] places the monster.
pub const MONSTER_START: OffsetCoord = OffsetCoord::new(7, 2);

/// The single raised cell in [`sample_world`], used to exercise elevation.
pub const RAISED_CELL: OffsetCoord = OffsetCoord::new(6, 6);

/// Elevation of [`RAISED_CELL`].
pub const RAISED_ELEVATION: i32 = 3;

fn tile(id: &str, terrain: &str, movement_cost: u32, color: &str) -> TileDefinition {
    TileDefinition {
        id: id.to_owned(),
        name: id.to_owned(),
        terrain: terrain.to_owned(),
        movement_cost,
        tags: Vec::new(),
        visual: TileVisual {
            visual_id: format!("terrain.{id}"),
            fallback_color: color.to_owned(),
            hints: Default::default(),
        },
        art: TileArt::default(),
    }
}

/// Two surface variants, one explicit elevation level and a repeat rule.
///
/// Enough for a downstream test to exercise the whole of
/// `docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md` without
/// rebuilding a tile set by hand.
fn sample_art() -> TileArt {
    TileArt {
        surface: vec![
            TileArtVariant {
                id: "a".to_owned(),
                asset: "assets/tiles/rock_surface_a.png".to_owned(),
            },
            TileArtVariant {
                id: "b".to_owned(),
                asset: "assets/tiles/rock_surface_b.png".to_owned(),
            },
        ],
        elevation: TileElevation {
            levels: vec![ElevationLevel {
                name: String::new(),
                variants: vec![TileArtVariant {
                    id: "a".to_owned(),
                    asset: "assets/tiles/rock_cliff_a.png".to_owned(),
                }],
            }],
            repeat: Some(ElevationRepeat::Level(1)),
        },
    }
}

/// A three-tile palette: passable grass and rock, impassable water.
#[must_use]
pub fn sample_tile_set() -> TileSetDefinition {
    TileSetDefinition {
        id: "mvp_terrain".to_owned(),
        schema_version: TILE_SET_SCHEMA_VERSION,
        name: "MVP Terrain".to_owned(),
        art: TileArtGeometry::default(),
        tiles: vec![
            tile("grass", "grass", 1, "#4f7a3a"),
            TileDefinition {
                art: sample_art(),
                ..tile("rock", "rock", 2, "#7a7169")
            },
            tile("water", "water", 0, "#1d4e79"),
        ],
    }
}

/// A 10x10 world with one water cell, one raised rock, one player, one monster.
#[must_use]
pub fn sample_world() -> WorldDefinition {
    WorldDefinition {
        id: "sample_world".to_owned(),
        schema_version: WORLD_SCHEMA_VERSION,
        name: "Sample World".to_owned(),
        zone: String::new(),
        width: 10,
        height: 10,
        orientation: HexOrientation::Pointy,
        projection: ProjectionMode::TopDown,
        tile_set_id: "mvp_terrain".to_owned(),
        default_tile: "grass".to_owned(),
        tiles: vec![
            PlacedTile {
                at: WATER_CELL,
                tile: "water".to_owned(),
                elevation: 0,
                tags: Vec::new(),
            },
            PlacedTile {
                at: RAISED_CELL,
                tile: "rock".to_owned(),
                elevation: RAISED_ELEVATION,
                tags: Vec::new(),
            },
        ],
        entities: vec![
            EntityDefinition {
                id: "player_1".to_owned(),
                template_id: "player".to_owned(),
                at: PLAYER_START,
                tags: Vec::new(),
                properties: Default::default(),
            },
            EntityDefinition {
                id: "monster_1".to_owned(),
                template_id: "monster".to_owned(),
                at: MONSTER_START,
                tags: Vec::new(),
                properties: Default::default(),
            },
        ],
        locations: vec![LocationDefinition {
            id: "loc_camp".to_owned(),
            at: OffsetCoord::new(1, 1),
            name: "Camp".to_owned(),
            tags: vec!["start".to_owned()],
        }],
        links: Vec::new(),
        metadata: WorldMetadata::default(),
    }
}

/// Where [`linked_world`] puts the door leading to [`interior_world`].
pub const DOOR_CELL: OffsetCoord = OffsetCoord::new(3, 2);

/// Where a player entering [`interior_world`] through the door arrives.
pub const INTERIOR_ARRIVAL: OffsetCoord = OffsetCoord::new(1, 1);

/// [`sample_world`] with a door on [`DOOR_CELL`] leading to [`interior_world`].
///
/// The door sits next to the player start, so one legal move reaches it.
#[must_use]
pub fn linked_world() -> WorldDefinition {
    let mut world = sample_world();
    world.id = "linked_world".to_owned();
    world.links = vec![MapLinkDefinition {
        id: "door_house".to_owned(),
        at: DOOR_CELL,
        target_world: "interior_world".to_owned(),
        target_at: INTERIOR_ARRIVAL,
        trigger: LinkTrigger::Enter,
        name: "House".to_owned(),
        tags: Vec::new(),
    }];
    world
}

/// A small interior map, the target of [`linked_world`]'s door.
///
/// It carries its own player start — every map stays independently playable
/// (`docs/adr/ADR-0017-map-links.md`) — plus a link back out.
#[must_use]
pub fn interior_world() -> WorldDefinition {
    let mut world = sample_world();
    world.id = "interior_world".to_owned();
    world.name = "Interior".to_owned();
    world.width = 5;
    world.height = 5;
    world.tiles = Vec::new();
    world.locations = Vec::new();
    world.entities = vec![EntityDefinition {
        id: "player_1".to_owned(),
        template_id: "player".to_owned(),
        at: OffsetCoord::new(2, 2),
        tags: Vec::new(),
        properties: Default::default(),
    }];
    world.links = vec![MapLinkDefinition {
        id: "door_out".to_owned(),
        at: OffsetCoord::new(0, 0),
        target_world: "linked_world".to_owned(),
        target_at: PLAYER_START,
        trigger: LinkTrigger::Enter,
        name: "Outside".to_owned(),
        tags: Vec::new(),
    }];
    world
}

/// A world with a wall of water separating the player from the monster.
///
/// Used to check that blocked chasers hold their position instead of walking
/// into impassable terrain.
#[must_use]
pub fn walled_world() -> WorldDefinition {
    let mut world = sample_world();
    world.id = "walled_world".to_owned();
    world.entities[0].at = OffsetCoord::new(1, 3);
    world.entities[1].at = OffsetCoord::new(5, 3);
    world.tiles = (0..10)
        .map(|row| PlacedTile {
            at: OffsetCoord::new(3, row),
            tile: "water".to_owned(),
            elevation: 0,
            tags: Vec::new(),
        })
        .collect();
    world
}
