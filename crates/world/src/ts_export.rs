//! The bounds and defaults the TypeScript side is compiled against.
//!
//! `ts-rs` derives the *shapes* of the content definitions (see the `#[ts(…)]`
//! attributes throughout this crate) but emits no `const`, and the bounds are
//! half of what an editor needs: a tile image larger than
//! [`crate::MAX_TILE_IMAGE_SIZE`] is content the editor accepts and the runtime
//! refuses. That is the failure `docs/adr/ADR-0012-shared-content-validation.md`
//! exists to prevent, one level below where that ADR is looking.
//!
//! So the values cross too, and they cross as *values*: the table below names
//! each constant, and the compiler supplies what it holds. A bound changed here
//! and nowhere else makes the committed TypeScript stale, which `npm run
//! check:types` refuses.
//!
//! Three things are checked rather than trusted:
//!
//! 1. the **name** — the table mentions the constant, so a rename or a deletion
//!    is a compile error;
//! 2. the **value** — rendered from the item itself, never retyped;
//! 3. the **coverage** — [`every_public_bound_is_accounted_for`] refuses a
//!    `pub const` in an exported module that is neither published nor
//!    explicitly held back.
//!
//! Documentation is lifted from the source text, keyed by a name the compiler
//! has already vouched for.

use crate::character::SpriteResolution;

/// How a value is written as a TypeScript expression.
///
/// Not `serde_json`: an `f32` widened to `f64` prints as `0.550000011920929`,
/// and a bound the editor compares against must be the number the author sees.
/// `Display` on a float is Rust's shortest round-tripping form, which is the
/// same text TypeScript parses back to the same value.
pub(crate) trait TsValue {
    /// This value as TypeScript source.
    fn to_ts(&self) -> String;
}

macro_rules! ts_value_via_display {
    ($($ty:ty),* $(,)?) => {
        $(impl TsValue for $ty {
            fn to_ts(&self) -> String {
                format!("{self}")
            }
        })*
    };
}

ts_value_via_display!(u8, u32, i32, usize, f32);

impl TsValue for &str {
    fn to_ts(&self) -> String {
        format!("{self:?}")
    }
}

impl TsValue for SpriteResolution {
    fn to_ts(&self) -> String {
        format!("{{ width: {}, height: {} }}", self.width, self.height)
    }
}

/// One published bound, as the generator receives it.
#[derive(Debug, serde::Serialize)]
pub(crate) struct BoundaryValue {
    /// Generated module the constant belongs in.
    pub module: &'static str,
    /// Its name, unchanged: a bound is spelled the same on both sides.
    pub name: &'static str,
    /// Its doc comment, lifted from the Rust source.
    pub doc: String,
    /// Its value, already rendered as TypeScript source.
    pub value: String,
}

/// Declares which constants cross to TypeScript, and from where.
///
/// `held_back` is not decoration: it is what makes the coverage test able to
/// tell "not part of the boundary" from "forgotten".
macro_rules! boundary_values {
    (
        $(
            $module:literal from $source:literal {
                published { $($name:ident),* $(,)? }
                held_back { $($held:ident),* $(,)? }
            }
        )*
    ) => {
        /// Every published bound, in declaration order.
        pub(crate) fn boundary_values() -> Vec<BoundaryValue> {
            [$($(
                BoundaryValue {
                    module: $module,
                    name: stringify!($name),
                    doc: doc_comment_for(include_str!($source), stringify!($name)),
                    value: TsValue::to_ts(&crate::$name),
                },
            )*)*].into()
        }

        /// What each source declares, for the coverage test.
        fn declared_bounds() -> Vec<(&'static str, Vec<&'static str>, Vec<&'static str>)> {
            vec![$((
                include_str!($source),
                vec![$(stringify!($name)),*],
                vec![$(stringify!($held)),*],
            )),*]
        }
    };
}

