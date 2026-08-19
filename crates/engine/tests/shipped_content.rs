//! Integration tests over the *actual* files in `content/`.
//!
//! These are the guard rails for the promise in `docs/architecture.md`: a world
//! that ships in this repository — and by extension any world the editor
//! exports in the same format — loads and plays without manual fixing.
//!
//! They also act as a demo-quality gate: if a future edit to `demo_world.json`
//! walls the monsters off from the player, `chasers_reach_the_player` fails.

use std::path::{Path, PathBuf};

use insulaire_engine::{Command, Engine};

fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR is `<repo>/crates/engine`.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crates/engine sits two levels below the repository root")
        .to_path_buf()
}

fn read(relative: &str) -> String {
    let path = repo_root().join(relative);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()))
}

/// Every locale file the shipped manifest lists, as `(language, namespace)`.
///
/// Spelled out rather than parsed from the manifest so this test fails when a
/// language is added without a file, instead of quietly testing whatever the
/// manifest happens to say.
const SHIPPED_LOCALES: [(&str, &str); 4] = [
    ("en", "menu"),
    ("en", "game"),
    ("fr", "menu"),
    ("fr", "game"),
];

/// Loads everything `content/project.json` lists, in the order a client does.
fn engine_with_shipped_content() -> Engine {
    let mut engine = Engine::new();
    engine
        .load_tile_set(&read("content/tilesets/mvp_terrain.json"))
        .expect("the shipped tile set must load");
    for world in ["demo_world", "demo_refuge"] {
        engine
            .load_world(&read(&format!("content/worlds/{world}.json")))
            .unwrap_or_else(|error| panic!("the shipped world `{world}` must load: {error}"));
    }
    for (language, namespace) in SHIPPED_LOCALES {
        engine
            .load_locale(
                language,
                namespace,
                &read(&format!("content/locales/{language}/{namespace}.json")),
            )
            .unwrap_or_else(|error| panic!("locale `{language}/{namespace}` must load: {error}"));
    }
    engine
        .load_character(&read("content/characters/human_player.json"))
        .expect("the shipped character must load");
    engine
        .load_title_screen(&read("content/menu/title-screen.json"))
        .expect("the shipped title screen must load");
    engine
        .load_settings(&read("content/settings.json"))
        .expect("the shipped settings must load");
    engine
        .load_project(&read("content/project.json"))
        .expect("the shipped project must load");
    engine
}

/// Hex distance between two offset positions, mirroring the engine's metric.
fn distance(a: insulaire_world::OffsetCoord, b: insulaire_world::OffsetCoord) -> u32 {
    insulaire_world::Hex::from_offset(a).distance(insulaire_world::Hex::from_offset(b))
}

#[test]
fn the_shipped_content_loads_without_errors_or_warnings() {
    let mut engine = Engine::new();

    let tile_set = engine
        .load_tile_set(&read("content/tilesets/mvp_terrain.json"))
        .expect("tile set loads");
    assert_eq!(tile_set.id, "mvp_terrain");
    assert!(
        tile_set.report.issues.is_empty(),
        "{:?}",
        tile_set.report.issues
    );

    for id in ["demo_world", "demo_refuge"] {
        let world = engine
            .load_world(&read(&format!("content/worlds/{id}.json")))
            .expect("world loads");
        assert_eq!(world.id, id);
        assert!(
            world.report.issues.is_empty(),
            "the shipped world `{id}` should not even warn: {:?}",
            world.report.issues
        );
    }

    for (language, namespace) in SHIPPED_LOCALES {
        engine
            .load_locale(
                language,
                namespace,
                &read(&format!("content/locales/{language}/{namespace}.json")),
            )
            .expect("locale file loads");
    }

    let character = engine
        .load_character(&read("content/characters/human_player.json"))
        .expect("character loads");
    assert_eq!(character.id, "human_player");
    assert!(
        character.report.issues.is_empty(),
        "{:?}",
        character.report.issues
    );

    let title_screen = engine
        .load_title_screen(&read("content/menu/title-screen.json"))
        .expect("title screen loads");
    assert_eq!(title_screen.id, "main");
    assert!(title_screen.report.issues.is_empty());

    let settings = engine
        .load_settings(&read("content/settings.json"))
        .expect("settings load");
    assert_eq!(settings.id, "insulaire_game");
    assert!(
        settings.report.issues.is_empty(),
        "{:?}",
        settings.report.issues
    );

    let project = engine
        .load_project(&read("content/project.json"))
        .expect("project loads");
    assert_eq!(project.id, "insulaire");
    assert!(project.report.issues.is_empty());
}

