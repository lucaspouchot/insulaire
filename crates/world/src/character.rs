//! Character definitions: how a *kind* of character is drawn, and what may be
//! chosen about one.
//!
//! Nothing here knows what a player is. A [`CharacterDefinition`] describes a
//! family of characters — the player's, a merchant, a goblin, a dragon — as a
//! list of **parameters** (the choices a definition offers) and a list of
//! **layers** (the pieces it is drawn from). A set of chosen values is a
//! *customisation*, and [`CharacterDefinition::resolve`] turns the two into a
//! [`ResolvedCharacter`]: a flat, ordered list of things to draw, with every
//! colour already resolved.
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
//! # Parameters are settings
//!
//! A parameter *is* a [`ControlDefinition`], the vocabulary the settings screen
//! already speaks (`docs/adr/ADR-0025-settings.md`). "Hair colour" is a
//! `select`, "height" is a `slider`, and both are rendered by the component
//! that renders a volume slider. Values are resolved by the same function, so
//! an unknown option or an out-of-range number means the same thing here as it
//! does there.
//!
//! # What is deliberately absent
//!
//! Animation. A variant draws one thing, and a character is a still image
//! today. The shape that leaves room for the rest is
//! [`LayerVisual`]: a layer resolves to *a visual*, so `Sprite` gaining frames,
//! or a third variant of the enum appearing, changes neither the definition's
//! structure nor the resolver.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::settings::{resolve_controls, ControlDefinition};

/// Highest character schema version this build understands.
pub const CHARACTER_SCHEMA_VERSION: u32 = 1;

/// Colour drawn when a `parameter` colour binding resolves to nothing.
///
/// Validation refuses a binding that names an undeclared parameter, so this is
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

/// How a character's layers are drawn.
///
/// A definition declares one and validation holds it to it, so "this character
/// is built from images" is a fact about the file rather than something you
/// discover by reading every variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RenderingMode {
    /// Shapes described by the definition itself, drawn by the renderer.
    #[default]
    Procedural,
    /// Images combined layer by layer.
    AssetComposition,
}

/// A drawing primitive.
///
/// Closed on purpose: a shape is something the renderer implements, so a new
/// one is a code change, not a content field — the same rule the title screen's
/// actions follow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShapeKind {
    /// An axis-aligned rectangle filling the variant's box.
    #[default]
    Rect,
    /// An ellipse inscribed in the variant's box.
    Ellipse,
    /// A triangle standing on the bottom edge of the variant's box.
    Triangle,
}

/// Where a shape's colour comes from.
///
/// The second case is what makes "hair colour" a *choice* rather than a
/// duplicate variant per colour: one brown-haired layer becomes one layer whose
/// colour is read off a parameter.
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

/// What one layer puts on screen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LayerVisual {
    /// An image, by path under the content root.
    Sprite {
        /// Path under the content root, e.g. `assets/characters/hair_long.png`.
        asset: String,
    },
    /// A shape drawn by the renderer.
    Shape {
        /// Which primitive.
        shape: ShapeKind,
        /// What colour to fill it with.
        color: ColorSource,
    },
}

impl LayerVisual {
    /// The rendering mode this visual belongs to.
    #[must_use]
    pub const fn mode(&self) -> RenderingMode {
        match self {
            Self::Sprite { .. } => RenderingMode::AssetComposition,
            Self::Shape { .. } => RenderingMode::Procedural,
        }
    }
}

/// A box in the character's unit square: `[x, y, width, height]`.
///
/// `0..=1` on both axes, origin top-left, **y down** — the canvas convention,
/// so the renderer scales by its own size and draws. Keeping placement in unit
/// space is what lets one definition be drawn at any size, from a 32-pixel map
/// token to a full-height portrait, without a second set of numbers.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct UnitRect(pub [f32; 4]);

impl UnitRect {
    /// A box from its corner and size.
    #[must_use]
    pub const fn new(x: f32, y: f32, width: f32, height: f32) -> Self {
        Self([x, y, width, height])
    }

    /// Distance from the left edge.
    #[must_use]
    pub const fn x(self) -> f32 {
        self.0[0]
    }

    /// Distance from the top edge.
    #[must_use]
    pub const fn y(self) -> f32 {
        self.0[1]
    }

    /// Width.
    #[must_use]
    pub const fn width(self) -> f32 {
        self.0[2]
    }

    /// Height.
    #[must_use]
    pub const fn height(self) -> f32 {
        self.0[3]
    }

