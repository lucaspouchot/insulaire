//! The content registry, and the list of content kinds it holds.
//!
//! Authored files are parsed and validated once, then kept in memory keyed by
//! their stable id. Content is only registered when validation reports no
//! errors, which is what makes "the editor exported it, therefore the runtime
//! can load it" a guarantee rather than a hope.
//!
//! The parsing, the refusal and the reading back are [`crate::kind`]'s, written
//! once for every kind. What is here is the list of kinds — each stating what
//! it is called, what it parses into, where it lives and which validator judges
//! it — and the three questions that are about the *set* rather than about one
//! file: which languages answer which keys, whether the manifest names content
//! that is actually loaded, and whether every map link resolves.

use std::collections::BTreeMap;

use insulaire_world::{
    validate_character, validate_character_creation, validate_decoration, validate_locales,
    validate_object, validate_placed_decorations, validate_project, validate_project_links,
    validate_project_zones, validate_settings, validate_tile_set, validate_title_screen,
    validate_world, CharacterCreationDefinition, CharacterDefinition, DecorationDefinition,
    LoadedContent, LocaleBundle, ObjectDefinition, ProjectDefinition, SettingsDefinition,
    TemplateRegistry, TileSetDefinition, TitleScreenDefinition, ValidationReport, WorldDefinition,
};

use crate::error::EngineError;
use crate::kind::{content_kinds, Keyed, Sole};

