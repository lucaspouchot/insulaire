//! The authored [`WorldDefinition`] and its parts.
//!
//! A world definition is *immutable reference data*. It is never mutated by the
//! simulation: the runtime derives a [`crate::WorldGrid`] plus a
//! `GameState` from it (see `docs/adr/ADR-0003-authored-world.md`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::animation::PixelOffset;
use crate::hex::{MapBounds, OffsetCoord};

/// Furthest a placed decoration may be nudged from its anchor, in either axis.
///
/// A bound rather than a preference: a nudge is a few pixels of variety, and a
/// four-digit one is a typo that puts a tree on another map
/// (`docs/adr/ADR-0051-a-decoration-is-placed-and-the-placement-decides.md`).
pub const MAX_DECORATION_OFFSET: i32 = 256;

/// Highest world schema version this build understands.
///
/// Version 2 added [`PlacedTile::art`], the per-cell art choice
/// (`docs/adr/ADR-0036-a-cell-may-choose-its-tile-art.md`). Every field of it
/// is defaulted, so a version 1 file parses unchanged and rolls its art as it
/// always did. Version 3 adds the authored [`GridStyle`]; older files receive
/// its defaults and keep the renderer's former appearance. Version 4 adds
/// [`WorldDefinition::origin`] and [`WorldDefinition::shape`]: a map is a set of
/// hexes rather than a rectangle
/// (`docs/adr/ADR-0046-a-map-is-a-set-of-hexes.md`). Both default to what every
/// earlier file meant — anchored at `[0, 0]`, every cell present. Version 5 adds
/// the authored [`RevealStyle`], which says how far relief may be seen through
/// (`docs/adr/ADR-0047-relief-never-hides-a-hex.md`); its defaults reveal one
/// ring at half opacity. Version 6 adds [`WorldDefinition::decorations`]: the
/// trees, houses and chests standing on the map, each with the id a scenario
/// addresses and its own `interactive` bit
/// (`docs/adr/ADR-0051-a-decoration-is-placed-and-the-placement-decides.md`),
/// each free to sit a few pixels off its anchor. An earlier file places none,
/// which is what an absent list means.
pub const WORLD_SCHEMA_VERSION: u32 = 6;

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

/// Default height, in projected tile faces, of a 128-pixel character canvas.
pub const DEFAULT_CHARACTER_HEIGHT_TILES: f32 = 2.0;

/// Smallest map-wide character scale accepted by content validation.
pub const MIN_CHARACTER_HEIGHT_TILES: f32 = 0.25;

/// Largest map-wide character scale accepted by content validation.
pub const MAX_CHARACTER_HEIGHT_TILES: f32 = 8.0;

/// Default grid stroke width in screen pixels.
pub const DEFAULT_GRID_LINE_WIDTH: u8 = 1;

/// Smallest authored grid stroke width.
pub const MIN_GRID_LINE_WIDTH: u8 = 1;

/// Largest authored grid stroke width.
pub const MAX_GRID_LINE_WIDTH: u8 = 4;

/// Default grid stroke colour. Opacity is authored separately.
pub const DEFAULT_GRID_COLOR: &str = "#000000";

/// Default grid stroke opacity.
pub const DEFAULT_GRID_ALPHA: f32 = 0.25;

/// Authored appearance of the hex grid in both the editor and Play.
///
/// Visibility remains a per-view toggle. These values define how the grid is
/// drawn whenever it is visible; no simulation rule reads them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridStyle {
    /// Stroke width in screen pixels, independent of camera zoom.
    #[serde(default = "default_grid_line_width")]
    pub line_width: u8,
    /// Six-digit RGB colour. Alpha is kept separate for the editor control.
    #[serde(default = "default_grid_color")]
    pub color: String,
    /// Stroke opacity from transparent (`0`) to opaque (`1`).
    #[serde(default = "default_grid_alpha")]
    pub alpha: f32,
}

impl Default for GridStyle {
    fn default() -> Self {
        Self {
            line_width: DEFAULT_GRID_LINE_WIDTH,
            color: DEFAULT_GRID_COLOR.to_owned(),
            alpha: DEFAULT_GRID_ALPHA,
        }
    }
}

impl GridStyle {
    /// `true` when the renderer's historical appearance is unchanged.
    #[must_use]
    pub fn is_default(&self) -> bool {
        self == &Self::default()
    }
}

/// Default number of hex rings revealed around the hex the pointer rests on.
pub const DEFAULT_REVEAL_RADIUS: u8 = 1;

/// Largest authored reveal radius.
///
/// Every revealed hex costs one coverage measurement, so the radius is bounded
/// rather than free (`docs/adr/ADR-0047-relief-never-hides-a-hex.md`).
pub const MAX_REVEAL_RADIUS: u8 = 6;

