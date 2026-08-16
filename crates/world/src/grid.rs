//! The resolved runtime view of an authored world.
//!
//! [`WorldGrid`] flattens a sparse [`WorldDefinition`] plus its
//! [`TileSetDefinition`] into two compact structures:
//!
//! * a palette of [`ResolvedTile`]s, and
//! * one `u8` palette index per cell, row-major in offset coordinates.
//!
//! The index buffer is handed to JavaScript as a single `Uint8Array`, so
//! rendering a 2048x2048 map costs exactly one boundary crossing instead of
//! four million (see `CLAUDE.md`, "Performance").

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::definition::WorldDefinition;
use crate::hex::{Hex, OffsetCoord};
use crate::tileset::TileSetDefinition;

/// Failure modes of [`WorldGrid::build`].
///
/// These are "should never happen after validation" conditions; callers are
/// expected to run [`crate::validate_world`] first.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum GridError {
    /// The world references a tile the palette does not define.
    #[error("tile `{tile}` referenced by the world is not defined by tile set `{tile_set}`")]
    UnknownTile {
        /// Referenced tile id.
        tile: String,
        /// Tile set that was searched.
        tile_set: String,
    },
    /// A painted cell lies outside `width x height`.
    #[error("tile position {at} is outside the {width}x{height} map")]
    OutOfBounds {
        /// The offending position.
        at: OffsetCoord,
        /// Map width.
        width: u32,
        /// Map height.
        height: u32,
    },
    /// The palette does not fit in a `u8`.
    #[error("tile set `{tile_set}` defines {count} tiles; at most 256 are supported")]
    PaletteTooLarge {
        /// Tile set that was too large.
        tile_set: String,
        /// Number of tiles it defines.
        count: usize,
    },
    /// `width` or `height` is zero.
    #[error("world dimensions must be greater than zero")]
    EmptyMap,
}

/// A palette entry, flattened for the runtime and for the renderer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTile {
    /// Stable tile id.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Terrain family.
    pub terrain: String,
    /// Cost of entering; `0` means impassable.
    pub movement_cost: u32,
    /// Convenience flag derived from `movement_cost`.
    pub passable: bool,
    /// Stable visual id resolved by the renderer.
    pub visual_id: String,
    /// Colour drawn when no sprite is registered for `visual_id`.
    pub fallback_color: String,
    /// Gameplay tags.
    pub tags: Vec<String>,
}

/// A dense, index-addressable world map.
#[derive(Debug, Clone, PartialEq)]
pub struct WorldGrid {
    width: u32,
    height: u32,
    palette: Vec<ResolvedTile>,
    /// One palette index per cell, row-major in offset coordinates.
    cells: Vec<u8>,
}

impl WorldGrid {
    /// Flattens `world` against `tile_set`.
    ///
    /// # Errors
    ///
    /// Returns a [`GridError`] when the world references an unknown tile, paints
    /// outside its own bounds, or the palette exceeds 256 entries. Running
    /// [`crate::validate_world`] first turns all of these into structured
    /// validation issues instead.
    pub fn build(world: &WorldDefinition, tile_set: &TileSetDefinition) -> Result<Self, GridError> {
        if world.width == 0 || world.height == 0 {
            return Err(GridError::EmptyMap);
        }
        if tile_set.tiles.len() > usize::from(u8::MAX) + 1 {
            return Err(GridError::PaletteTooLarge {
                tile_set: tile_set.id.clone(),
                count: tile_set.tiles.len(),
            });
        }

        let palette: Vec<ResolvedTile> = tile_set
            .tiles
            .iter()
            .map(|tile| ResolvedTile {
                id: tile.id.clone(),
                name: tile.name.clone(),
                terrain: tile.terrain.clone(),
                movement_cost: tile.movement_cost,
                passable: tile.is_passable(),
                visual_id: tile.visual.visual_id.clone(),
                fallback_color: tile.visual.fallback_color.clone(),
                tags: tile.tags.clone(),
            })
            .collect();

        let index_of = |tile_id: &str| -> Result<u8, GridError> {
            palette
                .iter()
                .position(|tile| tile.id == tile_id)
                .map(|index| index as u8)
                .ok_or_else(|| GridError::UnknownTile {
                    tile: tile_id.to_owned(),
                    tile_set: tile_set.id.clone(),
                })
        };

        let default_index = index_of(&world.default_tile)?;
        let mut cells = vec![default_index; world.cell_count()];

        for placed in &world.tiles {
            let cell =
                placed
                    .at
                    .index_in(world.width, world.height)
                    .ok_or(GridError::OutOfBounds {
                        at: placed.at,
                        width: world.width,
                        height: world.height,
                    })?;
            cells[cell] = index_of(&placed.tile)?;
        }

        Ok(Self {
            width: world.width,
            height: world.height,
            palette,
            cells,
        })
    }

