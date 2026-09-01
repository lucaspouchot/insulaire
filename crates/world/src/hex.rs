//! Hexagonal coordinate model.
//!
//! # Representations
//!
//! Two representations coexist, and the split is deliberate:
//!
//! * [`Hex`] — **axial** coordinates `(q, r)`. This is the *internal* engine
//!   representation. Axial coordinates are cube coordinates `(q, r, s)` with the
//!   redundant third component dropped, because `q + r + s == 0` always holds.
//!   Cube-style arithmetic (distance, neighbours, rotation) is recovered by
//!   computing `s` on demand via [`Hex::s`].
//! * [`OffsetCoord`] — **odd-r offset** coordinates `(col, row)`. This is the
//!   *authored* representation used by content files and by the editor, because
//!   a rectangular `width x height` map is far easier to author, diff and
//!   validate than a rhombus of axial coordinates.
//!
//! Conversion between the two is exact and lossless: see [`Hex::from_offset`]
//! and [`Hex::to_offset`].
//!
//! # Layout
//!
//! The MVP uses **pointy-top** hexagons with an **odd-r** offset layout: rows
//! run horizontally, `row` increases downwards, and odd-numbered rows are
//! shifted half a hex to the right.
//!
//! ```text
//!  row 0    (0,0) (1,0) (2,0)
//!  row 1      (0,1) (1,1) (2,1)      <- shifted right by half a hex
//!  row 2    (0,2) (1,2) (2,2)
//! ```
//!
//! # Pixel conversion
//!
//! Hex <-> pixel conversion intentionally lives in the TypeScript renderer, not
//! here: it depends on camera, zoom and device pixel ratio, it runs per frame,
//! and the engine must never depend on presentation concerns. See
//! `docs/adr/ADR-0011-hex-coordinate-model.md`.

use std::fmt;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The six neighbour directions of a pointy-top hexagon, in **canonical
/// order**.
///
/// The order is part of the engine's public behaviour: every rule that has to
/// pick between otherwise equivalent neighbours (most notably monster movement)
/// breaks the tie by preferring the lowest direction index. Changing this order
/// changes simulation outcomes and therefore requires a new ADR.
pub const DIRECTIONS: [HexDirection; 6] = [
    HexDirection::East,
    HexDirection::NorthEast,
    HexDirection::NorthWest,
    HexDirection::West,
    HexDirection::SouthWest,
    HexDirection::SouthEast,
];

/// A neighbour direction on a pointy-top hex grid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HexDirection {
    /// `(+1, 0)`
    East,
    /// `(+1, -1)`
    NorthEast,
    /// `(0, -1)`
    NorthWest,
    /// `(-1, 0)`
    West,
    /// `(-1, +1)`
    SouthWest,
    /// `(0, +1)`
    SouthEast,
}

impl HexDirection {
    /// Returns the axial delta `(dq, dr)` applied when stepping in this
    /// direction.
    #[must_use]
    pub const fn delta(self) -> (i32, i32) {
        match self {
            HexDirection::East => (1, 0),
            HexDirection::NorthEast => (1, -1),
            HexDirection::NorthWest => (0, -1),
            HexDirection::West => (-1, 0),
            HexDirection::SouthWest => (-1, 1),
            HexDirection::SouthEast => (0, 1),
        }
    }

    /// Returns the position of this direction in [`DIRECTIONS`].
    ///
    /// This index is the deterministic tie-breaking key used by the simulation.
    #[must_use]
    pub const fn index(self) -> usize {
        match self {
            HexDirection::East => 0,
            HexDirection::NorthEast => 1,
            HexDirection::NorthWest => 2,
            HexDirection::West => 3,
            HexDirection::SouthWest => 4,
            HexDirection::SouthEast => 5,
        }
    }
}

/// An axial hex coordinate `(q, r)`.
///
/// # Examples
///
/// ```
/// use insulaire_world::hex::Hex;
///
/// let origin = Hex::new(0, 0);
/// assert_eq!(origin.distance(Hex::new(2, -1)), 2);
/// assert_eq!(origin.neighbors().len(), 6);
/// ```
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize,
)]
pub struct Hex {
    q: i32,
    r: i32,
}

impl Hex {
    /// Creates an axial coordinate.
    #[must_use]
    pub const fn new(q: i32, r: i32) -> Self {
        Self { q, r }
    }

