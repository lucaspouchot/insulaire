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

/// One content file the project ships.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentRef {
    /// Id of the content in the file — its `id` field.
    pub id: String,
    /// Path of the file, relative to the content root.
    pub path: String,
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
    /// Tile sets to load, in order.
    #[serde(default)]
    pub tile_sets: Vec<ContentRef>,
    /// Worlds to load, in order. Every world reachable through a map link must
    /// be listed here, or the link cannot resolve at runtime.
    #[serde(default)]
    pub worlds: Vec<ContentRef>,
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
}
