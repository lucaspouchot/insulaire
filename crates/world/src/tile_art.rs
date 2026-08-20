//! Tile art: the images a tile is drawn from, and how a height resolves to them.
//!
//! [`crate::TileDefinition`] says what a tile *is* — its terrain, its cost, its
//! tags. This module says what it *looks like*: a set of surface images for the
//! flat top face, and a ladder of **elevation levels**, each an image that draws
//! one whole step of relief — the top face and every side face the projection
//! exposes, in one picture
//! (`docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`).
//!
//! ```text
//! TileDefinition + projection + elevation + roll ──> resolve() ──> ResolvedTileRender
//! ```
//!
//! # Two projections, two sets of images
//!
//! A hexagon seen straight down and the same hexagon seen isometrically are not
//! the same shape: one is `2 / sqrt(3)` as tall as it is wide, the other is
//! squashed to whatever tilt the authored grid implies, and it has side faces.
//! So each view has its own images — [`TileArt::flat`] for a top-down world,
//! [`TileArt::surface`] plus [`TileArt::elevation`] for an isometric one — and
//! neither is ever stretched into the other's shape
//! (`docs/adr/ADR-0037-a-flat-map-is-drawn-from-flat-art.md`).
//!
//! A tile that authors no [`flat`](TileArt::flat) draws its `fallbackColor` in
//! a top-down world. Reaching for the surface image instead is what this
//! separation exists to prevent: it is the top face of a *tilted* hexagon, and
//! it fits the flat one nowhere.
//!
//! # An elevation image is the faces, and only the faces
//!
//! A cell's top face always comes from its **surface** variants, at every
//! height. An elevation image holds the two faces a pointy-top hexagon exposes
//! — south-west and south-east — and nothing else, so raising a tile never
//! costs it the variety its surfaces give it and no image carries a copy of a
//! top face it would only ever be covered by.
//!
//! Nothing here rotates, mirrors, skews or scales any part of an image to
//! produce another part: the two faces are independent pixels, which is the
//! whole point of authoring pixel art by hand. The only thing resolution ever
//! does to an image is choose it and say how far **down** it is drawn.
//!
//! # A cell may choose, and mostly does not
//!
//! Which variant a cell draws is a **roll** — [`variant_roll`], a hash of its
//! coordinates — so a map costs nothing to author and looks the same in every
//! session. An author who wants a particular tile to look a particular way
//! overrides that with [`CellArt`]: this surface, this ladder, this variant.
//! The override travels on the cell, resolved to indices when the grid is
//! built, and everything left unset keeps rolling
//! (`docs/adr/ADR-0036-a-cell-may-choose-its-tile-art.md`).
//!
//! # Levels are resolved, not stored
//!
//! A cliff a hundred steps tall is not a hundred images. Levels `1..=n` are
//! authored explicitly; everything above them is produced by a
//! [`ElevationRepeat`] rule — reuse one level, or cycle through several — and
//! the resolver stacks the result, one drawn layer per step of visible drop.
//!
//! # Geometry
//!
//! [`TileArtGeometry`] is the pixel grid the images are authored on, declared
//! once per tile set. It is *also* what the renderer's projection is derived
//! from when a tile set declares it, so the polygon fallback and the sprites
//! cannot disagree about how tall a step is. Pixels never enter this crate as
//! a screen measurement — these are the authored dimensions of a file
//! (`docs/adr/ADR-0014-hex-coordinate-model.md`).

use serde::{Deserialize, Serialize};

use crate::definition::ProjectionMode;

/// Authored width of a tile image when a tile set declares no geometry.
pub const DEFAULT_TILE_WIDTH: u32 = 32;

/// Authored height of a surface image when a tile set declares no geometry.
///
/// `20 / 32` is the top face of a pointy-top hexagon under the isometric tilt
/// ADR-0016 chose, rounded to whole pixels.
pub const DEFAULT_SURFACE_HEIGHT: u32 = 20;

/// Authored height of an elevation image when a tile set declares no geometry.
///
/// The faces' own bounding box: the `V` the hexagon's lower edges cut, which is
/// a quarter of [`DEFAULT_SURFACE_HEIGHT`] deep, plus one whole step below it.
pub const DEFAULT_ELEVATION_HEIGHT: u32 = DEFAULT_SURFACE_HEIGHT / 4 + DEFAULT_ELEVATION_STEP;

/// Pixels one level of relief lifts a tile, when none is declared.
pub const DEFAULT_ELEVATION_STEP: u32 = 8;

/// Authored height of a flat image when a tile set declares no geometry.
///
/// The top-down hexagon's own bounding box. A pointy-top hexagon is
/// `2 / sqrt(3)` — about `1.155` — times as tall as it is wide, so a
/// [`DEFAULT_TILE_WIDTH`] of `32` is `37` tall, rounded to whole pixels.
/// Nothing tilts it: that is what makes it a different image from a surface
/// rather than the same one scaled.
pub const DEFAULT_FLAT_HEIGHT: u32 = 37;

/// Largest tile image this build accepts, on either side.
///
/// A cap rather than a preference: a tile asked to be 4096 pixels wide is a
/// background, not a tile.
pub const MAX_TILE_IMAGE_SIZE: u32 = 512;

/// Most explicit elevation levels one tile may author.
///
/// Beyond this the answer is a [`ElevationRepeat`] rule, which is the feature
/// that exists so a tall world costs no extra art.
pub const MAX_ELEVATION_LEVELS: usize = 32;