boundary_values! {
    "world.ts" from "definition.rs" {
        published {
            WORLD_SCHEMA_VERSION,
            MIN_ELEVATION,
            MAX_ELEVATION,
            MAX_DECORATION_OFFSET,
            DEFAULT_CHARACTER_HEIGHT_TILES,
            MIN_CHARACTER_HEIGHT_TILES,
            MAX_CHARACTER_HEIGHT_TILES,
            DEFAULT_GRID_LINE_WIDTH,
            MIN_GRID_LINE_WIDTH,
            MAX_GRID_LINE_WIDTH,
            DEFAULT_GRID_COLOR,
            DEFAULT_GRID_ALPHA,
            DEFAULT_REVEAL_RADIUS,
            MAX_REVEAL_RADIUS,
            DEFAULT_REVEAL_OPACITY,
            DEFAULT_REVEAL_NEIGHBOUR_OPACITY,
        }
        held_back {}
    }

    "tile-set.ts" from "tile_art.rs" {
        published {
            DEFAULT_TILE_WIDTH,
            DEFAULT_SURFACE_HEIGHT,
            DEFAULT_ELEVATION_HEIGHT,
            DEFAULT_ELEVATION_STEP,
            DEFAULT_FLAT_HEIGHT,
            MAX_TILE_IMAGE_SIZE,
            MAX_ELEVATION_LEVELS,
            MAX_TILE_VARIANTS,
        }
        // How far a cell may be stacked is a rule about the *renderer's* loop,
        // answered by `resolve_tile_render`; no editor control is bounded by it.
        held_back { MAX_STACKED_LEVELS }
    }

    "tile-set.ts" from "tileset.rs" {
        published { TILE_SET_SCHEMA_VERSION }
        held_back {}
    }

    "project.ts" from "project.rs" {
        published { PROJECT_SCHEMA_VERSION, DEFAULT_ZONE_ID }
        held_back {}
    }

    "title-screen.ts" from "title_screen.rs" {
        published { TITLE_SCREEN_SCHEMA_VERSION }
        held_back {}
    }

    "settings.ts" from "settings.rs" {
        published { SETTINGS_SCHEMA_VERSION }
        held_back {}
    }

    "character.ts" from "character.rs" {
        published { CHARACTER_SCHEMA_VERSION, MAX_SPRITE_RESOLUTION }
        // The colour a layer shows when its parameter resolves to nothing is
        // the resolver's own answer, and the host never draws with it.
        held_back { UNRESOLVED_COLOR }
    }

    "character.ts" from "animation.rs" {
        published {
            MAX_ANIMATION_FRAMES,
            DEFAULT_FRAME_DURATION_MS,
            MAX_FLIPBOOK_FRAMES,
        }
        held_back {}
    }

    "character-creation.ts" from "character_creation.rs" {
        published { CHARACTER_CREATION_SCHEMA_VERSION }
        held_back {}
    }

    "decoration.ts" from "decoration.rs" {
        published {
            DECORATION_SCHEMA_VERSION,
            MAX_DECORATION_ORDER,
            DEFAULT_DECORATION_RESOLUTION,
        }
        held_back {}
    }

    "object.ts" from "object.rs" {
        published {
            OBJECT_SCHEMA_VERSION,
            MAX_STACK_SIZE,
            DEFAULT_ICON_RESOLUTION,
        }
        held_back {}
    }
}

/// Declares what an omitted field means, per definition type.
///
/// The same trick as [`boundary_values!`], one level in: the table names the
/// **field**, and a definition parsed from a document that leaves that field out
/// supplies the value. What crosses is therefore what `serde` fills in, never a
/// default retyped beside the one in the attribute — a renamed or deleted field
/// is a compile error, and a changed `#[serde(default = "…")]` changes the
/// exported table on the next generator run.
///
/// `scaffold` is the smallest document the type parses from: the fields `serde`
/// requires, and nothing else. `flattened` reaches a field the *file* shows at
/// the top level but the struct holds inside a `#[serde(flatten)]` member.
macro_rules! absent_values {
    (
        $(
            $ty:ident => $module:literal as $name:ident {
                scaffold: $scaffold:literal,
                fields { $($field:ident),* $(,)? }
                $(flattened { $($flat:ident from $through:ident),* $(,)? })?
            }
        )*
    ) => {
        /// What an omitted field means, for every type a writer may omit one from.
        pub(crate) fn absent_values() -> Vec<BoundaryValue> {
            vec![$({
                let probe = omitting_everything_optional::<crate::$ty>($scaffold);
                let table: Vec<(String, String)> = vec![
                    $((camel_case(stringify!($field)), as_json(&probe.$field)),)*
                    $($((camel_case(stringify!($flat)), as_json(&probe.$through.$flat)),)*)?
                ];
                BoundaryValue {
                    module: $module,
                    name: stringify!($name),
                    doc: absent_doc(stringify!($ty)),
                    value: as_object(&table),
                }
            }),*]
        }

        /// The guarantee this table exists for: every value in it is already
        /// what a file leaving that field out means.
        ///
        /// Stating them all at once rather than one at a time is the stronger
        /// claim — the fields are independent, so a table that survives being
        /// written out in full holds for any subset a real file omits.
        #[test]
        fn an_absent_value_is_what_omitting_the_field_already_means() {
            $({
                let omitted = omitting_everything_optional::<crate::$ty>($scaffold);
                let mut document: serde_json::Map<String, serde_json::Value> =
                    serde_json::from_str($scaffold).expect("the scaffold is an object");
                $(document.insert(camel_case(stringify!($field)), parsed(&as_json(&omitted.$field)));)*
                $($(document.insert(
                    camel_case(stringify!($flat)),
                    parsed(&as_json(&omitted.$through.$flat)),
                );)*)?
                let stated: crate::$ty =
                    serde_json::from_value(serde_json::Value::Object(document))
                        .expect("a document stating every absent value parses");
                assert_eq!(
                    omitted,
                    stated,
                    "`{}` states what a `{}` omitting those fields does not mean",
                    stringify!($name),
                    stringify!($ty),
                );
            })*
        }
    };
}

