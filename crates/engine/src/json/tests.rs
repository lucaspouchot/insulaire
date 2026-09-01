//! The boundary's tests.
//!
//! They live beside `json.rs` rather than inside it because that file is
//! generated from `crates/engine/seam.json`. `super` is still the facade, so
//! every test reaches it exactly as it did when the two shared a file.

use super::*;
use serde_json::Value;

const TILE_SET: &str = r##"{
    "id": "t", "schemaVersion": 1, "tiles": [
        { "id": "grass", "terrain": "grass", "movementCost": 1,
          "visual": { "visualId": "terrain.grass", "fallbackColor": "#4f7a3a" } },
        { "id": "water", "terrain": "water", "movementCost": 0,
          "visual": { "visualId": "terrain.water", "fallbackColor": "#1d4e79" } }
    ]}"##;

const WORLD: &str = r#"{
    "id": "w", "schemaVersion": 1, "width": 8, "height": 8,
    "tileSetId": "t", "defaultTile": "grass",
    "tiles": [{ "at": [4, 4], "tile": "water" }],
    "entities": [
        { "id": "p", "templateId": "player", "at": [2, 2] },
        { "id": "m", "templateId": "monster", "at": [6, 2] }
    ]}"#;

fn json(text: &str) -> Value {
    serde_json::from_str(text).expect("valid JSON")
}

fn code(error: &str) -> String {
    json(error)["code"].as_str().expect("code field").to_owned()
}

fn loaded() -> JsonEngine {
    let mut engine = JsonEngine::new();
    engine.load_tile_set(TILE_SET).expect("tile set loads");
    engine.load_world(WORLD).expect("world loads");
    engine
}

#[test]
fn the_full_load_play_loop_works_through_the_string_api() {
    let mut engine = loaded();

    let view = json(&engine.world_view("w").expect("view"));
    assert_eq!(view["bounds"]["width"], 8);
    assert_eq!(view["bounds"]["origin"], serde_json::json!([0, 0]));
    assert_eq!(view["cellCount"], 64);
    assert_eq!(view["presentCellCount"], 64);
    assert_eq!(view["palette"].as_array().expect("palette").len(), 2);

    assert_eq!(engine.terrain_buffer("w").expect("buffer").len(), 64);
    // The third bulk transfer: all ones on a map nobody shaped
    // (`docs/adr/ADR-0033-a-map-is-a-set-of-hexes.md`).
    let presence = engine.presence_buffer("w").expect("buffer");
    assert_eq!(presence.len(), 64);
    assert!(presence.iter().all(|flag| *flag == 1));

    let snapshot = json(&engine.create_game("w", 7, "{}").expect("game"));
    assert_eq!(snapshot["tick"], 0);
    assert!(engine.has_game());

    let target = &snapshot["legalMoves"][0];
    let result = json(
        &engine
            .dispatch(&format!(r#"{{"type":"moveTo","to":{target}}}"#))
            .expect("dispatch"),
    );

    assert_eq!(result["accepted"], true);
    assert_eq!(result["state"]["tick"], 1);
    assert_eq!(result["state"]["player"]["at"], *target);
}

const ART_TILE_SET: &str = r##"{
    "id": "art", "schemaVersion": 3,
    "art": {
      "width": 32, "flatHeight": 37, "surfaceHeight": 20,
      "elevationHeight": 13, "elevationStep": 8
    },
    "tiles": [
        { "id": "rock", "terrain": "rock", "movementCost": 1,
          "visual": { "visualId": "terrain.rock", "fallbackColor": "#7a7169" },
          "art": {
            "flat": [{ "id": "a", "asset": "assets/tiles/rock_flat_a.png" }],
            "surface": [{ "id": "a", "asset": "assets/tiles/rock_a.png" }],
            "elevation": {
              "levels": [
                { "variants": [{ "id": "a", "asset": "assets/tiles/cliff_a.png" }] },
                { "variants": [{ "id": "b", "asset": "assets/tiles/cliff_b.png" }] }
              ],
              "repeat": { "level": 2 }
            }
          } },
        { "id": "turf", "terrain": "grass", "movementCost": 1,
          "visual": { "visualId": "terrain.grass", "fallbackColor": "#4a7c3f" },
          "art": {
            "surface": [
              { "id": "a", "asset": "assets/tiles/turf_a.png" },
              { "id": "b", "asset": "assets/tiles/turf_b.png" }
            ]
          } }
    ]}"##;

#[test]
fn a_cell_may_choose_its_art_through_the_boundary() {
    let engine = JsonEngine::new();

    // Grass on top, rock underneath: the borrowed ladder cuts the faces and
    // the top face stays the cell's own
    // (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
    let borrowed = json(
        &engine
            .preview_tile_render(
                ART_TILE_SET,
                "turf",
                "isometric",
                2,
                0,
                0,
                r#"{ "surface": "b", "elevationTile": "rock" }"#,
            )
            .expect("resolve"),
    );
    assert_eq!(borrowed["surface"], "assets/tiles/turf_b.png");
    let layers = borrowed["layers"].as_array().expect("layers");
    assert_eq!(layers.len(), 2);
    assert_eq!(layers[0]["asset"], "assets/tiles/cliff_a.png");
    assert_eq!(layers[1]["asset"], "assets/tiles/cliff_b.png");

    // Without the borrow the same tile draws no faces at all: it authors a
    // surface and no ladder.
    let alone = json(
        &engine
            .preview_tile_render(ART_TILE_SET, "turf", "isometric", 2, 0, 0, "{}")
            .expect("resolve"),
    );
    assert!(alone["layers"].as_array().is_none_or(Vec::is_empty));

    // An id nobody defined costs the cell its choice, not its picture.
    let dangling = json(
        &engine
            .preview_tile_render(
                ART_TILE_SET,
                "turf",
                "isometric",
                0,
                0,
                0,
                r#"{ "surface": "zz" }"#,
            )
            .expect("resolve"),
    );
    assert_eq!(dangling["surface"], "assets/tiles/turf_a.png");
}

#[test]
fn a_top_down_world_resolves_the_flat_image_and_nothing_else() {
    let engine = JsonEngine::new();

    // The same raised cell, drawn twice. Top-down it is one flat image and
    // no relief at all
    // (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
    let flat = json(
        &engine
            .preview_tile_render(ART_TILE_SET, "rock", "topDown", 3, 0, 0, "{}")
            .expect("resolve"),
    );
    assert_eq!(flat["flat"], "assets/tiles/rock_flat_a.png");
    assert!(flat["surface"].is_null());
    assert!(flat["layers"].as_array().is_none_or(Vec::is_empty));

    // A tile with no flat image resolves to nothing, so the renderer draws
    // its colour rather than reaching for a surface that would not fit.
    let bare = json(
        &engine
            .preview_tile_render(ART_TILE_SET, "turf", "topDown", 0, 0, 0, "{}")
            .expect("resolve"),
    );
    assert!(bare["flat"].is_null());
    assert!(bare["surface"].is_null());

    // A mode nobody knows is top-down, which is what the content default is.
    let unknown = json(
        &engine
            .preview_tile_render(ART_TILE_SET, "rock", "sideways", 0, 0, 0, "{}")
            .expect("resolve"),
    );
    assert_eq!(unknown["flat"], "assets/tiles/rock_flat_a.png");
}

#[test]
fn a_tile_set_can_be_validated_without_being_registered() {
    let engine = JsonEngine::new();

    let report = json(&engine.validate_tile_set(ART_TILE_SET).expect("validate"));
    assert_eq!(report["valid"], true);

    let broken = ART_TILE_SET.replace(r#""level": 2"#, r#""level": 9"#);
    let report = json(&engine.validate_tile_set(&broken).expect("validate"));
    assert_eq!(report["valid"], false);
    assert_eq!(report["issues"][0]["code"], "tile.unknownRepeatSource");

    assert_eq!(code(&engine.validate_tile_set("{").unwrap_err()), "parse");
}

const TORCH: &str = r#"{
    "id": "torch", "schemaVersion": 1, "name": "Torch",
    "category": "prop",
    "resolution": { "width": 16, "height": 32 },
    "anchor": [8, 31], "plane": "front", "order": 2, "interactive": true,
    "animations": [
        { "id": "burning", "frames": ["assets/decorations/torch_0.png",
          "assets/decorations/torch_1.png"], "frameDurationMs": 100, "looping": true },
        { "id": "out", "frames": ["assets/decorations/torch_out.png"] }
    ]}"#;

const POTION: &str = r#"{
    "id": "small_potion", "schemaVersion": 2, "kind": "consumable",
    "nameKey": "game.object.smallPotion.name",
    "frames": ["assets/objects/small_potion.png"],
    "resolution": { "width": 16, "height": 16 }, "stackSize": 10 }"#;

