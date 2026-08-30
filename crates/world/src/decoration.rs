//! Decorations: the things that stand on a hex without being the hex.
//!
//! A tile is what the ground *is*; a [`DecorationDefinition`] is what is
//! **put on it** — a tree, a house, a chest, a bush, a signpost. Several may
//! share one cell, each is placed at its own whole-pixel offset, and each says
//! whether a character walking onto that cell passes **in front of** it or
//! **behind** it (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
//!
//! ```text
//! DecorationDefinition + animation + time ──> resolve_at() ──> ResolvedDecoration ──> renderer
//! ```
//!
//! # Anchored, not centred
//!
//! A decoration carries an [`DecorationDefinition::anchor`]: the pixel of its
//! own canvas that lands on the cell's ground point. A tree anchors at the foot
//! of its trunk, a hanging lantern at the ring it hangs from, a puddle at its
//! middle. Centring the image instead would work for exactly one of those, and
//! nudging it back would be a fractional offset an author has to rediscover on
//! every map.
//!
//! # Two planes, then an order
//!
//! Depth on one cell is not a single number. A character standing on a hex is
//! **in front of** the grass and **behind** the tree canopy, so the sort key is
//! a [`DecorationPlane`] first — everything behind the characters, then the
//! characters, then everything in front — and an [`DecorationDefinition::order`]
//! within each plane. One combined z-index cannot express that without the
//! renderer knowing which numbers mean "past the characters", which is exactly
//! the scenario-shaped knowledge the engine must not carry.
//!
//! # Animated by frames, not by a skeleton
//!
//! A character is a tree of layers moved by offsets (`character.rs`). A
//! decoration is a **flipbook**: one image per frame, played at a fixed rate,
//! by the rule `animation.rs` writes once for everything drawn that way.
//! A torch has four drawings, and giving it a skeleton, tracks, poses and
//! variants would be a hundred times the file for a flame.
//!
//! A named [`DecorationAnimation`] is also how a decoration has **states**: a
//! chest declares `closed` and `open`, each one frame long, and the scenario
//! asks for one by id. Nothing here knows what opening a chest means — that is
//! content (`docs/adr/ADR-0004-scenario-runtime.md`).
//!
//! # What is deliberately absent
//!
//! Interaction, in both halves. A *definition* does not even say **whether**:
//! that is a fact about the chest standing at `[4, 7]`, and it lives on
//! [`crate::PlacedDecoration`] with the id a scenario names
//! (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
//! What *happens* when it is opened is scenario content, and an
//! `if this is a chest` in the engine is the thing `CLAUDE.md` forbids.

use serde::{Deserialize, Serialize};

use crate::animation::{
    flipbook_duration_ms, flipbook_index_at, PixelOffset, DEFAULT_FRAME_DURATION_MS,
};
use crate::character::SpriteResolution;

/// Highest decoration schema version this build understands.
///
/// `2` removed `interactive`. Whether a thing can be opened or searched is a
/// fact about the tree standing at `[4, 7]`, not about trees
/// (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
pub const DECORATION_SCHEMA_VERSION: u32 = 2;

/// Furthest a decoration may be sorted from the middle of its plane.
///
/// Bounded so the two planes stay readable as small hand-written numbers rather
/// than a war of ever-larger z-indices.
pub const MAX_DECORATION_ORDER: i32 = 999;

/// The canvas a decoration is authored on when its file names none.
pub const DEFAULT_DECORATION_RESOLUTION: SpriteResolution = SpriteResolution {
    width: 32,
    height: 48,
};

/// What a decoration is, for filing.
///
/// Filing, not behaviour: neither the resolver nor the renderer reads it. It is
/// what lets an editor group four hundred props, and what a later feature can
/// ask for without a naming convention — exactly the role
/// [`crate::CharacterCategory`] plays for characters.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize,
)]
#[serde(rename_all = "camelCase")]
pub enum DecorationCategory {
    /// Grown or geological: a tree, a rock, a bush.
    Nature,
    /// Built and stood in: a house, a wall, a bridge.
    Building,
    /// Movable-looking and small: a barrel, a table, a signpost.
    Prop,
    /// Holds something: a chest, a crate, a sack.
    Container,
    /// Unfiled.
    #[default]
    Other,
}

