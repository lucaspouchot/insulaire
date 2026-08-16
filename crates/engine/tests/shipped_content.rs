//! Integration tests over the *actual* files in `content/`.
//!
//! These are the guard rails for the promise in `docs/architecture.md`: a world
//! that ships in this repository — and by extension any world the editor
//! exports in the same format — loads and plays without manual fixing.
//!
//! They also act as a demo-quality gate: if a future edit to `demo_world.json`
//! walls the monsters off from the player, `chasers_reach_the_player` fails.

use std::path::{Path, PathBuf};

use hex_engine::{Command, Engine};

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

fn engine_with_shipped_content() -> Engine {
    let mut engine = Engine::new();
    engine
        .load_tile_set(&read("content/tilesets/mvp_terrain.json"))
        .expect("the shipped tile set must load");
    engine
        .load_world(&read("content/worlds/demo_world.json"))
        .expect("the shipped demo world must load");
    engine
}

/// Hex distance between two offset positions, mirroring the engine's metric.
fn distance(a: hex_world::OffsetCoord, b: hex_world::OffsetCoord) -> u32 {
    hex_world::Hex::from_offset(a).distance(hex_world::Hex::from_offset(b))
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

    let world = engine
        .load_world(&read("content/worlds/demo_world.json"))
        .expect("world loads");
    assert_eq!(world.id, "demo_world");
    assert!(
        world.report.issues.is_empty(),
        "the shipped world should not even warn: {:?}",
        world.report.issues
    );
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
    let snapshot = engine.create_game("demo_world", 2026).expect("game starts");

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
    let start = engine.create_game("demo_world", 2026).expect("game starts");
    let player_at = start.player.as_ref().expect("player").at;

    let mut result = engine.dispatch(Command::Wait).expect("dispatch");
    for _ in 0..40 {
        result = engine.dispatch(Command::Wait).expect("dispatch");
    }
    assert_eq!(result.state.tick, 41);

    let monsters: Vec<&hex_engine::EntitySnapshot> = result
        .state
        .entities
        .iter()
        .filter(|entity| entity.kind == hex_world::EntityKind::Monster)
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
    let start = engine.create_game("demo_world", 1).expect("game starts");
    let player_at = start.player.as_ref().expect("player").at;

    // Every hex that is *not* a legal move must be refused, and refusals must be
    // free: no tick, no monster movement, no randomness consumed.
    let far_away = hex_world::OffsetCoord::new(19, 19);
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
    let parsed: hex_world::WorldDefinition = serde_json::from_str(&source).expect("parse");
    let reserialised = serde_json::to_string(&parsed).expect("serialise");

    let mut engine = Engine::new();
    engine
        .load_tile_set(&read("content/tilesets/mvp_terrain.json"))
        .expect("tile set loads");
    engine
        .load_world(&reserialised)
        .expect("round-tripped world loads");

    let reparsed: hex_world::WorldDefinition =
        serde_json::from_str(&reserialised).expect("reparse");
    assert_eq!(parsed, reparsed, "serialisation must be lossless");
}

#[test]
fn replaying_the_demo_world_is_deterministic() {
    let script = [
        Command::Wait,
        Command::MoveTo {
            to: hex_world::OffsetCoord::new(5, 10),
        },
        Command::MoveTo {
            to: hex_world::OffsetCoord::new(19, 19),
        }, // rejected
        Command::Wait,
        Command::MoveTo {
            to: hex_world::OffsetCoord::new(5, 11),
        },
    ];

    let run = || {
        let mut engine = engine_with_shipped_content();
        engine.create_game("demo_world", 7).expect("game starts");
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
