//! Objects: the things a character carries, not the things a map is made of.
//!
//! An [`ObjectDefinition`] is a potion, a key, a sword, a torn letter. It is a
//! *sibling* of [`crate::DecorationDefinition`] and the opposite of it: a
//! decoration stands on a hex and is drawn in the world, an object travels in
//! an inventory and is drawn in a panel
//! (`docs/adr/ADR-0036-an-object-is-carried-not-placed.md`).
//!
//! That difference is the whole reason they are two formats rather than one
//! with a flag. A decoration needs an anchor, a plane and an order because it
//! shares a cell with characters; none of those mean anything in a bag. An
//! object needs a player-facing name, a description and a stack size; none of
//! those mean anything for a tree.
//!
//! # Everything the player reads is a key
//!
//! [`ObjectDefinition::name`] is the *editor's* label, like a character's.
//! What a player sees is [`ObjectDefinition::name_key`] and
//! [`ObjectDefinition::description_key`], resolved through the locale bundles
//! like every other displayed string
//! (`docs/adr/ADR-0020-localised-content-keys.md`).
//!
//! # An icon is a flipbook
//!
//! An object's picture is an ordered list of images played at a fixed rate —
//! the same flipbook a decoration animates with (`animation.rs`), flattened
//! onto the definition because an object has exactly one appearance and no
//! states to name. **One frame is a still icon**, which is what nearly every
//! object is, and the second frame is all a glinting gem costs.
//!
//! # What is deliberately absent
//!
//! Effects, prices, damage and durability. What drinking a potion *does* is
//! scenario and combat content, and putting a `heal: 5` here would be the first
//! gameplay rule written into an asset file. [`ObjectDefinition::kind`] and
//! [`ObjectDefinition::tags`] are how something is filed and found; they are
//! not a behaviour table.

use serde::{Deserialize, Serialize};

use crate::animation::{flipbook_duration_ms, flipbook_index_at, DEFAULT_FRAME_DURATION_MS};
use crate::character::SpriteResolution;
use ts_rs::TS;

/// Highest object schema version this build understands.
///
/// `2` replaced the single `icon` path with [`ObjectDefinition::frames`]: an
/// icon is a flipbook, and a still one is a flipbook one frame long.
pub const OBJECT_SCHEMA_VERSION: u32 = 2;

/// Largest stack one inventory slot may hold.
///
/// A cap rather than a preference: a slot holding four billion arrows is a
/// typed digit, not a design.
pub const MAX_STACK_SIZE: u32 = 9999;

/// The canvas an object's icon is drawn on when its file names none.
pub const DEFAULT_ICON_RESOLUTION: SpriteResolution = SpriteResolution {
    width: 32,
    height: 32,
};

/// What an object is for.
///
/// Filing, and the one seam an inventory screen may group by. No rule reads it:
/// what a consumable does when consumed is scenario content, not a branch in
/// this crate.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize, TS,
)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "object.ts")]
pub enum ObjectKind {
    /// Used up: a potion, a ration, a bandage.
    Consumable,
    /// Worn or wielded, in a [`ObjectDefinition::slot`].
    Equipment,
    /// Carried because the scenario says so: a letter, a key, a relic.
    Quest,
    /// Raw stuff: ore, cloth, a plank.
    Material,
    /// Unfiled.
    #[default]
    Other,
}

/// A kind of thing a character can carry.
///
/// The TypeScript `ObjectDefinition` is derived from this one, into
/// `apps/web/src/content/generated/object.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "object.ts")]
pub struct ObjectDefinition {
    /// Stable content id, referenced by inventories and by the scenario.
    pub id: String,
    /// Schema version of this file.
    pub schema_version: u32,
    /// Shown in the editor. Not player-facing, so not a key.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    /// How this definition is filed.
    #[serde(default, skip_serializing_if = "crate::is_default")]
    pub kind: ObjectKind,
    /// Key of the name a player reads.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name_key: String,
    /// Key of the description a player reads. Empty when it has none.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description_key: String,
    /// The images of the icon, in play order. Paths under the content root.
    ///
    /// One frame is a still icon. Empty is an object blocked out before its art
    /// exists, which is a warning and not a refusal.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub frames: Vec<String>,
    /// How long each frame lasts, in milliseconds. Unread by a still icon.
    #[serde(
        default = "default_frame_duration",
        skip_serializing_if = "is_default_frame_duration"
    )]
    pub frame_duration_ms: u32,
    /// Whether it starts again when it ends. A glinting gem does; a one-shot
    /// flourish holds its last frame.
    #[serde(default, skip_serializing_if = "crate::is_default")]
    pub looping: bool,
    /// The canvas every frame is drawn on.
    #[serde(
        default = "default_icon_resolution",
        skip_serializing_if = "is_default_icon_resolution"
    )]
    pub resolution: SpriteResolution,
    /// How many fit in one inventory slot. `1` means it does not stack.
    #[serde(default = "one", skip_serializing_if = "is_one")]
    pub stack_size: u32,
    /// Where equipment is worn — an author-owned id such as `head` or
    /// `mainHand`. Empty for anything that is not worn.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub slot: String,
    /// Author-owned gameplay tags, as everywhere else in the format.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