/// Most variants one surface or one elevation level may offer.
pub const MAX_TILE_VARIANTS: usize = 16;

/// Most layers [`resolve_tile_render`] will stack for one cell.
///
/// A drop of two hundred steps is drawn two hundred sprites deep otherwise, and
/// everything past the first few dozen is below the bottom of any viewport.
pub const MAX_STACKED_LEVELS: u32 = 64;

/// The pixel grid a tile set's images are authored on.
///
/// Every image in the set shares [`width`](Self::width). A **flat** image is
/// [`flat_height`](Self::flat_height) tall and holds the whole hexagon as a
/// top-down world sees it. A surface image is
/// [`surface_height`](Self::surface_height) tall and holds the top face alone.
/// An elevation image is [`elevation_height`](Self::elevation_height) tall and
/// holds **only the side faces**: its first row is the hexagon's lower shoulder
/// line, so its top [`shoulder_depth`](Self::shoulder_depth) rows are the `V`
/// the two lower edges cut.
///
/// What is drawn below that `V` is a band **one step thick that follows it** —
/// the shape `tile_preview::faceGuides` marks for the artist — and not the rest
/// of the canvas. The canvas is taller than the band because the `V` has to fit
/// above it, and painting into that spare room is painting an overhang: layers
/// still stack, but the lowest one ends on a flat cut instead of on the
/// hexagon's own silhouette, and the difference shows wherever nothing stands
/// in front of the cliff to hide it.
///
/// ```text
///   surface image            elevation image          flat image
///   ┌───────────────┐        ┌───────────────┐  ←     ┌───────────────┐
///   │      ___      │        │\             /│        │      /\       │
///   │    /     \    │        │ \___________/ │  ←     │    /    \     │
///   │   |       |   │        │  \ SW | SE /  │        │   |      |    │
///   │    \_____/    │        │   \___|___/   │  ←     │    \    /     │
///   └───────────────┘        └───────────────┘        │      \/       │
///                                                     └───────────────┘
///     the tilted top face      the two side faces       the hexagon itself,
///     (isometric worlds)       (isometric worlds)       untilted (top-down)
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileArtGeometry {
    /// Width of every image in the set, in authored pixels.
    pub width: u32,
    /// Height of a flat image: the untilted hexagon's bounding box.
    ///
    /// `width * 2 / sqrt(3)` for a hexagon drawn to the same width, which is
    /// what a top-down world puts on screen
    /// (`docs/adr/ADR-0037-a-flat-map-is-drawn-from-flat-art.md`).
    pub flat_height: u32,
    /// Height of a surface image: the top face's bounding box.
    pub surface_height: u32,
    /// Height of an elevation image: the `V` of the lower edges, then the faces.
    pub elevation_height: u32,
    /// Authored pixels one level of relief lifts a tile.
    ///
    /// Normally the same as [`face_height`](Self::face_height), so a stack of
    /// levels meets edge to edge. A smaller value overlaps them on purpose; a
    /// larger one would open a gap, and validation says so.
    pub elevation_step: u32,
}

impl Default for TileArtGeometry {
    fn default() -> Self {
        Self {
            width: DEFAULT_TILE_WIDTH,
            flat_height: DEFAULT_FLAT_HEIGHT,
            surface_height: DEFAULT_SURFACE_HEIGHT,
            elevation_height: DEFAULT_ELEVATION_HEIGHT,
            elevation_step: DEFAULT_ELEVATION_STEP,
        }
    }
}

impl TileArtGeometry {
    /// How far the hexagon's lower edges fall from its shoulders to its south
    /// vertex.
    ///
    /// A quarter of the top face's height, exactly: a pointy-top hexagon puts
    /// its `±30°` corners half a radius off centre, and the projection scales
    /// both by the same tilt. It is the depth of the `V` an elevation image has
    /// to leave room for above its faces.
    #[must_use]
    pub const fn shoulder_depth(&self) -> u32 {
        self.surface_height / 4
    }

    /// Height of the faces themselves, below the `V`.
    #[must_use]
    pub const fn face_height(&self) -> u32 {
        self.elevation_height.saturating_sub(self.shoulder_depth())
    }
}

/// One image a tile may be drawn with.
///
/// Variants exist so a field of grass is not the same forty pixels forty times.
/// Which one a cell gets is decided by [`variant_roll`], never by chance at
/// draw time: a tile keeps the same face from frame to frame and from session
/// to session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileArtVariant {
    /// Stable id, unique within the surface or level that declares it.
    pub id: String,
    /// Path of the image under the content root.
    pub asset: String,
}

/// One authored step of relief: the images that may draw it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElevationLevel {
    /// Display name for the editor; the level's number when empty.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    /// The images that may draw this level.
    #[serde(default)]
    pub variants: Vec<TileArtVariant>,
}

/// What draws the levels above the last explicit one.
///
/// Absent — `None` on [`TileElevation::repeat`] — reuses the highest explicit
/// level, which is the answer that needs no authoring and is right most of the
/// time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ElevationRepeat {
    /// Every level above the explicit ones reuses this one, 1-based.
    Level(u32),
    /// Levels above the explicit ones cycle through these, 1-based, in order.
    ///
    /// `[1, 2]` above two explicit levels gives `3 → 1`, `4 → 2`, `5 → 1`, …
    Pattern(Vec<u32>),
}

