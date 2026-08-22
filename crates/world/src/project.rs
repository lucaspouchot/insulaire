//! The authored [`ProjectDefinition`]: which content files make up a game.
//!
//! A world file knows its own tile set and, through [`crate::MapLinkDefinition`],
//! the worlds it sends the player to — but nothing in a world says *where the
//! session starts* or *which files a build must ship*. That is what a project
//! answers, and it is why a delivered bundle can boot with no editor and no
//! backend: it reads one project file and loads exactly what it lists
//! (`docs/adr/ADR-0018-client-delivery-build.md`).
//!
//! The project is content like everything else: authored, versioned, validated
//! by the same Rust validator the runtime uses (ADR-0006, ADR-0015).

use serde::{Deserialize, Serialize};

/// Highest project schema version this build understands.
pub const PROJECT_SCHEMA_VERSION: u32 = 1;

/// Id of the zone a project falls back on when it declares none.
///
/// A project written before zones existed lists none, and every one of its maps
/// belongs to this implicit zone — which is what keeps such a file loadable.
pub const DEFAULT_ZONE_ID: &str = "default";

/// A group of maps that belong together.
///
/// A zone is the unit of *simulated scope*: a tick advances the maps of one
/// zone, not only the map the player stands on, so two maps in a zone share a
/// clock while a map in another zone does not
/// (`docs/adr/ADR-0021-map-zones.md`). Every map belongs to exactly one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoneDefinition {
    /// Stable id, referenced by `WorldDefinition::zone`.
    pub id: String,
    /// Human readable name; defaults to the id in the editor.
    #[serde(default)]
    pub name: String,
}

/// One content file the project ships.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentRef {
    /// Id of the content in the file — its `id` field.
    pub id: String,
    /// Path of the file, relative to the content root.
    pub path: String,
}

/// One language the game is available in, and the files that translate it.
///
/// Each file's [`ContentRef::id`] is its **namespace**: `locales/fr/menu.json`
/// registered as `menu` provides the keys under `menu.` — so the same key
/// exists in every language, and a translator works on one area at a time
/// (`docs/adr/ADR-0023-localised-content-keys.md`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageDefinition {
    /// Stable id, ideally a BCP 47 tag: `fr`, `en`, `pt-BR`.
    pub id: String,
    /// Name shown in the language picker, in that language.
    #[serde(default)]
    pub name: String,
    /// Locale files, by namespace.
    #[serde(default)]
    pub files: Vec<ContentRef>,
}

/// The languages a project ships, and which one stands in for the others.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalesDefinition {
    /// Id of the language a missing translation falls back to. Empty means the
    /// first declared.
    #[serde(default)]
    pub default: String,
    /// Every language, in author order.
    #[serde(default)]
    pub languages: Vec<LanguageDefinition>,
}

impl LocalesDefinition {
    /// Id of the fallback language, or `None` when the project declares none.
    #[must_use]
    pub fn default_language(&self) -> Option<&str> {
        if !self.default.is_empty() {
            return Some(self.default.as_str());
        }
        self.languages.first().map(|language| language.id.as_str())
    }

    /// The declared language with this id.
    #[must_use]
    pub fn language(&self, id: &str) -> Option<&LanguageDefinition> {
        self.languages.iter().find(|language| language.id == id)
    }

    /// `true` when the project declares no language at all.
    ///
    /// A project may: the application then uses the languages it ships for its
    /// own chrome, which is enough to open the editor and see a map.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.languages.is_empty()
    }
}