/// Default opacity of the relief standing in front of the pointed-at hex.
///
/// Not `0`: a cell drawn away entirely takes its silhouette with it, and where
/// nothing stands behind it that is a hole in the map rather than a hex seen
/// through (`docs/adr/ADR-0047-relief-never-hides-a-hex.md`).
pub const DEFAULT_REVEAL_OPACITY: f32 = 0.25;

/// Default opacity of the relief standing in front of a revealed neighbour.
pub const DEFAULT_REVEAL_NEIGHBOUR_OPACITY: f32 = 0.55;

/// How far relief may be seen through when the pointer rests on a buried hex.
///
/// Both numbers are the opacity of **what stands in the way**, not of the hex
/// behind it: seeing a buried hex means drawing the relief in front of it
/// see-through, since drawing the hex back over that relief puts it in front of
/// the cliff it is behind (`docs/adr/ADR-0047-relief-never-hides-a-hex.md`).
/// Presentation only; no simulation rule reads it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealStyle {
    /// Hex rings around the pointed-at hex revealed with it; `0` reveals it alone.
    #[serde(default = "default_reveal_radius")]
    pub radius: u8,
    /// Opacity of the relief in front of the pointed-at hex, `0` to `1`.
    ///
    /// `1` leaves the relief alone and reveals nothing.
    #[serde(default = "default_reveal_opacity")]
    pub opacity: f32,
    /// The same for the relief in front of the ring around it.
    ///
    /// Higher than [`opacity`](Self::opacity) by default: the ring is context,
    /// and the hex being aimed at is the one that has to be readable.
    #[serde(default = "default_reveal_neighbour_opacity")]
    pub neighbour_opacity: f32,
}

impl Default for RevealStyle {
    fn default() -> Self {
        Self {
            radius: DEFAULT_REVEAL_RADIUS,
            opacity: DEFAULT_REVEAL_OPACITY,
            neighbour_opacity: DEFAULT_REVEAL_NEIGHBOUR_OPACITY,
        }
    }
}

impl RevealStyle {
    /// `true` when nothing but the defaults is authored.
    #[must_use]
    pub fn is_default(&self) -> bool {
        self == &Self::default()
    }
}

/// Whether a cell is part of the map or a hole in it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CellPresence {
    /// The map has this hex.
    #[default]
    Present,
    /// The map does not: nothing stands here, nothing walks here, nothing is
    /// drawn here.
    Absent,
}

impl CellPresence {
    /// The opposite presence, which is what an exception encodes.
    #[must_use]
    pub const fn inverted(self) -> Self {
        match self {
            Self::Present => Self::Absent,
            Self::Absent => Self::Present,
        }
    }

    /// `true` for [`CellPresence::Present`].
    #[must_use]
    pub const fn is_present(self) -> bool {
        matches!(self, Self::Present)
    }
}

/// Which of the extent's cells the map actually has.
///
/// Authored the way tiles are — a default plus the cells that differ — because
/// the two ways an author reaches a custom shape are opposites of each other:
/// carving a coastline out of a full canvas lists holes, drawing an archipelago
/// on an empty one lists hexes. Whichever list is shorter is the one written
/// (`docs/adr/ADR-0046-a-map-is-a-set-of-hexes.md`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapShape {
    /// What a cell is when the exception list does not name it.
    #[serde(default)]
    pub default: CellPresence,
    /// The cells that are the opposite of [`default`](Self::default).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exceptions: Vec<OffsetCoord>,
}

impl MapShape {
    /// `true` when the map is the full rectangle every map used to be.
    ///
    /// The value a file may leave out, and the one every world authored before
    /// schema version 4 means.
    #[must_use]
    pub fn is_full(&self) -> bool {
        self.default.is_present() && self.exceptions.is_empty()
    }

