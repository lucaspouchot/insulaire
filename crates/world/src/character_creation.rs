//! Authored character creation: generic choices, player characteristics and
//! the screens that present them.
//!
//! The vocabulary deliberately contains no `race`, `gender`, `hair` or
//! `armour`. Those are author-owned ids. A choice targets either the character
//! definition to resolve or one of that definition's parameters, which is the
//! seam between creation and the resource editor without forcing both lists to
//! be identical
//! (`docs/adr/ADR-0042-character-creation-is-a-generic-authored-workflow.md`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::settings::{resolve_controls, ControlDefinition};

/// Highest character-creation schema version this build understands.
pub const CHARACTER_CREATION_SCHEMA_VERSION: u32 = 1;

/// What one creation choice changes in the resolved character.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CreationBinding {
    /// The chosen value is the id of a character definition.
    Character,
    /// The chosen value is forwarded to this character parameter.
    Parameter {
        /// Id of a `CharacterDefinition.parameters` entry.
        parameter: String,
    },
}

/// One choice offered while a player creates a character.
///
/// The field is the shared control vocabulary: a restricted set of hairstyles
/// is a `select`, eye colour may be a `color`, and height may be a `slider`.
/// `scope` has no meaning here and is ignored, as it is for character
/// parameters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreationChoice {
    /// The control shown to the player and the values it accepts.
    #[serde(flatten)]
    pub field: ControlDefinition,
    /// Where the resolved value goes.
    pub binding: CreationBinding,
}

/// One value stored on the created player independently of appearance.
///
/// A characteristic uses the same scalar vocabulary as every other authored
/// control. Absent numeric bounds mean infinity in that direction; `nullable`
/// permits `null` as the default and as a resolved value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacteristicDefinition {
    /// The control and its default, enum options or numeric bounds.
    #[serde(flatten)]
    pub field: ControlDefinition,
    /// Whether the characteristic may hold JSON `null`.
    #[serde(default)]
    pub nullable: bool,
}

/// Animation used when moving from one creation screen to the next.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScreenTransition {
    /// Replace the screen immediately.
    #[default]
    None,
    /// Cross-fade the screen.
    Fade,
    /// Slide the next screen in from the right.
    SlideLeft,
    /// Slide the next screen in from the bottom.
    SlideUp,
}

/// One item placed on a creation screen, in display order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CreationBlock {
    /// A paragraph of localised text.
    Text {
        /// Key of the paragraph.
        text_key: String,
    },
    /// A previously declared creation choice.
    Choice {
        /// Id in `CharacterCreationDefinition.choices`.
        choice: String,
    },
    /// A previously declared characteristic.
    Characteristic {
        /// Id in `CharacterCreationDefinition.characteristics`.
        characteristic: String,
    },
    /// The character preview, optionally animated and with temporary parameter
    /// overrides. An armour preview is, generically, `{ "armor": "plate" }`.
    Preview {
        /// Animation id. Empty shows the rest pose.
        #[serde(default)]
        animation: String,
        /// Values used only while drawing this preview.
        #[serde(default)]
        parameters: BTreeMap<String, Value>,
    },
    /// A read-only recap of the values already chosen.
    Summary,
}

/// One page of the player-facing creation workflow.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreationScreen {
    /// Stable id, used by authoring tools.
    pub id: String,
    /// Key of the screen heading.
    pub title_key: String,
    /// Key of the optional introduction below the heading.
    #[serde(default)]
    pub text_key: String,
    /// How the screen appears after the previous one.
    #[serde(default)]
    pub transition: ScreenTransition,
    /// What the screen contains, in display order.
    #[serde(default)]
    pub blocks: Vec<CreationBlock>,
}

/// The generic result of resolving a creation form.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterCreationResult {
    /// Character definition chosen by the form.
    pub character: String,
    /// Active creation values, after defaults and conditions.
    pub choices: BTreeMap<String, Value>,
    /// Values forwarded to `CharacterDefinition.parameters`.
    pub parameters: BTreeMap<String, Value>,
    /// Values stored on the player independently of appearance.
    pub characteristics: BTreeMap<String, Value>,
}

/// The authored declaration behind a character-creation workflow.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterCreationDefinition {
    /// Stable content id.
    pub id: String,
    /// Schema version of this file.
    pub schema_version: u32,
    /// Character definition used until a choice targets `character`.
    #[serde(default)]
    pub base_character: String,
    /// Appearance choices, in dependency and display order.
    #[serde(default)]
    pub choices: Vec<CreationChoice>,
    /// Player characteristics, in author order.
    #[serde(default)]
    pub characteristics: Vec<CharacteristicDefinition>,
    /// Player-facing screens, in traversal order.
    #[serde(default)]
    pub screens: Vec<CreationScreen>,
}

impl CharacterCreationDefinition {
    /// The choice with this id.
    #[must_use]
    pub fn choice(&self, id: &str) -> Option<&CreationChoice> {
        self.choices.iter().find(|choice| choice.field.id == id)
    }

    /// The characteristic with this id.
    #[must_use]
    pub fn characteristic(&self, id: &str) -> Option<&CharacteristicDefinition> {
        self.characteristics
            .iter()
            .find(|characteristic| characteristic.field.id == id)
    }

    /// Character ids this declaration can resolve to, in author order.
    #[must_use]
    pub fn character_ids(&self) -> Vec<&str> {
        let mut ids = Vec::new();
        if !self.base_character.is_empty() {
            ids.push(self.base_character.as_str());
        }
        for choice in &self.choices {
            if choice.binding == CreationBinding::Character {
                if let Some(value) = choice.field.default.as_str() {
                    if !ids.contains(&value) {
                        ids.push(value);
                    }
                }
                for option in &choice.field.options {
                    if !ids.contains(&option.value.as_str()) {
                        ids.push(option.value.as_str());
                    }
                }
            }
        }
        ids
    }