/// `true` when an icon is drawn on the canvas an absent key would have meant.
fn is_default_icon_resolution(value: &SpriteResolution) -> bool {
    *value == default_icon_resolution()
}

fn default_icon_resolution() -> SpriteResolution {
    DEFAULT_ICON_RESOLUTION
}

/// `true` when an icon runs at the duration an absent key would have meant.
fn is_default_frame_duration(value: &u32) -> bool {
    *value == default_frame_duration()
}

const fn default_frame_duration() -> u32 {
    DEFAULT_FRAME_DURATION_MS
}

/// `true` when a stack holds the single item an absent key would have meant.
fn is_one(value: &u32) -> bool {
    *value == one()
}

const fn one() -> u32 {
    1
}

impl ObjectDefinition {
    /// The keys this definition names, with the field each came from.
    ///
    /// The same contract [`crate::CharacterDefinition::referenced_keys`] has,
    /// and what the editor uses to create every missing key on save
    /// (`docs/adr/ADR-0020-localised-content-keys.md`).
    #[must_use]
    pub fn referenced_keys(&self) -> Vec<(String, &str)> {
        let mut keys = Vec::new();
        if !self.name_key.is_empty() {
            keys.push(("nameKey".to_owned(), self.name_key.as_str()));
        }
        if !self.description_key.is_empty() {
            keys.push(("descriptionKey".to_owned(), self.description_key.as_str()));
        }
        keys
    }

    /// `true` when several of this object share one inventory slot.
    #[must_use]
    pub const fn stacks(&self) -> bool {
        self.stack_size > 1
    }

    /// `true` when the icon has something to play.
    #[must_use]
    pub fn animated(&self) -> bool {
        self.frames.len() > 1
    }

    /// How long one full play of the icon takes, in milliseconds.
    #[must_use]
    pub fn duration_ms(&self) -> u32 {
        flipbook_duration_ms(self.frames.len(), self.frame_duration_ms)
    }

    /// Which frame this time falls in, `0`-based.
    #[must_use]
    pub fn frame_index_at(&self, time_ms: u32) -> usize {
        flipbook_index_at(
            self.frames.len(),
            self.frame_duration_ms,
            self.looping,
            time_ms,
        )
    }

    /// The image drawn at this time, or `None` when the icon names none.
    #[must_use]
    pub fn asset_at(&self, time_ms: u32) -> Option<&str> {
        self.frames
            .get(self.frame_index_at(time_ms))
            .map(String::as_str)
    }

    /// What to draw, at a moment of the icon.
    ///
    /// The panel and the editor's preview go through this, for the reason
    /// [`crate::DecorationDefinition::resolve_at`] exists: the frame arithmetic
    /// happens once, in this crate.
    #[must_use]
    pub fn resolve_at(&self, time_ms: u32) -> ResolvedObject {
        let frame = self.frame_index_at(time_ms);
        ResolvedObject {
            id: self.id.clone(),
            resolution: self.resolution,
            frames: self.frames.len(),
            frame,
            asset: self.frames.get(frame).cloned().unwrap_or_default(),
            duration_ms: self.duration_ms(),
            looping: self.looping,
        }
    }

    /// The still icon: what an object looks like when nothing is playing.
    #[must_use]
    pub fn resolve(&self) -> ResolvedObject {
        self.resolve_at(0)
    }

    /// Every image path this definition names, in author order.
    #[must_use]
    pub fn assets(&self) -> Vec<&str> {
        self.frames.iter().map(String::as_str).collect()
    }
}

