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

    let json = serde_json::to_string_pretty(&boundary_values()).expect("the bounds serialise");
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
                let Some(rest) = line.strip_prefix("pub const ") else {
                    continue;
                };
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
