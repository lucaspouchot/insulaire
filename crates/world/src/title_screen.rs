//! The authored title screen: what a player sees before a game exists.
//!
//! A delivered client does not open on a map. It opens on a splash, then a menu
//! with a background, a piece of music and a few buttons — and every one of
//! those is **content**, not code, so a game can look like itself without a
//! rebuild (`docs/adr/ADR-0021-authored-title-screen.md`).
//!
//! What is *not* content is what the buttons do. [`TitleAction`] is a closed
//! set the application knows how to perform; a title screen chooses which of
//! them to offer, in what order, under what label. That keeps the promise in
//! `CLAUDE.md` — the engine holds no scenario-specific behaviour — while still
//! letting an author write the menu.
//!
//! Text is never written here either: `titleKey` and `labelKey` are keys
//! resolved against the language in use
//! (`docs/adr/ADR-0020-localised-content-keys.md`).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Highest title screen schema version this build understands.
pub const TITLE_SCREEN_SCHEMA_VERSION: u32 = 1;

/// What a title screen button does.
///
/// Closed on purpose: an action is something the application implements, so a
/// new one is a code change and an ADR, not a content field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "title-screen.ts")]
pub enum TitleAction {
    /// Start a new game on the project's `startWorld`.
    NewGame,
    /// Resume a saved game. Offered disabled while there is none.
    Continue,
    /// Open the settings screen.
    Settings,
    /// Show the credits.
    Credits,
    /// Leave the game. Only meaningful in the desktop shell.
    Quit,
}

/// One button of the menu.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "title-screen.ts")]
pub struct TitleButton {
    /// What pressing it does.
    pub action: TitleAction,
    /// Key of its label.
    pub label_key: String,
    /// Authored out of the menu without deleting it.
    #[serde(default, skip_serializing_if = "crate::is_default")]
    pub hidden: bool,
}

/// How a background image fills the screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "title-screen.ts")]
pub enum BackgroundFit {
    /// Fill the screen, cropping what does not fit.
    #[default]
    Cover,
    /// Fit the whole image, leaving margins.
    Contain,
    /// Repeat the image.
    Tile,
}

/// The image behind the menu.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "title-screen.ts")]
pub struct TitleBackground {
    /// Path under the content root. Empty means a plain background.
    #[serde(default)]
    pub image: String,
    /// How the image fills the screen.
    #[serde(default)]
    pub fit: BackgroundFit,
    /// CSS colour laid over the image, and used alone when there is none.
    #[serde(default)]
    pub tint: String,
}

/// The game's logo, drawn above the menu.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "title-screen.ts")]
pub struct TitleLogo {
    /// Path under the content root.
    pub image: String,
    /// Width as a percentage of the screen, `1..=100`.
    #[serde(default = "default_logo_width")]
    pub max_width_percent: u32,
}

const fn default_logo_width() -> u32 {
    40
}

/// The image shown before the menu, once per launch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "title-screen.ts")]
pub struct TitleSplash {
    /// Path under the content root. Empty shows the title alone.
    #[serde(default)]
    pub image: String,
    /// How long it stays, in milliseconds.
    pub duration_ms: u32,
    /// Whether a click or a key skips it.
    #[serde(default = "default_true")]
    pub skippable: bool,
}

const fn default_true() -> bool {
    true
}

/// The menu's music.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "title-screen.ts")]
pub struct TitleMusic {
    /// Path under the content root.
    pub track: String,
    /// Whether it repeats.
    #[serde(default = "default_true")]
    pub loops: bool,
    /// Volume relative to the music setting, `0.0..=1.0`.
    #[serde(default = "default_gain")]
    pub gain: f32,
    /// Fade-in, in milliseconds.
    #[serde(default)]
    pub fade_in_ms: u32,
}

const fn default_gain() -> f32 {
    1.0
}

/// Colours the menu is drawn with. Every field is a CSS colour.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "title-screen.ts")]
pub struct TitleTheme {
    /// Buttons and highlights.
    #[serde(default)]
    pub accent: String,
    /// Body text.
    #[serde(default)]
    pub text: String,
    /// The panel behind the menu.
    #[serde(default)]
    pub panel: String,
    /// CSS font family for the title.
    #[serde(default)]
    pub font: String,
}

/// Where the menu sits on screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "title-screen.ts")]
pub enum TitleLayout {
    /// Against the left edge.
    #[default]
    Left,
    /// Centred.
    Center,
    /// Against the right edge.
    Right,
}

/// The authored title screen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "title-screen.ts")]
pub struct TitleScreenDefinition {
    /// Stable content id.
    pub id: String,
    /// Schema version of this file.
    pub schema_version: u32,
    /// Key of the game's title.
    pub title_key: String,
    /// Key of the line under it.
    #[serde(default)]
    pub subtitle_key: String,
    /// The image behind the menu.
    #[serde(default)]
    pub background: TitleBackground,
    /// The logo above it, if any.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub logo: Option<TitleLogo>,
    /// The splash shown before it, if any.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub splash: Option<TitleSplash>,
    /// The music it plays, if any.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub music: Option<TitleMusic>,
    /// Colours and font.
    #[serde(default)]
    pub theme: TitleTheme,
    /// Where the menu sits.
    #[serde(default)]
    pub layout: TitleLayout,
    /// The buttons, in author order.
    #[serde(default)]
    pub buttons: Vec<TitleButton>,
}