    /// This box scaled about the bottom centre of the unit square.
    ///
    /// The anchor is the *ground line* — the bottom edge, where a character
    /// stands — and that is what makes scaling mean height: everything grows
    /// upward rather than away from the middle of the image, so a tall
    /// character and a short one still have their feet in the same place.
    #[must_use]
    pub fn scaled(self, factor: f32) -> Self {
        // An identity scale returns the box untouched rather than through the
        // arithmetic: `1.0 - (1.0 - y) * 1.0` is not exactly `y` in f32, and a
        // definition with no scale binding must resolve to what it authored.
        if factor == 1.0 {
            return self;
        }
        Self([
            0.5 + (self.x() - 0.5) * factor,
            1.0 - (1.0 - self.y()) * factor,
            self.width() * factor,
            self.height() * factor,
        ])
    }
}

impl Default for UnitRect {
    /// The whole unit square.
    fn default() -> Self {
        Self([0.0, 0.0, 1.0, 1.0])
    }
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
    /// Where it is drawn, in the character's unit square.
    #[serde(default)]
    pub rect: UnitRect,
    /// What it draws.
    pub visual: LayerVisual,
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
    /// How its layers are drawn.
    #[serde(default)]
    pub rendering: RenderingMode,
    /// The choices this definition offers, in author order.
    ///
    /// A definition may offer none — a skeleton that always looks the same is
    /// a list of layers and nothing else.
    #[serde(default)]
    pub parameters: Vec<ControlDefinition>,
    /// The pieces it is drawn from, back to front.
    #[serde(default)]
    pub layers: Vec<CharacterLayer>,
    /// Id of a numeric parameter whose value scales the whole character.
    ///
    /// Empty means no scaling. It is the one binding that acts on geometry
    /// rather than on one layer, because "taller" is not a swap: without it a
    /// height parameter would multiply every variant of every layer.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub scale_parameter: String,
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
    /// variant per layer, place it, resolve its colour. It is deterministic and
    /// total — an empty customisation resolves to the definition's defaults,
    /// and a definition with no layers resolves to nothing to draw.
    #[must_use]
    pub fn resolve(&self, values: &Value) -> ResolvedCharacter {
        let resolved = self.resolve_values(values);
        let scale = self.scale_factor(&resolved);

        let layers = self
            .layers
            .iter()
            .filter_map(|layer| {
                let variant = layer.variant_for(&resolved)?;
                Some(ResolvedLayer {
                    layer: layer.id.clone(),
                    variant: variant.id.clone(),
                    rect: variant.rect.scaled(scale),
                    visual: match &variant.visual {
                        LayerVisual::Sprite { asset } => ResolvedVisual::Sprite {
                            asset: asset.clone(),
                        },
                        LayerVisual::Shape { shape, color } => ResolvedVisual::Shape {
                            shape: *shape,
                            color: color.resolve(&resolved),
                        },
                    },
                })
            })
            .collect();

        ResolvedCharacter {
            character: self.id.clone(),
            category: self.category,
            values: resolved,
            layers,
        }
    }

    /// The scale the customisation asks for; `1.0` when none is bound.
    ///
    /// A non-positive or absent factor is ignored rather than obeyed: a
    /// character scaled to zero is invisible, and that is never what a slider
    /// at its minimum was meant to say.
    fn scale_factor(&self, values: &BTreeMap<String, Value>) -> f32 {
        if self.scale_parameter.is_empty() {
            return 1.0;
        }
        values
            .get(&self.scale_parameter)
            .and_then(Value::as_f64)
            .map(|factor| factor as f32)
            .filter(|factor| *factor > 0.0)
            .unwrap_or(1.0)
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
    /// Where to draw it, scaled, in the unit square.
    pub rect: UnitRect,
    /// What to draw.
    pub visual: ResolvedVisual,
}

/// A visual with nothing left to look up.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ResolvedVisual {
    /// An image to blit, by path under the content root.
    Sprite {
        /// Path under the content root.
        asset: String,
    },
    /// A shape to fill.
    Shape {
        /// Which primitive.
        shape: ShapeKind,
        /// The CSS colour to fill it with, already resolved.
        color: String,
    },
}

