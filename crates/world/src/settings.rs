//! Authored settings: the options a game offers, declared as data.
//!
//! There are two kinds of setting and only one of them lives here.
//!
//! **The application's** settings — window size, interface scale, text speed,
//! volumes, language — configure the shell around the game. They are fixed, the
//! application implements each one, and the engine has no business knowing that
//! a screen has a size (`docs/adr/ADR-0025-settings.md`).
//!
//! **The game's** settings — difficulty, starting population, whichever knobs a
//! particular game wants — are content: a project declares them, the player sets
//! them, and `createGame` receives them. The engine never interprets one; it
//! validates the declaration, resolves the values against it, and hands them to
//! the simulation, which is what keeps scenario-specific behaviour out of the
//! engine (`CLAUDE.md`).
//!
//! Both are described with the **same vocabulary** — [`ControlDefinition`] — so
//! one screen renders them side by side and an author has one set of concepts
//! to learn. Labels are keys, like all displayed text (ADR-0023).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Highest settings schema version this build understands.
pub const SETTINGS_SCHEMA_VERSION: u32 = 1;

/// How a setting is presented, and therefore what values it accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ControlKind {
    /// On/off, rendered as a switch. Boolean.
    Toggle,
    /// On/off, rendered as a checkbox. Boolean.
    Checkbox,
    /// One value out of a list. String.
    Select,
    /// Any number of values out of a list. Array of strings.
    MultiSelect,
    /// A number on a track. Number, `min..=max`.
    Slider,
    /// A number in a field. Number, `min..=max` when given.
    Number,
    /// Free text. String.
    Text,
    /// A CSS colour. String.
    Color,
}

impl ControlKind {
    /// `true` when this control's value is a list rather than a scalar.
    #[must_use]
    pub const fn is_multiple(self) -> bool {
        matches!(self, Self::MultiSelect)
    }

    /// `true` when this control chooses from a declared list of options.
    #[must_use]
    pub const fn uses_options(self) -> bool {
        matches!(self, Self::Select | Self::MultiSelect)
    }

    /// `true` when this control is numeric.
    #[must_use]
    pub const fn is_numeric(self) -> bool {
        matches!(self, Self::Slider | Self::Number)
    }

    /// `true` when this control is a boolean.
    #[must_use]
    pub const fn is_boolean(self) -> bool {
        matches!(self, Self::Toggle | Self::Checkbox)
    }
}

/// When a setting may be changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SettingScope {
    /// Applies immediately and may change at any time — a volume, a text speed.
    #[default]
    Session,
    /// Frozen once a game exists, because the game was created with it.
    NewGame,
}

/// One choice offered by a `select` or `multiSelect`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlOption {
    /// The stored value.
    pub value: String,
    /// Key of the label shown for it.
    pub label_key: String,
}

/// Shows a field only when another one holds a given value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowIf {
    /// Id of the field to look at.
    pub field: String,
    /// The value it must hold.
    pub equals: Value,
}

/// One setting: what it is called, how it is shown, and what it accepts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlDefinition {
    /// Stable id; the key its value is stored under.
    pub id: String,
    /// Key of its label.
    pub label_key: String,
    /// Key of the sentence under it.
    #[serde(default)]
    pub help_key: String,
    /// How it is presented.
    pub control: ControlKind,
    /// The value used until the player changes it.
    pub default: Value,
    /// Choices, for `select` and `multiSelect`.
    #[serde(default)]
    pub options: Vec<ControlOption>,
    /// Lower bound, for numeric controls.
    #[serde(default)]
    pub min: Option<f64>,
    /// Upper bound, for numeric controls.
    #[serde(default)]
    pub max: Option<f64>,
    /// Step, for numeric controls.
    #[serde(default)]
    pub step: Option<f64>,
    /// Unit shown next to the value, e.g. `%`. Displayed as written.
    #[serde(default)]
    pub unit: String,
    /// When it may be changed.
    #[serde(default)]
    pub scope: SettingScope,
    /// Condition on another field.
    #[serde(default)]
    pub show_if: Option<ShowIf>,
}

impl ControlDefinition {
    /// Whether `value` is acceptable for this control, ignoring bounds.
    #[must_use]
    pub fn accepts(&self, value: &Value) -> bool {
        match self.control {
            ControlKind::Toggle | ControlKind::Checkbox => value.is_boolean(),
            ControlKind::Slider | ControlKind::Number => value.is_number(),
            ControlKind::Text | ControlKind::Color => value.is_string(),
            ControlKind::Select => value
                .as_str()
                .is_some_and(|text| self.options.iter().any(|option| option.value == text)),
            ControlKind::MultiSelect => value.as_array().is_some_and(|items| {
                items.iter().all(|item| {
                    item.as_str()
                        .is_some_and(|text| self.options.iter().any(|option| option.value == text))
                })
            }),
        }
    }

