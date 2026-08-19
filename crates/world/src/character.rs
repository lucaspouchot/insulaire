//! Character definitions: how a kind of character is drawn, and what may be
//! chosen about one.
//!
//! Nothing here knows what a player is. A [`CharacterDefinition`] describes a
//! family of characters — the player's, a merchant, a goblin, a dragon — as a
//! list of **parameters** (the choices a definition offers) and a list of
//! **layers** (the sprites it is drawn from). A set of chosen values is a
//! *customisation*, and [`CharacterDefinition::resolve`] turns the two into a
//! [`ResolvedCharacter`]: a flat, ordered list of sprites to blit, with every
//! tint already resolved.
//!
//! ```text
//! CharacterDefinition + values ──> resolve() ──> ResolvedCharacter ──> renderer
//! ```
//!
//! That is the whole pipeline, and it is the same one for every category
//! (`docs/adr/ADR-0028-character-definitions.md`). There is no player branch,
//! and the renderer never reads [`CharacterCategory`] — a category is how an
//! author files a definition, not how it is drawn.
//!
//! # Everything is pixels
//!
//! A definition declares its [`SpriteResolution`]: the canvas its sprites are
//! authored on, at most [`MAX_SPRITE_RESOLUTION`] on a side. Every layer is
//! placed on that canvas with an integer [`PixelRect`], because pixel art
//! placed at a fractional position is pixel art with a seam down the middle
//! (`docs/adr/ADR-0029-characters-are-composed-sprites.md`).
//!
//! Size differences between *kinds* of character are the canvas, not a scale
//! factor: a rat is authored at 32×32 and a dragon at 256×256, and the host
//! draws each at its native size times a whole-number zoom.
//!
//! # Parameters are settings
//!
//! A parameter *is* a [`ControlDefinition`], the vocabulary the settings screen
//! already speaks (`docs/adr/ADR-0025-settings.md`). "Hair style" is a
//! `select`, "hair colour" is a `color`, and both are rendered by the component
//! that renders a volume slider. Values are resolved by the same function, so
//! an unknown option or an out-of-range number means the same thing here as it
//! does there.
//!
//! # Layers are nodes
//!
//! A layer is also a **node of a tree**: it may name a [`CharacterLayer::parent`],
//! and an animation's offsets compose down that tree, so a body that drops two
//! pixels takes the head, the hair and everything attached to them with it
//! (`docs/adr/ADR-0031-characters-animate-by-hierarchy-and-offsets.md`).
//!
//! The tree is **not** the draw order. Layers are still drawn in author order,
//! back to front, and `parent` is a separate reference — a head is drawn over a
//! body *and* hangs off it, and those are two different statements.
//!
//! # What is deliberately absent
//!
//! Rotation and scale. A [`crate::animation::Transform`] translates in whole
//! pixels, because rotating or non-integrally scaling pixel art resamples it,
//! which is the thing ADR-0029 exists to prevent. The shape that leaves room
//! for them is the transform itself: a node's local transform is a struct, so
//! a rotation is a field appearing there rather than a change to what a
//! keyframe is.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::animation::{Animation, PixelOffset, Transform};
use crate::settings::{resolve_controls, ControlDefinition};

/// Highest character schema version this build understands.
///
/// `2` is the sprite format of `docs/adr/ADR-0029-characters-are-composed-
/// sprites.md`: a layer draws an image placed in whole pixels on a declared
/// canvas. Version `1` was ADR-0028's, where a layer could also be a coloured
/// primitive placed on a unit square, and no file of it survives — pre-1.0,
/// there is no reader for it and none is coming (`CLAUDE.md`, "Versioning").
pub const CHARACTER_SCHEMA_VERSION: u32 = 2;

/// Largest sprite canvas a character may declare, on either side.
///
/// A cap rather than a preference: the editor draws the canvas, the renderer
/// zooms it by whole numbers, and a definition that asked for 4096 would be a
/// texture, not a character.
pub const MAX_SPRITE_RESOLUTION: u32 = 256;

/// Colour drawn when a `parameter` tint resolves to nothing.
///
/// Validation refuses a tint that names an undeclared parameter, so this is
/// only reached when a *declared* parameter holds something that is not a
/// colour — visible, obviously wrong, and not a panic.
pub const UNRESOLVED_COLOR: &str = "#ff00ff";

/// What a character is used for.
///
/// Filing, not behaviour: the resolver and the renderer never read it. It
/// exists so an editor can group two hundred definitions, and so a later
/// feature can ask a project for "its playable characters" without a naming
/// convention.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize,
)]
#[serde(rename_all = "camelCase")]
pub enum CharacterCategory {
    /// A character a human plays.
    Player,
    /// A character the world is populated with.
    Npc,
    /// A hostile character.
    Enemy,
    /// A non-human hostile character.
    Monster,
    /// Unfiled.
    #[default]
    Other,
}

/// The canvas a character's sprites are authored on, in pixels.
///
/// Every [`PixelRect`] in the definition is a position on *this* grid, so the
/// renderer knows how big the character is without loading a single image.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpriteResolution {
    /// Canvas width in pixels, `1..=`[`MAX_SPRITE_RESOLUTION`].
    pub width: u32,
    /// Canvas height in pixels, `1..=`[`MAX_SPRITE_RESOLUTION`].
    pub height: u32,
}

