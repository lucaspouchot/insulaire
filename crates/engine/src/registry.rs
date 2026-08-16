//! The content registry.
//!
//! Authored files are parsed and validated once, then kept in memory keyed by
//! their stable id. Worlds are only registered when validation reports no
//! errors, which is what makes "the editor exported it, therefore the runtime
//! can load it" a guarantee rather than a hope.

use std::collections::BTreeMap;

use hex_world::{
    validate_tile_set, validate_world, TemplateRegistry, TileSetDefinition, ValidationReport,
    WorldDefinition,
};

use crate::error::EngineError;

/// Parsed, validated content available to the engine.
#[derive(Debug, Clone, Default)]
pub struct ContentRegistry {
    tile_sets: BTreeMap<String, TileSetDefinition>,
    worlds: BTreeMap<String, WorldDefinition>,
    templates: TemplateRegistry,
}

impl ContentRegistry {
    /// An empty registry with the built-in entity templates.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The entity templates known to this engine build.
    #[must_use]
    pub const fn templates(&self) -> &TemplateRegistry {
        &self.templates
    }

    /// Parses and registers a tile set.
    ///
    /// # Errors
    ///
    /// [`EngineError::Parse`] when the JSON is malformed, or
    /// [`EngineError::Invalid`] when the tile set fails validation.
    pub fn load_tile_set(&mut self, json: &str) -> Result<(String, ValidationReport), EngineError> {
        let tile_set: TileSetDefinition =
            serde_json::from_str(json).map_err(|source| EngineError::Parse {
                what: "tile set".to_owned(),
                message: source.to_string(),
            })?;

        let report = validate_tile_set(&tile_set);
        if !report.valid {
            return Err(EngineError::Invalid {
                what: format!("tile set `{}`", tile_set.id),
                report: Box::new(report),
            });
        }

        let id = tile_set.id.clone();
        self.tile_sets.insert(id.clone(), tile_set);
        Ok((id, report))
    }

    /// Parses and registers a world, validating it against its tile set.
    ///
    /// # Errors
    ///
    /// [`EngineError::Parse`] when the JSON is malformed, or
    /// [`EngineError::Invalid`] when the world fails validation. Warnings do not
    /// prevent registration.
    pub fn load_world(&mut self, json: &str) -> Result<(String, ValidationReport), EngineError> {
        let world = Self::parse_world(json)?;
        let report = self.validate(&world);
        if !report.valid {
            return Err(EngineError::Invalid {
                what: format!("world `{}`", world.id),
                report: Box::new(report),
            });
        }

        let id = world.id.clone();
        self.worlds.insert(id.clone(), world);
        Ok((id, report))
    }

    /// Validates a world without registering it.
    ///
    /// This is what the editor calls before exporting.
    ///
    /// # Errors
    ///
    /// [`EngineError::Parse`] when the JSON is malformed. A world that parses
    /// but is unusable produces an invalid report rather than an error.
    pub fn validate_world_json(&self, json: &str) -> Result<ValidationReport, EngineError> {
        let world = Self::parse_world(json)?;
        Ok(self.validate(&world))
    }

    fn parse_world(json: &str) -> Result<WorldDefinition, EngineError> {
        serde_json::from_str(json).map_err(|source| EngineError::Parse {
            what: "world".to_owned(),
            message: source.to_string(),
        })
    }

    fn validate(&self, world: &WorldDefinition) -> ValidationReport {
        validate_world(
            world,
            self.tile_sets.get(&world.tile_set_id),
            &self.templates,
        )
    }

    /// A registered world.
    #[must_use]
    pub fn world(&self, id: &str) -> Option<&WorldDefinition> {
        self.worlds.get(id)
    }

    /// A registered tile set.
    #[must_use]
    pub fn tile_set(&self, id: &str) -> Option<&TileSetDefinition> {
        self.tile_sets.get(id)
    }

