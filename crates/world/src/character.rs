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
//! # What is deliberately absent
//!
//! Animation. A variant names one image, and a character is a still frame
//! today. The shape that leaves room for the rest is [`Sprite`]: a layer
//! resolves to *a sprite*, so frames, directions and sheet coordinates are
//! fields appearing there rather than a change to what a definition is.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

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

/// One piece a character is drawn from — a body, a head, a wing, a weapon.
///
/// Layers are drawn in author order, back to front. Which *variant* of a layer
/// is drawn depends on the customisation; a layer whose variants all fail draws
/// nothing, which is how an optional piece is authored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterLayer {
    /// Stable id, unique within the definition.
    pub id: String,
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
    /// This is the whole of "character rendering" outside the renderer: pick a
    /// variant per layer, place it, resolve its tint. It is deterministic and
    /// total — an empty customisation resolves to the definition's defaults,
    /// and a definition with no layers resolves to nothing to draw.
    #[must_use]
    pub fn resolve(&self, values: &Value) -> ResolvedCharacter {
        let resolved = self.resolve_values(values);

        let layers = self
            .layers
            .iter()
            .filter_map(|layer| {
                let variant = layer.variant_for(&resolved)?;
                Some(ResolvedLayer {
                    layer: layer.id.clone(),
                    variant: variant.id.clone(),
                    rect: variant.rect,
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
        }
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
    /// Where to draw it on the character's canvas.
    pub rect: PixelRect,
    /// Path of the image to blit, under the content root.
    pub asset: String,
    /// CSS colour to recolour it with. **Empty means draw it as authored.**
    pub tint: String,
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