absent_values! {
    ObjectDefinition => "object.ts" as OBJECT_ABSENT {
        scaffold: r#"{ "id": "", "schemaVersion": 0 }"#,
        fields {
            name, kind, name_key, description_key, frames, frame_duration_ms, looping,
            resolution, stack_size, slot, tags,
        }
    }

    DecorationDefinition => "decoration.ts" as DECORATION_ABSENT {
        scaffold: r#"{ "id": "", "schemaVersion": 0 }"#,
        fields {
            name, category, resolution, anchor, plane, order, tags, animations,
            default_animation,
        }
    }

    DecorationAnimation => "decoration.ts" as DECORATION_ANIMATION_ABSENT {
        scaffold: r#"{ "id": "" }"#,
        fields { name, frame_duration_ms, looping }
    }

    CharacterDefinition => "character.ts" as CHARACTER_ABSENT {
        scaffold: r#"{ "id": "", "schemaVersion": 0 }"#,
        fields { name, category, resolution, parameters, layers, animations }
    }

    CharacterLayer => "character.ts" as CHARACTER_LAYER_ABSENT {
        scaffold: r#"{ "id": "" }"#,
        fields { parent, parent_anchor, anchors }
    }

    LayerVariant => "character.ts" as LAYER_VARIANT_ABSENT {
        scaffold: r#"{ "id": "", "sprite": { "asset": "" } }"#,
        fields { when, rect, order }
    }

    Sprite => "character.ts" as SPRITE_ABSENT {
        scaffold: r#"{ "asset": "" }"#,
        fields { tint }
    }

    Animation => "character.ts" as ANIMATION_ABSENT {
        scaffold: r#"{ "id": "" }"#,
        fields {
            name, role, mirror_of, frames, frame_duration_ms, looping, pose, poses, tracks,
        }
    }

    Keyframe => "character.ts" as KEYFRAME_ABSENT {
        scaffold: r#"{ "frame": 0 }"#,
        fields { interpolation }
        flattened { offset from transform }
    }

    ControlDefinition => "settings.ts" as CONTROL_ABSENT {
        scaffold: r#"{ "id": "", "labelKey": "", "control": "toggle", "default": null }"#,
        fields { help_key, options, min, max, step, unit, scope, show_if }
    }

    CharacterCreationDefinition => "character-creation.ts" as CHARACTER_CREATION_ABSENT {
        scaffold: r#"{ "id": "", "schemaVersion": 0 }"#,
        fields { base_character, choices, characteristics, screens }
    }

    // A choice and a characteristic both flatten a `ControlDefinition`, so what
    // an absent field of *that* means is `CONTROL_ABSENT`, published once above.
    // Only what the two add to it is stated here.
    CharacteristicDefinition => "character-creation.ts" as CHARACTERISTIC_ABSENT {
        scaffold: r#"{ "id": "", "labelKey": "", "control": "toggle", "default": null }"#,
        fields { nullable }
    }

    CreationScreen => "character-creation.ts" as CREATION_SCREEN_ABSENT {
        scaffold: r#"{ "id": "", "titleKey": "" }"#,
        fields { text_key, transition, blocks }
    }

    TileSetDefinition => "tile-set.ts" as TILE_SET_ABSENT {
        scaffold: r#"{ "id": "", "schemaVersion": 0 }"#,
        fields { name, art }
    }

    TileDefinition => "tile-set.ts" as TILE_ABSENT {
        scaffold: r#"{
            "id": "", "terrain": "", "movementCost": 0,
            "visual": { "visualId": "", "fallbackColor": "" }
        }"#,
        fields { name, tags, art }
    }

    TileArt => "tile-set.ts" as TILE_ART_ABSENT {
        scaffold: r#"{}"#,
        fields { flat, surface, elevation }
    }

    TileElevation => "tile-set.ts" as TILE_ELEVATION_ABSENT {
        scaffold: r#"{}"#,
        fields { repeat }
    }

    ElevationLevel => "tile-set.ts" as ELEVATION_LEVEL_ABSENT {
        scaffold: r#"{}"#,
        fields { name }
    }

    WorldDefinition => "world.ts" as WORLD_ABSENT {
        scaffold: r#"{
            "id": "", "schemaVersion": 0, "width": 0, "height": 0,
            "tileSetId": "", "defaultTile": ""
        }"#,
        fields {
            name, zone, origin, shape, orientation, projection, character_height_tiles, grid,
            reveal, tiles, entities, decorations, locations, links, metadata,
        }
    }

    ProjectDefinition => "project.ts" as PROJECT_ABSENT {
        scaffold: r#"{ "id": "", "schemaVersion": 0, "startWorld": "" }"#,
        fields {
            name, zones, characters, decorations, objects, character_creation, title_screen,
            settings, locales,
        }
    }
}