/// The shipped languages say the same things.
///
/// A translation gap is only a warning at load time — the default language
/// stands in — but the content this repository ships is the example every game
/// is copied from, so here it is a failure.
#[test]
fn every_shipped_language_translates_every_key() {
    let engine = engine_with_shipped_content();

    let report = engine.validate_locales();
    assert!(
        report.issues.is_empty(),
        "the shipped languages must agree: {:?}",
        report.issues
    );

    for (language, _) in SHIPPED_LOCALES {
        let bundle = engine.locale(language).expect("bundle");
        assert!(
            bundle.fallbacks.is_empty(),
            "`{language}` falls back for {:?}",
            bundle.fallbacks
        );
        assert!(
            bundle.entries.contains_key("menu.buttons.newGame"),
            "`{language}` must define the menu keys"
        );
    }
}

#[test]
fn every_shipped_map_link_resolves() {
    // The check no single world file can make: the doors in `content/` lead
    // somewhere that exists, in bounds, on a cell the player can stand on.
    let engine = engine_with_shipped_content();
    let report = engine.validate_links();
    assert!(report.valid, "unresolved links: {:?}", report.issues);

    let view = engine.world_view("demo_world").expect("view");
    assert_eq!(view.links.len(), 1);
    assert_eq!(view.links[0].target_world, "demo_refuge");
}

#[test]
fn walking_through_the_shipped_door_changes_map_and_comes_back() {
    let mut engine = engine_with_shipped_content();
    let start = engine
        .create_game("demo_world", 2026, "{}")
        .expect("game starts");
    let door = engine.world_view("demo_world").expect("view").links[0].at;
    assert_eq!(
        distance(start.player.as_ref().expect("player").at, door),
        1,
        "the demo player must start next to the door so the loop is one move"
    );

    let inside = engine
        .dispatch(Command::MoveTo { to: door })
        .expect("dispatch");
    assert!(inside.accepted);
    assert_eq!(inside.state.world_id, "demo_refuge");

    // The way back is the interior's own door, and it lands where we came from.
    let exit = engine.world_view("demo_refuge").expect("view").links[0].at;
    let outside = engine
        .dispatch(Command::MoveTo { to: exit })
        .expect("dispatch");
    assert!(outside.accepted);
    assert_eq!(outside.state.world_id, "demo_world");
    assert_eq!(outside.state.player.as_ref().expect("player").at, door);

    // Standing on the door we arrived on must not send us straight back in.
    let waited = engine.dispatch(Command::Wait).expect("dispatch");
    assert_eq!(waited.state.world_id, "demo_world");
}

#[test]
fn the_demo_world_matches_its_documented_shape() {
    let engine = engine_with_shipped_content();
    let view = engine.world_view("demo_world").expect("view");

    assert_eq!((view.width, view.height), (20, 20));
    assert_eq!(view.orientation, "pointy");
    assert_eq!(view.tile_set_id, "mvp_terrain");
    assert_eq!(view.cell_count, 400);
    assert_eq!(view.palette.len(), 6);
    assert_eq!(view.locations.len(), 3);

    let impassable: Vec<&str> = view
        .palette
        .iter()
        .filter(|tile| !tile.passable)
        .map(|tile| tile.id.as_str())
        .collect();
    assert_eq!(impassable, vec!["mountain", "water"]);

    let buffer = engine.terrain_buffer("demo_world").expect("buffer");
    assert_eq!(buffer.len(), 400);
    assert!(
        buffer
            .iter()
            .any(|index| view.palette[usize::from(*index)].id == "water"),
        "the demo world should contain water"
    );
}