content_kinds! {
    /// Parsed, validated content available to the engine.
    pub struct ContentRegistry {
        /// The entity templates this engine build knows, which are code rather
        /// than content and so survive every reset.
        templates: TemplateRegistry,
        /// One merged bundle per language. Not a content kind: a locale file
        /// has no id, several files merge into one bundle, and it is keyed by
        /// language and namespace rather than by itself
        /// (`docs/adr/ADR-0020-localised-content-keys.md`).
        locales: BTreeMap<String, LocaleBundle>,
    }

    many {
        /// The tiles a world paints with.
        TileSet {
            what: "tile set",
            of: TileSetDefinition,
            at: tile_sets,
            validate: |_registry, tile_set| validate_tile_set(tile_set),
        }

        /// One authored map.
        World {
            what: "world",
            of: WorldDefinition,
            at: worlds,
            validate: |registry, world| validate_world(
                world,
                registry.get::<TileSet>(&world.tile_set_id),
                registry.templates(),
            ),
        }

        /// How a kind of character is drawn, and what may be chosen about one
        /// (`docs/adr/ADR-0024-character-definitions.md`).
        Character {
            what: "character",
            of: CharacterDefinition,
            at: characters,
            validate: |_registry, character| validate_character(character),
            keys: |character| character.referenced_keys(),
        }

        /// A thing that stands on a hex — a tree, a chest, a bush
        /// (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
        Decoration {
            what: "decoration",
            of: DecorationDefinition,
            at: decorations,
            // No cell in hand at load time: a decoration is not bound to one
            // tile set, so `decoration.overflowsCell` is the editor's warning
            // and not the registry's. See `Engine::validate_decoration`.
            validate: |_registry, decoration| validate_decoration(decoration, None),
        }

        /// A thing that is carried rather than placed
        /// (`docs/adr/ADR-0036-an-object-is-carried-not-placed.md`).
        Object {
            what: "object",
            of: ObjectDefinition,
            at: objects,
            validate: |_registry, object| validate_object(object),
            keys: |object| object.referenced_keys(),
        }
    }

    one {
        /// The menu a client opens on (`docs/adr/ADR-0021-authored-title-screen.md`).
        TitleScreen {
            what: "title screen",
            of: TitleScreenDefinition,
            at: title_screen,
            validate: |_registry, screen| validate_title_screen(screen),
            // The one kind whose keys are borrowed from the definition rather
            // than built with it; the paths are static strings.
            keys: |screen| screen
                .referenced_keys()
                .into_iter()
                .map(|(path, key)| (path.to_owned(), key))
                .collect(),
        }

        /// What a player may set before a game starts (`docs/adr/ADR-0022-settings.md`).
        Settings {
            what: "settings",
            of: SettingsDefinition,
            at: settings,
            validate: |_registry, settings| validate_settings(settings),
            keys: |settings| settings.referenced_keys(),
        }

        /// The choices offered when a player character is made.
        ///
        /// Character definitions must be registered first: bindings and preview
        /// overrides are cross-file references, checked here rather than left
        /// for a renderer to discover.
        CharacterCreation {
            what: "character creation",
            of: CharacterCreationDefinition,
            at: character_creation,
            validate: |registry, creation| validate_character_creation(
                creation,
                registry.all::<Character>(),
            ),
            keys: |creation| creation.referenced_keys(),
        }

        /// The manifest: which files make up the game, and where it starts.
        ///
        /// Load it **after** the content it lists — it is validated against
        /// what is actually in the registry, so a bundle missing a file fails
        /// at load time rather than when a player walks through a door
        /// (`docs/adr/ADR-0015-client-delivery-build.md`).
        Project {
            what: "project",
            of: ProjectDefinition,
            at: project,
            validate: |registry, project| registry.project_report(project),
        }
    }
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

    // ---------------------------------------------------------------- locales

    /// Registers one locale file under `language` and `namespace`.
    ///
    /// Files are merged into one bundle per language, in load order, and a key
    /// defined twice is refused rather than silently overwritten
    /// (`docs/adr/ADR-0020-localised-content-keys.md`).
    ///
    /// # Errors
    ///
    /// [`EngineError::Parse`] when the file is not a nested object of strings,
    /// or when it redefines a key the language already has.
    pub fn load_locale(
        &mut self,
        language: &str,
        namespace: &str,
        json: &str,
    ) -> Result<usize, EngineError> {
        let bundle = self
            .locales
            .entry(language.to_owned())
            .or_insert_with(|| LocaleBundle::new(language));

        bundle
            .merge_json(namespace, json)
            .map_err(|message| EngineError::Parse {
                what: format!("locale `{language}/{namespace}`"),
                message,
            })?;

        Ok(bundle.entries.len())
    }

    /// The translations of one language, with the project's default language
    /// filling every gap.
    ///
    /// Falling back here rather than in the host is what keeps a raw key off the
    /// screen no matter which host asks.
    #[must_use]
    pub fn locale_bundle(&self, language: &str) -> Option<LocaleBundle> {
        let bundle = self.locales.get(language)?;
        let default = self
            .only::<Project>()
            .and_then(|project| project.locales.default_language())
            .and_then(|id| self.locales.get(id));

        Some(match default {
            Some(default) if default.language != bundle.language => bundle.with_fallback(default),
            _ => bundle.clone(),
        })
    }

    /// Every loaded bundle, as authored — no fallback applied.
    pub fn locales(&self) -> impl Iterator<Item = &LocaleBundle> {
        self.locales.values()
    }

    /// Ids of the languages with at least one loaded file, sorted.
    #[must_use]
    pub fn language_ids(&self) -> Vec<String> {
        self.locales.keys().cloned().collect()
    }

    /// Compares the loaded languages against the manifest and each other.
    #[must_use]
    pub fn validate_locales(&self) -> ValidationReport {
        match self.only::<Project>() {
            Some(project) => validate_locales(project, self.locales()),
            None => ValidationReport::clean(),
        }
    }

    // ------------------------------------------------------- the set as a set

    /// Whether the manifest and the content it names agree.
    ///
    /// Three questions, one verdict: does the manifest hold together, does
    /// every loaded map name a zone this project declares, and do the loaded
    /// languages answer the same keys? Then the text the *registered* content
    /// names, for the kinds a player meets without opening an editor — the
    /// title screen, the creation screen and every object. A character's and a
    /// settings declaration's keys are the editor's business, checked when it
    /// validates the file it is writing (`docs/adr/ADR-0020-localised-content-keys.md`).
    fn project_report(&self, project: &ProjectDefinition) -> ValidationReport {
        validate_project(
            project,
            LoadedContent {
                worlds: &self.ids::<World>(),
                tile_sets: &self.ids::<TileSet>(),
                characters: &self.ids::<Character>(),
                decorations: &self.ids::<Decoration>(),
                objects: &self.ids::<Object>(),
                character_creation: self
                    .only::<CharacterCreation>()
                    .map(|creation| creation.id.as_str()),
                title_screen: self.only::<TitleScreen>().map(|screen| screen.id.as_str()),
                settings: self.only::<Settings>().map(|settings| settings.id.as_str()),
            },
        )
        .merge(validate_project_zones(project, self.all::<World>()))
        .merge(validate_placed_decorations(
            self.all::<World>(),
            &self.ids::<Decoration>(),
        ))
        .merge(validate_locales(project, self.locales()))
        .merge(self.sole_key_report::<TitleScreen>())
        .merge(self.sole_key_report::<CharacterCreation>())
        .merge(self.every_key_report::<Object>())
    }

    /// The keys named by the one definition of a kind, if one is registered.
    fn sole_key_report<K: Sole>(&self) -> ValidationReport {
        self.only::<K>()
            .map_or_else(ValidationReport::clean, |definition| {
                self.key_report::<K>(definition)
            })
    }

    /// The keys named by every registered definition of a kind.
    fn every_key_report<K: Keyed>(&self) -> ValidationReport {
        self.all::<K>()
            .fold(ValidationReport::clean(), |report, definition| {
                report.merge(self.key_report::<K>(definition))
            })
    }

    /// Resolves every map link across all registered worlds.
    ///
    /// Single-world validation cannot do this — a link's target lives in another
    /// file — so this is the check that says a *set* of maps hangs together
    /// (`docs/adr/ADR-0014-map-links.md`).
    #[must_use]
    pub fn validate_links(&self) -> ValidationReport {
        validate_project_links(self.all::<World>(), |id| self.get::<TileSet>(id))
    }

    // ----------------------------------------------------------------- resets

    /// Forgets every loaded definition, of every kind, and every language.
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
        self.clear_kinds();
        self.locales.clear();
    }

    /// Forgets every loaded language, keeping the rest of the content.
    ///
    /// Merging is additive and refuses a key twice, so a host that has *edited*
    /// a locale file cannot simply load it again — and dropping the worlds and
    /// the project to get there would be collateral damage. This is the narrow
    /// door the language editor needs: clear the languages, register the edited
    /// files, and the same registry answers the new text
    /// (`docs/adr/ADR-0020-localised-content-keys.md`).
    pub fn clear_locales(&mut self) {
        self.locales.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kind::ContentKind;

    fn tile_set_json() -> String {
        serde_json::to_string(&insulaire_world::testing::sample_tile_set()).expect("serialise")
    }

    fn world_json() -> String {
        serde_json::to_string(&insulaire_world::testing::sample_world()).expect("serialise")
    }

    fn loaded() -> ContentRegistry {
        let mut registry = ContentRegistry::new();
        registry
            .load::<TileSet>(&tile_set_json())
            .expect("tile set loads");
        registry.load::<World>(&world_json()).expect("world loads");
        registry
    }

    #[test]
    fn loading_registers_content_under_its_stable_id() {
        let registry = loaded();
        assert_eq!(registry.ids::<TileSet>(), vec!["mvp_terrain"]);
        assert_eq!(registry.ids::<World>(), vec!["sample_world"]);
        let world = registry.get::<World>("sample_world").expect("world");
        assert!(registry.get::<TileSet>(&world.tile_set_id).is_some());
    }

    #[test]
    fn malformed_json_is_a_parse_error_not_a_panic() {
        let mut registry = ContentRegistry::new();
        let error = registry
            .load::<World>("{ not json")
            .expect_err("should fail");
        assert!(matches!(error, EngineError::Parse { .. }));
        assert_eq!(error.code(), "parse");
    }

    /// One string per kind names it everywhere: the parse error, the refusal
    /// and the "no such content" error cannot drift apart, whatever is added.
    #[test]
    fn a_kind_is_called_the_same_thing_in_every_error() {
        let mut registry = ContentRegistry::new();
        for what in [
            <TileSet as ContentKind>::WHAT,
            <World as ContentKind>::WHAT,
            <Character as ContentKind>::WHAT,
            <Decoration as ContentKind>::WHAT,
            <Object as ContentKind>::WHAT,
            <TitleScreen as ContentKind>::WHAT,
            <Settings as ContentKind>::WHAT,
            <CharacterCreation as ContentKind>::WHAT,
            <Project as ContentKind>::WHAT,
        ] {
            assert!(!what.is_empty());
        }

        let error = registry
            .load::<Character>("{ not json")
            .expect_err("should fail");
        assert!(
            error.to_string().contains(<Character as ContentKind>::WHAT),
            "the parse error names the kind: {error}"
        );

        let error = registry
            .load::<World>(&world_json())
            .expect_err("no tile set is loaded");
        assert!(
            error.to_string().contains("world `sample_world`"),
            "the refusal names the kind and the id: {error}"
        );
    }

    #[test]
    fn a_world_referencing_an_unloaded_tile_set_is_refused() {
        let mut registry = ContentRegistry::new();
        let error = registry
            .load::<World>(&world_json())
            .expect_err("should fail");
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
            registry.ids::<World>().is_empty(),
            "invalid content must not be registered"
        );
    }

    #[test]
    fn validation_does_not_register_anything() {
        let mut registry = ContentRegistry::new();
        registry
            .load::<TileSet>(&tile_set_json())
            .expect("tile set loads");

        let report = registry
            .validate_json::<World>(&world_json())
            .expect("parses");
        assert!(report.valid);
        assert!(
            registry.ids::<World>().is_empty(),
            "validate must be side-effect free"
        );
    }

    #[test]
    fn reloading_a_world_replaces_the_previous_definition() {
        let mut registry = loaded();
        let mut world = insulaire_world::testing::sample_world();
        world.name = "Renamed".into();
        registry
            .load::<World>(&serde_json::to_string(&world).expect("serialise"))
            .expect("reload");

        assert_eq!(registry.ids::<World>().len(), 1);
        assert_eq!(
            registry.get::<World>("sample_world").expect("world").name,
            "Renamed"
        );
    }

    /// A project opens on one menu, so a second file replaces the first rather
    /// than accumulating — which is what the `one` shelf is for.
    #[test]
    fn a_kind_a_project_holds_one_of_keeps_only_the_last_file() {
        let mut registry = ContentRegistry::new();
        let screen = |id: &str| {
            format!(
                r#"{{"id":"{id}","schemaVersion":1,"titleKey":"menu.title",
                   "buttons":[{{"id":"new","action":"newGame","labelKey":"menu.new"}}]}}"#
            )
        };

        registry.load::<TitleScreen>(&screen("first")).expect("one");
        registry
            .load::<TitleScreen>(&screen("second"))
            .expect("two");

        assert_eq!(
            registry
                .only::<TitleScreen>()
                .map(|screen| screen.id.as_str()),
            Some("second")
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
            .load::<TileSet>(&tile_set_json())
            .expect("tile set loads");
        for world in [
            insulaire_world::testing::linked_world(),
            insulaire_world::testing::interior_world(),
        ] {
            registry
                .load::<World>(&serde_json::to_string(&world).expect("serialise"))
                .expect("world loads");
        }
        registry
    }

    #[test]
    fn links_resolve_once_every_world_is_registered() {
        let mut registry = ContentRegistry::new();
        registry
            .load::<TileSet>(&tile_set_json())
            .expect("tile set loads");
        registry
            .load::<World>(
                &serde_json::to_string(&insulaire_world::testing::linked_world()).expect("json"),
            )
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
            .load::<Project>(&project_json("linked_world"))
            .expect("project loads");
        assert_eq!(id, "demo");
        assert!(report.valid);
        assert_eq!(
            registry
                .only::<Project>()
                .map(|project| project.start_world.as_str()),
            Some("linked_world")
        );

        let error = registry
            .load::<Project>(&project_json("absent_world"))
            .expect_err("an unknown start world must be refused");
        assert_eq!(error.code(), "invalidContent");
    }

    /// A zone id resolves only against the project that declares it, so loading
    /// the manifest is where a map in a zone nobody declared is caught
    /// (`docs/adr/ADR-0018-map-zones.md`).
    #[test]
    fn a_project_refuses_a_world_in_a_zone_it_does_not_declare() {
        let mut registry = ContentRegistry::new();
        registry
            .load::<TileSet>(&tile_set_json())
            .expect("tile set loads");

        let mut world = insulaire_world::testing::linked_world();
        world.zone = "caves".to_owned();
        registry
            .load::<World>(&serde_json::to_string(&world).expect("serialise"))
            .expect("a world validates on its own whatever zone it names");
        registry
            .load::<World>(
                &serde_json::to_string(&insulaire_world::testing::interior_world())
                    .expect("serialise"),
            )
            .expect("world loads");

        let error = registry
            .load::<Project>(&project_json("linked_world"))
            .expect_err("the project declares no `caves`");
        assert_eq!(error.code(), "invalidContent");

        // Declaring it makes the same content load.
        let declared = project_json("linked_world").replace(
            r#""startWorld":"linked_world","#,
            r#""startWorld":"linked_world","zones":[{"id":"caves","name":"Caves"}],"#,
        );
        registry.load::<Project>(&declared).expect("project loads");
    }

    #[test]
    fn clearing_forgets_every_piece_of_content() {
        // Loading is additive, so re-loading a project that dropped a map has to
        // start from an empty registry or the removed map keeps answering.
        let mut registry = linked_registry();
        registry
            .load::<Project>(&project_json("linked_world"))
            .expect("project loads");

        registry.clear();

        assert!(registry.ids::<World>().is_empty());
        assert!(registry.ids::<TileSet>().is_empty());
        assert!(registry.only::<Project>().is_none());
        assert!(
            registry.validate_links().valid,
            "no worlds means no unresolved links"
        );
    }

    #[test]
    fn warnings_do_not_block_registration() {
        let mut registry = ContentRegistry::new();
        registry
            .load::<TileSet>(&tile_set_json())
            .expect("tile set loads");

        let mut world = insulaire_world::testing::sample_world();
        world
            .entities
            .retain(|entity| entity.template_id == "player");

        let (id, report) = registry
            .load::<World>(&serde_json::to_string(&world).expect("serialise"))
            .expect("a world without monsters is still loadable");
        assert_eq!(id, "sample_world");
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.code == "world.noMonsters"));
    }
}