    /// `value` clamped into this control's bounds, when it has any.
    ///
    /// A value already in range comes back **untouched**, integers included: a
    /// default of `120` must stay `120` rather than becoming `120.0`, or every
    /// round trip through here would rewrite the file it came from.
    #[must_use]
    pub fn clamp(&self, value: Value) -> Value {
        let Some(number) = value.as_f64() else {
            return value;
        };
        if self.contains(number) {
            return value;
        }
        let clamped = number
            .max(self.min.unwrap_or(f64::NEG_INFINITY))
            .min(self.max.unwrap_or(f64::INFINITY));
        serde_json::Number::from_f64(clamped).map_or(value, Value::Number)
    }

    /// Whether `number` is within this control's bounds.
    #[must_use]
    pub fn contains(&self, number: f64) -> bool {
        number >= self.min.unwrap_or(f64::NEG_INFINITY)
            && number <= self.max.unwrap_or(f64::INFINITY)
    }
}

/// A group of related settings inside a section.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsGroup {
    /// Stable id.
    pub id: String,
    /// Key of the group's heading.
    pub label_key: String,
    /// The settings it holds, in author order.
    #[serde(default)]
    pub fields: Vec<ControlDefinition>,
}

/// One tab of the settings screen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSection {
    /// Stable id.
    pub id: String,
    /// Key of the tab's label.
    pub label_key: String,
    /// The groups it holds, in author order.
    #[serde(default)]
    pub groups: Vec<SettingsGroup>,
}

/// The settings a project declares.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDefinition {
    /// Stable content id.
    pub id: String,
    /// Schema version of this file.
    pub schema_version: u32,
    /// Sections, in author order.
    #[serde(default)]
    pub sections: Vec<SettingsSection>,
}

impl SettingsDefinition {
    /// Every declared field, in author order, with the path that names it.
    pub fn fields(&self) -> impl Iterator<Item = (String, &ControlDefinition)> {
        self.sections
            .iter()
            .enumerate()
            .flat_map(|(section_index, section)| {
                section
                    .groups
                    .iter()
                    .enumerate()
                    .flat_map(move |(group_index, group)| {
                        group.fields.iter().enumerate().map(move |(index, field)| {
                            (
                                format!(
                                    "sections[{section_index}].groups[{group_index}].fields[{index}]"
                                ),
                                field,
                            )
                        })
                    })
            })
    }

    /// The field with this id, if it is declared.
    #[must_use]
    pub fn field(&self, id: &str) -> Option<&ControlDefinition> {
        self.fields()
            .find(|(_, field)| field.id == id)
            .map(|(_, field)| field)
    }

    /// Every text key this file references, with the path that names it.
    #[must_use]
    pub fn referenced_keys(&self) -> Vec<(String, &str)> {
        let mut keys = Vec::new();
        for (section_index, section) in self.sections.iter().enumerate() {
            keys.push((
                format!("sections[{section_index}].labelKey"),
                section.label_key.as_str(),
            ));
            for (group_index, group) in section.groups.iter().enumerate() {
                let group_path = format!("sections[{section_index}].groups[{group_index}]");
                keys.push((format!("{group_path}.labelKey"), group.label_key.as_str()));
                for (index, field) in group.fields.iter().enumerate() {
                    let path = format!("{group_path}.fields[{index}]");
                    keys.push((format!("{path}.labelKey"), field.label_key.as_str()));
                    if !field.help_key.is_empty() {
                        keys.push((format!("{path}.helpKey"), field.help_key.as_str()));
                    }
                    for (option_index, option) in field.options.iter().enumerate() {
                        keys.push((
                            format!("{path}.options[{option_index}].labelKey"),
                            option.label_key.as_str(),
                        ));
                    }
                }
            }
        }
        keys
    }

    /// Fills in defaults, drops what is not declared, and clamps what is.
    ///
    /// This is the one place a set of values becomes *the* set of values: the
    /// settings screen, a save file and `createGame` all go through it, so they
    /// cannot disagree about what an out-of-range or unknown entry means.
    #[must_use]
    pub fn resolve(&self, values: &Value) -> BTreeMap<String, Value> {
        resolve_controls(self.fields().map(|(_, field)| field), values)
    }
}

