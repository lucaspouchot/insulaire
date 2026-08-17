//! The data transfer objects that cross the engine boundary.
//!
//! Everything here is `serde`-serialisable, `camelCase`, and deliberately flat.
//! Host applications never see a `GameState`, an `EntityStore` or a
//! `WorldDefinition`: they see these DTOs, which is what lets the internals
//! change without breaking the UI (see `docs/wasm-api.md`).
//!
//! Positions cross the boundary as **offset** coordinates `[col, row]`, the same
//! space authored files and the editor use. Axial coordinates are included on
//! entity snapshots as a convenience for renderers, never as the primary key.

use insulaire_simulation::{EntityRuntime, Rng, SimEvent};
use insulaire_world::{
    EntityKind, Hex, LinkTrigger, MapLinkDefinition, OffsetCoord, ProjectDefinition, ResolvedTile,
};
use serde::{Deserialize, Serialize};

/// A command sent from the host to the engine.
///
/// This is the *only* way the outside world changes the simulation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Command {
    /// Move the player onto an adjacent hex.
    MoveTo {
        /// Destination in offset coordinates.
        to: OffsetCoord,
    },
    /// Spend a tick without moving.
    Wait,
}

impl From<Command> for insulaire_simulation::Action {
    fn from(command: Command) -> Self {
        match command {
            Command::MoveTo { to } => insulaire_simulation::Action::MoveTo(Hex::from_offset(to)),
            Command::Wait => insulaire_simulation::Action::Wait,
        }
    }
}

/// Axial coordinates, exposed for renderers that prefer cube maths.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct AxialDto {
    /// Cube `q` axis.
    pub q: i32,
    /// Cube `r` axis.
    pub r: i32,
}

impl From<Hex> for AxialDto {
    fn from(hex: Hex) -> Self {
        Self {
            q: hex.q(),
            r: hex.r(),
        }
    }
}

/// One entity, as the UI sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitySnapshot {
    /// Compact runtime handle.
    pub id: u32,
    /// Authored id from the world file.
    pub content_id: String,
    /// Template the entity was instantiated from.
    pub template_id: String,
    /// `player` or `monster`.
    pub kind: EntityKind,
    /// Position in offset coordinates.
    pub at: OffsetCoord,
    /// The same position in axial coordinates.
    pub axial: AxialDto,
    /// Stable visual id for the renderer's sprite registry.
    pub visual_id: String,
    /// Colour used when no sprite is registered.
    pub fallback_color: String,
    /// Whether this entity blocks movement.
    pub blocks_movement: bool,
    /// Gameplay tags carried from the world file.
    pub tags: Vec<String>,
}

impl From<&EntityRuntime> for EntitySnapshot {
    fn from(entity: &EntityRuntime) -> Self {
        Self {
            id: entity.id().raw(),
            content_id: entity.content_id().to_owned(),
            template_id: entity.template_id().to_owned(),
            kind: entity.kind(),
            at: entity.position().to_offset(),
            axial: entity.position().into(),
            visual_id: entity.visual_id().to_owned(),
            fallback_color: entity.fallback_color().to_owned(),
            blocks_movement: entity.blocks_movement(),
            tags: entity.tags().to_vec(),
        }
    }
}

/// The RNG state, exposed so the UI can prove the engine is advancing.
///
/// The 64-bit fields are hex strings: JSON numbers lose precision above 2^53.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RngSnapshot {
    /// LCG state as `0x...`.
    pub state: String,
    /// Stream selector as `0x...`.
    pub increment: String,
    /// How many values have been drawn since the game started.
    pub draws: u64,
}

impl From<&Rng> for RngSnapshot {
    fn from(rng: &Rng) -> Self {
        Self {
            state: format!("{:#018x}", rng.state()),
            increment: format!("{:#018x}", rng.increment()),
            draws: rng.draws(),
        }
    }
}