/// A tile's ladder of relief.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileElevation {
    /// Explicit levels; index `i` is level `i + 1`. Level `0` is the surface.
    #[serde(default)]
    pub levels: Vec<ElevationLevel>,
    /// What draws levels above the last explicit one; absent repeats the last.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat: Option<ElevationRepeat>,
}

impl TileElevation {
    /// `true` when nothing is authored, so relief falls back to flat colour.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.levels.iter().all(|level| level.variants.is_empty())
    }

    /// The explicit level, 1-based, whose art draws `level`.
    ///
    /// This is the whole repeat rule, and it is deliberately total: a rule that
    /// names a level nobody authored falls back to the highest explicit one
    /// rather than drawing a hole. Validation reports the rule separately, so
    /// the author is told without the picture breaking
    /// (`docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`).
    #[must_use]
    pub fn source_level(&self, level: u32) -> Option<u32> {
        let count = u32::try_from(self.levels.len()).unwrap_or(u32::MAX);
        if count == 0 || level == 0 {
            return None;
        }
        if level <= count {
            return Some(level);
        }
        let source = match &self.repeat {
            None => count,
            Some(ElevationRepeat::Level(source)) => *source,
            Some(ElevationRepeat::Pattern(pattern)) => {
                let usable: Vec<u32> = pattern
                    .iter()
                    .copied()
                    .filter(|source| (1..=count).contains(source))
                    .collect();
                if usable.is_empty() {
                    count
                } else {
                    let step = (level - count - 1) as usize % usable.len();
                    usable[step]
                }
            }
        };
        Some(if (1..=count).contains(&source) {
            source
        } else {
            count
        })
    }

    /// `true` when the file may leave this out entirely.
    fn is_unauthored(&self) -> bool {
        self.levels.is_empty() && self.repeat.is_none()
    }

    /// The explicit level with this 1-based number.
    #[must_use]
    pub fn level(&self, level: u32) -> Option<&ElevationLevel> {
        usize::try_from(level)
            .ok()
            .and_then(|index| index.checked_sub(1))
            .and_then(|index| self.levels.get(index))
    }
}

/// Everything a tile is drawn from, in either projection.
///
/// [`flat`](Self::flat) draws a top-down world; [`surface`](Self::surface) and
/// [`elevation`](Self::elevation) draw an isometric one. A tile may author one
/// view, both, or neither — whatever a projection finds nothing for is drawn in
/// the tile's `fallbackColor`
/// (`docs/adr/ADR-0037-a-flat-map-is-drawn-from-flat-art.md`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileArt {
    /// Images for the untilted hexagon, one per variant. Top-down worlds only.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub flat: Vec<TileArtVariant>,
    /// Images for the tilted top face, one per variant. Isometric worlds only.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub surface: Vec<TileArtVariant>,
    /// The ladder of relief. Isometric worlds only.
    #[serde(default, skip_serializing_if = "TileElevation::is_unauthored")]
    pub elevation: TileElevation,
}

impl TileArt {
    /// `true` when the tile declares no image at all, in any projection.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.flat.is_empty() && self.surface.is_empty() && self.elevation.is_empty()
    }
}

/// One image to draw for a cell, and how far below its top face it sits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTileLayer {
    /// The height this layer stands at, 1-based.
    pub level: u32,
    /// The explicit level whose art draws it; equal to `level` unless repeated.
    pub source_level: u32,
    /// Path of the image under the content root.
    pub asset: String,
    /// Steps of [`TileArtGeometry::elevation_step`] below the cell's top face.
    ///
    /// `0` is the layer whose surface *is* the top face. The whole image moves;
    /// nothing inside it is transformed.
    pub drop: u32,
}

/// What to draw for one cell, back to front.
///
/// One of the two projections answers, never both. A top-down world fills
/// [`flat`](Self::flat) alone; an isometric one fills
/// [`surface`](Self::surface) — at every height, not only when the cell is
/// flat — and stacks [`layers`](Self::layers) under it, faces first, lowest to
/// highest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTileRender {
    /// The tile this resolves.
    pub tile_id: String,
    /// The cell's authored height.
    pub elevation: i32,
    /// The untilted hexagon, in a top-down world. Excludes the two below.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flat: Option<String>,
    /// The tilted top face, at any height, in an isometric world.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<String>,
    /// The side faces, lowest first. Drawn *under* the surface.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub layers: Vec<ResolvedTileLayer>,
}

impl ResolvedTileRender {
    /// `true` when nothing is authored for this cell **in this projection**, so
    /// the renderer fills it with the tile's `fallbackColor` as it always has.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.flat.is_none() && self.surface.is_none() && self.layers.is_empty()
    }
}

/// The variant a cell rolls, stable for the life of the map.
///
/// A hash rather than an RNG: there is no state to advance, the same cell
/// always answers the same thing, and two hosts drawing the same map agree
/// without exchanging a seed. `salt` distinguishes what is being rolled — pass
/// the tile id, so moving a tile from grass to sand rerolls it.
///
/// FNV-1a, 32-bit: five lines, well-mixed at this size, and identical in the
/// TypeScript mirror (`apps/web/src/renderer/tile-art.ts`).
#[must_use]
pub fn variant_roll(col: i32, row: i32, salt: &str) -> u32 {
    const OFFSET: u32 = 2_166_136_261;
    const PRIME: u32 = 16_777_619;

    let mut hash = OFFSET;
    for byte in salt.as_bytes() {
        hash = (hash ^ u32::from(*byte)).wrapping_mul(PRIME);
    }
    for value in [col, row] {
        for byte in (value as u32).to_le_bytes() {
            hash = (hash ^ u32::from(byte)).wrapping_mul(PRIME);
        }
    }
    hash
}