/// A definition parsed from the smallest document it accepts, so every field
/// that may be left out holds exactly what leaving it out means.
fn omitting_everything_optional<T: serde::de::DeserializeOwned>(scaffold: &str) -> T {
    serde_json::from_str(scaffold).unwrap_or_else(|error| {
        panic!(
            "the scaffold for `{}` does not parse: {error}",
            std::any::type_name::<T>()
        )
    })
}

/// One field's value as JSON, which is the TypeScript source for it as well.
///
/// Serialised from the field itself rather than through a `serde_json::Value`,
/// which would sort a nested record's keys and widen an `f32`: a canvas reads
/// `{"width":32,"height":32}` here because that is the order the struct
/// declares, and that is the order a file states it in.
fn as_json<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).expect("a definition field serialises")
}

/// The same value back as JSON, for a test that compares definitions.
fn parsed(json: &str) -> serde_json::Value {
    serde_json::from_str(json).expect("a serialised field parses")
}

/// `frame_duration_ms` as the file spells it: `frameDurationMs`.
///
/// Every definition in this crate is `#[serde(rename_all = "camelCase")]`, so
/// this is the whole of the mapping between a field and its key.
fn camel_case(field: &str) -> String {
    let mut key = String::with_capacity(field.len());
    let mut capitalise = false;
    for character in field.chars() {
        if character == '_' {
            capitalise = true;
        } else if capitalise {
            key.extend(character.to_uppercase());
            capitalise = false;
        } else {
            key.push(character);
        }
    }
    key
}

/// The table as TypeScript source, its fields in the order the struct declares
/// them rather than the order a `serde_json::Map` would have sorted them into.
fn as_object(table: &[(String, String)]) -> String {
    let members: Vec<String> = table
        .iter()
        .map(|(key, value)| format!("{key:?}: {value}"))
        .collect();
    format!("{{ {} }}", members.join(", "))
}

/// What an absent-value table says about itself on the TypeScript side.
fn absent_doc(definition: &str) -> String {
    format!(
        "What an omitted field means in `{definition}`.\n\n\
         The value each field parses back to when a file leaves it out, so a writer can\n\
         drop what would say nothing without stating a default a second time\n\
         (`docs/adr/ADR-0012-shared-content-validation.md`)."
    )
}