impl SpriteResolution {
    /// A canvas of this size.
    #[must_use]
    pub const fn new(width: u32, height: u32) -> Self {
        Self { width, height }
    }

    /// Whether both sides are within `1..=`[`MAX_SPRITE_RESOLUTION`].
    #[must_use]
    pub const fn is_valid(self) -> bool {
        self.width >= 1
            && self.height >= 1
            && self.width <= MAX_SPRITE_RESOLUTION
            && self.height <= MAX_SPRITE_RESOLUTION
    }
}

impl Default for SpriteResolution {
    /// A portrait-shaped canvas: the common case for a standing character.
    fn default() -> Self {
        Self::new(64, 128)
    }
}

/// A sprite's box on the character's canvas: `[x, y, width, height]`, in pixels.
///
/// `x` and `y` may be negative — a cape overhangs the canvas on purpose — but
/// they are always **whole pixels**, which is the point: the renderer blits
/// this at an integer zoom, so a sprite lands on the pixel grid it was drawn
/// on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PixelRect(pub [i32; 4]);

impl PixelRect {
    /// A box from its corner and size.
    #[must_use]
    pub const fn new(x: i32, y: i32, width: i32, height: i32) -> Self {
        Self([x, y, width, height])
    }

    /// Distance from the left edge of the canvas.
    #[must_use]
    pub const fn x(self) -> i32 {
        self.0[0]
    }

    /// Distance from the top edge of the canvas.
    #[must_use]
    pub const fn y(self) -> i32 {
        self.0[1]
    }

    /// Width in pixels.
    #[must_use]
    pub const fn width(self) -> i32 {
        self.0[2]
    }

    /// Height in pixels.
    #[must_use]
    pub const fn height(self) -> i32 {
        self.0[3]
    }

    /// This box translated by an animation offset, keeping its size.
    #[must_use]
    pub const fn moved(self, offset: PixelOffset) -> Self {
        Self([
            self.x() + offset.x(),
            self.y() + offset.y(),
            self.width(),
            self.height(),
        ])
    }

    /// `true` when the box lies entirely inside a canvas of this size.
    #[must_use]
    pub const fn fits(self, resolution: SpriteResolution) -> bool {
        self.x() >= 0
            && self.y() >= 0
            && self.x() + self.width() <= resolution.width as i32
            && self.y() + self.height() <= resolution.height as i32
    }
}

impl Default for PixelRect {
    /// A box of no size at the canvas origin — what a variant starts as.
    fn default() -> Self {
        Self([0, 0, 0, 0])
    }
}

/// Where a tint's colour comes from.
///
/// The second case is what makes "hair colour" a *choice* rather than one
/// image per colour: a single greyscale sprite is recoloured by the value the
/// customisation holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ColorSource {
    /// A CSS colour written in the file.
    Fixed(String),
    /// The value of the parameter with this id, which must resolve to a string.
    Parameter(String),
}

impl ColorSource {
    /// The CSS colour this source yields, given a resolved customisation.
    #[must_use]
    pub fn resolve(&self, values: &BTreeMap<String, Value>) -> String {
        match self {
            Self::Fixed(color) => color.clone(),
            Self::Parameter(id) => values
                .get(id)
                .and_then(Value::as_str)
                .unwrap_or(UNRESOLVED_COLOR)
                .to_owned(),
        }
    }
}

/// The image a layer draws, and how it is recoloured.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sprite {
    /// Path under the content root, e.g. `assets/characters/hair_long.png`.
    pub asset: String,
    /// Recolouring, fixed or read off a parameter. Absent draws it as authored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tint: Option<ColorSource>,
}

/// One appearance a layer can take, and the choices it answers to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerVariant {
    /// Stable id, unique within its layer.
    pub id: String,
    /// Parameter values this variant requires. Empty means "always".
    ///
    /// Every entry must match for the variant to apply. A parameter holding a
    /// list matches a scalar it *contains*, which is how one variant answers
    /// "wearing a helmet" without enumerating every other piece of equipment.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub when: BTreeMap<String, Value>,
    /// Where it is drawn on the character's canvas.
    #[serde(default)]
    pub rect: PixelRect,
    /// What it draws.
    pub sprite: Sprite,
}

impl LayerVariant {
    /// Whether this variant's conditions hold for a resolved customisation.
    #[must_use]
    pub fn matches(&self, values: &BTreeMap<String, Value>) -> bool {
        self.when
            .iter()
            .all(|(id, required)| values.get(id).is_some_and(|held| holds(held, required)))
    }
}

/// Whether a held parameter value satisfies a required one.
fn holds(held: &Value, required: &Value) -> bool {
    if held == required {
        return true;
    }
    // A list contains the scalar asked for: `equipment` holding
    // `["helmet", "cape"]` satisfies `{"equipment": "helmet"}`.
    match held {
        Value::Array(items) => items.contains(required),
        _ => false,
    }
}

/// A named point on a layer, for another layer to hang off.
///
/// `at` is a position on the character's canvas, in the same pixels every other
/// coordinate here is in — the *neck*, the *hair line*, the *grip of a hand*.
///
/// An attachment point does not move anything on its own. It exists so a
/// parent/child link can be authored as "the head's hair anchor" instead of a
/// pair of coordinates nobody can check, so the editor can draw the skeleton
/// through the joints rather than through the corners of boxes, and because it
/// is the pivot a rotation will turn about the day there is one
/// (`docs/adr/ADR-0031-characters-animate-by-hierarchy-and-offsets.md`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPoint {
    /// Stable id, unique within its layer.
    pub id: String,
    /// Where it sits on the canvas, in pixels.
    #[serde(default)]
    pub at: PixelOffset,
}

