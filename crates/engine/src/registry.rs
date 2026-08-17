//! The content registry.
//!
//! Authored files are parsed and validated once, then kept in memory keyed by
//! their stable id. Worlds are only registered when validation reports no
//! errors, which is what makes "the editor exported it, therefore the runtime
//! can load it" a guarantee rather than a hope.

use std::collections::BTreeMap;

use hex_world::{
    validate_project, validate_project_links, validate_project_zones, validate_tile_set,
    validate_world, ProjectDefinition, TemplateRegistry, TileSetDefinition, ValidationReport,
    WorldDefinition,
};

use crate::error::EngineError;

/// Parsed, validated content available to the engine.
#[derive(Debug, Clone, Default)]
pub struct ContentRegistry {
    tile_sets: BTreeMap<String, TileSetDefinition>,
    worlds: BTreeMap<String, WorldDefinition>,
    templates: TemplateRegistry,
    project: Option<ProjectDefinition>,
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

    /// Parses and registers the project manifest.
    ///
    /// Load it **after** the content it lists: the project is validated against
    /// what is actually in the registry, so that a bundle missing a file fails
    /// at load time rather than when a player walks through a door
    /// (`docs/adr/ADR-0018-client-delivery-build.md`).
    ///
    /// # Errors
    ///
    /// [`EngineError::Parse`] when the JSON is malformed, or
    /// [`EngineError::Invalid`] when the manifest references content that is not
    /// loaded.
    pub fn load_project(&mut self, json: &str) -> Result<(String, ValidationReport), EngineError> {
        let project: ProjectDefinition =
            serde_json::from_str(json).map_err(|source| EngineError::Parse {
                what: "project".to_owned(),
                message: source.to_string(),
            })?;

        // Two questions, one verdict: does the manifest hold together, and does
        // every loaded map name a zone this project declares?
        let report = validate_project(&project, &self.world_ids(), &self.tile_set_ids())
            .merge(validate_project_zones(&project, self.worlds.values()));
        if !report.valid {
            return Err(EngineError::Invalid {
                what: format!("project `{}`", project.id),
                report: Box::new(report),
            });
        }

        let id = project.id.clone();
        self.project = Some(project);
        Ok((id, report))
    }

    /// The registered project manifest, if one was loaded.
    #[must_use]
    pub const fn project(&self) -> Option<&ProjectDefinition> {
        self.project.as_ref()
    }

    /// Forgets every loaded tile set, world and project.
    ///
    /// Loading is otherwise additive — a world stays registered under its id
    /// until something replaces it — which is wrong for a *set* of content: an
    /// editor that removed a map, or a client that switched project, would keep
    /// validating links against worlds that no longer exist. Callers that
    /// re-load a whole project start from here.
    ///
    /// A game already in progress is unaffected: it holds its own `Arc` to the
    /// grid it is playing.
    pub fn clear(&mut self) {
        self.tile_sets.clear();
        self.worlds.clear();
        self.project = None;
    }

    /// Resolves every map link across all registered worlds.
    ///
    /// Single-world validation cannot do this — a link's target lives in another
    /// file — so this is the check that says a *set* of maps hangs together
    /// (`docs/adr/ADR-0017-map-links.md`).
    #[must_use]
    pub fn validate_links(&self) -> ValidationReport {
        validate_project_links(self.worlds.values(), |id| self.tile_sets.get(id))
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

    fn project_json(start_world: &str) -> String {
        format!(
            r#"{{"id":"demo","schemaVersion":1,"name":"Demo","startWorld":"{start_world}",
               "tileSets":[{{"id":"mvp_terrain","path":"tilesets/mvp_terrain.json"}}],
               "worlds":[{{"id":"linked_world","path":"worlds/linked_world.json"}},
                         {{"id":"interior_world","path":"worlds/interior_world.json"}}]}}"#
        )
    }

    fn linked_registry() -> ContentRegistry {
        let mut registry = ContentRegistry::new();
        registry
            .load_tile_set(&tile_set_json())
            .expect("tile set loads");
        for world in [
            hex_world::testing::linked_world(),
            hex_world::testing::interior_world(),
        ] {
            registry
                .load_world(&serde_json::to_string(&world).expect("serialise"))
                .expect("world loads");
        }
        registry
    }

    #[test]
    fn links_resolve_once_every_world_is_registered() {
        let mut registry = ContentRegistry::new();
        registry
            .load_tile_set(&tile_set_json())
            .expect("tile set loads");
        registry
            .load_world(&serde_json::to_string(&hex_world::testing::linked_world()).expect("json"))
            .expect("a world with an unresolved link still loads on its own");

        let report = registry.validate_links();
        assert!(!report.valid, "the target world is missing");
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.code == "link.unknownTargetWorld"));

        assert!(linked_registry().validate_links().valid);
    }

    #[test]
    fn a_project_is_validated_against_what_is_loaded() {
        let mut registry = linked_registry();
        let (id, report) = registry
            .load_project(&project_json("linked_world"))
            .expect("project loads");
        assert_eq!(id, "demo");
        assert!(report.valid);
        assert_eq!(
            registry
                .project()
                .map(|project| project.start_world.as_str()),
            Some("linked_world")
        );

        let error = registry
            .load_project(&project_json("absent_world"))
            .expect_err("an unknown start world must be refused");
        assert_eq!(error.code(), "invalidContent");
    }

    /// A zone id resolves only against the project that declares it, so loading
    /// the manifest is where a map in a zone nobody declared is caught
    /// (`docs/adr/ADR-0021-map-zones.md`).
    #[test]
    fn a_project_refuses_a_world_in_a_zone_it_does_not_declare() {
        let mut registry = ContentRegistry::new();
        registry
            .load_tile_set(&tile_set_json())
            .expect("tile set loads");

        let mut world = hex_world::testing::linked_world();
        world.zone = "caves".to_owned();
        registry
            .load_world(&serde_json::to_string(&world).expect("serialise"))
            .expect("a world validates on its own whatever zone it names");
        registry
            .load_world(
                &serde_json::to_string(&hex_world::testing::interior_world()).expect("serialise"),
            )
            .expect("world loads");

        let error = registry
            .load_project(&project_json("linked_world"))
            .expect_err("the project declares no `caves`");
        assert_eq!(error.code(), "invalidContent");

        // Declaring it makes the same content load.
        let declared = project_json("linked_world").replace(
            r#""startWorld":"linked_world","#,
            r#""startWorld":"linked_world","zones":[{"id":"caves","name":"Caves"}],"#,
        );
        registry.load_project(&declared).expect("project loads");
    }

    #[test]
    fn clearing_forgets_every_piece_of_content() {
        // Loading is additive, so re-loading a project that dropped a map has to
        // start from an empty registry or the removed map keeps answering.
        let mut registry = linked_registry();
        registry
            .load_project(&project_json("linked_world"))
            .expect("project loads");

        registry.clear();

        assert!(registry.world_ids().is_empty());
        assert!(registry.tile_set_ids().is_empty());
        assert!(registry.project().is_none());
        assert!(
            registry.validate_links().valid,
            "no worlds means no unresolved links"
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