/// A character, resolved: an ordered list of things to draw.
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
    /// The customisation actually applied, defaults filled in.
    pub values: BTreeMap<String, Value>,
    /// What to draw, back to front.
    pub layers: Vec<ResolvedLayer>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Scenario 1 of `docs/implementing-character-editor.md`: a customisable
    /// player, drawn procedurally.
    const PLAYER: &str = r##"{
        "id": "human_player",
        "schemaVersion": 1,
        "name": "Human Player",
        "category": "player",
        "rendering": "procedural",
        "scaleParameter": "height",
        "parameters": [
            { "id": "gender", "labelKey": "game.character.gender",
              "control": "select", "default": "female",
              "options": [
                { "value": "female", "labelKey": "game.character.female" },
                { "value": "male", "labelKey": "game.character.male" }
              ] },
            { "id": "hairColor", "labelKey": "game.character.hairColor",
              "control": "color", "default": "#4b3621" },
            { "id": "height", "labelKey": "game.character.height",
              "control": "slider", "default": 1.0, "min": 0.85, "max": 1.15, "step": 0.05 }
        ],
        "layers": [
            { "id": "body", "variants": [
                { "id": "female", "when": { "gender": "female" },
                  "rect": [0.35, 0.35, 0.3, 0.5],
                  "visual": { "kind": "shape", "shape": "triangle",
                              "color": { "fixed": "#7a5c3e" } } },
                { "id": "default", "rect": [0.35, 0.35, 0.3, 0.5],
                  "visual": { "kind": "shape", "shape": "rect",
                              "color": { "fixed": "#7a5c3e" } } }
            ] },
            { "id": "head", "variants": [
                { "id": "default", "rect": [0.4, 0.12, 0.2, 0.22],
                  "visual": { "kind": "shape", "shape": "ellipse",
                              "color": { "fixed": "#e8c39e" } } }
            ] },
            { "id": "hair", "variants": [
                { "id": "default", "rect": [0.38, 0.08, 0.24, 0.14],
                  "visual": { "kind": "shape", "shape": "ellipse",
                              "color": { "parameter": "hairColor" } } }
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
        assert_eq!(character.rendering, RenderingMode::Procedural);
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
        assert_eq!(resolved.values["gender"], serde_json::json!("female"));
        // Three layers, in author order, back to front.
        let drawn: Vec<&str> = resolved
            .layers
            .iter()
            .map(|layer| layer.layer.as_str())
            .collect();
        assert_eq!(drawn, ["body", "head", "hair"]);
    }

    #[test]
    fn a_condition_picks_the_variant_and_author_order_breaks_ties() {
        let female = player().resolve(&serde_json::json!({ "gender": "female" }));
        assert_eq!(female.layers[0].variant, "female");

        // The male body has no variant of its own, so the unconditional one —
        // which is declared *after* it — applies.
        let male = player().resolve(&serde_json::json!({ "gender": "male" }));
        assert_eq!(male.layers[0].variant, "default");
    }

    #[test]
    fn a_colour_parameter_reaches_the_resolved_layer() {
        let resolved = player().resolve(&serde_json::json!({ "hairColor": "#f2c14e" }));
        let hair = resolved
            .layers
            .iter()
            .find(|layer| layer.layer == "hair")
            .expect("hair layer");

        assert_eq!(
            hair.visual,
            ResolvedVisual::Shape {
                shape: ShapeKind::Ellipse,
                color: "#f2c14e".to_owned(),
            }
        );
    }

    #[test]
    fn a_colour_binding_that_holds_no_colour_falls_back_rather_than_panicking() {
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
        assert_eq!(
            hair.visual,
            ResolvedVisual::Shape {
                shape: ShapeKind::Ellipse,
                color: UNRESOLVED_COLOR.to_owned(),
            }
        );
    }

    /// Height is the one parameter that moves geometry: everything grows
    /// upwards from the ground line, so the feet stay where they were.
    #[test]
    fn the_scale_parameter_grows_the_character_from_the_ground_line() {
        let tall = player().resolve(&serde_json::json!({ "height": 1.1 }));
        let plain = player().resolve(&serde_json::json!({ "height": 1.0 }));

        let tall_body = tall.layers[0].rect;
        let plain_body = plain.layers[0].rect;
        assert!(tall_body.height() > plain_body.height());

        // Everything is measured from the ground line at the bottom of the unit
        // square, so the gap beneath a layer grows by exactly the same factor —
        // which is what keeps a layer that *touches* the ground touching it.
        let plain_gap = 1.0 - (plain_body.y() + plain_body.height());
        let tall_gap = 1.0 - (tall_body.y() + tall_body.height());
        assert!(
            (tall_gap - plain_gap * 1.1).abs() < 1e-5,
            "{tall_gap} {plain_gap}"
        );
    }

    #[test]
    fn an_unbound_scale_leaves_the_geometry_alone() {
        let mut character = player();
        character.scale_parameter = String::new();

        let resolved = character.resolve(&serde_json::json!({ "height": 1.1 }));
        assert_eq!(resolved.layers[0].rect, UnitRect::new(0.35, 0.35, 0.3, 0.5));
    }

    /// Scenario 3: a monster, no player concept anywhere, same structures.
    #[test]
    fn a_monster_uses_the_same_structures_and_the_same_resolver() {
        let goblin: CharacterDefinition = serde_json::from_str(
            r##"{
                "id": "goblin", "schemaVersion": 1, "name": "Goblin",
                "category": "monster", "rendering": "procedural",
                "parameters": [
                    { "id": "skinColor", "labelKey": "game.character.skinColor",
                      "control": "color", "default": "#6b8f47" },
                    { "id": "equipment", "labelKey": "game.character.equipment",
                      "control": "multiSelect", "default": ["sword"],
                      "options": [
                        { "value": "sword", "labelKey": "game.character.sword" },
                        { "value": "helmet", "labelKey": "game.character.helmet" }
                      ] }
                ],
                "layers": [
                    { "id": "body", "variants": [
                        { "id": "default", "rect": [0.3, 0.4, 0.4, 0.45],
                          "visual": { "kind": "shape", "shape": "ellipse",
                                      "color": { "parameter": "skinColor" } } }
                    ] },
                    { "id": "helmet", "variants": [
                        { "id": "worn", "when": { "equipment": "helmet" },
                          "rect": [0.35, 0.2, 0.3, 0.12],
                          "visual": { "kind": "shape", "shape": "rect",
                                      "color": { "fixed": "#8d99ae" } } }
                    ] }
                ]
            }"##,
        )
        .expect("parse");

        // A list parameter matches a scalar it contains, and a layer whose
        // variants all fail simply draws nothing.
        let bare = goblin.resolve(&serde_json::json!({ "equipment": ["sword"] }));
        assert_eq!(bare.layers.len(), 1);

        let armed = goblin.resolve(&serde_json::json!({ "equipment": ["sword", "helmet"] }));
        assert_eq!(armed.layers.len(), 2);
        assert_eq!(armed.layers[1].variant, "worn");
    }

    /// Scenario 2: a merchant drawn by combining assets — a different rendering
    /// mode, resolved by the very same code path.
    #[test]
    fn an_asset_composed_character_resolves_through_the_same_pipeline() {
        let merchant: CharacterDefinition = serde_json::from_str(
            r##"{
                "id": "merchant", "schemaVersion": 1, "name": "Merchant NPC",
                "category": "npc", "rendering": "assetComposition",
                "parameters": [
                    { "id": "clothes", "labelKey": "game.character.clothes",
                      "control": "select", "default": "plain",
                      "options": [
                        { "value": "plain", "labelKey": "game.character.plain" },
                        { "value": "rich", "labelKey": "game.character.rich" }
                      ] }
                ],
                "layers": [
                    { "id": "clothes", "variants": [
                        { "id": "rich", "when": { "clothes": "rich" },
                          "visual": { "kind": "sprite", "asset": "assets/characters/rich.png" } },
                        { "id": "plain",
                          "visual": { "kind": "sprite", "asset": "assets/characters/plain.png" } }
                    ] }
                ]
            }"##,
        )
        .expect("parse");

        let resolved = merchant.resolve(&serde_json::json!({ "clothes": "rich" }));
        assert_eq!(
            resolved.layers[0].visual,
            ResolvedVisual::Sprite {
                asset: "assets/characters/rich.png".to_owned()
            }
        );
        // A variant that authors no rect fills the whole unit square.
        assert_eq!(resolved.layers[0].rect, UnitRect::default());
    }

    #[test]
    fn a_definition_without_parameters_resolves_to_its_only_appearance() {
        let skeleton: CharacterDefinition = serde_json::from_str(
            r##"{
                "id": "skeleton", "schemaVersion": 1, "category": "monster",
                "layers": [
                    { "id": "bones", "variants": [
                        { "id": "default",
                          "visual": { "kind": "shape", "shape": "rect",
                                      "color": { "fixed": "#e8e8e8" } } }
                    ] }
                ]
            }"##,
        )
        .expect("parse");

        let resolved = skeleton.resolve(&serde_json::json!({}));
        assert!(resolved.values.is_empty());
        assert_eq!(resolved.layers.len(), 1);
    }

    #[test]
    fn it_lists_every_key_it_references() {
        let player = player();
        let keys: Vec<&str> = player
            .referenced_keys()
            .into_iter()
            .map(|(_, key)| key)
            .collect();

        assert!(keys.contains(&"game.character.gender"));
        assert!(keys.contains(&"game.character.female"));
        assert!(keys.contains(&"game.character.height"));
    }
}