#[test]
fn a_game_starts_from_the_shipped_world() {
    let mut engine = engine_with_shipped_content();
    let snapshot = engine
        .create_game("demo_world", 2026, "{}")
        .expect("game starts");

    assert_eq!(snapshot.tick, 0);
    assert_eq!(snapshot.entities.len(), 3);
    assert_eq!(
        snapshot
            .player
            .as_ref()
            .map(|player| player.content_id.as_str()),
        Some("player_1")
    );
    assert!(
        !snapshot.legal_moves.is_empty(),
        "the player must be able to move"
    );
}

#[test]
fn chasers_reach_the_player_when_the_player_stands_still() {
    // Demo-quality gate: with a stationary player, both hunters must cross the
    // map and end in contact range. The MVP chase has no pathfinding, so this
    // fails loudly if someone paints terrain that walls a monster off from the
    // player's start.
    //
    // The bound is *two* hexes rather than one on purpose: greedy chasers
    // converging along the same line block each other, so the second one legally
    // stalls one hex further out. Demanding adjacency for both would assert
    // behaviour the documented rule does not provide.
    let mut engine = engine_with_shipped_content();
    let start = engine
        .create_game("demo_world", 2026, "{}")
        .expect("game starts");
    let player_at = start.player.as_ref().expect("player").at;

    let mut result = engine.dispatch(Command::Wait).expect("dispatch");
    for _ in 0..40 {
        result = engine.dispatch(Command::Wait).expect("dispatch");
    }
    assert_eq!(result.state.tick, 41);

    let monsters: Vec<&insulaire_engine::EntitySnapshot> = result
        .state
        .entities
        .iter()
        .filter(|entity| entity.kind == insulaire_world::EntityKind::Monster)
        .collect();
    assert_eq!(monsters.len(), 2);

    for monster in &monsters {
        let before = start
            .entities
            .iter()
            .find(|entity| entity.content_id == monster.content_id)
            .expect("same entity at tick 0");
        assert!(
            distance(monster.at, player_at) <= 2,
            "`{}` started at {} and only got to {}",
            monster.content_id,
            before.at,
            monster.at
        );
        assert!(
            distance(before.at, player_at) >= 10,
            "`{}` should start far away so the chase is worth watching",
            monster.content_id
        );
    }

    assert!(
        monsters
            .iter()
            .any(|monster| distance(monster.at, player_at) == 1),
        "at least one hunter must actually reach the player"
    );
}

#[test]
fn illegal_moves_never_advance_the_shipped_game() {
    let mut engine = engine_with_shipped_content();
    let start = engine
        .create_game("demo_world", 1, "{}")
        .expect("game starts");
    let player_at = start.player.as_ref().expect("player").at;

    // Every hex that is *not* a legal move must be refused, and refusals must be
    // free: no tick, no monster movement, no randomness consumed.
    let far_away = insulaire_world::OffsetCoord::new(19, 19);
    let rejected = engine
        .dispatch(Command::MoveTo { to: far_away })
        .expect("call succeeds");

    assert!(!rejected.accepted);
    assert_eq!(rejected.state.tick, 0);
    assert_eq!(rejected.state, start);
    assert_eq!(
        rejected.state.player.as_ref().expect("player").at,
        player_at
    );
}