/// A placed decoration crosses to the host as a *placement*: which
/// definition, where, and whether this one can be interacted with
/// (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
#[test]
fn a_placed_decoration_crosses_in_the_world_view() {
    let mut engine = JsonEngine::new();
    engine.load_tile_set(TILE_SET).expect("tile set loads");
    let world = WORLD.replace(
        r#""tiles": ["#,
        r#""decorations": [
            { "id": "oak_0", "decoration": "torch", "at": [3, 3] },
            { "id": "oak_1", "decoration": "torch", "at": [3, 3],
              "offset": [-6, 2], "interactive": true }
        ],
        "tiles": ["#,
    );
    engine.load_world(&world).expect("world loads");

    let view = json(&engine.world_view("w").expect("view"));
    let placed = &view["decorations"];
    assert_eq!(placed[0]["id"], "oak_0");
    assert_eq!(placed[0]["decoration"], "torch");
    assert_eq!(placed[0]["at"], serde_json::json!([3, 3]));
    // Whether is per placement: two torches on one cell, one of them live.
    assert_eq!(placed[0]["interactive"], false);
    assert_eq!(placed[1]["interactive"], true);
    // And so is the nudge, which is what keeps the two from being one
    // torch drawn twice in the same place.
    assert_eq!(placed[0]["offset"], serde_json::json!([0, 0]));
    assert_eq!(placed[1]["offset"], serde_json::json!([-6, 2]));
}

/// Which decorations exist is a fact about the *project*, so that is where
/// a map drawing from one nothing loaded is caught — exactly as a
/// `targetWorld` is.
#[test]
fn a_project_whose_map_places_an_unloaded_decoration_is_refused() {
    let mut engine = JsonEngine::new();
    engine.load_tile_set(TILE_SET).expect("tile set loads");
    engine
        .load_world(&WORLD.replace(
            r#""tiles": ["#,
            r#""decorations": [{ "id": "oak_0", "decoration": "torch", "at": [3, 3] }],
            "tiles": ["#,
        ))
        .expect("world loads");

    let project = r#"{ "id": "p", "schemaVersion": 1, "startWorld": "w",
        "worlds": [{ "id": "w", "path": "worlds/w.json" }],
        "tileSets": [{ "id": "t", "path": "tilesets/t.json" }] }"#;
    let error = engine.load_project(project).unwrap_err();
    assert_eq!(code(&error), "invalidContent");
    assert!(error.contains("decoration.unknownDefinition"), "{error}");

    // With the definition registered, the same project loads.
    engine.load_decoration(TORCH).expect("decoration loads");
    assert!(engine.load_project(project).is_ok());
}

#[test]
fn a_decoration_loads_resolves_and_previews_through_the_boundary() {
    let mut engine = JsonEngine::new();

    let outcome = json(&engine.load_decoration(TORCH).expect("decoration loads"));
    assert_eq!(outcome["id"], "torch");
    assert_eq!(outcome["report"]["valid"], true);

    let ids: Value = json(&engine.decoration_ids().expect("ids"));
    assert_eq!(ids, serde_json::json!(["torch"]));

    // The second frame of a looping flame, and the anchor already
    // subtracted: a host blits at the cell's ground point plus `placement`.
    let resolved = json(
        &engine
            .resolve_decoration("torch", Some("burning"), 100)
            .expect("resolve"),
    );
    assert_eq!(resolved["asset"], "assets/decorations/torch_1.png");
    assert_eq!(resolved["frame"], 1);
    assert_eq!(resolved["plane"], "front");
    assert_eq!(resolved["placement"], serde_json::json!([-8, -31, 16, 32]));

    // The editor previews a definition it has not registered.
    let preview = json(
        &engine
            .preview_decoration(TORCH, Some("out"), 0)
            .expect("preview"),
    );
    assert_eq!(preview["asset"], "assets/decorations/torch_out.png");

    assert_eq!(
        code(&engine.resolve_decoration("nope", None, 0).unwrap_err()),
        "unknownContent"
    );
    assert_eq!(code(&engine.load_decoration("{").unwrap_err()), "parse");
}

#[test]
fn an_invalid_decoration_is_refused_with_its_report() {
    let mut engine = JsonEngine::new();
    let empty = TORCH.replace(
        r#""frames": ["assets/decorations/torch_out.png"]"#,
        r#""frames": []"#,
    );

    let error = engine.load_decoration(&empty).unwrap_err();
    assert_eq!(code(&error), "invalidContent");
    assert_eq!(
        json(&error)["report"]["issues"][0]["code"],
        "decoration.emptyAnimation"
    );

    // Validating does not register, and says the same thing.
    let report = json(&engine.validate_decoration(&empty, "").expect("validate"));
    assert_eq!(report["valid"], false);
    assert!(engine.decoration("torch").is_err());
}