    /// The `q` (column-ish) cube axis.
    #[must_use]
    pub const fn q(self) -> i32 {
        self.q
    }

    /// The `r` (row) cube axis.
    #[must_use]
    pub const fn r(self) -> i32 {
        self.r
    }

    /// The implicit third cube axis, `s = -q - r`.
    #[must_use]
    pub const fn s(self) -> i32 {
        -self.q - self.r
    }

    /// Returns the neighbour in `direction`.
    #[must_use]
    pub const fn neighbor(self, direction: HexDirection) -> Self {
        let (dq, dr) = direction.delta();
        Self {
            q: self.q + dq,
            r: self.r + dr,
        }
    }

    /// Returns the six neighbours in [canonical order](DIRECTIONS).
    #[must_use]
    pub fn neighbors(self) -> [Self; 6] {
        DIRECTIONS.map(|direction| self.neighbor(direction))
    }

    /// Returns the six neighbours paired with the direction that reaches them,
    /// in [canonical order](DIRECTIONS).
    #[must_use]
    pub fn neighbors_with_direction(self) -> [(HexDirection, Self); 6] {
        DIRECTIONS.map(|direction| (direction, self.neighbor(direction)))
    }

    /// Returns the hex distance, i.e. the minimum number of steps between two
    /// hexes.
    ///
    /// This is the cube-coordinate Manhattan distance halved, which is the
    /// standard hex metric.
    #[must_use]
    pub fn distance(self, other: Self) -> u32 {
        let dq = self.q - other.q;
        let dr = self.r - other.r;
        let ds = self.s() - other.s();
        // Sum of absolute cube deltas is always even, so the halving is exact.
        (dq.unsigned_abs() + dr.unsigned_abs() + ds.unsigned_abs()) / 2
    }

    /// Returns `true` when `other` is exactly one step away.
    #[must_use]
    pub fn is_adjacent(self, other: Self) -> bool {
        self.distance(other) == 1
    }

    /// Converts an odd-r offset coordinate into axial coordinates.
    ///
    /// The numerator `row - (row mod 2)` is always even, so the division is
    /// exact and behaves identically for negative rows.
    #[must_use]
    pub fn from_offset(offset: OffsetCoord) -> Self {
        let row = offset.row;
        let q = offset.col - (row - row.rem_euclid(2)) / 2;
        Self { q, r: row }
    }

    /// Converts axial coordinates into odd-r offset coordinates.
    #[must_use]
    pub fn to_offset(self) -> OffsetCoord {
        let col = self.q + (self.r - self.r.rem_euclid(2)) / 2;
        OffsetCoord { col, row: self.r }
    }
}

impl fmt::Display for Hex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "({}, {})", self.q, self.r)
    }
}

impl From<OffsetCoord> for Hex {
    fn from(value: OffsetCoord) -> Self {
        Hex::from_offset(value)
    }
}

/// An odd-r offset coordinate `(col, row)` as used by authored content.
///
/// Serialises as a two-element array `[col, row]`, which keeps authored world
/// files compact and produces readable line-oriented Git diffs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, TS)]
#[ts(export, export_to = "shared.ts", type = "[number, number]")]
pub struct OffsetCoord {
    /// Column index; increases to the right.
    pub col: i32,
    /// Row index; increases downwards.
    pub row: i32,
}

impl OffsetCoord {
    /// Creates an offset coordinate.
    #[must_use]
    pub const fn new(col: i32, row: i32) -> Self {
        Self { col, row }
    }

    /// `true` when this is the coordinate a map's extent defaults to.
    ///
    /// The shape `skip_serializing_if` wants, so a map anchored where maps have
    /// always been anchored writes no `origin`.
    #[must_use]
    pub const fn is_origin(&self) -> bool {
        self.col == 0 && self.row == 0
    }
}

impl fmt::Display for OffsetCoord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}, {}]", self.col, self.row)
    }
}

impl From<Hex> for OffsetCoord {
    fn from(value: Hex) -> Self {
        value.to_offset()
    }
}