/// The variant `roll` selects out of `count`, or `None` when there is none.
#[must_use]
pub fn variant_index(roll: u32, count: usize) -> Option<usize> {
    if count == 0 {
        None
    } else {
        Some(roll as usize % count)
    }
}

/// What one authored cell asks for, instead of what the roll would give it.
///
/// Every field is an override of a default that is already right nearly
/// everywhere, so `None` — "roll it" — is what all but a handful of cells on a
/// map say (`docs/adr/ADR-0036-a-cell-may-choose-its-tile-art.md`). The
/// resolver never reads a tile set out of this: the ids an author writes are
/// turned into indices, and a reference to another tile into that tile's
/// [`TileArt`], once, when the grid is built.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CellArt<'a> {
    /// Which variant draws the cell's own footprint.
    ///
    /// One index for both projections: it picks out of
    /// [`TileArt::surface`] in an isometric world and out of
    /// [`TileArt::flat`] in a top-down one, wrapping when the two lists are
    /// different lengths. A set that ships both gives them matching ids, so a
    /// cell that chose `f` shows `f` whichever way the map is drawn.
    pub surface: Option<usize>,
    /// The art whose elevation ladder cuts the faces.
    ///
    /// This is how a meadow stands on a rock cliff: the top face stays the
    /// tile's own grass, and only the ladder comes from somewhere else.
    pub elevation: Option<&'a TileArt>,
    /// Which of a level's variants draws each layer; `None` follows the
    /// surface, so a cell's cut matches the ground standing on it.
    pub elevation_variant: Option<usize>,
}

/// What to draw for a cell of `art` standing at `elevation` over `base`.
///
/// `projection` decides which set of images answers, and the two never mix: a
/// top-down world is one [`flat`](TileArt::flat) image and nothing else, and a
/// tile that authors none resolves to nothing so the renderer fills its colour
/// (`docs/adr/ADR-0037-a-flat-map-is-drawn-from-flat-art.md`).
///
/// `base` is the height the cell's side faces reach down to — the lower of its
/// two front neighbours, which is what the renderer already computes so that a
/// cliff is extruded exactly as far as it is visible. `roll` is
/// [`variant_roll`] for the cell, and `cell` is whatever the author chose by
/// hand; [`CellArt::default`] is the ordinary case, where everything is rolled.
///
/// In an isometric world the stack runs from `base + 1` to `elevation`, one
/// layer per visible step, and each layer's `drop` is how many steps below the
/// top face it sits. When nothing is visible — a flat cell, or one no higher
/// than its neighbours — the surface image is the whole answer.
#[must_use]
pub fn resolve_tile_render(
    tile_id: &str,
    art: &TileArt,
    projection: ProjectionMode,
    elevation: i32,
    base: i32,
    roll: u32,
    cell: CellArt<'_>,
) -> ResolvedTileRender {
    // A top-down hexagon has no tilt and no side faces, so it has its own
    // images and borrows nothing from the isometric ones: a surface is the top
    // of a squashed hexagon and fits the round one nowhere.
    if projection == ProjectionMode::TopDown {
        let index = cell.surface.or_else(|| variant_index(roll, art.flat.len()));
        return ResolvedTileRender {
            tile_id: tile_id.to_owned(),
            elevation,
            flat: index
                .and_then(|index| at(&art.flat, index))
                .map(|variant| variant.asset.clone()),
            surface: None,
            layers: Vec::new(),
        };
    }

    let steps = u32::try_from(elevation.saturating_sub(base))
        .unwrap_or(0)
        .min(MAX_STACKED_LEVELS);
    // The top face is the tile's own, at every height: an elevation image is
    // the faces and nothing else, so raising a cell never costs it the variety
    // its surfaces give it.
    let surface_index = cell
        .surface
        .or_else(|| variant_index(roll, art.surface.len()));
    let surface = surface_index
        .and_then(|index| at(&art.surface, index))
        .map(|variant| variant.asset.clone());

    // The faces may come from another tile's ladder; the top face never does.
    let faces = cell.elevation.unwrap_or(art);

    if steps == 0 || faces.elevation.is_empty() {
        return ResolvedTileRender {
            tile_id: tile_id.to_owned(),
            elevation,
            flat: None,
            surface,
            layers: Vec::new(),
        };
    }

    // The cut follows the ground standing on it: unless the author says
    // otherwise, every layer takes the variant the surface took, so a cell
    // showing `grass_f` is undercut by `dirt_f` all the way down. A level with
    // a different number of variants wraps rather than losing the layer.
    let chosen = cell.elevation_variant.or(surface_index);

    let mut layers = Vec::with_capacity(steps as usize);
    for drop in (0..steps).rev() {
        // `level` is the height this layer stands at. A cell dug below the
        // ground it fronts still needs its faces drawn, and levels at or below
        // zero have no art of their own, so they borrow level 1's.
        let height = elevation.saturating_sub(i32::try_from(drop).unwrap_or(0));
        let level = u32::try_from(height).unwrap_or(0).max(1);
        let Some(source_level) = faces.elevation.source_level(level) else {
            continue;
        };
        let Some(source) = faces.elevation.level(source_level) else {
            continue;
        };
        let index = chosen.unwrap_or(roll as usize);
        let Some(variant) = at(&source.variants, index) else {
            continue;
        };
        layers.push(ResolvedTileLayer {
            level,
            source_level,
            asset: variant.asset.clone(),
            drop,
        });
    }

    ResolvedTileRender {
        tile_id: tile_id.to_owned(),
        elevation,
        flat: None,
        surface,
        layers,
    }
}

