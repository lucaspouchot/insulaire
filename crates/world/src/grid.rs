//! The resolved runtime view of an authored world.
//!
//! [`WorldGrid`] flattens a sparse [`WorldDefinition`] plus its
//! [`TileSetDefinition`] into three compact structures:
//!
//! * a palette of [`ResolvedTile`]s,
//! * one `u8` palette index per cell, row-major in offset coordinates, and
//! * one `i8` elevation per cell, in the same layout.
//!
//! Both buffers are handed to JavaScript whole — as a `Uint8Array` and an
//! `Int8Array` — so rendering a 2048x2048 map costs two boundary crossings
//! instead of eight million (see `CLAUDE.md`, "Performance").
//!
//! Cells that **choose** their art rather than rolling it are the fourth
//! structure, and the only sparse one: they are authored exceptions, a handful
//! on a map of millions, so they travel as a sorted list of
//! [`CellArtChoice`] rather than three more buffers nobody would fill
//! (`docs/adr/ADR-0036-a-cell-may-choose-its-tile-art.md`). Resolving the ids
//! an author wrote into the indices a renderer wants happens **here**, once per
//! load, so no draw call ever searches a variant list by name.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::definition::{PlacedTileArt, WorldDefinition, MAX_ELEVATION, MIN_ELEVATION};
use crate::hex::{Hex, OffsetCoord};
use crate::tile_art::{CellArt, TileArt};
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
    /// The images this tile is drawn from, carried through to the renderer.
    pub art: TileArt,
}

impl ResolvedTile {
    /// The palette entry a tile flattens to.
    ///
    /// Public because a palette is also what [`resolve_cell_art`] resolves ids
    /// against, and the asset editor's preview has a tile set but no world.
    #[must_use]
    pub fn of(tile: &crate::tileset::TileDefinition) -> Self {
        Self {
            id: tile.id.clone(),
            name: tile.name.clone(),
            terrain: tile.terrain.clone(),
            movement_cost: tile.movement_cost,
            passable: tile.is_passable(),
            visual_id: tile.visual.visual_id.clone(),
            fallback_color: tile.visual.fallback_color.clone(),
            tags: tile.tags.clone(),
            art: tile.art.clone(),
        }
    }
}

/// One cell's art choice, with every authored id already resolved.
///
/// The file names variants and tiles by id, because that is what an author
/// reads; a renderer wants indices, and turning one into the other is a search
/// no draw call should ever do. So it happens once, when the grid is built, and
/// an id that resolves to nothing simply leaves its field unset — the cell then
/// rolls that choice as it always would, and validation reports the dangling
/// reference separately rather than the picture breaking
/// (`docs/adr/ADR-0036-a-cell-may-choose-its-tile-art.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellArtChoice {
    /// Row-major cell index, the same layout as [`WorldGrid::cells`].
    pub cell: u32,
    /// Index into the cell's own tile's surface variants — or its flat ones,
    /// whichever the world's projection draws from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<u32>,
    /// Palette index of the tile whose elevation ladder cuts the faces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elevation_tile: Option<u32>,
    /// Index into the variants of whichever level ends up drawing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elevation: Option<u32>,
}

impl CellArtChoice {
    /// `true` when nothing was resolved, so the cell rolls everything.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.surface.is_none() && self.elevation_tile.is_none() && self.elevation.is_none()
    }

    /// The choice as [`crate::resolve_tile_render`] wants it.
    ///
    /// The one place a borrowed elevation ladder becomes a borrowed
    /// [`TileArt`]; `palette` must be the one the indices were resolved
    /// against.
    #[must_use]
    pub fn against<'a>(&self, palette: &'a [ResolvedTile]) -> CellArt<'a> {
        CellArt {
            surface: self.surface.map(|index| index as usize),
            elevation: self
                .elevation_tile
                .and_then(|index| palette.get(index as usize))
                .map(|tile| &tile.art),
            elevation_variant: self.elevation.map(|index| index as usize),
        }
    }
}