/// The complete runtime state of a game, minus the world map.
///
/// The map is **not** part of this: it is authored, immutable, and travels once
/// through [`WorldView`] and the packed terrain buffer. A snapshot is therefore
/// a few hundred bytes regardless of map size.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSnapshot {
    /// Id of the world being played.
    pub world_id: String,
    /// Seed the game was created with.
    pub seed: u32,
    /// Ticks elapsed.
    pub tick: u64,
    /// The player entity, if the world defines one.
    pub player: Option<EntitySnapshot>,
    /// Every entity, including the player.
    pub entities: Vec<EntitySnapshot>,
    /// Hexes the player may legally move to right now, in canonical direction
    /// order. The UI highlights these instead of re-deriving adjacency.
    pub legal_moves: Vec<OffsetCoord>,
    /// Current RNG state.
    pub rng: RngSnapshot,
}

/// The result of dispatching a [`Command`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    /// `true` when the command was applied and the tick advanced.
    pub accepted: bool,
    /// Present only on rejection.
    pub rejection: Option<insulaire_simulation::Rejection>,
    /// Ordered observable changes.
    pub events: Vec<SimEvent>,
    /// The state after the command; unchanged when `accepted` is `false`.
    pub state: GameSnapshot,
}

/// A tile palette entry, for the renderer and the editor's terrain picker.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaletteEntry {
    /// Index into the packed terrain buffer.
    pub index: u32,
    /// Stable tile id.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Terrain family.
    pub terrain: String,
    /// Entry cost; `0` means impassable.
    pub movement_cost: u32,
    /// Convenience flag.
    pub passable: bool,
    /// Stable visual id.
    pub visual_id: String,
    /// Colour used when no sprite is registered.
    pub fallback_color: String,
    /// Gameplay tags.
    pub tags: Vec<String>,
}

impl PaletteEntry {
    pub(crate) fn new(index: usize, tile: &ResolvedTile) -> Self {
        Self {
            index: index as u32,
            id: tile.id.clone(),
            name: if tile.name.is_empty() {
                tile.id.clone()
            } else {
                tile.name.clone()
            },
            terrain: tile.terrain.clone(),
            movement_cost: tile.movement_cost,
            passable: tile.passable,
            visual_id: tile.visual_id.clone(),
            fallback_color: tile.fallback_color.clone(),
            tags: tile.tags.clone(),
        }
    }
}

/// An authored point of interest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationView {
    /// Stable id.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Position in offset coordinates.
    pub at: OffsetCoord,
    /// Gameplay tags.
    pub tags: Vec<String>,
}

/// An authored map link, as the UI sees it.
///
/// Republished so the client can draw the door and name where it leads without
/// re-reading the world file (`docs/adr/ADR-0017-map-links.md`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkView {
    /// Stable id.
    pub id: String,
    /// Display name.
    pub name: String,
    /// The cell that triggers it, in offset coordinates.
    pub at: OffsetCoord,
    /// Id of the world it leads to.
    pub target_world: String,
    /// Where the player arrives there, in offset coordinates.
    pub target_at: OffsetCoord,
    /// What makes it fire; currently always `"enter"`.
    pub trigger: String,
    /// Gameplay tags.
    pub tags: Vec<String>,
}

impl From<&MapLinkDefinition> for LinkView {
    fn from(link: &MapLinkDefinition) -> Self {
        Self {
            id: link.id.clone(),
            name: link.name.clone(),
            at: link.at,
            target_world: link.target_world.clone(),
            target_at: link.target_at,
            trigger: match link.trigger {
                LinkTrigger::Enter => "enter",
                LinkTrigger::Interact => "interact",
            }
            .to_owned(),
            tags: link.tags.clone(),
        }
    }
}

/// Everything the renderer needs about a loaded world *except* the per-cell
/// buffers, which travel separately as packed typed arrays.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldView {
    /// Stable world id.
    pub world_id: String,
    /// Display name.
    pub name: String,
    /// Columns.
    pub width: u32,
    /// Rows.
    pub height: u32,
    /// Hex orientation, currently always `"pointy"`.
    pub orientation: String,
    /// Authored render projection: `"topDown"` or `"isometric"`.
    ///
    /// Transported, never interpreted: the engine has no notion of pixels
    /// (`docs/adr/ADR-0016-isometric-projection.md`).
    pub projection: String,
    /// Id of the tile set this world paints with.
    pub tile_set_id: String,
    /// The palette that the packed terrain buffer indexes into.
    pub palette: Vec<PaletteEntry>,
    /// Authored points of interest.
    pub locations: Vec<LocationView>,
    /// Authored map links leaving this world.
    pub links: Vec<LinkView>,
    /// Length of the packed terrain and elevation buffers, i.e. `width * height`.
    pub cell_count: u32,
}