    /// Resolves submitted values without interpreting any author-owned id.
    #[must_use]
    pub fn resolve(
        &self,
        choice_values: &Value,
        characteristic_values: &Value,
    ) -> CharacterCreationResult {
        let supplied = resolve_controls(
            self.choices.iter().map(|choice| &choice.field),
            choice_values,
        );
        let mut result = CharacterCreationResult {
            character: self.base_character.clone(),
            ..CharacterCreationResult::default()
        };

        // Conditions only look backwards (validation enforces it), so a single
        // author-order pass has a deterministic answer.
        for choice in &self.choices {
            let visible = choice.field.show_if.as_ref().is_none_or(|condition| {
                result.choices.get(&condition.field) == Some(&condition.equals)
            });
            if !visible {
                continue;
            }
            let Some(value) = supplied.get(&choice.field.id).cloned() else {
                continue;
            };
            result
                .choices
                .insert(choice.field.id.clone(), value.clone());
            match &choice.binding {
                CreationBinding::Character => {
                    if let Some(id) = value.as_str() {
                        result.character = id.to_owned();
                    }
                }
                CreationBinding::Parameter { parameter } => {
                    result.parameters.insert(parameter.clone(), value);
                }
            }
        }

        let supplied_characteristics = characteristic_values.as_object();
        for characteristic in &self.characteristics {
            let field = &characteristic.field;
            let value = supplied_characteristics
                .and_then(|values| values.get(&field.id))
                .filter(|value| {
                    (characteristic.nullable && value.is_null()) || field.accepts(value)
                })
                .map(|value| field.clamp(value.clone()))
                .unwrap_or_else(|| field.default.clone());
            result.characteristics.insert(field.id.clone(), value);
        }

        result
    }

    /// Every localised key this file references, with its content path.
    #[must_use]
    pub fn referenced_keys(&self) -> Vec<(String, &str)> {
        let mut keys = Vec::new();
        for (index, choice) in self.choices.iter().enumerate() {
            keys.extend(control_keys(format!("choices[{index}]"), &choice.field));
        }
        for (index, characteristic) in self.characteristics.iter().enumerate() {
            keys.extend(control_keys(
                format!("characteristics[{index}]"),
                &characteristic.field,
            ));
        }
        for (screen_index, screen) in self.screens.iter().enumerate() {
            let path = format!("screens[{screen_index}]");
            keys.push((format!("{path}.titleKey"), screen.title_key.as_str()));
            if !screen.text_key.is_empty() {
                keys.push((format!("{path}.textKey"), screen.text_key.as_str()));
            }
            for (block_index, block) in screen.blocks.iter().enumerate() {
                if let CreationBlock::Text { text_key } = block {
                    keys.push((
                        format!("{path}.blocks[{block_index}].textKey"),
                        text_key.as_str(),
                    ));
                }
            }
        }
        keys
    }
}

fn control_keys(path: String, field: &ControlDefinition) -> Vec<(String, &str)> {
    let mut keys = vec![(format!("{path}.labelKey"), field.label_key.as_str())];
    if !field.help_key.is_empty() {
        keys.push((format!("{path}.helpKey"), field.help_key.as_str()));
    }
    for (index, option) in field.options.iter().enumerate() {
        keys.push((
            format!("{path}.options[{index}].labelKey"),
            option.label_key.as_str(),
        ));
    }
    keys
}

#[cfg(test)]
mod tests {
    use super::*;

    const CREATION: &str = r#"{
      "id":"new_game", "schemaVersion":1, "baseCharacter":"human",
      "choices":[
        {"id":"race","labelKey":"game.race","control":"select","default":"elf",
         "options":[{"value":"human","labelKey":"game.human"},{"value":"elf","labelKey":"game.elf"}],
         "binding":{"kind":"character"}},
        {"id":"hair","labelKey":"game.hair","control":"select","default":"short",
         "options":[{"value":"short","labelKey":"game.short"},{"value":"long","labelKey":"game.long"}],
         "binding":{"kind":"parameter","parameter":"hairStyle"}}
      ],
      "characteristics":[
        {"id":"age","labelKey":"game.age","control":"number","default":18,"min":0,"nullable":false}
      ],
      "screens":[{"id":"identity","titleKey":"game.identity","blocks":[
        {"type":"choice","choice":"race"},{"type":"choice","choice":"hair"},
        {"type":"characteristic","characteristic":"age"},{"type":"preview","animation":"idle"}
      ]}]
    }"#;

    #[test]
    fn it_parses_and_resolves_without_semantic_branches() {
        let definition: CharacterCreationDefinition =
            serde_json::from_str(CREATION).expect("parse");
        let result = definition.resolve(
            &serde_json::json!({"race":"human","hair":"long"}),
            &serde_json::json!({"age":31}),
        );

        assert_eq!(result.character, "human");
        assert_eq!(result.parameters["hairStyle"], serde_json::json!("long"));
        assert_eq!(result.characteristics["age"], serde_json::json!(31));
        assert!(!result.parameters.contains_key("race"));
    }

    #[test]
    fn nullable_characteristics_keep_null() {
        let mut definition: CharacterCreationDefinition =
            serde_json::from_str(CREATION).expect("parse");
        definition.characteristics[0].nullable = true;
        definition.characteristics[0].field.default = Value::Null;

        let result = definition.resolve(&serde_json::json!({}), &serde_json::json!({"age":null}));
        assert_eq!(result.characteristics["age"], Value::Null);
    }
}