#[test]
fn the_shipped_world_survives_an_export_reload_round_trip() {
    // The editor exports the same `WorldDefinition` shape it imported. Parsing
    // the shipped file and re-serialising it must produce content the engine
    // still accepts, which is what makes editor -> runtime safe.
    let source = read("content/worlds/demo_world.json");
    let parsed: insulaire_world::WorldDefinition = serde_json::from_str(&source).expect("parse");
    let reserialised = serde_json::to_string(&parsed).expect("serialise");

    let mut engine = Engine::new();
    engine
        .load_tile_set(&read("content/tilesets/mvp_terrain.json"))
        .expect("tile set loads");
    engine
        .load_world(&reserialised)
        .expect("round-tripped world loads");

    let reparsed: insulaire_world::WorldDefinition =
        serde_json::from_str(&reserialised).expect("reparse");
    assert_eq!(parsed, reparsed, "serialisation must be lossless");
}

#[test]
fn replaying_the_demo_world_is_deterministic() {
    let script = [
        Command::Wait,
        Command::MoveTo {
            to: insulaire_world::OffsetCoord::new(5, 10),
        },
        Command::MoveTo {
            to: insulaire_world::OffsetCoord::new(19, 19),
        }, // rejected
        Command::Wait,
        Command::MoveTo {
            to: insulaire_world::OffsetCoord::new(5, 11),
        },
    ];

    let run = || {
        let mut engine = engine_with_shipped_content();
        engine
            .create_game("demo_world", 7, "{}")
            .expect("game starts");
        script
            .iter()
            .map(|command| engine.dispatch(*command).expect("dispatch"))
            .collect::<Vec<_>>()
    };

    let first = run();
    assert_eq!(
        first,
        run(),
        "same seed and same inputs must replay identically"
    );
    assert_eq!(first.last().expect("results").state.tick, 4);
}