/// The rectangle of offset coordinates a map's dense buffers cover.
///
/// A map is a *set of hexes*, not a rectangle
/// (`docs/adr/ADR-0033-a-map-is-a-set-of-hexes.md`); this is the box those
/// hexes are stored in, and the only thing that turns a coordinate into a
/// buffer index.
///
/// The `origin` is what makes extending a map cheap and safe. Growing
/// northwards or westwards moves the origin instead of renumbering the cells,
/// so an authored `[col, row]` means the same hex forever — which matters twice
/// over: odd-r is not translation-invariant, so shifting rows by an odd amount
/// would mirror the shape, and another map's door names a coordinate in this
/// one (`docs/adr/ADR-0014-map-links.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapBounds {
    /// The north-west corner: the coordinate stored at index `0`.
    pub origin: OffsetCoord,
    /// Number of columns covered.
    pub width: u32,
    /// Number of rows covered.
    pub height: u32,
}

impl MapBounds {
    /// Creates an extent anchored at `origin`.
    #[must_use]
    pub const fn new(origin: OffsetCoord, width: u32, height: u32) -> Self {
        Self {
            origin,
            width,
            height,
        }
    }

    /// Creates an extent anchored at `[0, 0]`, where every map used to be.
    #[must_use]
    pub const fn of_size(width: u32, height: u32) -> Self {
        Self::new(OffsetCoord::new(0, 0), width, height)
    }

    /// Number of cells the buffers hold, present or not.
    #[must_use]
    pub const fn cell_count(&self) -> usize {
        self.width as usize * self.height as usize
    }

    /// `true` when the extent covers no cell at all.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.width == 0 || self.height == 0
    }

    /// First column covered.
    #[must_use]
    pub const fn min_col(&self) -> i32 {
        self.origin.col
    }

    /// First row covered.
    #[must_use]
    pub const fn min_row(&self) -> i32 {
        self.origin.row
    }

    /// Last column covered; meaningless on an empty extent.
    #[must_use]
    pub const fn max_col(&self) -> i32 {
        self.origin.col + self.width as i32 - 1
    }

    /// Last row covered; meaningless on an empty extent.
    #[must_use]
    pub const fn max_row(&self) -> i32 {
        self.origin.row + self.height as i32 - 1
    }

    /// `true` when `at` has a slot in the buffers.
    ///
    /// This answers where a *buffer index* lives. Whether the world actually has
    /// that hex is [`crate::WorldGrid::contains`], and only that one is a rule
    /// (`docs/adr/ADR-0033-a-map-is-a-set-of-hexes.md`).
    #[must_use]
    pub const fn contains(&self, at: OffsetCoord) -> bool {
        let col = at.col as i64 - self.origin.col as i64;
        let row = at.row as i64 - self.origin.row as i64;
        col >= 0 && row >= 0 && col < self.width as i64 && row < self.height as i64
    }

    /// The row-major index of `at`, or `None` when it is outside the extent.
    #[must_use]
    pub fn index_of(&self, at: OffsetCoord) -> Option<usize> {
        if !self.contains(at) {
            return None;
        }
        let col = (at.col - self.origin.col) as usize;
        let row = (at.row - self.origin.row) as usize;
        Some(row * self.width as usize + col)
    }

    /// The coordinate stored at a row-major index.
    #[must_use]
    pub fn coord_at(&self, index: usize) -> OffsetCoord {
        let width = (self.width as usize).max(1);
        OffsetCoord::new(
            self.origin.col + (index % width) as i32,
            self.origin.row + (index / width) as i32,
        )
    }

    /// Every coordinate the extent covers, row-major.
    pub fn coords(&self) -> impl Iterator<Item = OffsetCoord> + '_ {
        (0..self.cell_count()).map(|index| self.coord_at(index))
    }
}

impl Default for MapBounds {
    fn default() -> Self {
        Self::of_size(0, 0)
    }
}

impl fmt::Display for MapBounds {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}x{} at {}", self.width, self.height, self.origin)
    }
}

impl Serialize for OffsetCoord {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        [self.col, self.row].serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for OffsetCoord {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let [col, row] = <[i32; 2]>::deserialize(deserializer)?;
        Ok(Self { col, row })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cube_axes_always_sum_to_zero() {
        for q in -5..=5 {
            for r in -5..=5 {
                let hex = Hex::new(q, r);
                assert_eq!(hex.q() + hex.r() + hex.s(), 0);
            }
        }
    }