/// An entity template, for the editor's placement palette.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateView {
    /// Stable template id.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Simulation role.
    pub kind: EntityKind,
    /// Stable visual id.
    pub visual_id: String,
    /// Colour used when no sprite is registered.
    pub fallback_color: String,
}

/// A world known to the content registry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldSummary {
    /// Stable id.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Columns.
    pub width: u32,
    /// Rows.
    pub height: u32,
    /// Referenced tile set.
    pub tile_set_id: String,
    /// `true` when the world passed validation with no errors.
    pub valid: bool,
}

/// The loaded project manifest, as the UI sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectView {
    /// Stable project id.
    pub id: String,
    /// Display name.
    pub name: String,
    /// World a new session starts on.
    pub start_world: String,
    /// Ids of every world the project ships, in listed order.
    pub world_ids: Vec<String>,
}

impl From<&ProjectDefinition> for ProjectView {
    fn from(project: &ProjectDefinition) -> Self {
        Self {
            id: project.id.clone(),
            name: project.name.clone(),
            start_world: project.start_world.clone(),
            world_ids: project
                .worlds
                .iter()
                .map(|entry| entry.id.clone())
                .collect(),
        }
    }
}

/// What the content registry currently holds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSummary {
    /// Loaded tile set ids.
    pub tile_sets: Vec<String>,
    /// Loaded worlds.
    pub worlds: Vec<WorldSummary>,
    /// Known entity templates.
    pub templates: Vec<TemplateView>,
    /// The project manifest, when one has been loaded.
    pub project: Option<ProjectView>,
}

/// The outcome of loading one content file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadOutcome {
    /// Id of the loaded content.
    pub id: String,
    /// Validation findings; the content is registered only when `valid`.
    pub report: insulaire_world::ValidationReport,
}

/// Build identity of the engine, so the UI can prove which binary it is talking
/// to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    /// Crate name.
    pub name: String,
    /// Crate version.
    pub version: String,
    /// Architecture the engine was compiled for; `"wasm32"` in the browser.
    pub target_arch: String,
    /// Pointer width, `32` for the WASM build.
    pub pointer_width: u32,
    /// Highest supported world schema version.
    pub world_schema_version: u32,
    /// Highest supported tile set schema version.
    pub tile_set_schema_version: u32,
}

impl EngineInfo {
    /// Reports the identity of this build.
    #[must_use]
    pub fn current() -> Self {
        Self {
            name: env!("CARGO_PKG_NAME").to_owned(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
            target_arch: std::env::consts::ARCH.to_owned(),
            pointer_width: usize::BITS,
            world_schema_version: insulaire_world::WORLD_SCHEMA_VERSION,
            tile_set_schema_version: insulaire_world::TILE_SET_SCHEMA_VERSION,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_parse_from_the_wire_format() {
        let command: Command =
            serde_json::from_str(r#"{"type":"moveTo","to":[3,4]}"#).expect("parse");
        assert_eq!(
            command,
            Command::MoveTo {
                to: OffsetCoord::new(3, 4)
            }
        );
        assert_eq!(
            insulaire_simulation::Action::from(command),
            insulaire_simulation::Action::MoveTo(Hex::from_offset(OffsetCoord::new(3, 4)))
        );

        let wait: Command = serde_json::from_str(r#"{"type":"wait"}"#).expect("parse");
        assert_eq!(wait, Command::Wait);
    }

    #[test]
    fn rng_snapshots_use_hex_strings_to_survive_json() {
        let snapshot = RngSnapshot::from(&Rng::from_seed(1));
        assert!(snapshot.state.starts_with("0x"), "got {}", snapshot.state);
        assert_eq!(snapshot.state.len(), 18);
        assert_eq!(snapshot.increment.len(), 18);
    }

    #[test]
    fn engine_info_reports_the_compiled_target() {
        let info = EngineInfo::current();
        assert_eq!(info.name, "insulaire-engine");
        assert_eq!(
            info.world_schema_version,
            insulaire_world::WORLD_SCHEMA_VERSION
        );
        assert!(info.pointer_width == 32 || info.pointer_width == 64);
    }
}