/// One piece a character is drawn from — a body, a head, a wing, a weapon.
///
/// Layers are drawn in author order, back to front. Which *variant* of a layer
/// is drawn depends on the customisation; a layer whose variants all fail draws
/// nothing, which is how an optional piece is authored.
///
/// A layer is also a **node**: [`Self::parent`] makes it hang off another one,
/// and an animation's offsets compose down that tree. Parentage and draw order
/// are independent — a cape is drawn behind the body and still moves with it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterLayer {
    /// Stable id, unique within the definition.
    pub id: String,
    /// Id of the layer this one hangs off. Absent makes it a root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// Which of the parent's [`Self::anchors`] it hangs off, if it names one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_anchor: Option<String>,
    /// Points other layers may hang off.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub anchors: Vec<AttachmentPoint>,
    /// The appearances it can take, most specific first.
    #[serde(default)]
    pub variants: Vec<LayerVariant>,
}

impl CharacterLayer {
    /// The first variant whose conditions hold, if any.
    ///
    /// **First** rather than best: author order is the priority, so a variant
    /// with conditions goes above the one without, and "most specific first"
    /// is a rule an author can see in the file.
    #[must_use]
    pub fn variant_for(&self, values: &BTreeMap<String, Value>) -> Option<&LayerVariant> {
        self.variants.iter().find(|variant| variant.matches(values))
    }

    /// The attachment point with this id, if this layer declares it.
    #[must_use]
    pub fn anchor(&self, id: &str) -> Option<&AttachmentPoint> {
        self.anchors.iter().find(|anchor| anchor.id == id)
    }
}

/// How a kind of character can be drawn, and what may be chosen about it.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterDefinition {
    /// Stable content id.
    pub id: String,
    /// Schema version of this file.
    pub schema_version: u32,
    /// Name shown in the editor. Not player-facing text, so not a key.
    #[serde(default)]
    pub name: String,
    /// What the definition is used for. Never read by the resolver.
    #[serde(default)]
    pub category: CharacterCategory,
    /// The canvas its sprites are authored on.
    #[serde(default)]
    pub resolution: SpriteResolution,
    /// The choices this definition offers, in author order.
    ///
    /// A definition may offer none — a skeleton that always looks the same is
    /// a list of layers and nothing else.
    #[serde(default)]
    pub parameters: Vec<ControlDefinition>,
    /// The pieces it is drawn from, back to front.
    #[serde(default)]
    pub layers: Vec<CharacterLayer>,
    /// The movements it can play. A definition may declare none, and a still
    /// character is what one with none resolves to.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub animations: Vec<Animation>,
}

impl CharacterDefinition {
    /// The parameter with this id, if it is declared.
    #[must_use]
    pub fn parameter(&self, id: &str) -> Option<&ControlDefinition> {
        self.parameters.iter().find(|field| field.id == id)
    }

    /// The layer with this id, if it is declared.
    #[must_use]
    pub fn layer(&self, id: &str) -> Option<&CharacterLayer> {
        self.layers.iter().find(|layer| layer.id == id)
    }

    /// The animation with this id, if it is declared.
    #[must_use]
    pub fn animation(&self, id: &str) -> Option<&Animation> {
        self.animations.iter().find(|animation| animation.id == id)
    }

    /// Fills in defaults, drops what is not declared, and clamps what is.
    ///
    /// The same function the settings screen resolves through, so a
    /// customisation and a settings payload cannot disagree about what an
    /// unknown key or an out-of-range number means.
    #[must_use]
    pub fn resolve_values(&self, values: &Value) -> BTreeMap<String, Value> {
        resolve_controls(self.parameters.iter(), values)
    }

    /// Every text key this file references, with the path that names it.
    #[must_use]
    pub fn referenced_keys(&self) -> Vec<(String, &str)> {
        let mut keys = Vec::new();
        for (index, parameter) in self.parameters.iter().enumerate() {
            let path = format!("parameters[{index}]");
            keys.push((format!("{path}.labelKey"), parameter.label_key.as_str()));
            if !parameter.help_key.is_empty() {
                keys.push((format!("{path}.helpKey"), parameter.help_key.as_str()));
            }
            for (option_index, option) in parameter.options.iter().enumerate() {
                keys.push((
                    format!("{path}.options[{option_index}].labelKey"),
                    option.label_key.as_str(),
                ));
            }
        }
        keys
    }

    /// Turns this definition plus a customisation into something drawable.
    ///
    /// The rest pose: what the character looks like when nothing is playing.
    /// Equivalent to [`Self::resolve_at`] with no animation.
    #[must_use]
    pub fn resolve(&self, values: &Value) -> ResolvedCharacter {
        self.resolve_at(values, None, 0)
    }