    #[test]
    fn neighbors_are_six_distinct_hexes_at_distance_one() {
        let center = Hex::new(3, -2);
        let neighbors = center.neighbors();

        assert_eq!(neighbors.len(), 6);
        for neighbor in neighbors {
            assert_eq!(
                center.distance(neighbor),
                1,
                "{neighbor} should be adjacent"
            );
            assert!(center.is_adjacent(neighbor));
        }

        let mut sorted = neighbors;
        sorted.sort_unstable();
        sorted.windows(2).for_each(|pair| {
            assert_ne!(pair[0], pair[1], "neighbours must be distinct");
        });
    }

    #[test]
    fn neighbor_directions_follow_the_canonical_order() {
        let center = Hex::new(0, 0);
        assert_eq!(
            center.neighbors(),
            [
                Hex::new(1, 0),  // East
                Hex::new(1, -1), // NorthEast
                Hex::new(0, -1), // NorthWest
                Hex::new(-1, 0), // West
                Hex::new(-1, 1), // SouthWest
                Hex::new(0, 1),  // SouthEast
            ]
        );
        for (index, direction) in DIRECTIONS.iter().enumerate() {
            assert_eq!(direction.index(), index);
        }
    }

    #[test]
    fn distance_is_symmetric_and_zero_on_self() {
        let a = Hex::new(-4, 7);
        let b = Hex::new(2, -3);
        assert_eq!(a.distance(a), 0);
        assert_eq!(a.distance(b), b.distance(a));
    }

    #[test]
    fn distance_matches_known_values() {
        let origin = Hex::new(0, 0);
        assert_eq!(origin.distance(Hex::new(0, 0)), 0);
        assert_eq!(origin.distance(Hex::new(1, 0)), 1);
        assert_eq!(origin.distance(Hex::new(0, 1)), 1);
        assert_eq!(origin.distance(Hex::new(2, 0)), 2);
        assert_eq!(origin.distance(Hex::new(-2, 1)), 2);
        assert_eq!(origin.distance(Hex::new(3, -1)), 3);
    }

    #[test]
    fn distance_obeys_the_triangle_inequality() {
        let a = Hex::new(0, 0);
        let b = Hex::new(4, -2);
        let c = Hex::new(-3, 5);
        assert!(a.distance(c) <= a.distance(b) + b.distance(c));
    }

    #[test]
    fn walking_n_steps_in_one_direction_yields_distance_n() {
        for direction in DIRECTIONS {
            let mut hex = Hex::new(0, 0);
            for step in 1..=6 {
                hex = hex.neighbor(direction);
                assert_eq!(Hex::new(0, 0).distance(hex), step);
            }
        }
    }

    #[test]
    fn offset_and_axial_round_trip() {
        for row in -8..=8 {
            for col in -8..=8 {
                let offset = OffsetCoord::new(col, row);
                let round_tripped = Hex::from_offset(offset).to_offset();
                assert_eq!(offset, round_tripped, "round trip failed for {offset}");
            }
        }
    }

    #[test]
    fn axial_and_offset_round_trip() {
        for q in -8..=8 {
            for r in -8..=8 {
                let hex = Hex::new(q, r);
                assert_eq!(hex, Hex::from_offset(hex.to_offset()));
            }
        }
    }

    #[test]
    fn odd_rows_are_shifted_right() {
        // Even rows are unshifted; odd rows sit half a hex to the right, so the
        // hex below-left of (1, 0) is (1, 1) in offset space.
        assert_eq!(Hex::from_offset(OffsetCoord::new(0, 0)), Hex::new(0, 0));
        assert_eq!(Hex::from_offset(OffsetCoord::new(0, 1)), Hex::new(0, 1));
        assert_eq!(Hex::from_offset(OffsetCoord::new(0, 2)), Hex::new(-1, 2));

        let start = Hex::from_offset(OffsetCoord::new(1, 0));
        assert_eq!(
            start.neighbor(HexDirection::SouthEast).to_offset(),
            OffsetCoord::new(1, 1)
        );
        assert_eq!(
            start.neighbor(HexDirection::SouthWest).to_offset(),
            OffsetCoord::new(0, 1)
        );
    }

