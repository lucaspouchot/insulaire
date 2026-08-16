//! Runtime entities.
//!
//! Authored [`EntityDefinition`]s are turned into [`EntityRuntime`]s once, at
//! game creation. From then on the simulation addresses entities by a compact
//! [`EntityId`] handle; the authored string id travels along so that saves,
//! logs and the UI can refer to entities stably.

use std::collections::BTreeMap;

use hex_world::{Behavior, EntityDefinition, EntityKind, EntityTemplate, Hex};
use serde::{Deserialize, Serialize};

/// A compact runtime handle for an entity.
///
/// The value is the entity's index in [`EntityStore`]. The MVP never removes
/// entities, so handles stay valid for the life of a game.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct EntityId(u32);

impl EntityId {
    /// The underlying index.
    #[must_use]
    pub const fn index(self) -> usize {
        self.0 as usize
    }

    /// The raw handle value, for DTOs.
    #[must_use]
    pub const fn raw(self) -> u32 {
        self.0
    }
}

/// The mutable runtime state of one entity.
#[derive(Debug, Clone, PartialEq)]
pub struct EntityRuntime {
    id: EntityId,
    content_id: String,
    template_id: String,
    kind: EntityKind,
    behavior: Behavior,
    blocks_movement: bool,
    visual_id: String,
    fallback_color: String,
    position: Hex,
    tags: Vec<String>,
}

impl EntityRuntime {
    /// Runtime handle.
    #[must_use]
    pub const fn id(&self) -> EntityId {
        self.id
    }

    /// The authored id from the world file.
    #[must_use]
    pub fn content_id(&self) -> &str {
        &self.content_id
    }

    /// The template this entity was instantiated from.
    #[must_use]
    pub fn template_id(&self) -> &str {
        &self.template_id
    }

    /// Simulation role.
    #[must_use]
    pub const fn kind(&self) -> EntityKind {
        self.kind
    }

    /// Per-tick behaviour.
    #[must_use]
    pub const fn behavior(&self) -> Behavior {
        self.behavior
    }

    /// Whether this entity prevents others from entering its hex.
    #[must_use]
    pub const fn blocks_movement(&self) -> bool {
        self.blocks_movement
    }

    /// Stable visual id for the renderer.
    #[must_use]
    pub fn visual_id(&self) -> &str {
        &self.visual_id
    }

    /// Colour used when no sprite is registered for [`Self::visual_id`].
    #[must_use]
    pub fn fallback_color(&self) -> &str {
        &self.fallback_color
    }

    /// Current position.
    #[must_use]
    pub const fn position(&self) -> Hex {
        self.position
    }

    /// Gameplay tags carried over from the world file.
    #[must_use]
    pub fn tags(&self) -> &[String] {
        &self.tags
    }
}

/// All runtime entities of a game.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct EntityStore {
    entities: Vec<EntityRuntime>,
    by_content_id: BTreeMap<String, EntityId>,
    player: Option<EntityId>,
}

impl EntityStore {
    /// Instantiates `definition` with the values from `template`.
    ///
    /// Returns the new handle. The caller is responsible for having validated
    /// that the template exists (see `hex_world::validate_world`).
    pub fn spawn(&mut self, definition: &EntityDefinition, template: &EntityTemplate) -> EntityId {
        let id = EntityId(self.entities.len() as u32);
        self.entities.push(EntityRuntime {
            id,
            content_id: definition.id.clone(),
            template_id: template.id.clone(),
            kind: template.kind,
            behavior: template.behavior,
            blocks_movement: template.blocks_movement,
            visual_id: template.visual_id.clone(),
            fallback_color: template.fallback_color.clone(),
            position: Hex::from_offset(definition.at),
            tags: definition.tags.clone(),
        });
        self.by_content_id.insert(definition.id.clone(), id);
        if template.kind == EntityKind::Player {
            self.player = Some(id);
        }
        id
    }

    /// Every entity, in spawn order.
    #[must_use]
    pub fn all(&self) -> &[EntityRuntime] {
        &self.entities
    }

    /// Looks an entity up by handle.
    #[must_use]
    pub fn get(&self, id: EntityId) -> Option<&EntityRuntime> {
        self.entities.get(id.index())
    }