    /// Map width in columns.
    #[must_use]
    pub const fn width(&self) -> u32 {
        self.width
    }

    /// Map height in rows.
    #[must_use]
    pub const fn height(&self) -> u32 {
        self.height
    }

    /// The tile palette, indexed by the values in [`cells`](Self::cells).
    #[must_use]
    pub fn palette(&self) -> &[ResolvedTile] {
        &self.palette
    }

    /// The packed palette indices, row-major in offset coordinates.
    #[must_use]
    pub fn cells(&self) -> &[u8] {
        &self.cells
    }

    /// Returns `true` when `hex` lies inside the map.
    #[must_use]
    pub fn contains(&self, hex: Hex) -> bool {
        hex.to_offset().is_within(self.width, self.height)
    }

    /// Returns the tile at `hex`, or `None` when out of bounds.
    #[must_use]
    pub fn tile_at(&self, hex: Hex) -> Option<&ResolvedTile> {
        let index = hex.to_offset().index_in(self.width, self.height)?;
        self.palette.get(usize::from(self.cells[index]))
    }

    /// Returns whether `hex` is inside the map and its tile can be entered.
    #[must_use]
    pub fn is_passable(&self, hex: Hex) -> bool {
        self.tile_at(hex).is_some_and(|tile| tile.passable)
    }

    /// Returns the movement cost of `hex`, or `None` when out of bounds.
    #[must_use]
    pub fn movement_cost(&self, hex: Hex) -> Option<u32> {
        self.tile_at(hex).map(|tile| tile.movement_cost)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing;

    #[test]
    fn unlisted_cells_fall_back_to_the_default_tile() {
        let world = testing::sample_world();
        let grid = WorldGrid::build(&world, &testing::sample_tile_set()).expect("build");

        assert_eq!(grid.width(), world.width);
        assert_eq!(grid.height(), world.height);
        assert_eq!(grid.cells().len(), world.cell_count());

        let untouched = Hex::from_offset(OffsetCoord::new(0, 0));
        assert_eq!(
            grid.tile_at(untouched).map(|tile| tile.id.as_str()),
            Some("grass")
        );
    }

    #[test]
    fn painted_cells_override_the_default() {
        let world = testing::sample_world();
        let grid = WorldGrid::build(&world, &testing::sample_tile_set()).expect("build");
        let painted = Hex::from_offset(world.tiles[0].at);
        assert_eq!(
            grid.tile_at(painted).map(|tile| tile.id.as_str()),
            Some(world.tiles[0].tile.as_str())
        );
    }

    #[test]
    fn water_is_impassable_and_grass_is_not() {
        let world = testing::sample_world();
        let grid = WorldGrid::build(&world, &testing::sample_tile_set()).expect("build");

        let water = Hex::from_offset(testing::WATER_CELL);
        assert!(!grid.is_passable(water));
        assert_eq!(grid.movement_cost(water), Some(0));

        let grass = Hex::from_offset(OffsetCoord::new(0, 0));
        assert!(grid.is_passable(grass));
        assert_eq!(grid.movement_cost(grass), Some(1));
    }

    #[test]
    fn out_of_bounds_lookups_return_none() {
        let grid =
            WorldGrid::build(&testing::sample_world(), &testing::sample_tile_set()).expect("build");
        let outside = Hex::from_offset(OffsetCoord::new(-1, 0));
        assert!(!grid.contains(outside));
        assert!(grid.tile_at(outside).is_none());
        assert!(!grid.is_passable(outside));
        assert_eq!(grid.movement_cost(outside), None);
    }

    #[test]
    fn unknown_tile_reference_is_reported() {
        let mut world = testing::sample_world();
        world.default_tile = "lava".into();
        let error = WorldGrid::build(&world, &testing::sample_tile_set()).expect_err("should fail");
        assert!(matches!(error, GridError::UnknownTile { .. }));
    }

    #[test]
    fn packed_cells_are_row_major_in_offset_space() {
        let world = testing::sample_world();
        let grid = WorldGrid::build(&world, &testing::sample_tile_set()).expect("build");
        let water_index = testing::WATER_CELL
            .index_in(world.width, world.height)
            .expect("water cell inside map");
        let palette_index = usize::from(grid.cells()[water_index]);
        assert_eq!(grid.palette()[palette_index].id, "water");
    }
}