/// The shipped character resolves into something a renderer can draw.
///
/// It is the first definition of its kind, and the one every other is copied
/// from, so "it parses" is not enough: it has to produce layers in order, name
/// images that exist on disk, and honour the choices it offers.
#[test]
fn the_shipped_character_resolves_for_every_choice_it_offers() {
    let engine = engine_with_shipped_content();

    let resolved = engine
        .resolve_character("human_player", "{}", None, 0)
        .expect("the shipped character resolves");
    let drawn: Vec<&str> = resolved
        .layers
        .iter()
        .map(|layer| layer.layer.as_str())
        .collect();
    assert_eq!(
        drawn,
        [
            "cape",
            "hairBack",
            "body",
            "legs",
            "top",
            "skirt",
            "hairFront"
        ]
    );

    // Every sprite it names is a file this repository actually ships, which is
    // the half of "the content is loadable" that no validator can check.
    for layer in &resolved.layers {
        let path = repo_root().join("content").join(&layer.asset);
        assert!(path.is_file(), "missing sprite: {}", path.display());
    }

    // Hair is one greyscale sprite recoloured by the chosen value, not one
    // image per colour: the tint reaches the layer that draws it.
    let dyed = engine
        .resolve_character("human_player", r##"{ "hairColor": "#f2c14e" }"##, None, 0)
        .expect("resolves");
    for layer in dyed.layers.iter().filter(|l| l.layer.starts_with("hair")) {
        assert_eq!(layer.tint, "#f2c14e");
    }

    // A choice swaps a variant; another removes a layer entirely.
    let plated = engine
        .resolve_character("human_player", r#"{ "armor": "plate" }"#, None, 0)
        .expect("resolves");
    let top = plated
        .layers
        .iter()
        .find(|layer| layer.layer == "top")
        .expect("a top");
    assert_eq!(top.variant, "plate");

    let bare = engine
        .resolve_character(
            "human_player",
            r#"{ "cape": false, "hairStyle": "short" }"#,
            None,
            0,
        )
        .expect("resolves");
    assert!(!bare.layers.iter().any(|layer| layer.layer == "cape"));
    assert!(!bare.layers.iter().any(|layer| layer.layer == "hairBack"));

    // Every box is whole pixels inside the declared canvas.
    for layer in &resolved.layers {
        assert!(
            layer.rect.fits(resolved.resolution),
            "{} is outside the canvas: {:?}",
            layer.layer,
            layer.rect
        );
    }
}

/// The shipped character breathes, and the skeleton is what makes it cheap.
///
/// Its idle drives one node — the body — and every layer that hangs off it
/// moves too, while the legs stay planted on the ground because they hang off
/// nothing (`docs/adr/ADR-0031-characters-animate-by-hierarchy-and-offsets.md`).
#[test]
fn the_shipped_character_plays_its_idle_through_the_hierarchy() {
    let engine = engine_with_shipped_content();

    let definition = engine.character("human_player").expect("the definition");
    let idle = definition.animation("idle").expect("an idle animation");
    assert!(idle.looping);
    assert_eq!(idle.frames, 4);
    // One track for the body, one correcting the hair: the other five layers
    // move because of the tree, not because anybody keyframed them.
    assert_eq!(idle.tracks.len(), 2);

    let offset_of = |resolved: &insulaire_world::ResolvedCharacter, layer: &str| {
        resolved
            .layers
            .iter()
            .find(|drawn| drawn.layer == layer)
            .unwrap_or_else(|| panic!("layer `{layer}`"))
            .offset
    };

    let rest = engine
        .resolve_character("human_player", "{}", Some("idle"), 0)
        .expect("frame 0");
    assert_eq!(rest.pose.as_ref().expect("a pose").frame, 0);
    assert!(rest.layers.iter().all(|layer| layer.offset.is_zero()));

    // Frame 1, the top of the breath: everything on the body rises with it.
    let up = engine
        .resolve_character("human_player", "{}", Some("idle"), idle.time_of(1))
        .expect("frame 1");
    for layer in ["body", "cape", "hairBack", "hairFront", "top", "skirt"] {
        assert_eq!(
            offset_of(&up, layer).y(),
            -1,
            "`{layer}` did not follow the body"
        );
    }
    // The legs hang off nothing, so the feet stay on the ground while the
    // torso breathes above them.
    assert!(offset_of(&up, "legs").is_zero(), "the feet left the ground");

    // Frame 3, the bottom: the hair's own keyframe adds to what it inherited.
    let down = engine
        .resolve_character("human_player", "{}", Some("idle"), idle.time_of(3))
        .expect("frame 3");
    assert_eq!(offset_of(&down, "body").y(), 1);
    assert_eq!(offset_of(&down, "hairFront").y(), 2);

    // A whole cycle later it is the same picture, to the pixel.
    let looped = engine
        .resolve_character("human_player", "{}", Some("idle"), idle.duration_ms() * 5)
        .expect("five loops later")
        .layers;
    assert_eq!(looped, rest.layers);
}

/// The shipped walk cycle: a leg sprite per frame, and the other direction for
/// free.
///
/// This is the pair the whole per-frame-sprite feature exists for — the legs
/// change drawing four times a cycle while everything else about them stays
/// what the customisation said, and `walking_right` is the same cycle with one
/// flag set (`docs/adr/ADR-0031-characters-animate-by-hierarchy-and-offsets.md`).
#[test]
fn the_shipped_character_walks_left_and_mirrors_it_to_walk_right() {
    let engine = engine_with_shipped_content();
    let definition = engine.character("human_player").expect("the definition");
    let walk = definition
        .animation("walking_left")
        .expect("a walking_left animation");
    assert!(walk.looping);
    assert_eq!(walk.frames, 4);

    let variant_of = |resolved: &insulaire_world::ResolvedCharacter, layer: &str| {
        resolved
            .layers
            .iter()
            .find(|drawn| drawn.layer == layer)
            .unwrap_or_else(|| panic!("a `{layer}` layer"))
            .variant
            .clone()
    };
    let legs_of = |resolved: &insulaire_world::ResolvedCharacter| {
        resolved
            .layers
            .iter()
            .find(|drawn| drawn.layer == "legs")
            .expect("a legs layer")
            .clone()
    };

    // At rest the legs stand and the character faces the reader; the walk sets
    // `view: side` for its whole length and a `step` for each of its frames.
    let rest = engine
        .resolve_character("human_player", "{}", None, 0)
        .expect("rest");
    assert_eq!(legs_of(&rest).variant, "stand");
    assert_eq!(
        variant_of(&rest, "body"),
        "default",
        "the rest pose is the front view"
    );

    let expected = ["sideContact", "sidePass", "sideContactBack", "sidePassBack"];
    for (frame, variant) in expected.iter().enumerate() {
        let posed = engine
            .resolve_character(
                "human_player",
                "{}",
                Some("walking_left"),
                walk.time_of(frame as u32),
            )
            .expect("a walk frame");
        let legs = legs_of(&posed);
        assert_eq!(&legs.variant, variant, "frame {frame}");
        // The sprite changes; the box it is drawn in does not.
        assert_eq!(legs.rect, legs_of(&rest).rect, "frame {frame}");
        // Every layer with a side-on drawing takes it, for one line of `when`
        // and no per-frame repetition at all.
        for layer in ["body", "top", "skirt", "hairBack", "cape", "hairFront"] {
            assert!(
                variant_of(&posed, layer).to_lowercase().contains("side"),
                "layer `{layer}` is not drawn side-on at frame {frame}"
            );
        }
        // Every sprite the cycle draws is a file this repository ships.
        for drawn in &posed.layers {
            let path = repo_root().join("content").join(&drawn.asset);
            assert!(path.is_file(), "missing sprite: {}", path.display());
        }
        assert!(!posed.mirrored);
    }

    // The cape steps in front of the body while the walk plays, chosen by the
    // same condition that chose its side-on drawing — and it is behind again
    // the moment nothing is playing.
    let sideways = engine
        .resolve_character("human_player", "{}", Some("walking_left"), 0)
        .expect("a walk frame");
    let order = |resolved: &insulaire_world::ResolvedCharacter, layer: &str| {
        resolved
            .layers
            .iter()
            .position(|drawn| drawn.layer == layer)
            .unwrap_or_else(|| panic!("a `{layer}` layer"))
    };
    assert!(order(&sideways, "cape") > order(&sideways, "body"));
    assert!(order(&rest, "cape") < order(&rest, "body"));

    // Boxes are measured from the joint their layer hangs off, and the engine
    // is what turns that back into a place on the canvas.
    let top = sideways
        .layers
        .iter()
        .find(|drawn| drawn.layer == "top")
        .expect("a top layer");
    assert_eq!(top.origin, insulaire_world::PixelOffset::new(32, 36));
    assert_eq!(top.rect, insulaire_world::PixelRect::new(23, 36, 18, 14));

    // A pose combines with the customisation instead of replacing it: plate
    // armour seen from the side is its own drawing, chosen by both at once.
    let plated = engine
        .resolve_character(
            "human_player",
            r#"{"armor":"plate"}"#,
            Some("walking_left"),
            0,
        )
        .expect("plated");
    assert_eq!(variant_of(&plated, "top"), "plateSide");

    // walking_right is authored as nothing but a reflection: same sprites,
    // same boxes, same clock, drawn the other way round.
    for time in [0_u32, 130, 260, 390, 1_000] {
        let left = engine
            .resolve_character("human_player", "{}", Some("walking_left"), time)
            .expect("left");
        let right = engine
            .resolve_character("human_player", "{}", Some("walking_right"), time)
            .expect("right");

        assert!(right.mirrored, "at {time}ms");
        assert_eq!(left.layers, right.layers, "at {time}ms");
        assert_eq!(right.pose.expect("pose").animation, "walking_right");
    }

    // It is a *mirror*, so it carries no timing or tracks of its own.
    let mirror = definition
        .animation("walking_right")
        .expect("a walking_right animation");
    assert_eq!(mirror.mirror_of.as_deref(), Some("walking_left"));
    assert!(mirror.tracks.is_empty());
}