    /// Turns this definition, a customisation and a moment of an animation into
    /// something drawable.
    ///
    /// This is the whole of "character rendering" outside the renderer, and the
    /// order matters (§23 of `docs/implementing-character-animator.md`):
    ///
    /// 1. resolve the customisation — defaults, clamps, unknown keys dropped;
    /// 2. pick a variant per layer and resolve its tint, from *those* values;
    /// 3. evaluate the animation into a local transform per node;
    /// 4. compose those down the hierarchy into a global transform per node;
    /// 5. move each layer's box by its node's offset.
    ///
    /// An animation therefore never touches what a layer *is* — only where it
    /// is. A hair layer tinted from `hairColor` keeps that colour through every
    /// frame, because the tint was resolved before the animation was read.
    ///
    /// It is deterministic and total: an unknown animation id resolves to the
    /// rest pose rather than an error, which is what lets the editor preview a
    /// definition that is still being written.
    #[must_use]
    pub fn resolve_at(
        &self,
        values: &Value,
        animation: Option<&str>,
        time_ms: u32,
    ) -> ResolvedCharacter {
        let resolved = self.resolve_values(values);
        let playing = animation.and_then(|id| self.animation(id));
        let offsets = self.offsets_at(playing, time_ms);

        let layers = self
            .layers
            .iter()
            .filter_map(|layer| {
                let variant = layer.variant_for(&resolved)?;
                let offset = offsets
                    .get(layer.id.as_str())
                    .copied()
                    .unwrap_or_default()
                    .offset;
                Some(ResolvedLayer {
                    layer: layer.id.clone(),
                    variant: variant.id.clone(),
                    rect: variant.rect.moved(offset),
                    offset,
                    asset: variant.sprite.asset.clone(),
                    tint: variant
                        .sprite
                        .tint
                        .as_ref()
                        .map(|tint| tint.resolve(&resolved))
                        .unwrap_or_default(),
                })
            })
            .collect();

        ResolvedCharacter {
            character: self.id.clone(),
            category: self.category,
            resolution: self.resolution,
            values: resolved,
            layers,
            pose: playing.map(|animation| ResolvedPose {
                animation: animation.id.clone(),
                frame: animation.frame_at(time_ms),
                time_ms,
            }),
        }
    }

    /// Every node's **global** transform at this moment.
    ///
    /// The composition of §3: a node's global transform is its parent's global
    /// transform with its own local one applied on top, so a local correction
    /// adds to what was inherited rather than replacing it. Composing
    /// translations is adding them, so this is the sum of the local transforms
    /// along the chain from the node up to its root.
    ///
    /// Only nodes the animation actually moved are walked, and only nodes that
    /// end up moved are returned — the common case is two tracks and thirty
    /// layers that follow, and thirty identities are worth neither the walk nor
    /// the map entry.
    ///
    /// A parent chain that loops stops at the repeat rather than recursing:
    /// a cycle is a content error and validation reports it
    /// (`character.circularHierarchy`), but the resolver still owes a picture.
    #[must_use]
    pub fn offsets_at(
        &self,
        animation: Option<&Animation>,
        time_ms: u32,
    ) -> BTreeMap<&str, Transform> {
        let locals = animation
            .map(|animation| animation.local_transforms(time_ms))
            .unwrap_or_default();
        if locals.is_empty() {
            return BTreeMap::new();
        }

        self.layers
            .iter()
            .filter_map(|layer| {
                let global = self.compose_up(layer, &locals);
                (!global.is_identity()).then_some((layer.id.as_str(), global))
            })
            .collect()
    }

    /// This node's local transform composed with every ancestor's.
    fn compose_up(&self, layer: &CharacterLayer, locals: &BTreeMap<&str, Transform>) -> Transform {
        let mut global = Transform::identity();
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        let mut node = Some(layer);

        while let Some(current) = node {
            if !seen.insert(current.id.as_str()) {
                break;
            }
            if let Some(local) = locals.get(current.id.as_str()) {
                global = global.compose(*local);
            }
            node = current.parent.as_deref().and_then(|id| self.layer(id));
        }
        global
    }
}

/// One layer of a resolved character, ready to draw.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLayer {
    /// Id of the layer it came from.
    pub layer: String,
    /// Id of the variant that applied.
    pub variant: String,
    /// Where to draw it on the character's canvas, **animation included**.
    pub rect: PixelRect,
    /// How far the animation moved it from its rest pose, inherited transforms
    /// included. Already applied to [`Self::rect`]; a renderer ignores it, and
    /// an editor uses it to say what the hierarchy did.
    #[serde(default)]
    pub offset: PixelOffset,
    /// Path of the image to blit, under the content root.
    pub asset: String,
    /// CSS colour to recolour it with. **Empty means draw it as authored.**
    pub tint: String,
}

/// Which moment of which animation a resolved character is.
///
/// Absent on a rest pose. It is carried so a payload says what it is —
/// a frame captured out of a preview and one captured out of a game are
/// comparable, which is the point of both going through the same resolver.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPose {
    /// Id of the animation that was playing.
    pub animation: String,
    /// The frame it was showing, `0`-based.
    pub frame: u32,
    /// The time it was asked for, in milliseconds since the animation started.
    pub time_ms: u32,
}