#[test]
fn an_object_loads_and_reads_back_through_the_boundary() {
    let mut engine = JsonEngine::new();

    let outcome = json(&engine.load_object(POTION).expect("object loads"));
    assert_eq!(outcome["id"], "small_potion");
    // No language is loaded, so a nameKey nothing defines is not yet an issue.
    assert_eq!(outcome["report"]["valid"], true);

    let object = json(&engine.object("small_potion").expect("read back"));
    assert_eq!(object["kind"], "consumable");
    assert_eq!(object["stackSize"], 10);

    let ids: Value = json(&engine.object_ids().expect("ids"));
    assert_eq!(ids, serde_json::json!(["small_potion"]));

    // A still icon resolves to its one frame, whenever it is asked for.
    let resolved = json(&engine.resolve_object("small_potion", 500).expect("resolve"));
    assert_eq!(resolved["asset"], "assets/objects/small_potion.png");
    assert_eq!(resolved["frame"], 0);
    assert_eq!(resolved["frames"], 1);

    let broken = POTION.replace(r#""stackSize": 10"#, r#""stackSize": 0"#);
    let report = json(&engine.validate_object(&broken).expect("validate"));
    assert_eq!(report["valid"], false);
    assert_eq!(report["issues"][0]["code"], "object.invalidStackSize");

    assert_eq!(code(&engine.object("nope").unwrap_err()), "unknownContent");
    assert_eq!(
        code(&engine.resolve_object("nope", 0).unwrap_err()),
        "unknownContent"
    );
}

/// An animated icon is previewed the way a decoration is: from the JSON in
/// the editor's hand, unregistered and possibly not yet valid
/// (`docs/adr/ADR-0036-an-object-is-carried-not-placed.md`).
#[test]
fn an_animated_object_icon_previews_through_the_boundary() {
    let engine = JsonEngine::new();
    let gem = POTION.replace(
        r#""frames": ["assets/objects/small_potion.png"]"#,
        r#""frames": ["assets/objects/gem_0.png", "assets/objects/gem_1.png"],
           "frameDurationMs": 100, "looping": true"#,
    );

    let first = json(&engine.preview_object(&gem, 0).expect("preview"));
    assert_eq!(first["asset"], "assets/objects/gem_0.png");
    assert_eq!(first["durationMs"], 200);
    assert_eq!(first["looping"], true);

    let second = json(&engine.preview_object(&gem, 150).expect("preview"));
    assert_eq!(second["frame"], 1);
    assert_eq!(second["asset"], "assets/objects/gem_1.png");

    assert_eq!(code(&engine.preview_object("{", 0).unwrap_err()), "parse");
}

#[test]
fn a_tile_render_resolves_through_the_boundary() {
    let engine = JsonEngine::new();

    let flat = json(
        &engine
            .preview_tile_render(ART_TILE_SET, "rock", "isometric", 0, 0, 0, "{}")
            .expect("resolve"),
    );
    assert_eq!(flat["surface"], "assets/tiles/rock_a.png");
    assert!(flat["layers"].as_array().is_none_or(Vec::is_empty));

    // Four steps of relief over two authored levels: the third and fourth
    // repeat level 2, moved down whole steps and never transformed.
    let tall = json(
        &engine
            .preview_tile_render(ART_TILE_SET, "rock", "isometric", 4, 0, 0, "{}")
            .expect("resolve"),
    );
    let layers = tall["layers"].as_array().expect("layers");
    assert_eq!(layers.len(), 4);
    assert_eq!(layers[0]["asset"], "assets/tiles/cliff_a.png");
    assert_eq!(layers[0]["drop"], 3);
    assert_eq!(layers[3]["asset"], "assets/tiles/cliff_b.png");
    assert_eq!(layers[3]["drop"], 0);
    assert_eq!(layers[3]["sourceLevel"], 2);
    // The faces never carry a top face: that is still the tile's surface.
    assert_eq!(tall["surface"], "assets/tiles/rock_a.png");

    assert_eq!(
        code(
            &engine
                .preview_tile_render(ART_TILE_SET, "absent", "isometric", 0, 0, 0, "{}")
                .unwrap_err()
        ),
        "unknownContent"
    );
    assert_eq!(
        code(
            &engine
                .preview_tile_render(ART_TILE_SET, "rock", "isometric", 0, 0, 0, "{")
                .unwrap_err()
        ),
        "parse"
    );
}

#[test]
fn the_world_view_carries_the_tile_sets_pixel_grid() {
    let mut engine = JsonEngine::new();
    engine.load_tile_set(ART_TILE_SET).expect("tile set loads");
    engine
        .load_world(
            &WORLD
                .replace(r#""tileSetId": "t""#, r#""tileSetId": "art""#)
                .replace(r#""defaultTile": "grass""#, r#""defaultTile": "rock""#)
                .replace(r#""tiles": [{ "at": [4, 4], "tile": "water" }],"#, ""),
        )
        .expect("world loads");

    let view = json(&engine.world_view("w").expect("view"));
    assert_eq!(view["tileArt"]["width"], 32);
    assert_eq!(view["tileArt"]["flatHeight"], 37);
    assert_eq!(view["tileArt"]["elevationStep"], 8);
    assert_eq!(
        view["palette"][0]["art"]["surface"][0]["asset"],
        "assets/tiles/rock_a.png"
    );
}

#[test]
fn projection_and_elevation_cross_the_boundary_for_the_renderer() {
    let mut engine = JsonEngine::new();
    engine.load_tile_set(TILE_SET).expect("tile set loads");
    engine
        .load_world(
            &WORLD
                .replace(r#""width": 8"#, r#""projection": "isometric", "width": 8"#)
                .replace(
                    r#"{ "at": [4, 4], "tile": "water" }"#,
                    r#"{ "at": [4, 4], "tile": "water" }, { "at": [1, 1], "tile": "grass", "elevation": 5 }"#,
                ),
        )
        .expect("world loads");

    let view = json(&engine.world_view("w").expect("view"));
    assert_eq!(view["projection"], "isometric");
    assert_eq!(view["characterHeightTiles"], 2.0);
    assert_eq!(view["grid"]["lineWidth"], 1);
    assert_eq!(view["grid"]["color"], "#000000");
    assert_eq!(view["grid"]["alpha"], 0.25);

    let elevations = engine.elevation_buffer("w").expect("buffer");
    assert_eq!(elevations.len(), 64);
    assert_eq!(elevations[9], 5, "row 1, col 1 in an 8-wide map");
    assert_eq!(elevations[0], 0);

    assert_eq!(
        code(&engine.elevation_buffer("nope").unwrap_err()),
        "unknownContent"
    );
}

#[test]
fn a_world_without_a_projection_defaults_to_top_down() {
    assert_eq!(
        json(&loaded().world_view("w").expect("view"))["projection"],
        "topDown"
    );
}

#[test]
fn an_authored_character_scale_crosses_the_json_boundary() {
    let mut engine = JsonEngine::new();
    engine.load_tile_set(TILE_SET).expect("tile set loads");
    engine
        .load_world(&WORLD.replace(
            r#""width": 8"#,
            r#""characterHeightTiles": 3.5, "width": 8"#,
        ))
        .expect("world loads");

    assert_eq!(
        json(&engine.world_view("w").expect("view"))["characterHeightTiles"],
        3.5
    );
}

#[test]
fn an_authored_grid_style_crosses_the_json_boundary() {
    let mut engine = JsonEngine::new();
    engine.load_tile_set(TILE_SET).expect("tile set loads");
    engine
        .load_world(&WORLD.replace(
            r#""width": 8"#,
            r##""grid": { "lineWidth": 3, "color": "#abcdef", "alpha": 0.4 }, "width": 8"##,
        ))
        .expect("world loads");

    let grid = &json(&engine.world_view("w").expect("view"))["grid"];
    assert_eq!(grid["lineWidth"], 3);
    assert_eq!(grid["color"], "#abcdef");
    assert_eq!(grid["alpha"], 0.4);
}

#[test]
fn errors_cross_the_boundary_as_json_payloads() {
    let mut engine = JsonEngine::new();
    assert_eq!(code(&engine.load_world("{").unwrap_err()), "parse");
    assert_eq!(
        code(&engine.load_world(WORLD).unwrap_err()),
        "invalidContent"
    );
    assert_eq!(code(&engine.snapshot().unwrap_err()), "noGame");
    assert_eq!(
        code(&engine.world_view("nope").unwrap_err()),
        "unknownContent"
    );
    assert_eq!(
        code(&engine.terrain_buffer("nope").expect_err("unknown world")),
        "unknownContent"
    );
    assert_eq!(
        code(&engine.dispatch(r#"{"type":"fly"}"#).unwrap_err()),
        "parse"
    );
    assert_eq!(
        code(&engine.create_game("nope", 1, "{}").unwrap_err()),
        "unknownContent"
    );
}

#[test]
fn an_illegal_command_is_a_result_not_an_error() {
    let mut engine = loaded();
    engine.create_game("w", 1, "{}").expect("game");

    let result = json(
        &engine
            .dispatch(r#"{"type":"moveTo","to":[7,7]}"#)
            .expect("the call itself succeeds"),
    );

    assert_eq!(result["accepted"], false);
    assert_eq!(result["rejection"]["code"], "notAdjacent");
    assert_eq!(result["state"]["tick"], 0);
}

#[test]
fn invalid_content_errors_carry_the_validation_report() {
    let mut engine = JsonEngine::new();
    engine.load_tile_set(TILE_SET).expect("tile set loads");

    let broken = WORLD.replace(
        r#"{ "id": "p", "templateId": "player", "at": [2, 2] },"#,
        "",
    );
    let payload = json(&engine.load_world(&broken).unwrap_err());

    assert_eq!(payload["code"], "invalidContent");
    let codes: Vec<&str> = payload["report"]["issues"]
        .as_array()
        .expect("issues")
        .iter()
        .filter_map(|issue| issue["code"].as_str())
        .collect();
    assert!(codes.contains(&"world.missingPlayer"), "got {codes:?}");
}

#[test]
fn the_editor_validation_path_does_not_register_worlds() {
    let mut engine = JsonEngine::new();
    engine.load_tile_set(TILE_SET).expect("tile set loads");

    assert_eq!(
        json(&engine.validate_world(WORLD).expect("validates"))["valid"],
        true
    );

    let summary = json(&engine.content_summary().expect("summary"));
    assert_eq!(summary["worlds"].as_array().expect("worlds").len(), 0);
    assert_eq!(summary["tileSets"].as_array().expect("tileSets").len(), 1);
    assert_eq!(summary["templates"].as_array().expect("templates").len(), 2);
}

const LINKED_WORLD: &str = r#"{
    "id": "outside", "schemaVersion": 1, "width": 8, "height": 8,
    "tileSetId": "t", "defaultTile": "grass",
    "entities": [
        { "id": "p", "templateId": "player", "at": [2, 2] },
        { "id": "m", "templateId": "monster", "at": [6, 6] }
    ],
    "links": [
        { "id": "door", "at": [3, 2], "targetWorld": "house",
          "targetAt": [1, 1], "name": "House" }
    ]}"#;

const HOUSE_WORLD: &str = r#"{
    "id": "house", "schemaVersion": 1, "width": 5, "height": 5,
    "tileSetId": "t", "defaultTile": "grass",
    "entities": [{ "id": "p", "templateId": "player", "at": [2, 2] }],
    "links": [
        { "id": "door_out", "at": [1, 0], "targetWorld": "outside",
          "targetAt": [2, 2] }
    ]}"#;

const PROJECT: &str = r#"{
    "id": "demo", "schemaVersion": 1, "name": "Demo", "startWorld": "outside",
    "tileSets": [{ "id": "t", "path": "tilesets/t.json" }],
    "worlds": [
        { "id": "outside", "path": "worlds/outside.json" },
        { "id": "house", "path": "worlds/house.json" }
    ]}"#;

fn linked() -> JsonEngine {
    let mut engine = JsonEngine::new();
    engine.load_tile_set(TILE_SET).expect("tile set loads");
    engine.load_world(LINKED_WORLD).expect("outside loads");
    engine.load_world(HOUSE_WORLD).expect("house loads");
    engine
}

#[test]
fn walking_through_a_door_changes_map_across_the_boundary() {
    let mut engine = linked();

    let view = json(&engine.world_view("outside").expect("view"));
    assert_eq!(view["links"][0]["id"], "door");
    assert_eq!(view["links"][0]["targetWorld"], "house");
    assert_eq!(view["links"][0]["targetAt"], json("[1,1]"));
    assert_eq!(view["links"][0]["trigger"], "enter");

    engine.create_game("outside", 5, "{}").expect("game");
    let result = json(
        &engine
            .dispatch(r#"{"type":"moveTo","to":[3,2]}"#)
            .expect("dispatch"),
    );

    assert_eq!(result["accepted"], true);
    assert_eq!(result["state"]["worldId"], "house");
    assert_eq!(result["state"]["player"]["at"], json("[1,1]"));

    let types: Vec<&str> = result["events"]
        .as_array()
        .expect("events")
        .iter()
        .filter_map(|event| event["type"].as_str())
        .collect();
    assert!(types.contains(&"linkTriggered"), "got {types:?}");
    assert!(types.contains(&"worldEntered"), "got {types:?}");

    // And back out again through the house's own door.
    let back = json(
        &engine
            .dispatch(r#"{"type":"moveTo","to":[1,0]}"#)
            .expect("dispatch"),
    );
    assert_eq!(back["state"]["worldId"], "outside");
    assert_eq!(back["state"]["tick"], 2, "each map change costs one tick");
}

#[test]
fn link_and_project_validation_cross_the_boundary() {
    let mut engine = JsonEngine::new();
    engine.load_tile_set(TILE_SET).expect("tile set loads");
    engine.load_world(LINKED_WORLD).expect("outside loads");

    let report = json(&engine.validate_links().expect("report"));
    assert_eq!(report["valid"], false);
    assert_eq!(report["issues"][0]["code"], "link.unknownTargetWorld");

    // The project cannot load while one of its worlds is missing …
    let payload = json(&engine.load_project(PROJECT).unwrap_err());
    assert_eq!(payload["code"], "invalidContent");
    assert_eq!(
        payload["report"]["issues"][0]["code"],
        "project.unloadedWorld"
    );

    // … and both go valid once it is.
    engine.load_world(HOUSE_WORLD).expect("house loads");
    assert_eq!(
        json(&engine.validate_links().expect("report"))["valid"],
        true
    );
    let outcome = json(&engine.load_project(PROJECT).expect("project loads"));
    assert_eq!(outcome["id"], "demo");

    let summary = json(&engine.content_summary().expect("summary"));
    assert_eq!(summary["project"]["startWorld"], "outside");
    assert_eq!(code(&engine.load_project("{").unwrap_err()), "parse");
}

#[test]
fn resetting_content_leaves_a_running_game_alone() {
    let mut engine = linked();
    engine.create_game("outside", 5, "{}").expect("game");

    engine.reset_content();

    let summary = json(&engine.content_summary().expect("summary"));
    assert_eq!(summary["worlds"].as_array().expect("worlds").len(), 0);
    assert_eq!(summary["project"], Value::Null);
    assert!(engine.has_game(), "the session survives a content reload");
    assert_eq!(
        json(&engine.snapshot().expect("snapshot"))["worldId"],
        "outside"
    );
    // The map it is on can no longer be re-fetched, which is exactly why a
    // host resets only when it is about to load content again.
    assert_eq!(
        code(&engine.world_view("outside").unwrap_err()),
        "unknownContent"
    );
}

#[test]
fn engine_info_reports_the_build() {
    let info = json(&JsonEngine::new().engine_info().expect("info"));
    assert_eq!(info["name"], "insulaire-engine");
    assert_eq!(info["worldSchemaVersion"], 6);
    assert!(info["version"].is_string());
}

#[test]
fn waiting_advances_the_tick_and_the_monster() {
    let mut engine = loaded();
    let before = json(&engine.create_game("w", 3, "{}").expect("game"));
    let monster_before = before["entities"][1]["at"].clone();

    let result = json(&engine.dispatch(r#"{"type":"wait"}"#).expect("dispatch"));

    assert_eq!(result["state"]["tick"], 1);
    assert_ne!(result["state"]["entities"][1]["at"], monster_before);
}

#[test]
fn ending_a_game_leaves_content_loaded() {
    let mut engine = loaded();
    engine.create_game("w", 1, "{}").expect("game");
    engine.end_game();

    assert!(!engine.has_game());
    assert_eq!(code(&engine.snapshot().unwrap_err()), "noGame");
    assert!(engine.world_view("w").is_ok());
}

// ---------------------------------------------------------------- locales

const LOCALISED_PROJECT: &str = r#"{
    "id": "p", "schemaVersion": 1, "startWorld": "w",
    "tileSets": [{ "id": "t", "path": "tilesets/t.json" }],
    "worlds": [{ "id": "w", "path": "worlds/w.json" }],
    "locales": {
        "default": "en",
        "languages": [
            { "id": "en", "name": "English",
              "files": [{ "id": "menu", "path": "locales/en/menu.json" }] },
            { "id": "fr", "name": "Français",
              "files": [{ "id": "menu", "path": "locales/fr/menu.json" }] }
        ]
    }}"#;

#[test]
fn locale_files_load_and_resolve_through_the_string_api() {
    let mut engine = loaded();
    engine
        .load_locale(
            "en",
            "menu",
            r#"{ "buttons": { "newGame": "New game", "quit": "Quit" } }"#,
        )
        .expect("english loads");
    engine
        .load_locale(
            "fr",
            "menu",
            r#"{ "buttons": { "newGame": "Nouvelle partie" } }"#,
        )
        .expect("french loads");
    engine.load_project(LOCALISED_PROJECT).expect("project");

    let fr = json(&engine.locale("fr").expect("french bundle"));
    assert_eq!(fr["language"], "fr");
    assert_eq!(fr["entries"]["menu.buttons.newGame"], "Nouvelle partie");
    // Untranslated: the default language stands in, and says so.
    assert_eq!(fr["entries"]["menu.buttons.quit"], "Quit");
    assert_eq!(fr["fallbacks"][0], "menu.buttons.quit");

    let summary = json(&engine.content_summary().expect("summary"));
    assert_eq!(summary["project"]["languages"][0]["id"], "en");
    assert_eq!(summary["project"]["languages"][0]["isDefault"], true);
    assert_eq!(summary["project"]["languages"][1]["name"], "Français");
}

#[test]
fn a_missing_translation_is_a_warning_not_a_failed_load() {
    let mut engine = loaded();
    engine
        .load_locale("en", "menu", r#"{ "play": "Play", "quit": "Quit" }"#)
        .expect("english loads");
    engine
        .load_locale("fr", "menu", r#"{ "play": "Jouer" }"#)
        .expect("french loads");

    // The project loads: the gap does not make the content unusable.
    engine.load_project(LOCALISED_PROJECT).expect("project");

    let report = json(&engine.validate_locales().expect("report"));
    assert_eq!(report["valid"], true);
    assert_eq!(report["issues"][0]["code"], "locale.missingTranslation");
    assert_eq!(report["issues"][0]["path"], "fr.menu.quit");
}

#[test]
fn a_locale_file_that_is_not_nested_strings_is_a_parse_error() {
    let mut engine = loaded();
    assert_eq!(
        code(
            &engine
                .load_locale("en", "menu", r#"{ "delay": 42 }"#)
                .unwrap_err()
        ),
        "parse"
    );
    assert_eq!(
        code(&engine.load_locale("en", "menu", "not json").unwrap_err()),
        "parse"
    );
}

#[test]
fn a_key_defined_twice_in_one_language_is_refused() {
    let mut engine = loaded();
    engine
        .load_locale("en", "menu", r#"{ "play": "Play" }"#)
        .expect("first file");

    let error = engine.load_locale("en", "menu", r#"{ "play": "Again" }"#);
    assert_eq!(code(&error.unwrap_err()), "parse");

    // The first value stands; a refused file changes nothing.
    let bundle = json(&engine.locale("en").expect("bundle"));
    assert_eq!(bundle["entries"]["menu.play"], "Play");
}

#[test]
fn asking_for_a_language_that_was_never_loaded_is_an_error() {
    let engine = loaded();
    assert_eq!(code(&engine.locale("de").unwrap_err()), "unknownContent");
}

// ----------------------------------------------------------- title screen

const TITLE_SCREEN: &str = r#"{
    "id": "main", "schemaVersion": 1, "titleKey": "menu.title",
    "buttons": [{ "action": "newGame", "labelKey": "menu.play" }]
}"#;

#[test]
fn a_title_screen_loads_and_comes_back_through_the_string_api() {
    let mut engine = loaded();
    let outcome = json(&engine.load_title_screen(TITLE_SCREEN).expect("loads"));
    assert_eq!(outcome["id"], "main");

    let screen = json(&engine.title_screen().expect("screen"));
    assert_eq!(screen["titleKey"], "menu.title");
    assert_eq!(screen["buttons"][0]["action"], "newGame");
    // Defaults are explicit on the way out, so a host never guesses.
    assert_eq!(screen["layout"], "left");
    assert_eq!(screen["background"]["fit"], "cover");
}

#[test]
fn a_title_screen_with_no_way_to_start_a_game_is_refused() {
    let mut engine = loaded();
    let error = engine
        .load_title_screen(
            r#"{ "id": "main", "schemaVersion": 1, "titleKey": "menu.title", "buttons": [] }"#,
        )
        .unwrap_err();

    assert_eq!(code(&error), "invalidContent");
    assert!(error.contains("titleScreen.noNewGame"), "{error}");
    assert_eq!(code(&engine.title_screen().unwrap_err()), "unknownContent");
}

#[test]
fn a_project_naming_a_title_screen_that_is_not_loaded_does_not_load() {
    let mut engine = loaded();
    let manifest = r#"{
        "id": "p", "schemaVersion": 1, "startWorld": "w",
        "tileSets": [{ "id": "t", "path": "tilesets/t.json" }],
        "worlds": [{ "id": "w", "path": "worlds/w.json" }],
        "titleScreen": { "id": "main", "path": "menu/title-screen.json" }
    }"#;

    let error = engine.load_project(manifest).unwrap_err();
    assert!(error.contains("project.unloadedTitleScreen"), "{error}");

    engine
        .load_title_screen(TITLE_SCREEN)
        .expect("screen loads");
    assert!(engine.load_project(manifest).is_ok());
}

/**
 * The check that needs both halves: a label key is only meaningful if some
 * language answers it, and that is only knowable once both are loaded.
 */
#[test]
fn a_label_key_no_language_defines_is_reported() {
    let mut engine = loaded();
    engine
        .load_locale("en", "menu", r#"{ "title": "Insulaire" }"#)
        .expect("locale loads");
    engine
        .load_title_screen(TITLE_SCREEN)
        .expect("screen loads");

    let report = json(&engine.validate_title_screen(TITLE_SCREEN).expect("report"));
    // Reported, but not fatal: an untranslated label renders as its key
    // until the language editor fills it in.
    assert_eq!(report["valid"], true);
    let codes: Vec<&str> = report["issues"]
        .as_array()
        .expect("issues")
        .iter()
        .map(|issue| issue["code"].as_str().expect("code"))
        .collect();
    assert!(codes.contains(&"locale.unknownKey"), "{codes:?}");
}

// --------------------------------------------------------------- settings

const SETTINGS: &str = r#"{
    "id": "game", "schemaVersion": 1,
    "sections": [{ "id": "gameplay", "labelKey": "game.gameplay", "groups": [{
        "id": "world", "labelKey": "game.world", "fields": [
            { "id": "difficulty", "labelKey": "game.difficulty", "control": "select",
              "default": "normal", "scope": "newGame",
              "options": [{ "value": "easy", "labelKey": "game.easy" },
                          { "value": "normal", "labelKey": "game.normal" }] },
            { "id": "population", "labelKey": "game.population", "control": "slider",
              "default": 120, "min": 10, "max": 500, "scope": "newGame" }
        ] }] }]
}"#;

#[test]
fn settings_load_and_resolve_through_the_string_api() {
    let mut engine = loaded();
    let outcome = json(&engine.load_settings(SETTINGS).expect("loads"));
    assert_eq!(outcome["id"], "game");

    let declaration = json(&engine.settings().expect("settings"));
    assert_eq!(
        declaration["sections"][0]["groups"][0]["fields"][0]["id"],
        "difficulty"
    );

    // Defaults filled, unknown dropped, out of range clamped: one rule, in
    // one place, for the screen and for createGame alike.
    let resolved = json(
        &engine
            .resolve_settings(r#"{ "population": 9000, "unknown": true }"#)
            .expect("resolve"),
    );
    assert_eq!(resolved["difficulty"], "normal");
    assert_eq!(resolved["population"], 500.0);
    assert!(resolved.get("unknown").is_none());
}

#[test]
fn a_game_carries_the_settings_it_was_created_with() {
    let mut engine = loaded();
    engine.load_settings(SETTINGS).expect("settings load");

    let start = json(
        &engine
            .create_game("w", 7, r#"{ "difficulty": "easy" }"#)
            .expect("game"),
    );
    assert_eq!(start["settings"]["difficulty"], "easy");
    assert_eq!(start["settings"]["population"], 120);

    // And they survive a tick, because they are what the game was made with.
    let result = json(&engine.dispatch(r#"{"type":"wait"}"#).expect("dispatch"));
    assert_eq!(result["state"]["settings"]["difficulty"], "easy");
}

#[test]
fn a_game_without_a_settings_declaration_carries_none() {
    let mut engine = loaded();
    let start = json(
        &engine
            .create_game("w", 7, r#"{ "anything": 1 }"#)
            .expect("game"),
    );

    assert_eq!(start["settings"], serde_json::json!({}));
    assert_eq!(code(&engine.settings().unwrap_err()), "unknownContent");
}

#[test]
fn a_settings_declaration_that_cannot_be_rendered_is_refused() {
    let mut engine = loaded();
    let error = engine
        .load_settings(
            r#"{ "id": "game", "schemaVersion": 1, "sections": [{ "id": "s", "labelKey": "k",
                 "groups": [{ "id": "g", "labelKey": "k", "fields": [
                   { "id": "difficulty", "labelKey": "k", "control": "select",
                     "default": "nightmare", "options": [] }
                 ] }] }] }"#,
        )
        .unwrap_err();

    assert_eq!(code(&error), "invalidContent");
    assert!(error.contains("settings.noOptions"), "{error}");
    assert!(error.contains("settings.invalidDefault"), "{error}");
}

// ------------------------------------------------------------- characters

const CHARACTER: &str = r##"{
    "id": "human_player", "schemaVersion": 1, "name": "Human Player",
    "category": "player", "resolution": { "width": 64, "height": 128 },
    "parameters": [
        { "id": "hairColor", "labelKey": "game.character.hairColor",
          "control": "color", "default": "#4b3621" },
        { "id": "cape", "labelKey": "game.character.cape", "control": "toggle",
          "default": true }
    ],
    "layers": [
        { "id": "cape", "variants": [
            { "id": "worn", "when": { "cape": true }, "rect": [12, 27, 40, 95],
              "sprite": { "asset": "assets/characters/cape.png" } }
        ] },
        { "id": "hair", "variants": [
            { "id": "default", "rect": [23, 10, 18, 20],
              "sprite": { "asset": "assets/characters/hair_front.png",
                          "tint": { "parameter": "hairColor" } } }
        ] }
    ]
}"##;

const CHARACTER_CREATION: &str = r##"{
    "id": "new_game", "schemaVersion": 1, "baseCharacter": "human_player",
    "choices": [
        { "id": "anything", "labelKey": "game.creation.anything",
          "control": "color", "default": "#4b3621",
          "binding": { "kind": "parameter", "parameter": "hairColor" } }
    ],
    "characteristics": [
        { "id": "age", "labelKey": "game.creation.age", "control": "number",
          "default": 18, "min": 0, "max": 120, "nullable": false },
        { "id": "mana", "labelKey": "game.creation.mana", "control": "number",
          "default": null, "min": 0, "nullable": true }
    ],
    "screens": [{ "id": "identity", "titleKey": "game.creation.identity", "blocks": [
        { "type": "choice", "choice": "anything" },
        { "type": "characteristic", "characteristic": "age" },
        { "type": "characteristic", "characteristic": "mana" },
        { "type": "preview" }
    ] }]
}"##;

#[test]
fn characters_load_and_resolve_through_the_string_api() {
    let mut engine = loaded();
    let outcome = json(&engine.load_character(CHARACTER).expect("loads"));
    assert_eq!(outcome["id"], "human_player");

    let ids = json(&engine.character_ids().expect("ids"));
    assert_eq!(ids, serde_json::json!(["human_player"]));

    let definition = json(&engine.character("human_player").expect("definition"));
    assert_eq!(definition["category"], "player");
    assert_eq!(definition["parameters"][0]["id"], "hairColor");
    // A definition drawn on the canvas `SpriteResolution::default()` names
    // writes no `resolution`, which is what makes the field optional in the
    // generated TypeScript. What the default *is* stays the engine's answer:
    // the resolved character below carries it.
    assert!(definition.get("resolution").is_none());

    // The customisation crosses as values and comes back as geometry: the
    // host blits what Rust resolved, and resolves nothing itself.
    let resolved = json(
        &engine
            .resolve_character("human_player", r##"{ "hairColor": "#f2c14e" }"##, None, 0)
            .expect("resolve"),
    );
    assert_eq!(resolved["character"], "human_player");
    assert_eq!(resolved["resolution"]["height"], 128);
    assert_eq!(resolved["layers"][1]["layer"], "hair");
    assert_eq!(
        resolved["layers"][1]["asset"],
        "assets/characters/hair_front.png"
    );
    assert_eq!(resolved["layers"][1]["tint"], "#f2c14e");
    // An untinted sprite says so as an empty string, not as a colour.
    assert_eq!(resolved["layers"][0]["tint"], "");
}

#[test]
fn a_customisation_is_resolved_by_the_same_rules_as_settings() {
    let mut engine = loaded();
    engine.load_character(CHARACTER).expect("loads");

    let resolved = json(
        &engine
            .resolve_character(
                "human_player",
                r#"{ "cape": "yes", "hairColor": 3, "unknown": true }"#,
                None,
                0,
            )
            .expect("resolve"),
    );

    // Refused, refused, dropped — exactly what a settings payload gets.
    assert_eq!(resolved["values"]["cape"], true);
    assert_eq!(resolved["values"]["hairColor"], "#4b3621");
    assert!(resolved["values"].get("unknown").is_none());
}

#[test]
fn character_creation_loads_validates_and_resolves_through_the_string_api() {
    let mut engine = loaded();
    engine.load_character(CHARACTER).expect("character loads");

    let validation = json(
        &engine
            .validate_character_creation(CHARACTER_CREATION)
            .expect("validates"),
    );
    assert_eq!(validation["valid"], true);

    let outcome = json(
        &engine
            .load_character_creation(CHARACTER_CREATION)
            .expect("creation loads"),
    );
    assert_eq!(outcome["id"], "new_game");
    assert_eq!(outcome["report"]["valid"], true);

    let definition = json(&engine.character_creation().expect("definition"));
    assert_eq!(definition["choices"][0]["id"], "anything");
    assert_eq!(definition["characteristics"][1]["nullable"], true);
    assert_eq!(
        json(&engine.content_summary().expect("summary"))["characterCreation"],
        "new_game"
    );

    let resolved = json(
        &engine
            .resolve_character_creation(
                r##"{ "anything": "#f2c14e", "unknown": true }"##,
                r#"{ "age": 999, "mana": null, "unknown": 3 }"#,
            )
            .expect("resolves"),
    );
    assert_eq!(resolved["character"], "human_player");
    assert_eq!(resolved["choices"]["anything"], "#f2c14e");
    assert_eq!(resolved["parameters"]["hairColor"], "#f2c14e");
    assert_eq!(resolved["characteristics"]["age"], 120.0);
    assert_eq!(resolved["characteristics"]["mana"], Value::Null);
    assert!(resolved["choices"].get("unknown").is_none());
    assert!(resolved["characteristics"].get("unknown").is_none());
}

#[test]
fn an_editor_can_preview_unregistered_character_creation() {
    let engine = loaded();
    let resolved = json(
        &engine
            .preview_character_creation(CHARACTER_CREATION, r##"{ "anything": "#ffffff" }"##, "{}")
            .expect("previews"),
    );

    assert_eq!(resolved["parameters"]["hairColor"], "#ffffff");
    assert_eq!(resolved["characteristics"]["age"], 18);
    assert_eq!(resolved["characteristics"]["mana"], Value::Null);
    assert_eq!(
        code(&engine.character_creation().unwrap_err()),
        "unknownContent"
    );
    assert_eq!(
        code(
            &engine
                .preview_character_creation("{", "{}", "{}")
                .unwrap_err()
        ),
        "parse"
    );
}

/// The editor previews content that is not registered and need not be
/// finished: resolution is total, so a half-written definition still draws.
#[test]
fn a_definition_in_hand_previews_without_being_registered() {
    let engine = loaded();

    let resolved = json(
        &engine
            .preview_character(CHARACTER, r#"{ "cape": false }"#, None, 0)
            .expect("preview"),
    );
    assert_eq!(resolved["character"], "human_player");
    assert_eq!(resolved["values"]["cape"], false);
    // The cape's only variant waits on it, so the layer is simply not there.
    assert_eq!(resolved["layers"][0]["layer"], "hair");
    // Nothing was registered by previewing it.
    assert_eq!(
        code(&engine.character("human_player").unwrap_err()),
        "unknownContent"
    );

    // A definition whose tint binding names nothing still previews, in the
    // colour that says so.
    let broken = json(
        &engine
            .preview_character(
                r##"{ "id": "wip", "schemaVersion": 1, "layers": [{ "id": "hair",
                      "variants": [{ "id": "v", "rect": [0, 0, 8, 8], "sprite": {
                      "asset": "a.png", "tint": { "parameter": "absent" } } }] }] }"##,
                "{}",
                None,
                0,
            )
            .expect("preview"),
    );
    assert_eq!(broken["layers"][0]["tint"], "#ff00ff");

    assert_eq!(
        code(&engine.preview_character("{", "{}", None, 0).unwrap_err()),
        "parse"
    );
}

/// A character with a skeleton and a four-frame idle, carried across the
/// string boundary: the smallest definition that proves placement and
/// animation survive being serialised.
const ANIMATED: &str = r#"{
    "id": "knight", "schemaVersion": 2, "resolution": { "width": 64, "height": 128 },
    "layers": [
        { "id": "body", "anchors": [ { "id": "neck", "at": [32, 40] } ],
          "variants": [ { "id": "d", "rect": [20, 40, 24, 76],
                          "sprite": { "asset": "assets/characters/body.png" } } ] },
        { "id": "head", "parent": "body", "parentAnchor": "neck",
          "variants": [ { "id": "d", "rect": [24, 12, 16, 28],
                          "sprite": { "asset": "assets/characters/head.png" } } ] },
        { "id": "hair", "parent": "head",
          "variants": [ { "id": "d", "rect": [23, 8, 18, 20],
                          "sprite": { "asset": "assets/characters/hair.png" } } ] }
    ],
    "animations": [
        { "id": "idle", "name": "Idle", "role": "idle", "frames": 4, "frameDurationMs": 120,
          "looping": true, "tracks": [
            { "node": "body", "keyframes": [
                { "frame": 0, "offset": [0, 0] },
                { "frame": 1, "offset": [0, -2] },
                { "frame": 2, "offset": [0, 0] },
                { "frame": 3, "offset": [0, 2] } ] },
            { "node": "hair", "keyframes": [
                { "frame": 0, "offset": [0, 0] },
                { "frame": 3, "offset": [0, -1] } ] } ] }
    ]
}"#;

/// The whole animation contract at the boundary: one track moves the body,
/// the hierarchy moves everything hanging off it, and a local keyframe adds
/// to what was inherited rather than replacing it.
#[test]
fn an_animation_moves_a_node_and_everything_that_hangs_off_it() {
    let mut engine = loaded();
    engine.load_character(ANIMATED).expect("loads");

    let rest = json(
        &engine
            .resolve_character("knight", "{}", None, 0)
            .expect("rest"),
    );
    assert!(rest.get("pose").is_none());

    let up = json(
        &engine
            .resolve_character("knight", "{}", Some("idle"), 120)
            .expect("frame 1"),
    );
    assert_eq!(up["pose"]["animation"], "idle");
    assert_eq!(up["pose"]["frame"], 1);
    assert_eq!(up["pose"]["timeMs"], 120);
    assert_eq!(up["pose"]["durationMs"], 480);

    // Only the body has a keyframe at frame 1; the head and the hair follow.
    for index in 0..3 {
        assert_eq!(up["layers"][index]["offset"], serde_json::json!([0, -2]));
        assert_eq!(
            up["layers"][index]["rect"][1].as_i64().expect("y"),
            rest["layers"][index]["rect"][1].as_i64().expect("y") - 2,
        );
    }

    // Frame 3: the body drops 2 and the hair corrects itself by 1, so it
    // ends up 1 lower — not 1 higher, and not back at the rest pose.
    let down = json(
        &engine
            .resolve_character("knight", "{}", Some("idle"), 360)
            .expect("frame 3"),
    );
    assert_eq!(down["layers"][0]["offset"], serde_json::json!([0, 2]));
    assert_eq!(down["layers"][2]["offset"], serde_json::json!([0, 1]));

    // It loops, so a whole cycle later it is the same picture.
    let looped = json(
        &engine
            .resolve_character("knight", "{}", Some("idle"), 360 + 480 * 3)
            .expect("later"),
    );
    assert_eq!(looped["layers"], down["layers"]);
}

#[test]
fn gameplay_resolves_a_character_by_validated_animation_role() {
    let mut engine = loaded();
    engine.load_character(ANIMATED).expect("loads");

    let idle = json(
        &engine
            .resolve_character_role("knight", "{}", "idle", 120)
            .expect("role"),
    );
    assert_eq!(idle["pose"]["animation"], "idle");
    assert_eq!(idle["pose"]["frame"], 1);

    let rest = json(
        &engine
            .resolve_character_role("knight", "{}", "moveNorthWest", 120)
            .expect("unassigned role is rest"),
    );
    assert!(rest.get("pose").is_none());
    assert_eq!(
        code(
            &engine
                .resolve_character_role("knight", "{}", "walk", 0)
                .expect_err("unknown role")
        ),
        "parse"
    );
}

/// An id nobody declares is the rest pose, not an error: the editor deletes
/// an animation while its preview is still asking for it.
#[test]
fn an_unknown_animation_previews_as_the_rest_pose() {
    let engine = loaded();
    let resolved = json(
        &engine
            .preview_character(ANIMATED, "{}", Some("walk"), 3_000)
            .expect("preview"),
    );
    assert!(resolved.get("pose").is_none());
    assert_eq!(resolved["layers"][0]["offset"], serde_json::json!([0, 0]));
}

/// A hierarchy that loops is refused at the door, like any other content
/// the renderer could not make sense of.
#[test]
fn a_character_whose_hierarchy_loops_is_refused() {
    let mut engine = loaded();
    let error = engine
        .load_character(
            r#"{ "id": "loop", "schemaVersion": 2, "layers": [
                { "id": "a", "parent": "b", "variants": [ { "id": "v", "rect": [0,0,8,8],
                  "sprite": { "asset": "a.png" } } ] },
                { "id": "b", "parent": "a", "variants": [ { "id": "v", "rect": [0,0,8,8],
                  "sprite": { "asset": "b.png" } } ] } ] }"#,
        )
        .unwrap_err();

    assert_eq!(code(&error), "invalidContent");
    assert!(error.contains("character.circularHierarchy"), "{error}");
}

/// A track pointed at a node that is not there is refused too — an
/// animation that drives nothing is a rename nobody finished.
#[test]
fn a_character_whose_track_names_no_layer_is_refused() {
    let mut engine = loaded();
    let error = engine
        .load_character(
            r#"{ "id": "stray", "schemaVersion": 2, "layers": [
                { "id": "body", "variants": [ { "id": "v", "rect": [0,0,8,8],
                  "sprite": { "asset": "a.png" } } ] } ],
                "animations": [ { "id": "idle", "frames": 2, "tracks": [
                  { "node": "tail", "keyframes": [ { "frame": 0, "offset": [0, 1] } ] } ] } ] }"#,
        )
        .unwrap_err();

    assert_eq!(code(&error), "invalidContent");
    assert!(error.contains("character.unknownTrackNode"), "{error}");
}

#[test]
fn a_character_the_renderer_could_not_draw_is_refused() {
    let mut engine = loaded();
    let error = engine
        .load_character(
            r##"{ "id": "broken", "schemaVersion": 1,
                  "layers": [{ "id": "hair", "variants": [
                    { "id": "default", "rect": [0, 0, 24, 30],
                      "sprite": { "asset": "assets/characters/hair.png",
                                  "tint": { "parameter": "hairColor" } } }
                  ] }] }"##,
        )
        .unwrap_err();

    assert_eq!(code(&error), "invalidContent");
    assert!(error.contains("character.unknownTintParameter"), "{error}");
    assert_eq!(
        code(&engine.character("broken").unwrap_err()),
        "unknownContent"
    );
    assert_eq!(
        code(
            &engine
                .resolve_character("broken", "{}", None, 0)
                .unwrap_err()
        ),
        "unknownContent"
    );
}

#[test]
fn a_project_naming_a_character_that_is_not_loaded_does_not_load() {
    let mut engine = loaded();
    let manifest = r#"{
        "id": "p", "schemaVersion": 1, "startWorld": "w",
        "tileSets": [{ "id": "t", "path": "tilesets/t.json" }],
        "worlds": [{ "id": "w", "path": "worlds/w.json" }],
        "characters": [{ "id": "human_player", "path": "characters/human_player.json" }]
    }"#;

    let error = engine.load_project(manifest).unwrap_err();
    assert!(error.contains("project.unloadedCharacter"), "{error}");

    engine.load_character(CHARACTER).expect("character loads");
    assert!(engine.load_project(manifest).is_ok());

    let summary = json(&engine.content_summary().expect("summary"));
    assert_eq!(summary["characters"], serde_json::json!(["human_player"]));
}

#[test]
fn a_key_empty_in_every_language_is_still_that_language_s_own() {
    let mut engine = loaded();
    engine
        .load_locale("en", "menu", r#"{ "play": "Play", "credits": "" }"#)
        .expect("english loads");
    engine
        .load_locale("fr", "menu", r#"{ "play": "Jouer", "credits": "" }"#)
        .expect("french loads");
    engine.load_project(LOCALISED_PROJECT).expect("project");

    // Created by an editor and not written yet: nobody answered it, so it
    // is not a fallback and the language editor still lists it.
    let fr = json(&engine.locale("fr").expect("french bundle"));
    assert_eq!(fr["entries"]["menu.credits"], "");
    assert_eq!(fr["fallbacks"].as_array().expect("fallbacks").len(), 0);
}

#[test]
fn resetting_the_languages_keeps_the_rest_of_the_content() {
    let mut engine = loaded();
    engine
        .load_locale("en", "menu", r#"{ "play": "Play" }"#)
        .expect("english loads");

    engine.reset_locales();
    // The edited file goes back in where a second load would have been
    // refused as a duplicate key.
    engine
        .load_locale("en", "menu", r#"{ "play": "Start", "quit": "Quit" }"#)
        .expect("edited english loads");

    let en = json(&engine.locale("en").expect("english bundle"));
    assert_eq!(en["entries"]["menu.play"], "Start");
    assert_eq!(en["entries"]["menu.quit"], "Quit");
    // The worlds the registry held are untouched.
    let summary = json(&engine.content_summary().expect("summary"));
    assert_eq!(summary["worlds"][0]["id"], "w");
}

#[test]
fn an_empty_translation_is_a_gap_the_default_language_fills() {
    let mut engine = loaded();
    engine
        .load_locale("en", "menu", r#"{ "play": "Play", "quit": "Quit" }"#)
        .expect("english loads");
    engine
        .load_locale("fr", "menu", r#"{ "play": "Jouer", "quit": "" }"#)
        .expect("french loads");
    engine.load_project(LOCALISED_PROJECT).expect("project");

    let fr = json(&engine.locale("fr").expect("french bundle"));
    assert_eq!(fr["entries"]["menu.quit"], "Quit");
    // Created but unwritten, so the editor shows the cell as empty.
    assert_eq!(fr["fallbacks"][0], "menu.quit");
}

#[test]
fn resetting_content_forgets_the_languages_too() {
    let mut engine = loaded();
    engine
        .load_locale("en", "menu", r#"{ "play": "Play" }"#)
        .expect("english loads");
    engine.reset_content();

    assert_eq!(code(&engine.locale("en").unwrap_err()), "unknownContent");
}