/// The set of content files that make up one game, and where it starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDefinition {
    /// Stable content id.
    pub id: String,
    /// Schema version of this file.
    pub schema_version: u32,
    /// Human readable name; shown by the client build.
    #[serde(default)]
    pub name: String,
    /// Id of the world a new session starts on.
    pub start_world: String,
    /// Zones the project's maps are grouped into, in author order.
    ///
    /// The **first is the default**: a world naming no zone belongs to it. An
    /// empty list means the single implicit [`DEFAULT_ZONE_ID`] zone.
    #[serde(default)]
    pub zones: Vec<ZoneDefinition>,
    /// Tile sets to load, in order.
    #[serde(default)]
    pub tile_sets: Vec<ContentRef>,
    /// Worlds to load, in order. Every world reachable through a map link must
    /// be listed here, or the link cannot resolve at runtime.
    #[serde(default)]
    pub worlds: Vec<ContentRef>,
    /// Character definitions to load, in order.
    ///
    /// A project may ship none: characters describe how an entity is *drawn*,
    /// and a map of coloured tokens needs no definition
    /// (`docs/adr/ADR-0028-character-definitions.md`).
    #[serde(default)]
    pub characters: Vec<ContentRef>,
    /// The player-facing character-creation workflow, if this game has one.
    ///
    /// The file contains generic choices and bindings. Words such as race or
    /// gender are author-owned ids, never fields of the engine
    /// (`docs/adr/ADR-0042-character-creation-is-a-generic-authored-workflow.md`).
    #[serde(default)]
    pub character_creation: Option<ContentRef>,
    /// The languages the game is available in, and their locale files.
    #[serde(default)]
    pub locales: LocalesDefinition,
    /// The title screen a client opens on, if the project authors one.
    ///
    /// Absent means the game starts on its `start_world` with no menu, which is
    /// what development wants and what a delivery should not do
    /// (`docs/adr/ADR-0024-authored-title-screen.md`).
    #[serde(default)]
    pub title_screen: Option<ContentRef>,
    /// The settings this game offers, if it declares any.
    ///
    /// The *application's* settings — volumes, interface scale, language — are
    /// not here: they configure the shell, not the game
    /// (`docs/adr/ADR-0025-settings.md`).
    #[serde(default)]
    pub settings: Option<ContentRef>,
}

impl ProjectDefinition {
    /// The file path listed for `world_id`, if the project ships it.
    #[must_use]
    pub fn world_path(&self, world_id: &str) -> Option<&str> {
        self.worlds
            .iter()
            .find(|entry| entry.id == world_id)
            .map(|entry| entry.path.as_str())
    }

    /// Id of the zone a world that names none belongs to.
    #[must_use]
    pub fn default_zone_id(&self) -> &str {
        self.zones
            .first()
            .map_or(DEFAULT_ZONE_ID, |zone| zone.id.as_str())
    }

    /// The zone `zone` names, resolving an empty one to the default.
    ///
    /// Zones are mandatory in the model even though the field is optional in the
    /// file: every map has one, and this is where "none authored" becomes it.
    #[must_use]
    pub fn resolve_zone<'a>(&'a self, zone: &'a str) -> &'a str {
        if zone.is_empty() {
            self.default_zone_id()
        } else {
            zone
        }
    }

    /// `true` when the project declares — or implies — a zone with this id.
    #[must_use]
    pub fn has_zone(&self, id: &str) -> bool {
        if self.zones.is_empty() {
            return id == DEFAULT_ZONE_ID;
        }
        self.zones.iter().any(|zone| zone.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = r#"{
        "id": "insulaire",
        "schemaVersion": 1,
        "startWorld": "demo_world",
        "tileSets": [{ "id": "mvp_terrain", "path": "tilesets/mvp_terrain.json" }],
        "worlds": [{ "id": "demo_world", "path": "worlds/demo_world.json" }]
    }"#;

    #[test]
    fn a_project_parses_and_round_trips() {
        let project: ProjectDefinition = serde_json::from_str(MINIMAL).expect("parse");
        assert_eq!(project.start_world, "demo_world");
        assert_eq!(project.name, "");
        assert_eq!(
            project.world_path("demo_world"),
            Some("worlds/demo_world.json")
        );
        assert_eq!(project.world_path("absent"), None);

        let serialised = serde_json::to_string(&project).expect("serialise");
        let reparsed: ProjectDefinition = serde_json::from_str(&serialised).expect("reparse");
        assert_eq!(project, reparsed);
    }

    #[test]
    fn a_project_without_zones_implies_the_default_one() {
        let project: ProjectDefinition = serde_json::from_str(MINIMAL).expect("parse");

        assert!(project.zones.is_empty());
        assert_eq!(project.default_zone_id(), DEFAULT_ZONE_ID);
        assert_eq!(project.resolve_zone(""), DEFAULT_ZONE_ID);
        assert!(project.has_zone(DEFAULT_ZONE_ID));
        assert!(!project.has_zone("valley"));
    }

    #[test]
    fn the_first_declared_zone_is_the_default() {
        let project: ProjectDefinition = serde_json::from_str(&MINIMAL.replace(
            r#""startWorld": "demo_world","#,
            r#""startWorld": "demo_world",
               "zones": [{ "id": "valley", "name": "Valley" }, { "id": "caves" }],"#,
        ))
        .expect("parse");

        assert_eq!(project.default_zone_id(), "valley");
        assert_eq!(project.resolve_zone(""), "valley");
        assert_eq!(project.resolve_zone("caves"), "caves");
        assert!(project.has_zone("caves"));
        // The implicit fallback is gone once a project declares its zones.
        assert!(!project.has_zone(DEFAULT_ZONE_ID));
    }
}