/// Which side of the characters a decoration is drawn on.
///
/// The two groups of z-index. A character on a cell is drawn between them, so
/// this is the one thing a combined ordering cannot say
/// (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize,
)]
#[serde(rename_all = "camelCase")]
pub enum DecorationPlane {
    /// Drawn before the characters: the ground the feet cover.
    #[default]
    Behind,
    /// Drawn after them: the canopy, the fence, the doorway they walk into.
    Front,
}

/// One appearance a decoration can play, as an ordered list of images.
///
/// Both an *animation* (a torch flickering) and a *state* (a chest that is
/// open) are this: the second is simply one frame long, and the scenario asks
/// for it by id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecorationAnimation {
    /// Stable id, unique within the definition — `idle`, `open`, `burning`.
    pub id: String,
    /// Shown in the editor. Not player-facing, so not a key.
    #[serde(default)]
    pub name: String,
    /// The images, in play order. Paths under the content root.
    #[serde(default)]
    pub frames: Vec<String>,
    /// How long each frame lasts, in milliseconds.
    #[serde(default = "default_frame_duration")]
    pub frame_duration_ms: u32,
    /// Whether it starts again when it ends. A state does not; a flame does.
    #[serde(default)]
    pub looping: bool,
}

const fn default_frame_duration() -> u32 {
    DEFAULT_FRAME_DURATION_MS
}

impl DecorationAnimation {
    /// A still appearance drawn from one image.
    #[must_use]
    pub fn still(id: impl Into<String>, asset: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: String::new(),
            frames: vec![asset.into()],
            frame_duration_ms: DEFAULT_FRAME_DURATION_MS,
            looping: false,
        }
    }

    /// How long one full play takes, in milliseconds.
    #[must_use]
    pub fn duration_ms(&self) -> u32 {
        flipbook_duration_ms(self.frames.len(), self.frame_duration_ms)
    }

    /// Which frame this time falls in, `0`-based.
    ///
    /// The shared flipbook rule ([`flipbook_index_at`]): a looping animation
    /// wraps, one that does not holds its **last** frame.
    #[must_use]
    pub fn frame_index_at(&self, time_ms: u32) -> usize {
        flipbook_index_at(
            self.frames.len(),
            self.frame_duration_ms,
            self.looping,
            time_ms,
        )
    }

    /// The image played at this time, or `None` when the animation has no frame.
    #[must_use]
    pub fn asset_at(&self, time_ms: u32) -> Option<&str> {
        self.frames
            .get(self.frame_index_at(time_ms))
            .map(String::as_str)
    }
}

/// A kind of thing that stands on a hex.
///
/// Mirrors the TypeScript `DecorationDefinition` in
/// `apps/web/src/content/content-types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecorationDefinition {
    /// Stable content id, referenced by a placed decoration.
    pub id: String,
    /// Schema version of this file.
    pub schema_version: u32,
    /// Shown in the editor. Not player-facing, so not a key.
    #[serde(default)]
    pub name: String,
    /// How this definition is filed.
    #[serde(default)]
    pub category: DecorationCategory,
    /// The canvas every frame is drawn on, at most
    /// [`crate::MAX_SPRITE_RESOLUTION`] a side.
    #[serde(default = "default_resolution")]
    pub resolution: SpriteResolution,
    /// The pixel of that canvas which lands on the cell's ground point.
    ///
    /// Absent is the canvas origin, because that is the one value that needs no
    /// knowledge of the image. It is rarely what an author wants — a thing
    /// standing on the ground anchors at its bottom middle — so the editor
    /// puts a new decoration's anchor there rather than leaving it at `[0, 0]`.
    #[serde(default)]
    pub anchor: PixelOffset,
    /// Whether characters on the same cell pass in front of it or behind it.
    #[serde(default)]
    pub plane: DecorationPlane,
    /// Sort key within [`Self::plane`]; higher is drawn later, so over.
    #[serde(default)]
    pub order: i32,
    /// Author-owned gameplay tags, as everywhere else in the format.
    #[serde(default)]
    pub tags: Vec<String>,
    /// The appearances it can play, in author order. The first is the default.
    #[serde(default)]
    pub animations: Vec<DecorationAnimation>,
    /// Id of the animation played when nothing else is asked for.
    ///
    /// Empty names the first declared, which is what nearly every decoration
    /// means.
    #[serde(default)]
    pub default_animation: String,
}