    /// Looks an entity up by authored id.
    #[must_use]
    pub fn by_content_id(&self, content_id: &str) -> Option<&EntityRuntime> {
        self.by_content_id
            .get(content_id)
            .and_then(|id| self.get(*id))
    }

    /// The player entity, if the world defined one.
    #[must_use]
    pub fn player(&self) -> Option<&EntityRuntime> {
        self.player.and_then(|id| self.get(id))
    }

    /// The handles of every entity whose behaviour is `behavior`, in spawn order.
    #[must_use]
    pub fn with_behavior(&self, behavior: Behavior) -> Vec<EntityId> {
        self.entities
            .iter()
            .filter(|entity| entity.behavior == behavior)
            .map(|entity| entity.id)
            .collect()
    }

    /// Returns the blocking entity standing on `hex`, ignoring `ignored`.
    #[must_use]
    pub fn blocker_at(&self, hex: Hex, ignored: Option<EntityId>) -> Option<&EntityRuntime> {
        self.entities.iter().find(|entity| {
            entity.blocks_movement && entity.position == hex && Some(entity.id) != ignored
        })
    }

    /// Moves an entity. Returns the previous position, or `None` for an unknown
    /// handle.
    pub fn move_to(&mut self, id: EntityId, destination: Hex) -> Option<Hex> {
        let entity = self.entities.get_mut(id.index())?;
        let previous = entity.position;
        entity.position = destination;
        Some(previous)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hex_world::{OffsetCoord, TemplateRegistry};

    fn definition(id: &str, template_id: &str, col: i32, row: i32) -> EntityDefinition {
        EntityDefinition {
            id: id.to_owned(),
            template_id: template_id.to_owned(),
            at: OffsetCoord::new(col, row),
            tags: vec!["demo".to_owned()],
            properties: BTreeMap::new(),
        }
    }

    fn populated() -> (EntityStore, TemplateRegistry) {
        let templates = TemplateRegistry::builtin();
        let mut store = EntityStore::default();
        store.spawn(
            &definition("p", "player", 1, 1),
            templates.get("player").expect("player"),
        );
        store.spawn(
            &definition("m", "monster", 4, 4),
            templates.get("monster").expect("monster"),
        );
        (store, templates)
    }

    #[test]
    fn spawning_indexes_by_handle_content_id_and_role() {
        let (store, _) = populated();
        assert_eq!(store.all().len(), 2);
        assert_eq!(store.player().map(EntityRuntime::content_id), Some("p"));
        assert_eq!(
            store.by_content_id("m").map(EntityRuntime::template_id),
            Some("monster")
        );
        assert!(store.by_content_id("absent").is_none());

        let handle = store.player().expect("player").id();
        assert_eq!(store.get(handle).map(EntityRuntime::content_id), Some("p"));
        assert_eq!(store.all()[0].tags(), ["demo"]);
    }

    #[test]
    fn positions_come_from_offset_coordinates() {
        let (store, _) = populated();
        assert_eq!(
            store.player().expect("player").position(),
            Hex::from_offset(OffsetCoord::new(1, 1))
        );
    }

    #[test]
    fn blocker_lookup_can_ignore_the_mover_itself() {
        let (store, _) = populated();
        let player = store.player().expect("player");
        let at = player.position();

        assert_eq!(
            store.blocker_at(at, None).map(EntityRuntime::content_id),
            Some("p")
        );
        assert!(store.blocker_at(at, Some(player.id())).is_none());
    }

    #[test]
    fn moving_returns_the_previous_position() {
        let (mut store, _) = populated();
        let player = store.player().expect("player").id();
        let destination = Hex::new(9, 9);

        let previous = store.move_to(player, destination).expect("known handle");
        assert_eq!(previous, Hex::from_offset(OffsetCoord::new(1, 1)));
        assert_eq!(store.get(player).expect("player").position(), destination);
        assert_eq!(store.move_to(EntityId(42), destination), None);
    }

    #[test]
    fn behaviour_query_selects_chasers_only() {
        let (store, _) = populated();
        let chasers = store.with_behavior(Behavior::ChasePlayer);
        assert_eq!(chasers.len(), 1);
        assert_eq!(
            store.get(chasers[0]).map(EntityRuntime::content_id),
            Some("m")
        );
    }
}
