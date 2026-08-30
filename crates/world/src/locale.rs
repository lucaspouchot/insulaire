//! Authored translations: the text every screen displays, by language.
//!
//! No string shown to a player or an author is written in the source. Each one
//! is a **key** — `menu.title.buttons.newGame` — resolved against the language
//! in use (`docs/adr/ADR-0020-localised-content-keys.md`). The application
//! ships the keys of its own chrome so it is never blank; everything the game
//! says is content, like the maps.
//!
//! A locale file is a plain nested object of strings, which is what a
//! translator and a diff both read best:
//!
//! ```json
//! // locales/fr/menu.json          →  keys under the `menu` namespace
//! { "title": { "buttons": { "newGame": "Nouvelle partie" } } }
//! //                              →  menu.title.buttons.newGame
//! ```
//!
//! The file has no id and no schema version on purpose: its namespace is the
//! id the project's manifest gives it, and its shape cannot change without the
//! notion of "nested strings" changing.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

/// One node of a locale file: a translated string, or a group of them.
///
/// Numbers and booleans are deliberately not accepted. A locale file holds
/// display text, and a value that is not text is a mistake worth failing on
/// rather than stringifying.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum LocaleNode {
    /// A translated string.
    Text(String),
    /// A group of nested entries.
    Group(BTreeMap<String, LocaleNode>),
}

/// Why a locale file could not be flattened into keys.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocaleError {
    /// A key segment is empty or contains the separator.
    InvalidSegment {
        /// Full key of the group the segment was found in.
        path: String,
        /// The unusable segment.
        segment: String,
    },
    /// Two files, or two branches, produced the same full key.
    DuplicateKey {
        /// The key defined twice.
        key: String,
    },
}

impl std::fmt::Display for LocaleError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidSegment { path, segment } => write!(
                formatter,
                "`{segment}` is not a usable key segment (at `{path}`): a segment must not be \
                 empty and must not contain a dot"
            ),
            Self::DuplicateKey { key } => write!(formatter, "the key `{key}` is defined twice"),
        }
    }
}

impl std::error::Error for LocaleError {}

/// Every translation of one language, flattened to full keys.
///
/// Bundles are built namespace by namespace, because that is how the files are
/// authored: one file per area of the game, merged into a single lookup.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocaleBundle {
    /// Language id, e.g. `fr`.
    pub language: String,
    /// Full key to translated text, in key order.
    pub entries: BTreeMap<String, String>,
}

impl LocaleBundle {
    /// An empty bundle for `language`.
    #[must_use]
    pub fn new(language: impl Into<String>) -> Self {
        Self {
            language: language.into(),
            entries: BTreeMap::new(),
        }
    }

    /// Adds a namespace's entries, prefixing every key with it.
    ///
    /// # Errors
    ///
    /// [`LocaleError`] when a segment is unusable or a key is already defined —
    /// a silent overwrite would make which file wins depend on load order.
    pub fn merge(&mut self, namespace: &str, root: &LocaleNode) -> Result<(), LocaleError> {
        let mut flattened = Vec::new();
        flatten(namespace, root, &mut flattened)?;
        // Checked in full before anything is inserted: a file that is refused
        // must leave the bundle exactly as it was, or a failed load would be
        // half applied and the next lookup would depend on where it stopped.
        if let Some((key, _)) = flattened
            .iter()
            .find(|(key, _)| self.entries.contains_key(key))
        {
            return Err(LocaleError::DuplicateKey { key: key.clone() });
        }
        self.entries.extend(flattened);
        Ok(())
    }

    /// Parses a locale file and adds it under `namespace`.
    ///
    /// # Errors
    ///
    /// The parse error as a [`LocaleError::InvalidSegment`]-free string is the
    /// caller's business; this returns `Err(String)` so hosts can report both
    /// failures the same way.
    pub fn merge_json(&mut self, namespace: &str, json: &str) -> Result<(), String> {
        let root: LocaleNode = serde_json::from_str(json).map_err(|source| {
            format!("locale file `{namespace}` is not a nested object of strings: {source}")
        })?;
        self.merge(namespace, &root)
            .map_err(|error| error.to_string())
    }

    /// The text for `key`, if this language has it.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&str> {
        self.entries.get(key).map(String::as_str)
    }

    /// Every key this language defines.
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.entries.keys().map(String::as_str)
    }

    /// `true` when the bundle holds no entry.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// A copy of this bundle with `fallback`'s entries filling every gap.
    ///
    /// This is what keeps a raw key off the screen: an untranslated string
    /// shows the default language's text. The gap is still reported by
    /// [`crate::validate_locales`] — falling back is a courtesy to the player,
    /// not an excuse for the author.
    ///
    /// A key this language holds *empty* is a gap like any other. The editor
    /// creates a key in every language the moment content names it
    /// (`docs/adr/ADR-0020-localised-content-keys.md`), so an empty value means
    /// "nobody has written this yet", not "this language says nothing".
    #[must_use]
    pub fn with_fallback(&self, fallback: &Self) -> Self {
        let mut merged = fallback.entries.clone();
        for (key, value) in &self.entries {
            if value.trim().is_empty() && merged.contains_key(key) {
                continue;
            }
            merged.insert(key.clone(), value.clone());
        }
        Self {
            language: self.language.clone(),
            entries: merged,
        }
    }
}

