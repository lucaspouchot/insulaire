//! Entity templates.
//!
//! Authored entities reference a `templateId`; the template supplies the
//! gameplay behaviour and the visual identity that the world file deliberately
//! does not carry.
//!
//! # MVP scope
//!
//! Templates live in a small built-in registry rather than in content files.
//! That is a conscious MVP limitation: the *indirection* is what matters
//! architecturally, and it lets templates move into
//! `content/templates/*.json` later without touching any world file. See
//! `docs/content-format.md`.

use serde::{Deserialize, Serialize};

/// What an entity is, from the simulation's point of view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntityKind {
    /// The hex the human player controls.
    Player,
    /// An engine-driven actor.
    Monster,
}

/// The behaviour an entity runs during the world-systems phase of a tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Behavior {
    /// Never acts on its own; driven by player commands.
    PlayerControlled,
    /// Steps one hex towards the player each tick. See
    /// `insulaire_simulation::ai` for the exact rule.
    ChasePlayer,
}

/// A named bundle of gameplay and visual defaults for an entity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityTemplate {
    /// Stable id referenced by [`crate::EntityDefinition::template_id`].
    pub id: String,
    /// Display name.
    pub name: String,
    /// Simulation role.
    pub kind: EntityKind,
    /// Per-tick behaviour.
    pub behavior: Behavior,
    /// Whether other entities are prevented from entering this entity's hex.
    pub blocks_movement: bool,
    /// Stable visual id resolved by the renderer's sprite registry.
    pub visual_id: String,
    /// Colour used when no sprite is registered for `visual_id`.
    pub fallback_color: String,
}

/// The built-in template registry.
#[derive(Debug, Clone, PartialEq)]
pub struct TemplateRegistry {
    templates: Vec<EntityTemplate>,
}

impl TemplateRegistry {
    /// Returns the MVP registry: one player template and one monster template.
    #[must_use]
    pub fn builtin() -> Self {
        Self {
            templates: vec![
                EntityTemplate {
                    id: "player".into(),
                    name: "Player".into(),
                    kind: EntityKind::Player,
                    behavior: Behavior::PlayerControlled,
                    blocks_movement: true,
                    visual_id: "entity.player".into(),
                    fallback_color: "#f2c14e".into(),
                },
                EntityTemplate {
                    id: "monster".into(),
                    name: "Monster".into(),
                    kind: EntityKind::Monster,
                    behavior: Behavior::ChasePlayer,
                    blocks_movement: true,
                    visual_id: "entity.monster".into(),
                    fallback_color: "#c0392b".into(),
                },
            ],
        }
    }

    /// Looks a template up by id.
    #[must_use]
    pub fn get(&self, id: &str) -> Option<&EntityTemplate> {
        self.templates.iter().find(|template| template.id == id)
    }

    /// Every known template, in registration order.
    #[must_use]
    pub fn all(&self) -> &[EntityTemplate] {
        &self.templates
    }
}

impl Default for TemplateRegistry {
    fn default() -> Self {
        Self::builtin()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_registry_exposes_player_and_monster() {
        let registry = TemplateRegistry::builtin();
        assert_eq!(registry.all().len(), 2);

        let player = registry.get("player").expect("player template");
        assert_eq!(player.kind, EntityKind::Player);
        assert_eq!(player.behavior, Behavior::PlayerControlled);

        let monster = registry.get("monster").expect("monster template");
        assert_eq!(monster.kind, EntityKind::Monster);
        assert_eq!(monster.behavior, Behavior::ChasePlayer);

        assert!(registry.get("dragon").is_none());
    }
}