/// Resolves values against a list of controls, whatever declared them.
///
/// The rule in one place, for both callers: a settings file and a character's
/// parameters are the same vocabulary, so "unknown key dropped, wrong type
/// refused, number clamped, gap filled with the default" cannot come to mean
/// two different things (`docs/adr/ADR-0028-character-definitions.md`).
#[must_use]
pub fn resolve_controls<'a>(
    controls: impl Iterator<Item = &'a ControlDefinition>,
    values: &Value,
) -> BTreeMap<String, Value> {
    let supplied = values.as_object();
    let mut resolved = BTreeMap::new();

    for field in controls {
        let value = supplied
            .and_then(|map| map.get(&field.id))
            .filter(|value| field.accepts(value))
            .map(|value| field.clamp(value.clone()))
            .unwrap_or_else(|| field.default.clone());
        resolved.insert(field.id.clone(), value);
    }

    resolved
}

#[cfg(test)]
mod tests {
    use super::*;

    const SETTINGS: &str = r#"{
        "id": "game",
        "schemaVersion": 1,
        "sections": [{
            "id": "gameplay", "labelKey": "game.settings.gameplay",
            "groups": [{
                "id": "world", "labelKey": "game.settings.world",
                "fields": [
                    { "id": "difficulty", "labelKey": "game.settings.difficulty",
                      "control": "select", "default": "normal", "scope": "newGame",
                      "options": [
                        { "value": "easy", "labelKey": "game.settings.easy" },
                        { "value": "normal", "labelKey": "game.settings.normal" }
                      ] },
                    { "id": "population", "labelKey": "game.settings.population",
                      "control": "slider", "default": 120, "min": 10, "max": 500, "step": 10,
                      "scope": "newGame" },
                    { "id": "permadeath", "labelKey": "game.settings.permadeath",
                      "control": "toggle", "default": false, "scope": "newGame" }
                ]
            }]
        }]
    }"#;

    fn settings() -> SettingsDefinition {
        serde_json::from_str(SETTINGS).expect("parse")
    }

    #[test]
    fn it_parses_and_lists_its_fields_in_author_order() {
        let settings = settings();
        let ids: Vec<&str> = settings
            .fields()
            .map(|(_, field)| field.id.as_str())
            .collect();

        assert_eq!(ids, ["difficulty", "population", "permadeath"]);
        assert_eq!(
            settings.field("population").expect("field").max,
            Some(500.0)
        );
        assert_eq!(settings.field("absent"), None);
    }

    #[test]
    fn resolving_fills_defaults_and_keeps_what_is_valid() {
        let resolved = settings().resolve(&serde_json::json!({ "difficulty": "easy" }));

        assert_eq!(resolved["difficulty"], serde_json::json!("easy"));
        assert_eq!(resolved["population"], serde_json::json!(120));
        assert_eq!(resolved["permadeath"], serde_json::json!(false));
    }

    /**
     * The three ways a supplied value is wrong, and what happens to each: an
     * option nobody declared and a value of the wrong type fall back to the
     * default, a number out of range is clamped, and a field nobody declared
     * disappears.
     */
    #[test]
    fn resolving_refuses_what_the_declaration_does_not_allow() {
        let resolved = settings().resolve(&serde_json::json!({
            "difficulty": "nightmare",
            "population": 9000,
            "permadeath": "yes",
            "unknown": 1,
        }));

        assert_eq!(resolved["difficulty"], serde_json::json!("normal"));
        assert_eq!(resolved["population"], serde_json::json!(500.0));
        assert_eq!(resolved["permadeath"], serde_json::json!(false));
        assert!(!resolved.contains_key("unknown"));
    }

    #[test]
    fn multi_select_accepts_only_declared_options() {
        let field = ControlDefinition {
            id: "factions".to_owned(),
            label_key: "k".to_owned(),
            help_key: String::new(),
            control: ControlKind::MultiSelect,
            default: serde_json::json!([]),
            options: vec![
                ControlOption {
                    value: "north".to_owned(),
                    label_key: "k".to_owned(),
                },
                ControlOption {
                    value: "south".to_owned(),
                    label_key: "k".to_owned(),
                },
            ],
            min: None,
            max: None,
            step: None,
            unit: String::new(),
            scope: SettingScope::NewGame,
            show_if: None,
        };

        assert!(field.accepts(&serde_json::json!(["north"])));
        assert!(field.accepts(&serde_json::json!([])));
        assert!(!field.accepts(&serde_json::json!(["north", "east"])));
        assert!(!field.accepts(&serde_json::json!("north")));
    }

    #[test]
    fn it_lists_every_key_it_references() {
        let settings = settings();
        let keys: Vec<&str> = settings
            .referenced_keys()
            .into_iter()
            .map(|(_, key)| key)
            .collect();

        assert!(keys.contains(&"game.settings.gameplay"));
        assert!(keys.contains(&"game.settings.difficulty"));
        assert!(keys.contains(&"game.settings.easy"));
    }
}
