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
//! TileDefinition + elevation + variant roll ──> resolve() ──> ResolvedTileRender
//! ```
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
/// Every image in the set shares [`width`](Self::width). A surface image is
/// [`surface_height`](Self::surface_height) tall and holds the top face alone.
/// An elevation image is [`elevation_height`](Self::elevation_height) tall and
/// holds **only the side faces**: its first row is the hexagon's lower shoulder
/// line, so its top [`shoulder_depth`](Self::shoulder_depth) rows are the `V`
/// the two lower edges cut and everything below that is face.
///
/// ```text
///   surface image            elevation image
///   ┌───────────────┐        ┌───────────────┐  ← the lower shoulders
///   │      ___      │        │ \           / │     shoulder_depth
///   │    /     \    │        │  \_________/  │  ←  the V the edges cut
///   │   |       |   │        │  |    |    |  │
///   │    \_____/    │        │  | SW | SE |  │     face_height
///   └───────────────┘        └───────────────┘
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileArtGeometry {
    /// Width of every image in the set, in authored pixels.
    pub width: u32,
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

/// Everything a tile is drawn from.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileArt {
    /// Images for the flat top face, one per variant. Empty draws the colour.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub surface: Vec<TileArtVariant>,
    /// The ladder of relief.
    #[serde(default, skip_serializing_if = "TileElevation::is_unauthored")]
    pub elevation: TileElevation,
}

impl TileArt {
    /// `true` when the tile declares no image at all.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.surface.is_empty() && self.elevation.is_empty()
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
/// The faces first, lowest to highest, then the top face over them — which is
/// why [`surface`](Self::surface) is filled in at every height rather than only
/// when the cell is flat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTileRender {
    /// The tile this resolves.
    pub tile_id: String,
    /// The cell's authored height.
    pub elevation: i32,
    /// The top face, at any height. Absent only when the tile authors none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<String>,
    /// The side faces, lowest first. Drawn *under* the surface.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub layers: Vec<ResolvedTileLayer>,
}

impl ResolvedTileRender {
    /// `true` when nothing is authored for this cell, so the renderer fills it
    /// with the tile's `fallbackColor` as it always has.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.surface.is_none() && self.layers.is_empty()
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

/// What to draw for a cell of `art` standing at `elevation` over `base`.
///
/// `base` is the height the cell's side faces reach down to — the lower of its
/// two front neighbours, which is what the renderer already computes so that a
/// cliff is extruded exactly as far as it is visible. `roll` is
/// [`variant_roll`] for the cell.
///
/// The stack runs from `base + 1` to `elevation`, one layer per visible step,
/// and each layer's `drop` is how many steps below the top face it sits. When
/// nothing is visible — a flat cell, or one no higher than its neighbours — the
/// surface image is the whole answer.
#[must_use]
pub fn resolve_tile_render(
    tile_id: &str,
    art: &TileArt,
    elevation: i32,
    base: i32,
    roll: u32,
) -> ResolvedTileRender {
    let steps = u32::try_from(elevation.saturating_sub(base))
        .unwrap_or(0)
        .min(MAX_STACKED_LEVELS);
    // The top face is the tile's own, at every height: an elevation image is
    // the faces and nothing else, so raising a cell never costs it the variety
    // its surfaces give it.
    let surface = pick(&art.surface, roll).map(|variant| variant.asset.clone());

    if steps == 0 || art.elevation.is_empty() {
        return ResolvedTileRender {
            tile_id: tile_id.to_owned(),
            elevation,
            surface,
            layers: Vec::new(),
        };
    }

    let mut layers = Vec::with_capacity(steps as usize);
    for drop in (0..steps).rev() {
        // `level` is the height this layer stands at. A cell dug below the
        // ground it fronts still needs its faces drawn, and levels at or below
        // zero have no art of their own, so they borrow level 1's.
        let height = elevation.saturating_sub(i32::try_from(drop).unwrap_or(0));
        let level = u32::try_from(height).unwrap_or(0).max(1);
        let Some(source_level) = art.elevation.source_level(level) else {
            continue;
        };
        let Some(source) = art.elevation.level(source_level) else {
            continue;
        };
        // Rolling with the level as well as the cell is what stops a tall cliff
        // repeating one rock face all the way down.
        let Some(variant) = pick(&source.variants, roll.wrapping_add(level)) else {
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
        surface,
        layers,
    }
}

fn pick(variants: &[TileArtVariant], roll: u32) -> Option<&TileArtVariant> {
    variant_index(roll, variants.len()).and_then(|index| variants.get(index))
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
        let resolved = resolve_tile_render("grass", &art, 0, 0, 0);

        assert_eq!(
            resolved.surface.as_deref(),
            Some("assets/tiles/grass_01.png")
        );
        assert!(resolved.layers.is_empty());
    }

    #[test]
    fn a_tile_with_no_art_resolves_to_nothing() {
        let resolved = resolve_tile_render("grass", &TileArt::default(), 3, 0, 0);
        assert!(resolved.is_empty());
    }

    #[test]
    fn explicit_levels_are_stacked_bottom_to_top() {
        let art = art(vec![level("a"), level("b"), level("c")], None);
        let resolved = resolve_tile_render("mountain", &art, 3, 0, 0);

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

        let resolved = resolve_tile_render("mountain", &art, 4, 0, 0);
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
        let resolved = resolve_tile_render("mountain", &art, 3, 0, 0);

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
        let resolved = resolve_tile_render("mountain", &art, 100, 0, 0);

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
            let resolved = resolve_tile_render("mountain", &art, elevation, 0, 0);
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
            surface: Vec::new(),
            elevation: TileElevation {
                levels: vec![level("a")],
                repeat: None,
            },
        };
        let resolved = resolve_tile_render("rock", &art, 2, 0, 0);

        assert_eq!(resolved.surface, None);
        assert_eq!(resolved.layers.len(), 2);
    }

    #[test]
    fn only_the_visible_drop_is_drawn() {
        let art = art(vec![level("a")], None);
        // Standing at 5 next to neighbours at 4: one step of face shows.
        let resolved = resolve_tile_render("mountain", &art, 5, 4, 0);
        assert_eq!(resolved.layers.len(), 1);
        assert_eq!(resolved.layers[0].level, 5);
        assert_eq!(resolved.layers[0].drop, 0);
    }

    #[test]
    fn a_cell_dug_below_its_neighbours_still_draws_its_faces() {
        let art = art(vec![level("a")], None);
        let resolved = resolve_tile_render("rock", &art, -1, -3, 0);
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
    fn a_stack_varies_its_variant_down_the_column() {
        let art = TileArt {
            surface: Vec::new(),
            elevation: TileElevation {
                levels: vec![ElevationLevel {
                    name: String::new(),
                    variants: vec![variant("a"), variant("b")],
                }],
                repeat: None,
            },
        };
        let resolved = resolve_tile_render("rock", &art, 4, 0, 0);
        let assets: Vec<&str> = resolved
            .layers
            .iter()
            .map(|layer| layer.asset.as_str())
            .collect();
        assert_eq!(
            assets,
            vec![
                "assets/tiles/b.png",
                "assets/tiles/a.png",
                "assets/tiles/b.png",
                "assets/tiles/a.png"
            ]
        );
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