impl TitleScreenDefinition {
    /// Every text key this screen references, with the path that names it.
    ///
    /// Feeds `validate_referenced_keys`, which is what turns a typo in a
    /// `labelKey` into a validation issue instead of a blank button.
    #[must_use]
    pub fn referenced_keys(&self) -> Vec<(&str, &str)> {
        let mut keys = vec![("titleKey", self.title_key.as_str())];
        if !self.subtitle_key.is_empty() {
            keys.push(("subtitleKey", self.subtitle_key.as_str()));
        }
        keys.extend(
            self.buttons
                .iter()
                .map(|button| ("buttons[].labelKey", button.label_key.as_str())),
        );
        keys
    }

    /// Every content path this screen references, with the field that names it.
    #[must_use]
    pub fn referenced_assets(&self) -> Vec<(&str, &str)> {
        let mut assets = Vec::new();
        if !self.background.image.is_empty() {
            assets.push(("background.image", self.background.image.as_str()));
        }
        if let Some(logo) = &self.logo {
            assets.push(("logo.image", logo.image.as_str()));
        }
        if let Some(splash) = &self.splash {
            if !splash.image.is_empty() {
                assets.push(("splash.image", splash.image.as_str()));
            }
        }
        if let Some(music) = &self.music {
            assets.push(("music.track", music.track.as_str()));
        }
        assets
    }

    /// The buttons a player actually sees, in author order.
    pub fn visible_buttons(&self) -> impl Iterator<Item = &TitleButton> {
        self.buttons.iter().filter(|button| !button.hidden)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = r#"{
        "id": "main",
        "schemaVersion": 1,
        "titleKey": "menu.title.title",
        "buttons": [
            { "action": "newGame", "labelKey": "menu.buttons.newGame" },
            { "action": "quit", "labelKey": "menu.buttons.quit", "hidden": true }
        ]
    }"#;

    #[test]
    fn a_minimal_title_screen_parses_with_sensible_defaults() {
        let screen: TitleScreenDefinition = serde_json::from_str(MINIMAL).expect("parse");

        assert_eq!(screen.id, "main");
        assert_eq!(screen.layout, TitleLayout::Left);
        assert_eq!(screen.background.fit, BackgroundFit::Cover);
        assert!(screen.logo.is_none());
        assert!(screen.music.is_none());
        assert_eq!(screen.buttons[0].action, TitleAction::NewGame);
        // A hidden button stays in the file and off the screen.
        assert_eq!(screen.visible_buttons().count(), 1);
    }

    #[test]
    fn a_full_title_screen_round_trips() {
        let json = r##"{
            "id": "main",
            "schemaVersion": 1,
            "titleKey": "menu.title.title",
            "subtitleKey": "menu.title.subtitle",
            "background": { "image": "assets/images/title.png", "fit": "contain", "tint": "#0b0f14" },
            "logo": { "image": "assets/images/logo.png", "maxWidthPercent": 55 },
            "splash": { "image": "assets/images/splash.png", "durationMs": 2500, "skippable": false },
            "music": { "track": "assets/audio/theme.ogg", "loops": false, "gain": 0.6, "fadeInMs": 1200 },
            "theme": { "accent": "#c8a35a", "text": "#f3ede2", "panel": "#12161c", "font": "serif" },
            "layout": "center",
            "buttons": [{ "action": "newGame", "labelKey": "menu.buttons.newGame" }]
        }"##;

        let screen: TitleScreenDefinition = serde_json::from_str(json).expect("parse");
        let reparsed: TitleScreenDefinition =
            serde_json::from_str(&serde_json::to_string(&screen).expect("serialise"))
                .expect("reparse");

        assert_eq!(screen, reparsed);
        assert_eq!(screen.layout, TitleLayout::Center);
        assert_eq!(screen.music.as_ref().expect("music").gain, 0.6);
    }

    #[test]
    fn it_lists_the_keys_and_assets_it_references() {
        let json = r#"{
            "id": "main", "schemaVersion": 1,
            "titleKey": "menu.title.title", "subtitleKey": "menu.title.subtitle",
            "background": { "image": "assets/images/title.png" },
            "music": { "track": "assets/audio/theme.ogg" },
            "buttons": [{ "action": "newGame", "labelKey": "menu.buttons.newGame" }]
        }"#;
        let screen: TitleScreenDefinition = serde_json::from_str(json).expect("parse");

        let keys: Vec<&str> = screen
            .referenced_keys()
            .iter()
            .map(|(_, key)| *key)
            .collect();
        assert_eq!(
            keys,
            [
                "menu.title.title",
                "menu.title.subtitle",
                "menu.buttons.newGame"
            ]
        );

        let assets: Vec<&str> = screen
            .referenced_assets()
            .iter()
            .map(|(_, path)| *path)
            .collect();
        assert_eq!(
            assets,
            ["assets/images/title.png", "assets/audio/theme.ogg"]
        );
    }
}