/// Flattens a node into `namespace.a.b` / value pairs.
fn flatten(
    prefix: &str,
    node: &LocaleNode,
    out: &mut Vec<(String, String)>,
) -> Result<(), LocaleError> {
    match node {
        LocaleNode::Text(text) => {
            out.push((prefix.to_owned(), text.clone()));
            Ok(())
        }
        LocaleNode::Group(children) => {
            for (segment, child) in children {
                if segment.is_empty() || segment.contains('.') {
                    return Err(LocaleError::InvalidSegment {
                        path: prefix.to_owned(),
                        segment: segment.clone(),
                    });
                }
                flatten(&format!("{prefix}.{segment}"), child, out)?;
            }
            Ok(())
        }
    }
}

/// Keys defined by `bundle` that `other` does not have.
#[must_use]
pub fn missing_keys(bundle: &LocaleBundle, other: &LocaleBundle) -> Vec<String> {
    let known: BTreeSet<&str> = other.keys().collect();
    bundle
        .keys()
        .filter(|key| !known.contains(key))
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle(language: &str, namespace: &str, json: &str) -> LocaleBundle {
        let mut bundle = LocaleBundle::new(language);
        bundle.merge_json(namespace, json).expect("merge");
        bundle
    }

    #[test]
    fn a_nested_file_flattens_into_dotted_keys() {
        let fr = bundle(
            "fr",
            "menu",
            r#"{ "title": { "buttons": { "newGame": "Nouvelle partie", "quit": "Quitter" } } }"#,
        );

        assert_eq!(
            fr.get("menu.title.buttons.newGame"),
            Some("Nouvelle partie")
        );
        assert_eq!(fr.get("menu.title.buttons.quit"), Some("Quitter"));
        assert_eq!(fr.get("menu.title.buttons"), None);
    }

    #[test]
    fn namespaces_merge_into_one_language() {
        let mut fr = bundle("fr", "menu", r#"{ "play": "Jouer" }"#);
        fr.merge_json("ui", r#"{ "common": { "cancel": "Annuler" } }"#)
            .expect("second namespace");

        assert_eq!(fr.get("menu.play"), Some("Jouer"));
        assert_eq!(fr.get("ui.common.cancel"), Some("Annuler"));
    }

    #[test]
    fn a_key_defined_twice_is_refused() {
        let mut fr = bundle("fr", "menu", r#"{ "play": "Jouer" }"#);
        let error = fr
            .merge_json("menu", r#"{ "play": "Encore" }"#)
            .unwrap_err();

        assert!(error.contains("menu.play"), "unexpected message: {error}");
        // The first value stands: a failed merge must not half-apply.
        assert_eq!(fr.get("menu.play"), Some("Jouer"));
    }

    #[test]
    fn a_value_that_is_not_text_is_refused() {
        let mut fr = LocaleBundle::new("fr");
        let error = fr.merge_json("menu", r#"{ "delay": 42 }"#).unwrap_err();

        assert!(error.contains("nested object of strings"), "{error}");
    }

    #[test]
    fn a_segment_containing_a_dot_is_refused() {
        let mut fr = LocaleBundle::new("fr");
        let error = fr
            .merge_json("menu", r#"{ "title.buttons": "Nope" }"#)
            .unwrap_err();

        assert!(error.contains("not a usable key segment"), "{error}");
    }

    #[test]
    fn a_fallback_fills_gaps_without_overriding() {
        let fr = bundle("fr", "menu", r#"{ "play": "Jouer" }"#);
        let en = bundle("en", "menu", r#"{ "play": "Play", "quit": "Quit" }"#);

        let resolved = fr.with_fallback(&en);

        assert_eq!(resolved.language, "fr");
        assert_eq!(resolved.get("menu.play"), Some("Jouer"));
        assert_eq!(resolved.get("menu.quit"), Some("Quit"));
        assert_eq!(missing_keys(&en, &fr), vec!["menu.quit".to_owned()]);
        assert!(missing_keys(&fr, &en).is_empty());
    }

    #[test]
    fn a_key_left_empty_falls_back_like_a_missing_one() {
        let fr = bundle("fr", "menu", r#"{ "play": "Jouer", "quit": "" }"#);
        let en = bundle("en", "menu", r#"{ "play": "Play", "quit": "Quit" }"#);

        let resolved = fr.with_fallback(&en);

        assert_eq!(resolved.get("menu.play"), Some("Jouer"));
        // Created but not yet written: the default language still answers.
        assert_eq!(resolved.get("menu.quit"), Some("Quit"));
    }

    #[test]
    fn an_empty_key_nobody_translated_stays_empty() {
        let fr = bundle("fr", "menu", r#"{ "quit": "" }"#);
        let en = bundle("en", "menu", r#"{ "play": "Play" }"#);

        // Nothing to fall back to: the host renders the key itself.
        assert_eq!(fr.with_fallback(&en).get("menu.quit"), Some(""));
    }
}