fn default_resolution() -> SpriteResolution {
    DEFAULT_DECORATION_RESOLUTION
}

impl DecorationDefinition {
    /// The animation with this id.
    #[must_use]
    pub fn animation(&self, id: &str) -> Option<&DecorationAnimation> {
        self.animations.iter().find(|entry| entry.id == id)
    }

    /// The animation played when a caller asks for none.
    ///
    /// [`Self::default_animation`] when it resolves, the first declared
    /// otherwise — a decoration whose default was renamed still draws.
    #[must_use]
    pub fn resting_animation(&self) -> Option<&DecorationAnimation> {
        if !self.default_animation.is_empty() {
            if let Some(animation) = self.animation(&self.default_animation) {
                return Some(animation);
            }
        }
        self.animations.first()
    }

    /// The pixel box this decoration occupies once placed, relative to the
    /// cell's ground point: `[x, y, width, height]`.
    ///
    /// Anchor arithmetic in one place, so the editor's preview and the map
    /// renderer cannot disagree about where a tree's trunk is.
    #[must_use]
    pub fn placement(&self) -> [i32; 4] {
        [
            -self.anchor.x(),
            -self.anchor.y(),
            i32::try_from(self.resolution.width).unwrap_or(i32::MAX),
            i32::try_from(self.resolution.height).unwrap_or(i32::MAX),
        ]
    }

    /// What to draw, at a moment of an animation.
    ///
    /// `animation` of `None` — or an id this definition does not declare — is
    /// the resting animation, for the reason the character resolver treats an
    /// unknown animation as the rest pose: a preview must still draw something.
    #[must_use]
    pub fn resolve_at(&self, animation: Option<&str>, time_ms: u32) -> ResolvedDecoration {
        let played = animation
            .and_then(|id| self.animation(id))
            .or_else(|| self.resting_animation());

        let (animation_id, frame, asset) = played.map_or_else(
            || (String::new(), 0, String::new()),
            |entry| {
                let index = entry.frame_index_at(time_ms);
                (
                    entry.id.clone(),
                    index,
                    entry.frames.get(index).cloned().unwrap_or_default(),
                )
            },
        );

        ResolvedDecoration {
            id: self.id.clone(),
            resolution: self.resolution,
            anchor: self.anchor,
            placement: self.placement(),
            plane: self.plane,
            order: self.order,
            animation: animation_id,
            frame,
            asset,
        }
    }

    /// The resting appearance: what a still decoration looks like.
    #[must_use]
    pub fn resolve(&self) -> ResolvedDecoration {
        self.resolve_at(None, 0)
    }

    /// Every image path this definition names, in author order.
    #[must_use]
    pub fn assets(&self) -> Vec<&str> {
        self.animations
            .iter()
            .flat_map(|animation| animation.frames.iter().map(String::as_str))
            .collect()
    }
}