    /// The tile set a world paints with.
    #[must_use]
    pub fn tile_set_for(&self, world: &WorldDefinition) -> Option<&TileSetDefinition> {
        self.tile_sets.get(&world.tile_set_id)
    }

    /// Registered world ids, sorted.
    #[must_use]
    pub fn world_ids(&self) -> Vec<String> {
        self.worlds.keys().cloned().collect()
    }

    /// Registered tile set ids, sorted.
    #[must_use]
    pub fn tile_set_ids(&self) -> Vec<String> {
        self.tile_sets.keys().cloned().collect()
    }

    /// All registered worlds, sorted by id.
    pub fn worlds(&self) -> impl Iterator<Item = &WorldDefinition> {
        self.worlds.values()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tile_set_json() -> String {
        serde_json::to_string(&hex_world::testing::sample_tile_set()).expect("serialise")
    }

    fn world_json() -> String {
        serde_json::to_string(&hex_world::testing::sample_world()).expect("serialise")
    }

    fn loaded() -> ContentRegistry {
        let mut registry = ContentRegistry::new();
        registry
            .load_tile_set(&tile_set_json())
            .expect("tile set loads");
        registry.load_world(&world_json()).expect("world loads");
        registry
    }

    #[test]
    fn loading_registers_content_under_its_stable_id() {
        let registry = loaded();
        assert_eq!(registry.tile_set_ids(), vec!["mvp_terrain"]);
        assert_eq!(registry.world_ids(), vec!["sample_world"]);
        assert!(registry.world("sample_world").is_some());
        assert!(registry
            .tile_set_for(registry.world("sample_world").expect("world"))
            .is_some());
    }

    #[test]
    fn malformed_json_is_a_parse_error_not_a_panic() {
        let mut registry = ContentRegistry::new();
        let error = registry.load_world("{ not json").expect_err("should fail");
        assert!(matches!(error, EngineError::Parse { .. }));
        assert_eq!(error.code(), "parse");
    }

    #[test]
    fn a_world_referencing_an_unloaded_tile_set_is_refused() {
        let mut registry = ContentRegistry::new();
        let error = registry.load_world(&world_json()).expect_err("should fail");
        match error {
            EngineError::Invalid { report, .. } => {
                assert!(report
                    .issues
                    .iter()
                    .any(|issue| issue.code == "world.unknownTileSet"));
            }
            other => panic!("unexpected error: {other}"),
        }
        assert!(
            registry.world_ids().is_empty(),
            "invalid content must not be registered"
        );
    }

    #[test]
    fn validation_does_not_register_anything() {
        let mut registry = ContentRegistry::new();
        registry
            .load_tile_set(&tile_set_json())
            .expect("tile set loads");

        let report = registry.validate_world_json(&world_json()).expect("parses");
        assert!(report.valid);
        assert!(
            registry.world_ids().is_empty(),
            "validate must be side-effect free"
        );
    }

    #[test]
    fn reloading_a_world_replaces_the_previous_definition() {
        let mut registry = loaded();
        let mut world = hex_world::testing::sample_world();
        world.name = "Renamed".into();
        registry
            .load_world(&serde_json::to_string(&world).expect("serialise"))
            .expect("reload");

        assert_eq!(registry.world_ids().len(), 1);
        assert_eq!(
            registry.world("sample_world").expect("world").name,
            "Renamed"
        );
    }

    #[test]
    fn warnings_do_not_block_registration() {
        let mut registry = ContentRegistry::new();
        registry
            .load_tile_set(&tile_set_json())
            .expect("tile set loads");

        let mut world = hex_world::testing::sample_world();
        world
            .entities
            .retain(|entity| entity.template_id == "player");

        let (id, report) = registry
            .load_world(&serde_json::to_string(&world).expect("serialise"))
            .expect("a world without monsters is still loadable");
        assert_eq!(id, "sample_world");
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.code == "world.noMonsters"));
    }
}