    /// Whether the map has `at`, ignoring the extent.
    ///
    /// Linear in the exception list, so this is for the handful of authored
    /// records a validator checks — never for a per-cell loop. Flattening the
    /// shape into a buffer is [`crate::WorldGrid`]'s job.
    #[must_use]
    pub fn presence_at(&self, at: OffsetCoord) -> CellPresence {
        if self.exceptions.contains(&at) {
            self.default.inverted()
        } else {
            self.default
        }
    }
}

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
    /// North-west corner of the extent; the coordinate stored at buffer index
    /// `0`.
    ///
    /// Defaults to `[0, 0]`, which is where every map was anchored before
    /// extents could move. Extending a map northwards or westwards moves this
    /// rather than renumbering the cells, so an authored coordinate keeps its
    /// hex — and its row parity — forever
    /// (`docs/adr/ADR-0046-a-map-is-a-set-of-hexes.md`).
    #[serde(default, skip_serializing_if = "OffsetCoord::is_origin")]
    pub origin: OffsetCoord,
    /// Number of columns the extent covers.
    pub width: u32,
    /// Number of rows the extent covers.
    pub height: u32,
    /// Which of those cells the map actually has.
    ///
    /// Omitted — the usual case, and what every pre-version-4 file means — is
    /// the full rectangle.
    #[serde(default, skip_serializing_if = "MapShape::is_full")]
    pub shape: MapShape,
    /// Hex orientation.
    #[serde(default)]
    pub orientation: HexOrientation,
    /// How the renderer projects this map. Never read by the simulation.
    #[serde(default)]
    pub projection: ProjectionMode,
    /// Projected tile-face heights occupied by a 128-pixel character canvas.
    ///
    /// Presentation only. Rust transports and validates it; the map renderer
    /// applies it (`docs/adr/ADR-0044-map-entity-presentation.md`).
    #[serde(
        default = "default_character_height_tiles",
        skip_serializing_if = "is_default_character_height_tiles"
    )]
    pub character_height_tiles: f32,
    /// Grid appearance shared by editor preview and gameplay rendering.
    #[serde(default, skip_serializing_if = "GridStyle::is_default")]
    pub grid: GridStyle,
    /// How far relief may be seen through around the pointer.
    ///
    /// Presentation, transported and validated here and applied by the map
    /// renderer (`docs/adr/ADR-0047-relief-never-hides-a-hex.md`).
    #[serde(default, skip_serializing_if = "RevealStyle::is_default")]
    pub reveal: RevealStyle,
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
    /// Decorations standing on this map's cells.
    ///
    /// Several may share a cell, and each is drawn in the plane its definition
    /// declares — everything `behind`, then the characters, then everything
    /// `front` (`docs/adr/ADR-0048-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
    #[serde(default)]
    pub decorations: Vec<PlacedDecoration>,
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
    /// The rectangle this map's dense buffers cover.
    #[must_use]
    pub const fn bounds(&self) -> MapBounds {
        MapBounds::new(self.origin, self.width, self.height)
    }

    /// Number of cells the extent covers, present or not.
    ///
    /// This is the length of the packed buffers, not the size of the world:
    /// what the map *has* is [`WorldGrid::present_cell_count`](crate::WorldGrid::present_cell_count).
    #[must_use]
    pub const fn cell_count(&self) -> usize {
        self.bounds().cell_count()
    }

    /// Whether the map has the hex at `at`.
    ///
    /// A coordinate outside the extent is absent like any other hole: the
    /// extent is storage, and no authored record may lean on it
    /// (`docs/adr/ADR-0046-a-map-is-a-set-of-hexes.md`).
    #[must_use]
    pub fn has_cell(&self, at: OffsetCoord) -> bool {
        self.bounds().contains(at) && self.shape.presence_at(at).is_present()
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

/// One decoration standing on one cell.
///
/// The *definition* says what a tree looks like, where its trunk sits and which
/// side of the characters it is drawn on. This says **which** tree, **where**,
/// and — the field that only makes sense once a thing exists in the world —
/// whether *this* one can be interacted with
/// (`docs/adr/ADR-0051-a-decoration-is-placed-and-the-placement-decides.md`).
///
/// [`Self::id`] is unique within the map because that is what a scenario
/// addresses: one definition is placed a dozen times, and only one of those
/// chests holds the letter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacedDecoration {
    /// Stable id, unique within this world.
    pub id: String,
    /// Referenced [`crate::DecorationDefinition::id`].
    pub decoration: String,
    /// Offset position `[col, row]`.
    pub at: OffsetCoord,
    /// Whole-pixel nudge from where the definition's anchor puts it.
    ///
    /// `[0, 0]` — the usual case — is exactly what the decoration editor
    /// authored: the anchor pixel on the cell's ground point. A nudge is what
    /// keeps a row of the same fence post from reading as a stamped pattern,
    /// and it is per *placement* because that is the only thing that differs
    /// between two trees drawn from one definition
    /// (`docs/adr/ADR-0051-a-decoration-is-placed-and-the-placement-decides.md`).
    ///
    /// Positive moves the drawing right and down, which is the direction
    /// dragging it in the editor moves it. Measured in the tile set's authored
    /// pixels, like every other length in the format.
    #[serde(default, skip_serializing_if = "is_zero_offset")]
    pub offset: PixelOffset,
    /// Whether a player may interact with **this** placement.
    ///
    /// *Whether*, never *what*: opening a chest and searching a bush are
    /// scenario content, and an `if this is a chest` in the engine is the thing
    /// `CLAUDE.md` forbids (`docs/adr/ADR-0005-scenario-runtime.md`).
    #[serde(default, skip_serializing_if = "is_false")]
    pub interactive: bool,
    /// Free-form gameplay tags, as everywhere else in the format.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
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
const fn is_false(value: &bool) -> bool {
    !*value
}

#[allow(clippy::trivially_copy_pass_by_ref)] // required shape for `skip_serializing_if`
fn is_zero_offset(value: &PixelOffset) -> bool {
    value.is_zero()
}

#[allow(clippy::trivially_copy_pass_by_ref)] // required shape for `skip_serializing_if`
fn is_zero(value: &i32) -> bool {
    *value == 0
}

fn default_character_height_tiles() -> f32 {
    DEFAULT_CHARACTER_HEIGHT_TILES
}

#[allow(clippy::trivially_copy_pass_by_ref)] // required shape for `skip_serializing_if`
fn is_default_character_height_tiles(value: &f32) -> bool {
    *value == DEFAULT_CHARACTER_HEIGHT_TILES
}

const fn default_reveal_radius() -> u8 {
    DEFAULT_REVEAL_RADIUS
}

const fn default_reveal_opacity() -> f32 {
    DEFAULT_REVEAL_OPACITY
}

const fn default_reveal_neighbour_opacity() -> f32 {
    DEFAULT_REVEAL_NEIGHBOUR_OPACITY
}

const fn default_grid_line_width() -> u8 {
    DEFAULT_GRID_LINE_WIDTH
}

fn default_grid_color() -> String {
    DEFAULT_GRID_COLOR.to_owned()
}

const fn default_grid_alpha() -> f32 {
    DEFAULT_GRID_ALPHA
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = r#"{
        "id": "tiny",
        "schemaVersion": 3,
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
        assert_eq!(world.character_height_tiles, DEFAULT_CHARACTER_HEIGHT_TILES);
        assert_eq!(world.grid, GridStyle::default());
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
        assert!(!serialised.contains("\"grid\""));
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
    fn a_custom_reveal_round_trips_and_the_default_is_omitted() {
        let world: WorldDefinition = serde_json::from_str(MINIMAL).expect("parse");
        assert_eq!(world.reveal, RevealStyle::default());
        assert!(!serde_json::to_string(&world)
            .expect("serialise")
            .contains("\"reveal\""));

        let custom: WorldDefinition = serde_json::from_str(&MINIMAL.replace(
            r#""width": 3,"#,
            r#""width": 3, "reveal": { "radius": 3, "opacity": 0.1, "neighbourOpacity": 0.25 },"#,
        ))
        .expect("parse");
        assert_eq!(custom.reveal.radius, 3);
        assert_eq!(custom.reveal.opacity, 0.1);
        assert_eq!(custom.reveal.neighbour_opacity, 0.25);
        assert!(serde_json::to_string(&custom)
            .expect("serialise")
            .contains(r#""reveal":{"radius":3,"opacity":0.1,"neighbourOpacity":0.25}"#));
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

    #[test]
    fn a_custom_character_height_round_trips_and_the_default_is_omitted() {
        let default: WorldDefinition = serde_json::from_str(MINIMAL).expect("parse");
        assert!(!serde_json::to_string(&default)
            .expect("serialise")
            .contains("characterHeightTiles"));

        let custom: WorldDefinition = serde_json::from_str(&MINIMAL.replace(
            r#""width": 3,"#,
            r#""width": 3, "characterHeightTiles": 2.75,"#,
        ))
        .expect("parse");
        assert_eq!(custom.character_height_tiles, 2.75);
        assert!(serde_json::to_string(&custom)
            .expect("serialise")
            .contains(r#""characterHeightTiles":2.75"#));
    }

    #[test]
    fn a_custom_grid_style_round_trips_and_the_default_is_omitted() {
        let default: WorldDefinition = serde_json::from_str(MINIMAL).expect("parse");
        assert!(!serde_json::to_string(&default)
            .expect("serialise")
            .contains("\"grid\""));

        let custom: WorldDefinition = serde_json::from_str(&MINIMAL.replace(
            r#""width": 3,"#,
            r##""width": 3, "grid": { "lineWidth": 3, "color": "#336699", "alpha": 0.6 },"##,
        ))
        .expect("parse");
        assert_eq!(custom.grid.line_width, 3);
        assert_eq!(custom.grid.color, "#336699");
        assert_eq!(custom.grid.alpha, 0.6);
        assert!(serde_json::to_string(&custom)
            .expect("serialise")
            .contains(r##""grid":{"lineWidth":3,"color":"#336699","alpha":0.6}"##));
    }
}