/// One decoration, ready to blit.
///
/// Flat on purpose: a host should not have to redo the frame arithmetic or the
/// anchor subtraction to place a tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedDecoration {
    /// Id of the definition this came from.
    pub id: String,
    /// The canvas the image is drawn on.
    pub resolution: SpriteResolution,
    /// The pixel of that canvas which sits on the cell's ground point.
    pub anchor: PixelOffset,
    /// `[x, y, width, height]` relative to that ground point.
    pub placement: [i32; 4],
    /// Which side of the characters it is drawn on.
    pub plane: DecorationPlane,
    /// Sort key within that plane.
    pub order: i32,
    /// Id of the animation that was played; empty when there was none.
    pub animation: String,
    /// Index of the frame within that animation.
    pub frame: usize,
    /// Path of the image to draw; empty when the frame names none.
    pub asset: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn torch() -> DecorationDefinition {
        serde_json::from_str(
            r#"{
              "id": "torch",
              "schemaVersion": 1,
              "resolution": { "width": 16, "height": 32 },
              "anchor": [8, 31],
              "plane": "front",
              "order": 2,
              "animations": [
                {
                  "id": "burning",
                  "frames": ["a.png", "b.png"],
                  "frameDurationMs": 100,
                  "looping": true
                },
                { "id": "out", "frames": ["out.png"] }
              ]
            }"#,
        )
        .expect("the fixture parses")
    }

    #[test]
    fn a_decoration_parses_from_its_camel_case_file() {
        let torch = torch();
        assert_eq!(torch.plane, DecorationPlane::Front);
        assert_eq!(torch.order, 2);
        assert_eq!(torch.anchor, PixelOffset::new(8, 31));
        assert_eq!(torch.animations.len(), 2);
    }

    #[test]
    fn an_absent_default_animation_is_the_first_declared() {
        let torch = torch();
        assert_eq!(
            torch.resting_animation().map(|a| a.id.as_str()),
            Some("burning")
        );
    }

    /// A default naming an animation that was renamed away still draws: the
    /// first declared stands in rather than the decoration vanishing.
    #[test]
    fn a_dangling_default_animation_falls_back_to_the_first() {
        let mut torch = torch();
        torch.default_animation = "gone".to_owned();
        assert_eq!(
            torch.resting_animation().map(|a| a.id.as_str()),
            Some("burning")
        );
    }

    #[test]
    fn a_looping_animation_wraps_and_a_still_one_holds_its_last_frame() {
        let torch = torch();
        let burning = torch.animation("burning").expect("declared");
        assert_eq!(burning.frame_index_at(0), 0);
        assert_eq!(burning.frame_index_at(100), 1);
        assert_eq!(burning.frame_index_at(200), 0);

        let out = torch.animation("out").expect("declared");
        assert_eq!(out.frame_index_at(10_000), 0);
    }

    #[test]
    fn resolving_answers_the_frame_and_the_placement() {
        let resolved = torch().resolve_at(Some("burning"), 100);
        assert_eq!(resolved.asset, "b.png");
        assert_eq!(resolved.frame, 1);
        // The anchor is the trunk's foot, so the image hangs up and left of it.
        assert_eq!(resolved.placement, [-8, -31, 16, 32]);
        assert_eq!(resolved.plane, DecorationPlane::Front);
    }

    /// An unknown animation is the resting one, not nothing: a preview of a
    /// definition being written must still draw.
    #[test]
    fn an_unknown_animation_resolves_to_the_resting_one() {
        let resolved = torch().resolve_at(Some("nope"), 0);
        assert_eq!(resolved.animation, "burning");
    }

    #[test]
    fn a_decoration_with_no_animation_resolves_to_nothing_drawable() {
        let bare = DecorationDefinition {
            id: "bare".to_owned(),
            schema_version: DECORATION_SCHEMA_VERSION,
            name: String::new(),
            category: DecorationCategory::Other,
            resolution: DEFAULT_DECORATION_RESOLUTION,
            anchor: PixelOffset::new(0, 0),
            plane: DecorationPlane::Behind,
            order: 0,
            tags: Vec::new(),
            animations: Vec::new(),
            default_animation: String::new(),
        };
        let resolved = bare.resolve();
        assert!(resolved.asset.is_empty());
        assert!(resolved.animation.is_empty());
    }
}