/// The variant at `index`, wrapped into range. Total, so no caller drops a
/// layer because two lists have different lengths.
fn at(variants: &[TileArtVariant], index: usize) -> Option<&TileArtVariant> {
    variant_index(
        u32::try_from(index % variants.len().max(1)).unwrap_or(0),
        variants.len(),
    )
    .and_then(|index| variants.get(index))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn variant(id: &str) -> TileArtVariant {
        TileArtVariant {
            id: id.to_owned(),
            asset: format!("assets/tiles/{id}.png"),
        }
    }

    fn level(id: &str) -> ElevationLevel {
        ElevationLevel {
            name: String::new(),
            variants: vec![variant(id)],
        }
    }

    fn art(levels: Vec<ElevationLevel>, repeat: Option<ElevationRepeat>) -> TileArt {
        TileArt {
            flat: vec![variant("grass_flat_01")],
            surface: vec![variant("grass_01")],
            elevation: TileElevation { levels, repeat },
        }
    }

    #[test]
    fn geometry_defaults_describe_a_pointy_top_face() {
        let geometry = TileArtGeometry::default();
        assert_eq!(geometry.width, 32);
        // The V the lower edges cut is a quarter of the top face's height, and
        // an elevation image is that plus one whole step of face.
        assert_eq!(geometry.shoulder_depth(), 5);
        assert_eq!(geometry.face_height(), 8);
        assert_eq!(geometry.elevation_step, geometry.face_height());
        assert_eq!(
            geometry.elevation_height,
            geometry.shoulder_depth() + geometry.face_height()
        );
    }

    #[test]
    fn a_flat_cell_draws_its_surface_and_nothing_else() {
        let art = art(vec![level("cliff_01")], None);
        let resolved = resolve_tile_render(
            "grass",
            &art,
            ProjectionMode::Isometric,
            0,
            0,
            0,
            CellArt::default(),
        );

        assert_eq!(
            resolved.surface.as_deref(),
            Some("assets/tiles/grass_01.png")
        );
        assert!(resolved.layers.is_empty());
    }

    #[test]
    fn a_tile_with_no_art_resolves_to_nothing() {
        let resolved = resolve_tile_render(
            "grass",
            &TileArt::default(),
            ProjectionMode::Isometric,
            3,
            0,
            0,
            CellArt::default(),
        );
        assert!(resolved.is_empty());
    }

    #[test]
    fn explicit_levels_are_stacked_bottom_to_top() {
        let art = art(vec![level("a"), level("b"), level("c")], None);
        let resolved = resolve_tile_render(
            "mountain",
            &art,
            ProjectionMode::Isometric,
            3,
            0,
            0,
            CellArt::default(),
        );

        let stack: Vec<(u32, u32, &str)> = resolved
            .layers
            .iter()
            .map(|layer| (layer.level, layer.drop, layer.asset.as_str()))
            .collect();
        assert_eq!(
            stack,
            vec![
                (1, 2, "assets/tiles/a.png"),
                (2, 1, "assets/tiles/b.png"),
                (3, 0, "assets/tiles/c.png"),
            ]
        );
        // An elevation image is the faces alone, so the top face is still the
        // tile's own surface — a raised cell keeps its surface variants.
        assert_eq!(
            resolved.surface.as_deref(),
            Some("assets/tiles/grass_01.png")
        );
    }

    #[test]
    fn levels_above_the_explicit_ones_repeat_the_last_by_default() {
        let art = art(vec![level("a"), level("b")], None);
        assert_eq!(art.elevation.source_level(1), Some(1));
        assert_eq!(art.elevation.source_level(2), Some(2));
        assert_eq!(art.elevation.source_level(3), Some(2));
        assert_eq!(art.elevation.source_level(50), Some(2));
    }

    #[test]
    fn a_repeat_rule_names_the_level_it_reuses() {
        let art = art(
            vec![level("a"), level("b")],
            Some(ElevationRepeat::Level(1)),
        );
        assert_eq!(art.elevation.source_level(3), Some(1));
        assert_eq!(art.elevation.source_level(10), Some(1));

        let resolved = resolve_tile_render(
            "mountain",
            &art,
            ProjectionMode::Isometric,
            4,
            0,
            0,
            CellArt::default(),
        );
        let sources: Vec<u32> = resolved
            .layers
            .iter()
            .map(|layer| layer.source_level)
            .collect();
        assert_eq!(sources, vec![1, 2, 1, 1]);
    }

    #[test]
    fn a_repeated_level_moves_the_whole_asset_down_one_step_at_a_time() {
        let art = art(vec![level("a")], Some(ElevationRepeat::Level(1)));
        let resolved = resolve_tile_render(
            "mountain",
            &art,
            ProjectionMode::Isometric,
            3,
            0,
            0,
            CellArt::default(),
        );

        // One asset, three drops: the image is displaced, never transformed.
        assert!(resolved
            .layers
            .iter()
            .all(|layer| layer.asset == "assets/tiles/a.png"));
        assert_eq!(
            resolved
                .layers
                .iter()
                .map(|layer| layer.drop)
                .collect::<Vec<_>>(),
            vec![2, 1, 0]
        );
    }

    #[test]
    fn a_pattern_cycles_through_the_levels_it_names() {
        let art = art(
            vec![level("a"), level("b"), level("c")],
            Some(ElevationRepeat::Pattern(vec![2, 3])),
        );

        let sources: Vec<Option<u32>> = (1..=7).map(|l| art.elevation.source_level(l)).collect();
        assert_eq!(
            sources,
            vec![
                Some(1),
                Some(2),
                Some(3),
                Some(2),
                Some(3),
                Some(2),
                Some(3)
            ]
        );
    }

    #[test]
    fn a_pattern_naming_nothing_usable_falls_back_to_the_last_level() {
        let art = art(vec![level("a")], Some(ElevationRepeat::Pattern(vec![9])));
        assert_eq!(art.elevation.source_level(4), Some(1));
    }

    #[test]
    fn a_tall_cell_costs_no_extra_art() {
        let art = art(
            vec![level("a"), level("b")],
            Some(ElevationRepeat::Level(2)),
        );
        let resolved = resolve_tile_render(
            "mountain",
            &art,
            ProjectionMode::Isometric,
            100,
            0,
            0,
            CellArt::default(),
        );

        // The stack is capped, and every one of its layers reuses level 2's
        // single image: a hundred steps of relief cost no extra art.
        assert_eq!(resolved.layers.len() as u32, MAX_STACKED_LEVELS);
        assert!(resolved
            .layers
            .iter()
            .all(|layer| layer.asset == "assets/tiles/b.png" && layer.source_level == 2));
        assert_eq!(resolved.layers.last().expect("top").level, 100);
    }

    #[test]
    fn a_raised_cell_keeps_its_own_surface_at_every_height() {
        let art = art(
            vec![level("a"), level("b")],
            Some(ElevationRepeat::Level(2)),
        );

        for elevation in [0, 1, 2, 3, 12] {
            let resolved = resolve_tile_render(
                "mountain",
                &art,
                ProjectionMode::Isometric,
                elevation,
                0,
                0,
                CellArt::default(),
            );
            assert_eq!(
                resolved.surface.as_deref(),
                Some("assets/tiles/grass_01.png"),
                "elevation {elevation} lost its top face"
            );
            // And no face image ever claims to be one.
            assert!(resolved
                .layers
                .iter()
                .all(|layer| layer.asset != "assets/tiles/grass_01.png"));
        }
    }

    #[test]
    fn a_tile_with_faces_but_no_surface_draws_only_its_faces() {
        let art = TileArt {
            flat: Vec::new(),
            surface: Vec::new(),
            elevation: TileElevation {
                levels: vec![level("a")],
                repeat: None,
            },
        };
        let resolved = resolve_tile_render(
            "rock",
            &art,
            ProjectionMode::Isometric,
            2,
            0,
            0,
            CellArt::default(),
        );

        assert_eq!(resolved.surface, None);
        assert_eq!(resolved.layers.len(), 2);
    }

    #[test]
    fn only_the_visible_drop_is_drawn() {
        let art = art(vec![level("a")], None);
        // Standing at 5 next to neighbours at 4: one step of face shows.
        let resolved = resolve_tile_render(
            "mountain",
            &art,
            ProjectionMode::Isometric,
            5,
            4,
            0,
            CellArt::default(),
        );
        assert_eq!(resolved.layers.len(), 1);
        assert_eq!(resolved.layers[0].level, 5);
        assert_eq!(resolved.layers[0].drop, 0);
    }

    #[test]
    fn a_cell_dug_below_its_neighbours_still_draws_its_faces() {
        let art = art(vec![level("a")], None);
        let resolved = resolve_tile_render(
            "rock",
            &art,
            ProjectionMode::Isometric,
            -1,
            -3,
            0,
            CellArt::default(),
        );
        assert_eq!(resolved.layers.len(), 2);
        // Nothing is authored below level 1, so those steps borrow it.
        assert!(resolved.layers.iter().all(|layer| layer.source_level == 1));
    }

    #[test]
    fn variants_are_chosen_deterministically_and_differ_between_cells() {
        let salt = "grass";
        let a = variant_roll(3, 4, salt);
        assert_eq!(a, variant_roll(3, 4, salt));
        assert_ne!(a, variant_roll(4, 3, salt));
        assert_ne!(a, variant_roll(3, 4, "sand"));

        assert_eq!(variant_index(7, 4), Some(3));
        assert_eq!(variant_index(7, 0), None);
    }

    #[test]
    fn a_stack_keeps_one_face_the_whole_way_down() {
        // A cliff is *one* cut through *one* ground, so its layers agree: the
        // variety is between neighbouring cells and between levels, not down a
        // single column, where alternating faces read as a stack of bricks
        // (`docs/adr/ADR-0036-a-cell-may-choose-its-tile-art.md`).
        let art = TileArt {
            flat: Vec::new(),
            surface: vec![variant("top_a"), variant("top_b")],
            elevation: TileElevation {
                levels: vec![ElevationLevel {
                    name: String::new(),
                    variants: vec![variant("a"), variant("b")],
                }],
                repeat: None,
            },
        };
        let resolved = resolve_tile_render(
            "rock",
            &art,
            ProjectionMode::Isometric,
            4,
            0,
            1,
            CellArt::default(),
        );
        let assets: Vec<&str> = resolved
            .layers
            .iter()
            .map(|layer| layer.asset.as_str())
            .collect();
        assert_eq!(assets, vec!["assets/tiles/b.png"; 4]);
    }

    #[test]
    fn a_top_down_cell_draws_its_flat_image_and_no_relief() {
        // The two projections are two sets of pictures, and a top-down world
        // never reaches for the isometric ones: a surface is the top of a
        // squashed hexagon and fits the round one nowhere
        // (`docs/adr/ADR-0037-a-flat-map-is-drawn-from-flat-art.md`).
        let art = TileArt {
            flat: vec![variant("flat_a"), variant("flat_b")],
            surface: vec![variant("top_a"), variant("top_b")],
            elevation: TileElevation {
                levels: vec![ElevationLevel {
                    name: String::new(),
                    variants: vec![variant("a")],
                }],
                repeat: None,
            },
        };

        let resolved = resolve_tile_render(
            "rock",
            &art,
            ProjectionMode::TopDown,
            4,
            0,
            1,
            CellArt::default(),
        );
        assert_eq!(resolved.flat.as_deref(), Some("assets/tiles/flat_b.png"));
        assert_eq!(resolved.surface, None);
        assert!(resolved.layers.is_empty());
        assert!(!resolved.is_empty());

        // The same roll, drawn isometrically: the other set of images entirely.
        let isometric = resolve_tile_render(
            "rock",
            &art,
            ProjectionMode::Isometric,
            4,
            0,
            1,
            CellArt::default(),
        );
        assert_eq!(isometric.flat, None);
        assert_eq!(isometric.surface.as_deref(), Some("assets/tiles/top_b.png"));
        assert_eq!(isometric.layers.len(), 4);
    }

    #[test]
    fn a_tile_that_authors_no_flat_image_resolves_to_nothing_top_down() {
        // Which is what tells the renderer to fill `fallbackColor`, rather than
        // stretching a surface into a shape it was not drawn for.
        let art = TileArt {
            flat: Vec::new(),
            surface: vec![variant("top_a")],
            elevation: TileElevation::default(),
        };
        let resolved = resolve_tile_render(
            "rock",
            &art,
            ProjectionMode::TopDown,
            0,
            0,
            0,
            CellArt::default(),
        );
        assert!(resolved.is_empty());
    }

    #[test]
    fn a_chosen_variant_picks_the_same_letter_in_either_projection() {
        // One index serves both lists, so a cell that chose `b` shows `b`
        // whichever way the map is drawn — and wraps rather than losing its
        // picture when the two lists are different lengths.
        let art = TileArt {
            flat: vec![variant("flat_a"), variant("flat_b")],
            surface: vec![variant("top_a"), variant("top_b"), variant("top_c")],
            elevation: TileElevation::default(),
        };
        let chosen = CellArt {
            surface: Some(1),
            ..CellArt::default()
        };

        let flat = resolve_tile_render("rock", &art, ProjectionMode::TopDown, 0, 0, 0, chosen);
        assert_eq!(flat.flat.as_deref(), Some("assets/tiles/flat_b.png"));

        let tilted = resolve_tile_render("rock", &art, ProjectionMode::Isometric, 0, 0, 0, chosen);
        assert_eq!(tilted.surface.as_deref(), Some("assets/tiles/top_b.png"));

        // Index 2 exists among the surfaces and not among the flats; wrapping
        // keeps the cell a picture instead of a hole.
        let wrapped = CellArt {
            surface: Some(2),
            ..CellArt::default()
        };
        let flat = resolve_tile_render("rock", &art, ProjectionMode::TopDown, 0, 0, 0, wrapped);
        assert_eq!(flat.flat.as_deref(), Some("assets/tiles/flat_a.png"));
    }

    #[test]
    fn a_tile_with_faces_and_no_surface_still_picks_one_face() {
        // Nothing to follow, so the roll decides — and keeps deciding the same
        // thing, which is what makes the column read as one cut.
        let art = TileArt {
            flat: Vec::new(),
            surface: Vec::new(),
            elevation: TileElevation {
                levels: vec![ElevationLevel {
                    name: String::new(),
                    variants: vec![variant("a"), variant("b")],
                }],
                repeat: None,
            },
        };
        let resolved = resolve_tile_render(
            "rock",
            &art,
            ProjectionMode::Isometric,
            3,
            0,
            1,
            CellArt::default(),
        );
        assert!(resolved
            .layers
            .iter()
            .all(|layer| layer.asset == "assets/tiles/b.png"));
    }

    #[test]
    fn a_cut_takes_the_variant_its_surface_took() {
        // Two surfaces, two variants per level: the layer must follow the top
        // face rather than roll separately, so `grass_b` is undercut by `b`.
        let art = TileArt {
            flat: Vec::new(),
            surface: vec![variant("top_a"), variant("top_b")],
            elevation: TileElevation {
                levels: vec![ElevationLevel {
                    name: String::new(),
                    variants: vec![variant("face_a"), variant("face_b")],
                }],
                repeat: None,
            },
        };

        for (roll, top, face) in [(0, "top_a", "face_a"), (1, "top_b", "face_b")] {
            let resolved = resolve_tile_render(
                "rock",
                &art,
                ProjectionMode::Isometric,
                3,
                0,
                roll,
                CellArt::default(),
            );
            assert_eq!(
                resolved.surface.as_deref(),
                Some(format!("assets/tiles/{top}.png").as_str())
            );
            assert!(
                resolved
                    .layers
                    .iter()
                    .all(|layer| layer.asset == format!("assets/tiles/{face}.png")),
                "layers did not follow the surface for roll {roll}"
            );
        }
    }

    #[test]
    fn a_cell_may_name_its_own_surface_and_face() {
        let art = TileArt {
            flat: Vec::new(),
            surface: vec![variant("top_a"), variant("top_b")],
            elevation: TileElevation {
                levels: vec![ElevationLevel {
                    name: String::new(),
                    variants: vec![variant("face_a"), variant("face_b")],
                }],
                repeat: None,
            },
        };
        let resolved = resolve_tile_render(
            "rock",
            &art,
            ProjectionMode::Isometric,
            2,
            0,
            0,
            CellArt {
                surface: Some(1),
                elevation: None,
                elevation_variant: Some(0),
            },
        );

        assert_eq!(
            resolved.surface.as_deref(),
            Some("assets/tiles/top_b.png"),
            "the named surface was not used"
        );
        assert!(resolved
            .layers
            .iter()
            .all(|layer| layer.asset == "assets/tiles/face_a.png"));
    }

    #[test]
    fn a_cell_may_cut_its_faces_out_of_another_tiles_ladder() {
        // The point of the feature: grass on top, rock underneath. The top face
        // stays the cell's own, and not one layer comes from its own ladder.
        let meadow = art(vec![level("turf")], None);
        let cliff = art(vec![level("granite")], None);

        let resolved = resolve_tile_render(
            "grass",
            &meadow,
            ProjectionMode::Isometric,
            2,
            0,
            0,
            CellArt {
                surface: None,
                elevation: Some(&cliff),
                elevation_variant: None,
            },
        );

        assert_eq!(
            resolved.surface.as_deref(),
            Some("assets/tiles/grass_01.png")
        );
        assert_eq!(resolved.layers.len(), 2);
        assert!(resolved
            .layers
            .iter()
            .all(|layer| layer.asset == "assets/tiles/granite.png"));
    }

    #[test]
    fn a_borrowed_ladder_is_what_decides_whether_there_are_faces_at_all() {
        // A tile with no ladder of its own still draws a cliff when it borrows
        // one, and a tile that has one draws none when it borrows an empty one.
        let flat = TileArt {
            flat: Vec::new(),
            surface: vec![variant("turf")],
            elevation: TileElevation::default(),
        };
        let cliff = art(vec![level("granite")], None);

        let borrowed = resolve_tile_render(
            "grass",
            &flat,
            ProjectionMode::Isometric,
            3,
            0,
            0,
            CellArt {
                surface: None,
                elevation: Some(&cliff),
                elevation_variant: None,
            },
        );
        assert_eq!(borrowed.layers.len(), 3);

        let flattened = resolve_tile_render(
            "mountain",
            &cliff,
            ProjectionMode::Isometric,
            3,
            0,
            0,
            CellArt {
                surface: None,
                elevation: Some(&flat),
                elevation_variant: None,
            },
        );
        assert!(flattened.layers.is_empty());
    }

    #[test]
    fn a_chosen_variant_wraps_rather_than_dropping_a_layer() {
        // Three surfaces over a level that authors two faces: the third cell
        // still gets a cut, it just shares the first one's.
        let art = TileArt {
            flat: Vec::new(),
            surface: vec![variant("a"), variant("b"), variant("c")],
            elevation: TileElevation {
                levels: vec![ElevationLevel {
                    name: String::new(),
                    variants: vec![variant("face_a"), variant("face_b")],
                }],
                repeat: None,
            },
        };
        let resolved = resolve_tile_render(
            "rock",
            &art,
            ProjectionMode::Isometric,
            1,
            0,
            0,
            CellArt {
                surface: Some(2),
                elevation: None,
                elevation_variant: None,
            },
        );
        assert_eq!(resolved.surface.as_deref(), Some("assets/tiles/c.png"));
        assert_eq!(resolved.layers.len(), 1);
        assert_eq!(resolved.layers[0].asset, "assets/tiles/face_a.png");
    }

    #[test]
    fn art_round_trips_through_json() {
        let art = art(
            vec![level("a"), level("b")],
            Some(ElevationRepeat::Pattern(vec![1, 2])),
        );
        let json = serde_json::to_string(&art).expect("serialise");
        assert!(json.contains(r#""repeat":{"pattern":[1,2]}"#), "{json}");
        let reparsed: TileArt = serde_json::from_str(&json).expect("reparse");
        assert_eq!(art, reparsed);
    }

    #[test]
    fn a_tile_without_art_omits_it_from_the_file() {
        let empty = TileArt::default();
        assert_eq!(serde_json::to_string(&empty).expect("serialise"), "{}");
    }
}