/// A character, resolved: an ordered list of sprites to draw.
///
/// The renderer needs nothing else — no definition, no customisation, no
/// lookup. That is what lets the same struct feed the editor's preview, a map
/// token and a portrait.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedCharacter {
    /// Id of the definition it came from.
    pub character: String,
    /// Its category, carried for the host's convenience; the renderer ignores it.
    pub category: CharacterCategory,
    /// The canvas the layer boxes are positions on.
    pub resolution: SpriteResolution,
    /// The customisation actually applied, defaults filled in.
    pub values: BTreeMap<String, Value>,
    /// What to draw, back to front.
    pub layers: Vec<ResolvedLayer>,
    /// The animation and moment this pose came from. Absent is the rest pose.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pose: Option<ResolvedPose>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A customisable player, drawn by combining sprites: the first scenario of
    /// `docs/implementing-character-editor.md`, as it is actually authored.
    const PLAYER: &str = r##"{
        "id": "human_player",
        "schemaVersion": 1,
        "name": "Human Player",
        "category": "player",
        "resolution": { "width": 64, "height": 128 },
        "parameters": [
            { "id": "hairStyle", "labelKey": "game.character.hairStyle",
              "control": "select", "default": "long",
              "options": [
                { "value": "long", "labelKey": "game.character.hairLong" },
                { "value": "short", "labelKey": "game.character.hairShort" }
              ] },
            { "id": "hairColor", "labelKey": "game.character.hairColor",
              "control": "color", "default": "#8b5a2b" },
            { "id": "cape", "labelKey": "game.character.cape",
              "control": "toggle", "default": true }
        ],
        "layers": [
            { "id": "cape", "variants": [
                { "id": "worn", "when": { "cape": true }, "rect": [8, 28, 48, 92],
                  "sprite": { "asset": "assets/characters/cape.png" } }
            ] },
            { "id": "body", "variants": [
                { "id": "default", "rect": [20, 12, 24, 108],
                  "sprite": { "asset": "assets/characters/body.png" } }
            ] },
            { "id": "hair", "variants": [
                { "id": "long", "when": { "hairStyle": "long" }, "rect": [20, 8, 24, 30],
                  "sprite": { "asset": "assets/characters/hair_long.png",
                              "tint": { "parameter": "hairColor" } } },
                { "id": "short", "rect": [21, 8, 22, 18],
                  "sprite": { "asset": "assets/characters/hair_short.png",
                              "tint": { "parameter": "hairColor" } } }
            ] }
        ]
    }"##;

    fn player() -> CharacterDefinition {
        serde_json::from_str(PLAYER).expect("parse")
    }

    #[test]
    fn a_definition_parses_and_round_trips() {
        let character = player();
        assert_eq!(character.category, CharacterCategory::Player);
        assert_eq!(character.resolution, SpriteResolution::new(64, 128));
        assert_eq!(character.parameters.len(), 3);
        assert!(character.parameter("hairColor").is_some());
        assert!(character.parameter("wings").is_none());
        assert!(character.layer("hair").is_some());

        let reparsed: CharacterDefinition =
            serde_json::from_str(&serde_json::to_string(&character).expect("serialise"))
                .expect("reparse");
        assert_eq!(character, reparsed);
    }

    #[test]
    fn an_empty_customisation_resolves_to_the_declared_defaults() {
        let resolved = player().resolve(&serde_json::json!({}));

        assert_eq!(resolved.character, "human_player");
        assert_eq!(resolved.resolution, SpriteResolution::new(64, 128));
        assert_eq!(resolved.values["hairStyle"], serde_json::json!("long"));
        // Three layers, in author order, back to front.
        let drawn: Vec<&str> = resolved
            .layers
            .iter()
            .map(|layer| layer.layer.as_str())
            .collect();
        assert_eq!(drawn, ["cape", "body", "hair"]);
    }

    #[test]
    fn a_condition_picks_the_variant_and_author_order_breaks_ties() {
        let long = player().resolve(&serde_json::json!({ "hairStyle": "long" }));
        let hair = long
            .layers
            .iter()
            .find(|l| l.layer == "hair")
            .expect("hair");
        assert_eq!(hair.variant, "long");
        assert_eq!(hair.asset, "assets/characters/hair_long.png");

        // The short style has no condition of its own, so the unconditional
        // variant — declared *after* the long one — applies.
        let short = player().resolve(&serde_json::json!({ "hairStyle": "short" }));
        let hair = short
            .layers
            .iter()
            .find(|l| l.layer == "hair")
            .expect("hair");
        assert_eq!(hair.variant, "short");
    }

    /// A toggled-off layer is a layer with no matching variant: it simply is
    /// not in the resolved list, which is how an optional piece is authored.
    #[test]
    fn a_layer_whose_variants_all_fail_draws_nothing() {
        let without = player().resolve(&serde_json::json!({ "cape": false }));
        assert!(!without.layers.iter().any(|layer| layer.layer == "cape"));

        let with = player().resolve(&serde_json::json!({ "cape": true }));
        assert_eq!(with.layers[0].layer, "cape");
    }

    #[test]
    fn a_tint_parameter_reaches_the_resolved_layer() {
        let resolved = player().resolve(&serde_json::json!({ "hairColor": "#f2c14e" }));
        let hair = resolved
            .layers
            .iter()
            .find(|layer| layer.layer == "hair")
            .expect("hair layer");

        assert_eq!(hair.tint, "#f2c14e");
        // The box is carried through as authored: whole pixels, no scaling.
        assert_eq!(hair.rect, PixelRect::new(20, 8, 24, 30));
    }

    #[test]
    fn a_sprite_with_no_tint_resolves_to_no_tint() {
        let resolved = player().resolve(&serde_json::json!({}));
        let body = resolved
            .layers
            .iter()
            .find(|layer| layer.layer == "body")
            .expect("body layer");

        assert_eq!(body.tint, "");
    }

    #[test]
    fn a_tint_binding_that_holds_no_colour_falls_back_rather_than_panicking() {
        let mut character = player();
        // A number where a colour was expected: resolvable, not a colour.
        character.parameters[1].control = crate::settings::ControlKind::Number;
        character.parameters[1].default = serde_json::json!(3);

        let resolved = character.resolve(&serde_json::json!({}));
        let hair = resolved
            .layers
            .iter()
            .find(|layer| layer.layer == "hair")
            .expect("hair layer");
        assert_eq!(hair.tint, UNRESOLVED_COLOR);
    }

    /// A monster: no player concept anywhere, same structures, a smaller canvas
    /// — which is how a goblin is smaller than a knight.
    #[test]
    fn a_monster_uses_the_same_structures_and_its_own_canvas() {
        let goblin: CharacterDefinition = serde_json::from_str(
            r##"{
                "id": "goblin", "schemaVersion": 1, "name": "Goblin",
                "category": "monster",
                "resolution": { "width": 32, "height": 48 },
                "parameters": [
                    { "id": "skinColor", "labelKey": "k", "control": "color",
                      "default": "#6b8f47" },
                    { "id": "equipment", "labelKey": "k", "control": "multiSelect",
                      "default": ["sword"],
                      "options": [
                        { "value": "sword", "labelKey": "k" },
                        { "value": "helmet", "labelKey": "k" }
                      ] }
                ],
                "layers": [
                    { "id": "body", "variants": [
                        { "id": "default", "rect": [4, 8, 24, 40],
                          "sprite": { "asset": "assets/characters/goblin.png",
                                      "tint": { "parameter": "skinColor" } } }
                    ] },
                    { "id": "helmet", "variants": [
                        { "id": "worn", "when": { "equipment": "helmet" },
                          "rect": [8, 4, 16, 10],
                          "sprite": { "asset": "assets/characters/helmet.png" } }
                    ] }
                ]
            }"##,
        )
        .expect("parse");

        assert_eq!(goblin.resolution, SpriteResolution::new(32, 48));

        // A list parameter matches a scalar it contains.
        let bare = goblin.resolve(&serde_json::json!({ "equipment": ["sword"] }));
        assert_eq!(bare.layers.len(), 1);

        let armed = goblin.resolve(&serde_json::json!({ "equipment": ["sword", "helmet"] }));
        assert_eq!(armed.layers.len(), 2);
        assert_eq!(armed.layers[1].variant, "worn");
    }

    #[test]
    fn a_definition_without_parameters_resolves_to_its_only_appearance() {
        let skeleton: CharacterDefinition = serde_json::from_str(
            r##"{
                "id": "skeleton", "schemaVersion": 1, "category": "monster",
                "layers": [
                    { "id": "bones", "variants": [
                        { "id": "default", "rect": [0, 0, 64, 128],
                          "sprite": { "asset": "assets/characters/skeleton.png" } }
                    ] }
                ]
            }"##,
        )
        .expect("parse");

        let resolved = skeleton.resolve(&serde_json::json!({}));
        assert!(resolved.values.is_empty());
        assert_eq!(resolved.layers.len(), 1);
        // A file that names no canvas gets the default one.
        assert_eq!(resolved.resolution, SpriteResolution::default());
    }

    #[test]
    fn a_box_knows_whether_it_fits_the_canvas() {
        let canvas = SpriteResolution::new(64, 128);
        assert!(PixelRect::new(0, 0, 64, 128).fits(canvas));
        assert!(PixelRect::new(20, 8, 24, 30).fits(canvas));
        // A cape hanging off the left edge, and one running past the bottom.
        assert!(!PixelRect::new(-4, 8, 24, 30).fits(canvas));
        assert!(!PixelRect::new(0, 100, 64, 40).fits(canvas));
    }

    // ----------------------------------------------------------- hierarchy

    /// The skeleton of §28: a body with a head, hair on the head, two arms and
    /// a piece of armour — and a four-frame breathing idle that only ever
    /// mentions the body.
    const SKELETON: &str = r#"{
        "id": "knight", "schemaVersion": 2, "resolution": { "width": 64, "height": 128 },
        "layers": [
            { "id": "body", "anchors": [ { "id": "neck", "at": [32, 40] } ],
              "variants": [ { "id": "d", "rect": [20, 40, 24, 76],
                              "sprite": { "asset": "a/body.png" } } ] },
            { "id": "head", "parent": "body", "parentAnchor": "neck",
              "anchors": [ { "id": "hairline", "at": [32, 14] } ],
              "variants": [ { "id": "d", "rect": [24, 12, 16, 28],
                              "sprite": { "asset": "a/head.png" } } ] },
            { "id": "hair", "parent": "head", "parentAnchor": "hairline",
              "variants": [ { "id": "d", "rect": [23, 8, 18, 20],
                              "sprite": { "asset": "a/hair.png" } } ] },
            { "id": "leftArm", "parent": "body",
              "variants": [ { "id": "d", "rect": [14, 44, 8, 34],
                              "sprite": { "asset": "a/arm.png" } } ] },
            { "id": "rightArm", "parent": "body",
              "variants": [ { "id": "d", "rect": [42, 44, 8, 34],
                              "sprite": { "asset": "a/arm.png" } } ] },
            { "id": "armor", "parent": "body",
              "variants": [ { "id": "d", "rect": [19, 44, 26, 24],
                              "sprite": { "asset": "a/armor.png" } } ] }
        ],
        "animations": [
            { "id": "idle", "name": "Idle", "frames": 4, "frameDurationMs": 120,
              "looping": true, "tracks": [
                { "node": "body", "keyframes": [
                    { "frame": 0, "offset": [0, 0] },
                    { "frame": 1, "offset": [0, -2] },
                    { "frame": 2, "offset": [0, 0] },
                    { "frame": 3, "offset": [0, 2] } ] } ] }
        ]
    }"#;

    fn knight() -> CharacterDefinition {
        serde_json::from_str(SKELETON).expect("parse")
    }

    impl CharacterDefinition {
        /// The layer with this id, mutably — tests only, to bend a definition
        /// into a shape an author could write but should not.
        fn layer_mut(&mut self, id: &str) -> &mut CharacterLayer {
            self.layers
                .iter_mut()
                .find(|layer| layer.id == id)
                .unwrap_or_else(|| panic!("layer `{id}`"))
        }
    }

    /// Where a layer's box ends up, once everything has been applied.
    fn drawn(resolved: &ResolvedCharacter, layer: &str) -> ResolvedLayer {
        resolved
            .layers
            .iter()
            .find(|drawn| drawn.layer == layer)
            .cloned()
            .unwrap_or_else(|| panic!("layer `{layer}` was not drawn"))
    }

    #[test]
    fn a_hierarchy_parses_and_round_trips() {
        let knight = knight();
        assert_eq!(
            knight.layer("head").expect("head").parent.as_deref(),
            Some("body")
        );
        assert_eq!(
            knight.layer("hair").expect("hair").parent_anchor.as_deref(),
            Some("hairline")
        );
        assert_eq!(
            knight
                .layer("body")
                .expect("body")
                .anchor("neck")
                .expect("neck")
                .at,
            PixelOffset::new(32, 40)
        );
        assert!(knight.layer("body").expect("body").parent.is_none());
        assert!(knight.animation("idle").is_some());
        assert!(knight.animation("walk").is_none());

        let reparsed: CharacterDefinition =
            serde_json::from_str(&serde_json::to_string(&knight).expect("serialise"))
                .expect("reparse");
        assert_eq!(knight, reparsed);
    }

    /// §25, propagation: the animation names only the body, and the whole
    /// character moves with it.
    #[test]
    fn a_parents_offset_reaches_every_descendant() {
        let knight = knight();
        let rest = knight.resolve(&serde_json::json!({}));
        let up = knight.resolve_at(&serde_json::json!({}), Some("idle"), 120);

        for layer in ["body", "head", "hair", "leftArm", "rightArm", "armor"] {
            assert_eq!(
                drawn(&up, layer).rect.y(),
                drawn(&rest, layer).rect.y() - 2,
                "layer `{layer}` did not follow the body"
            );
            assert_eq!(drawn(&up, layer).offset, PixelOffset::new(0, -2));
            // Only the position moves; the box keeps its size.
            assert_eq!(
                drawn(&up, layer).rect.width(),
                drawn(&rest, layer).rect.width()
            );
        }
    }

    /// §25, local correction: a child's own keyframe *adds* to what it
    /// inherited rather than replacing it.
    #[test]
    fn a_local_correction_adds_to_the_inherited_transform() {
        let mut knight = knight();
        knight.animations[0].tracks.push(
            serde_json::from_str(
                r#"{ "node": "head", "keyframes": [ { "frame": 1, "offset": [1, 1] } ] }"#,
            )
            .expect("parse track"),
        );

        let rest = knight.resolve(&serde_json::json!({}));
        let posed = knight.resolve_at(&serde_json::json!({}), Some("idle"), 120);

        // Body: -2. Head: -2 inherited, +1 of its own, so -1.
        assert_eq!(drawn(&posed, "body").offset, PixelOffset::new(0, -2));
        assert_eq!(drawn(&posed, "head").offset, PixelOffset::new(1, -1));
        assert_eq!(
            drawn(&posed, "head").rect.y(),
            drawn(&rest, "head").rect.y() - 1
        );
        // And the hair, two levels down, carries both.
        assert_eq!(drawn(&posed, "hair").offset, PixelOffset::new(1, -1));
    }

    /// §25, partial tracks: everything that has no track is still drawn, in
    /// its rest pose or its parent's.
    #[test]
    fn a_partial_animation_still_draws_the_whole_character() {
        let knight = knight();
        let rest = knight.resolve(&serde_json::json!({}));
        let posed = knight.resolve_at(&serde_json::json!({}), Some("idle"), 0);

        assert_eq!(posed.layers.len(), rest.layers.len());
        assert_eq!(
            posed
                .layers
                .iter()
                .map(|l| l.layer.as_str())
                .collect::<Vec<_>>(),
            ["body", "head", "hair", "leftArm", "rightArm", "armor"],
        );
        // Frame 0 of the idle is the rest pose, so nothing moved.
        for layer in &posed.layers {
            assert_eq!(layer.offset, PixelOffset::default());
        }
    }

    #[test]
    fn the_pose_says_which_frame_it_is() {
        let knight = knight();
        let posed = knight.resolve_at(&serde_json::json!({}), Some("idle"), 380);
        let pose = posed.pose.expect("a pose");
        assert_eq!(pose.animation, "idle");
        assert_eq!(pose.frame, 3);
        assert_eq!(pose.time_ms, 380);

        // The rest pose is not a pose.
        assert!(knight.resolve(&serde_json::json!({})).pose.is_none());
    }

    /// An animation the definition does not declare is not an error: the editor
    /// previews a definition mid-edit, and an id it has just deleted must not
    /// take the preview with it.
    #[test]
    fn an_unknown_animation_resolves_to_the_rest_pose() {
        let knight = knight();
        let unknown = knight.resolve_at(&serde_json::json!({}), Some("walk"), 5_000);
        assert_eq!(
            unknown.layers,
            knight.resolve(&serde_json::json!({})).layers
        );
        assert!(unknown.pose.is_none());
    }

    /// §25, loop: a full cycle later, the character is where it started.
    #[test]
    fn a_looping_animation_comes_back_to_its_first_frame() {
        let knight = knight();
        let first = knight.resolve_at(&serde_json::json!({}), Some("idle"), 120);
        let later = knight.resolve_at(&serde_json::json!({}), Some("idle"), 120 + 480 * 7);
        assert_eq!(first.layers, later.layers);
    }

    /// §25, determinism: same time, same data, same picture.
    #[test]
    fn resolution_is_deterministic() {
        let knight = knight();
        for time in [0_u32, 61, 120, 479, 480, 9_999] {
            assert_eq!(
                knight.resolve_at(&serde_json::json!({}), Some("idle"), time),
                knight.resolve_at(&serde_json::json!({}), Some("idle"), time),
            );
        }
    }

    /// §22: the animation moves the node and leaves the procedural resolution
    /// alone — a tinted layer keeps its colour through every frame.
    #[test]
    fn an_animation_does_not_disturb_the_resolved_parameters() {
        let mut knight = knight();
        knight.parameters.push(
            serde_json::from_str(
                r##"{ "id": "hairColor", "labelKey": "k", "control": "color",
                      "default": "#8b5a2b" }"##,
            )
            .expect("parse parameter"),
        );
        knight.layers[2].variants[0].sprite.tint =
            Some(ColorSource::Parameter("hairColor".to_owned()));

        let values = serde_json::json!({ "hairColor": "#f2c14e" });
        for time in [0_u32, 120, 240, 360] {
            let posed = knight.resolve_at(&values, Some("idle"), time);
            assert_eq!(drawn(&posed, "hair").tint, "#f2c14e");
            assert_eq!(drawn(&posed, "hair").asset, "a/hair.png");
            assert_eq!(posed.values["hairColor"], serde_json::json!("#f2c14e"));
        }
    }

    /// A layer whose variants all fail is still absent when animated, and its
    /// children still follow the parent that *is* drawn.
    #[test]
    fn an_undrawn_layer_does_not_break_the_chain() {
        let mut knight = knight();
        // The head draws nothing, but the hair still hangs off it.
        knight.layers[1].variants.clear();

        let posed = knight.resolve_at(&serde_json::json!({}), Some("idle"), 120);
        assert!(!posed.layers.iter().any(|layer| layer.layer == "head"));
        assert_eq!(drawn(&posed, "hair").offset, PixelOffset::new(0, -2));
    }

    /// A cycle is a content error, and validation says so. What the resolver
    /// owes is a picture rather than a stack overflow.
    #[test]
    fn a_circular_hierarchy_resolves_rather_than_recursing_forever() {
        let mut knight = knight();
        knight.layer_mut("body").parent = Some("hair".to_owned());

        let posed = knight.resolve_at(&serde_json::json!({}), Some("idle"), 120);
        assert_eq!(posed.layers.len(), 6);
        // The body still carries its own keyframe; nothing hangs.
        assert_eq!(drawn(&posed, "body").offset.y(), -2);
    }

    #[test]
    fn a_layer_that_parents_itself_keeps_only_its_own_transform() {
        let mut knight = knight();
        knight.layer_mut("body").parent = Some("body".to_owned());
        let posed = knight.resolve_at(&serde_json::json!({}), Some("idle"), 360);
        assert_eq!(drawn(&posed, "body").offset, PixelOffset::new(0, 2));
    }

    /// A definition with no hierarchy and no animations resolves exactly as it
    /// did before either existed (§27).
    #[test]
    fn a_definition_without_animations_is_untouched() {
        let player = player();
        assert!(player.animations.is_empty());
        let resolved = player.resolve(&serde_json::json!({}));
        assert!(resolved.pose.is_none());
        assert!(resolved.layers.iter().all(|layer| layer.offset.is_zero()));
        assert_eq!(
            resolved,
            player.resolve_at(&serde_json::json!({}), None, 9_000)
        );
    }

    #[test]
    fn it_lists_every_key_it_references() {
        let player = player();
        let keys: Vec<&str> = player
            .referenced_keys()
            .into_iter()
            .map(|(_, key)| key)
            .collect();

        assert!(keys.contains(&"game.character.hairStyle"));
        assert!(keys.contains(&"game.character.hairLong"));
        assert!(keys.contains(&"game.character.cape"));
    }
}