/// The `///` block immediately above `pub const $name`, as Markdown.
///
/// Keyed by a name the table has already made the compiler check, so this looks
/// for something it knows is there rather than discovering what exists.
fn doc_comment_for(source: &str, name: &str) -> String {
    let lines: Vec<&str> = source.lines().collect();
    let Some(at) = lines
        .iter()
        .position(|line| line.starts_with(&format!("pub const {name}:")))
    else {
        return String::new();
    };

    let mut doc: Vec<&str> = Vec::new();
    for line in lines[..at].iter().rev() {
        let Some(text) = line.strip_prefix("///") else {
            break;
        };
        doc.push(text.strip_prefix(' ').unwrap_or(text));
    }
    doc.reverse();
    doc.join("\n").trim_end().to_owned()
}

/// Writes the published bounds where `scripts/generate-content-types.mjs` reads
/// them, beside the modules `ts-rs` writes.
///
/// A test because that is how `ts-rs` exports too, so one `cargo test` renders
/// the whole mirror. It writes its own file rather than appending to a module:
/// the export tests run in parallel, and two writers on one path is a race.
#[test]
fn export_boundary_values() {
    use std::io::Write;

    let directory = std::path::PathBuf::from(
        std::env::var("TS_RS_EXPORT_DIR").unwrap_or_else(|_| "./bindings".to_owned()),
    );
    std::fs::create_dir_all(&directory).expect("the export directory is writable");

    let published: Vec<BoundaryValue> = boundary_values()
        .into_iter()
        .chain(absent_values())
        .collect();
    let json = serde_json::to_string_pretty(&published).expect("the bounds serialise");
    let mut file =
        std::fs::File::create(directory.join("boundary-values.json")).expect("the file is created");
    writeln!(file, "{json}").expect("the bounds are written");
}

#[cfg(test)]
mod tests {
    use super::{boundary_values, declared_bounds, doc_comment_for};

    /// The guarantee the table exists for: a bound cannot quietly stop crossing.
    ///
    /// A `pub const` added to an exported module is published or held back by
    /// name. Neither is a choice this test makes for the author; both are
    /// choices it insists the author writes down.
    #[test]
    fn every_public_bound_is_accounted_for() {
        for (source, published, held_back) in declared_bounds() {
            for line in source.lines() {
                // `trim_start`, so a bound declared inside a nested `mod` is
                // held to the same rule as one at the top of the file; and not
                // `pub const fn`, which declares no value to publish.
                let Some(rest) = line.trim_start().strip_prefix("pub const ") else {
                    continue;
                };
                if rest.starts_with("fn ") {
                    continue;
                }
                let name = rest.split(':').next().unwrap_or_default();
                assert!(
                    published.contains(&name) || held_back.contains(&name),
                    "`pub const {name}` crosses no boundary and is held back by nothing. \
                     Add it to `boundary_values!`, under `published` or under `held_back`."
                );
            }
        }
    }

    #[test]
    fn a_bound_carries_its_value_and_its_documentation() {
        let values = boundary_values();

        let elevation = values
            .iter()
            .find(|value| value.name == "MAX_ELEVATION")
            .expect("MAX_ELEVATION is published");
        assert_eq!(elevation.value, "127", "the compiler resolves `i8::MAX`");
        assert!(elevation.doc.contains("signed byte"));
        assert_eq!(elevation.module, "world.ts");

        let colour = values
            .iter()
            .find(|value| value.name == "DEFAULT_GRID_COLOR")
            .expect("DEFAULT_GRID_COLOR is published");
        assert_eq!(colour.value, "\"#000000\"", "a string arrives quoted");

        let derived = values
            .iter()
            .find(|value| value.name == "DEFAULT_ELEVATION_HEIGHT")
            .expect("DEFAULT_ELEVATION_HEIGHT is published");
        assert_eq!(
            derived.value, "13",
            "`20 / 4 + 8`, evaluated by the compiler"
        );
    }

    /// `serde_json` would widen this to `0.550000011920929`.
    #[test]
    fn a_float_bound_keeps_the_number_the_author_wrote() {
        let values = boundary_values();
        let opacity = values
            .iter()
            .find(|value| value.name == "DEFAULT_REVEAL_NEIGHBOUR_OPACITY")
            .expect("published");
        assert_eq!(opacity.value, "0.55");
    }

    #[test]
    fn a_documented_constant_loses_neither_paragraph_nor_link() {
        let source = "/// First line.\n///\n/// Second, with `code`.\npub const X: u32 = 1;\n";
        assert_eq!(
            doc_comment_for(source, "X"),
            "First line.\n\nSecond, with `code`."
        );
    }
}