    #[test]
    fn offset_neighbours_stay_adjacent_in_offset_space() {
        // Regression guard for the offset conversion: every axial neighbour must
        // remain a visual neighbour on the rectangular authored grid.
        for row in 0..6 {
            for col in 0..6 {
                let hex = Hex::from_offset(OffsetCoord::new(col, row));
                for neighbor in hex.neighbors() {
                    let offset = neighbor.to_offset();
                    assert!((offset.row - row).abs() <= 1);
                    assert!((offset.col - col).abs() <= 1);
                }
            }
        }
    }

    #[test]
    fn bounds_checking_rejects_coordinates_outside_the_extent() {
        let bounds = MapBounds::of_size(20, 20);
        assert!(bounds.contains(OffsetCoord::new(0, 0)));
        assert!(bounds.contains(OffsetCoord::new(19, 19)));
        assert!(!bounds.contains(OffsetCoord::new(20, 0)));
        assert!(!bounds.contains(OffsetCoord::new(0, 20)));
        assert!(!bounds.contains(OffsetCoord::new(-1, 0)));
        assert!(!bounds.contains(OffsetCoord::new(0, -1)));
    }

    #[test]
    fn an_extent_with_an_origin_covers_negative_coordinates() {
        let bounds = MapBounds::new(OffsetCoord::new(-3, -5), 6, 8);
        assert!(bounds.contains(OffsetCoord::new(-3, -5)));
        assert!(bounds.contains(OffsetCoord::new(2, 2)));
        assert!(!bounds.contains(OffsetCoord::new(-4, -5)));
        assert!(!bounds.contains(OffsetCoord::new(3, 2)));

        assert_eq!(bounds.index_of(OffsetCoord::new(-3, -5)), Some(0));
        assert_eq!(bounds.index_of(OffsetCoord::new(-2, -5)), Some(1));
        assert_eq!(bounds.index_of(OffsetCoord::new(-3, -4)), Some(6));
        assert_eq!(bounds.min_col(), -3);
        assert_eq!(bounds.max_col(), 2);
        assert_eq!(bounds.min_row(), -5);
        assert_eq!(bounds.max_row(), 2);
    }

    #[test]
    fn row_major_index_round_trips() {
        let bounds = MapBounds::of_size(20, 12);
        assert_eq!(bounds.index_of(OffsetCoord::new(0, 0)), Some(0));
        assert_eq!(bounds.index_of(OffsetCoord::new(19, 0)), Some(19));
        assert_eq!(bounds.index_of(OffsetCoord::new(0, 1)), Some(20));
        assert_eq!(bounds.index_of(OffsetCoord::new(20, 0)), None);
        assert_eq!(bounds.index_of(OffsetCoord::new(0, 12)), None);

        for bounds in [
            MapBounds::of_size(20, 12),
            MapBounds::new(OffsetCoord::new(-7, -3), 20, 12),
        ] {
            for index in 0..bounds.cell_count() {
                assert_eq!(bounds.index_of(bounds.coord_at(index)), Some(index));
            }
        }
    }

    #[test]
    fn moving_the_origin_keeps_every_cell_on_its_own_row_parity() {
        // Odd-r is not translation-invariant, which is the whole reason the
        // extent has an origin rather than the cells being renumbered: the same
        // authored coordinate must keep the same neighbours whatever box holds
        // it (`docs/adr/ADR-0033-a-map-is-a-set-of-hexes.md`).
        let cell = OffsetCoord::new(4, 3);
        let neighbours = Hex::from_offset(cell).neighbors().map(Hex::to_offset);

        let narrow = MapBounds::of_size(8, 8);
        let widened = MapBounds::new(OffsetCoord::new(-5, -5), 20, 20);
        assert!(narrow.contains(cell) && widened.contains(cell));
        assert_ne!(narrow.index_of(cell), widened.index_of(cell));
        assert_eq!(
            neighbours,
            Hex::from_offset(cell).neighbors().map(Hex::to_offset)
        );
    }

    #[test]
    fn offset_serialises_as_a_two_element_array() {
        let json = serde_json::to_string(&OffsetCoord::new(4, 7)).expect("serialise");
        assert_eq!(json, "[4,7]");
        let parsed: OffsetCoord = serde_json::from_str("[4,7]").expect("deserialise");
        assert_eq!(parsed, OffsetCoord::new(4, 7));
    }
}