/// A dense, index-addressable world map.
#[derive(Debug, Clone, PartialEq)]
pub struct WorldGrid {
    width: u32,
    height: u32,
    palette: Vec<ResolvedTile>,
    /// One palette index per cell, row-major in offset coordinates.
    cells: Vec<u8>,
    /// One elevation per cell, in the same layout as [`cells`](Self::cells).
    elevations: Vec<i8>,
    /// The cells that chose their art, sorted by [`CellArtChoice::cell`].
    art_choices: Vec<CellArtChoice>,
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

        let palette: Vec<ResolvedTile> = tile_set.tiles.iter().map(ResolvedTile::of).collect();

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
        let mut elevations = vec![0_i8; world.cell_count()];
        let mut art_choices = Vec::new();

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
            let tile_index = index_of(&placed.tile)?;
            cells[cell] = tile_index;
            // Validation rejects anything outside the byte range; clamping here
            // keeps an unvalidated definition from silently wrapping around.
            elevations[cell] = placed.elevation.clamp(MIN_ELEVATION, MAX_ELEVATION) as i8;

            if !placed.art.is_empty() {
                let choice = CellArtChoice {
                    cell: u32::try_from(cell).unwrap_or(u32::MAX),
                    ..resolve_cell_art(&palette, &placed.tile, &placed.art)
                };
                if !choice.is_empty() {
                    art_choices.push(choice);
                }
            }
        }

        // Sorted, so a lookup is a binary search and two builds of the same
        // world produce the same grid whatever order the file listed its cells.
        art_choices.sort_unstable_by_key(|choice| choice.cell);

        Ok(Self {
            width: world.width,
            height: world.height,
            palette,
            cells,
            elevations,
            art_choices,
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

    /// The packed elevations, in the same layout as [`cells`](Self::cells).
    ///
    /// Presentation only: the renderer lifts a cell by this much in isometric
    /// mode (`docs/adr/ADR-0016-isometric-projection.md`). No rule reads it.
    #[must_use]
    pub fn elevations(&self) -> &[i8] {
        &self.elevations
    }

    /// Every cell that chose its art, sorted by cell index.
    ///
    /// Sparse on purpose: choosing is the exception, and three more dense
    /// buffers would be three more megabytes of zeroes per million cells.
    #[must_use]
    pub fn art_choices(&self) -> &[CellArtChoice] {
        &self.art_choices
    }

    /// What `hex` chose, or `None` when it rolls everything.
    #[must_use]
    pub fn art_choice_at(&self, hex: Hex) -> Option<CellArtChoice> {
        let index = u32::try_from(hex.to_offset().index_in(self.width, self.height)?).ok()?;
        self.art_choices
            .binary_search_by_key(&index, |choice| choice.cell)
            .ok()
            .and_then(|at| self.art_choices.get(at).copied())
    }

    /// What to draw `hex` with: its choice, resolved against the palette, ready
    /// for [`crate::resolve_tile_render`].
    #[must_use]
    pub fn cell_art_at(&self, hex: Hex) -> CellArt<'_> {
        self.art_choice_at(hex)
            .map_or_else(CellArt::default, |choice| choice.against(&self.palette))
    }

    /// The elevation at `hex`, or `None` when out of bounds.
    #[must_use]
    pub fn elevation_at(&self, hex: Hex) -> Option<i8> {
        let index = hex.to_offset().index_in(self.width, self.height)?;
        self.elevations.get(index).copied()
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

/// Turns one cell's authored ids into indices against `palette`.
///
/// Total by construction: an id nobody defined resolves to `None`, which is the
/// same as not having chosen. The author is told by validation
/// (`tile.unknownSurfaceVariant` and friends), not by a hole in the map.
///
/// The returned [`CellArtChoice::cell`] is `0`: this resolves *what*, not
/// *where*, so a caller with a cell index fills that in.
#[must_use]
pub fn resolve_cell_art(
    palette: &[ResolvedTile],
    tile_id: &str,
    art: &PlacedTileArt,
) -> CellArtChoice {
    let own = palette.iter().find(|tile| tile.id == tile_id);
    // One index serves both projections, so the search falls through to the
    // flat list for a tile that only draws top-down; a set that ships both
    // gives them the same ids and the two lookups agree
    // (`docs/adr/ADR-0037-a-flat-map-is-drawn-from-flat-art.md`).
    let surface = if art.surface.is_empty() {
        None
    } else {
        own.and_then(|tile| index_of_variant(&tile.art.surface, &art.surface))
            .or_else(|| own.and_then(|tile| index_of_variant(&tile.art.flat, &art.surface)))
    };

    let elevation_tile = if art.elevation_tile.is_empty() {
        None
    } else {
        palette
            .iter()
            .position(|tile| tile.id == art.elevation_tile)
            .and_then(|index| u32::try_from(index).ok())
    };

    // The named variant is looked up in the ladder that will actually draw —
    // the borrowed one when there is one — because that is where the id has to
    // mean something.
    let ladder = elevation_tile
        .and_then(|index| palette.get(index as usize))
        .or(own);
    let elevation = if art.elevation.is_empty() {
        None
    } else {
        ladder.and_then(|tile| {
            tile.art
                .elevation
                .levels
                .iter()
                .find_map(|level| index_of_variant(&level.variants, &art.elevation))
        })
    };

    CellArtChoice {
        cell: 0,
        surface,
        elevation_tile,
        elevation,
    }
}

/// The position of `id` in a variant list.
fn index_of_variant(variants: &[crate::tile_art::TileArtVariant], id: &str) -> Option<u32> {
    variants
        .iter()
        .position(|variant| variant.id == id)
        .and_then(|index| u32::try_from(index).ok())
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
    fn elevation_defaults_to_zero_and_follows_the_painted_cell() {
        let world = testing::sample_world();
        let grid = WorldGrid::build(&world, &testing::sample_tile_set()).expect("build");

        assert_eq!(grid.elevations().len(), world.cell_count());
        assert_eq!(
            grid.elevation_at(Hex::from_offset(testing::RAISED_CELL)),
            Some(testing::RAISED_ELEVATION as i8)
        );
        assert_eq!(
            grid.elevation_at(Hex::from_offset(OffsetCoord::new(0, 0))),
            Some(0)
        );
        assert_eq!(
            grid.elevation_at(Hex::from_offset(OffsetCoord::new(-1, 0))),
            None
        );
    }

    #[test]
    fn elevation_beyond_a_byte_is_clamped_rather_than_wrapped() {
        // Validation rejects this world; `build` must still not wrap 300 to 44.
        let mut world = testing::sample_world();
        world.tiles[1].elevation = 300;
        let grid = WorldGrid::build(&world, &testing::sample_tile_set()).expect("build");
        assert_eq!(
            grid.elevation_at(Hex::from_offset(testing::RAISED_CELL)),
            Some(i8::MAX)
        );
    }

    /// A meadow that authors surfaces only, over a cliff that authors a ladder.
    ///
    /// The shared fixture gives its art to `rock` alone, and the whole point of
    /// a choice is one tile's top face over another tile's cut — so this test
    /// group builds the pair it needs rather than bending the fixture around it.
    fn choosing_set() -> TileSetDefinition {
        let mut set = testing::sample_tile_set();
        let grass = set
            .tiles
            .iter_mut()
            .find(|tile| tile.id == "grass")
            .expect("grass is in the sample set");
        grass.art = TileArt {
            flat: Vec::new(),
            surface: vec![
                crate::tile_art::TileArtVariant {
                    id: "a".to_owned(),
                    asset: "assets/tiles/grass/surfaces/grass_a.png".to_owned(),
                },
                crate::tile_art::TileArtVariant {
                    id: "b".to_owned(),
                    asset: "assets/tiles/grass/surfaces/grass_b.png".to_owned(),
                },
            ],
            elevation: crate::tile_art::TileElevation::default(),
        };
        set
    }

    #[test]
    fn a_cell_that_chooses_nothing_costs_no_entry() {
        let grid = WorldGrid::build(&testing::sample_world(), &choosing_set()).expect("build");
        assert!(grid.art_choices().is_empty());
        assert_eq!(
            grid.cell_art_at(Hex::from_offset(OffsetCoord::new(0, 0))),
            CellArt::default()
        );
    }

    #[test]
    fn authored_ids_are_resolved_to_indices_once() {
        let set = choosing_set();
        let mut world = testing::sample_world();
        let at = world.tiles[0].at;
        world.tiles[0].tile = "grass".into();
        world.tiles[0].art = PlacedTileArt {
            surface: "b".into(),
            elevation_tile: "rock".into(),
            elevation: "a".into(),
        };
        let grid = WorldGrid::build(&world, &set).expect("build");

        let rock = set
            .tiles
            .iter()
            .position(|tile| tile.id == "rock")
            .expect("rock is in the sample set") as u32;
        let choice = grid
            .art_choice_at(Hex::from_offset(at))
            .expect("the cell chose");
        assert_eq!(choice.surface, Some(1));
        assert_eq!(choice.elevation_tile, Some(rock));
        assert_eq!(choice.elevation, Some(0));

        // And the borrowed ladder comes back as the *other* tile's art, which
        // is the whole point: grass on top, rock underneath.
        let art = grid.cell_art_at(Hex::from_offset(at));
        assert_eq!(art.surface, Some(1));
        assert_eq!(art.elevation_variant, Some(0));
        assert_eq!(
            art.elevation,
            Some(&set.tiles[rock as usize].art),
            "the faces did not come from the borrowed tile"
        );
    }

    #[test]
    fn a_borrowed_variant_id_is_looked_up_in_the_borrowed_ladder() {
        // `grass` authors no ladder at all, so `elevation: "a"` can only mean
        // something in `rock`'s — which is the one that will draw.
        let mut world = testing::sample_world();
        let at = world.tiles[0].at;
        world.tiles[0].tile = "grass".into();
        world.tiles[0].art = PlacedTileArt {
            surface: String::new(),
            elevation_tile: "rock".into(),
            elevation: "a".into(),
        };
        let grid = WorldGrid::build(&world, &choosing_set()).expect("build");

        let choice = grid
            .art_choice_at(Hex::from_offset(at))
            .expect("the cell chose");
        assert_eq!(choice.elevation, Some(0));
    }

    #[test]
    fn an_id_nobody_defined_leaves_the_cell_rolling() {
        // Validation reports the dangling reference; the map still draws.
        let mut world = testing::sample_world();
        let at = world.tiles[0].at;
        world.tiles[0].art = PlacedTileArt {
            surface: "zz".into(),
            elevation_tile: "lava".into(),
            elevation: String::new(),
        };
        let grid = WorldGrid::build(&world, &choosing_set()).expect("build");

        assert!(grid.art_choices().is_empty());
        assert_eq!(grid.cell_art_at(Hex::from_offset(at)), CellArt::default());
    }

    #[test]
    fn choices_are_sorted_whatever_order_the_file_listed_them() {
        let mut world = testing::sample_world();
        for placed in &mut world.tiles {
            placed.tile = "grass".into();
            placed.art = PlacedTileArt {
                surface: "b".into(),
                ..PlacedTileArt::default()
            };
        }
        world.tiles.reverse();
        let grid = WorldGrid::build(&world, &choosing_set()).expect("build");

        assert!(grid.art_choices().len() > 1);
        assert!(grid
            .art_choices()
            .windows(2)
            .all(|pair| pair[0].cell < pair[1].cell));
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