/// One object icon, ready to blit.
///
/// Flat on purpose: an inventory panel should not have to redo the frame
/// arithmetic to draw a glinting gem.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "object.ts")]
pub struct ResolvedObject {
    /// Id of the definition this came from.
    pub id: String,
    /// The canvas the image is drawn on.
    pub resolution: SpriteResolution,
    /// How many frames the icon declares.
    pub frames: usize,
    /// Index of the frame on screen.
    pub frame: usize,
    /// Path of the image to draw; empty when the icon names none.
    pub asset: String,
    /// How long one full play takes, in milliseconds.
    pub duration_ms: u32,
    /// Whether it starts again when it ends.
    pub looping: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn potion() -> ObjectDefinition {
        serde_json::from_str(
            r#"{
              "id": "small_potion",
              "schemaVersion": 2,
              "kind": "consumable",
              "nameKey": "game.object.smallPotion.name",
              "descriptionKey": "game.object.smallPotion.description",
              "frames": ["assets/objects/small_potion.png"],
              "resolution": { "width": 16, "height": 16 },
              "stackSize": 10,
              "tags": ["healing"]
            }"#,
        )
        .expect("the fixture parses")
    }

    #[test]
    fn an_object_parses_from_its_camel_case_file() {
        let potion = potion();
        assert_eq!(potion.kind, ObjectKind::Consumable);
        assert_eq!(potion.stack_size, 10);
        assert!(potion.stacks());
        assert_eq!(potion.resolution.width, 16);
    }

    /// A file that says nothing about stacking says "one per slot", not "zero".
    #[test]
    fn an_absent_stack_size_is_one() {
        let key: ObjectDefinition =
            serde_json::from_str(r#"{ "id": "key", "schemaVersion": 2 }"#).expect("parses");
        assert_eq!(key.stack_size, 1);
        assert!(!key.stacks());
        assert_eq!(key.kind, ObjectKind::Other);
        assert_eq!(key.resolution, DEFAULT_ICON_RESOLUTION);
        assert_eq!(key.frame_duration_ms, DEFAULT_FRAME_DURATION_MS);
        assert!(key.frames.is_empty());
    }

    /// The overwhelmingly common object: one drawing, and nothing playing.
    #[test]
    fn a_one_frame_icon_is_a_still_one() {
        let potion = potion();
        assert!(!potion.animated());

        let resolved = potion.resolve();
        assert_eq!(resolved.frame, 0);
        assert_eq!(resolved.asset, "assets/objects/small_potion.png");
        assert_eq!(resolved.frames, 1);

        // However long it is left on screen, a still icon stays on its frame.
        assert_eq!(potion.resolve_at(10_000).asset, resolved.asset);
    }

    /// The same rule a decoration plays by: a loop wraps, a one-shot holds.
    #[test]
    fn an_animated_icon_plays_and_then_wraps() {
        let mut gem = potion();
        gem.frames = vec!["a.png".to_owned(), "b.png".to_owned(), "c.png".to_owned()];
        gem.frame_duration_ms = 100;
        gem.looping = true;

        assert!(gem.animated());
        assert_eq!(gem.duration_ms(), 300);
        assert_eq!(gem.asset_at(0), Some("a.png"));
        assert_eq!(gem.asset_at(150), Some("b.png"));
        assert_eq!(gem.asset_at(250), Some("c.png"));
        // Past the end it wraps: 350ms is 50ms into the second play.
        assert_eq!(gem.asset_at(350), Some("a.png"));
        assert_eq!(gem.asset_at(450), Some("b.png"));

        gem.looping = false;
        assert_eq!(gem.asset_at(10_000), Some("c.png"));
    }

    /// An object written before its art exists resolves to nothing, rather
    /// than to a path the host would fail to load.
    #[test]
    fn an_icon_with_no_frame_resolves_to_no_asset() {
        let mut potion = potion();
        potion.frames.clear();
        let resolved = potion.resolve();
        assert!(resolved.asset.is_empty());
        assert_eq!(resolved.frames, 0);
        assert_eq!(potion.asset_at(0), None);
    }

    #[test]
    fn referenced_keys_are_the_two_player_facing_ones() {
        let potion = potion();
        let keys: Vec<&str> = potion
            .referenced_keys()
            .into_iter()
            .map(|(_, key)| key)
            .collect();
        assert_eq!(
            keys,
            vec![
                "game.object.smallPotion.name",
                "game.object.smallPotion.description"
            ]
        );
    }

    /// An object with no description names one key, not an empty one: the
    /// editor would otherwise create `""` in every language.
    #[test]
    fn an_empty_key_is_not_referenced() {
        let mut potion = potion();
        potion.description_key = String::new();
        assert_eq!(potion.referenced_keys().len(), 1);
    }
}
