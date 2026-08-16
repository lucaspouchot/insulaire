//! Movement rules.
//!
//! Every "can the player do this?" question in the whole stack routes through
//! [`validate`]. The UI never re-implements adjacency or passability checks: it
//! asks the engine for [`legal_moves`] and highlights what comes back.

use hex_world::Hex;

use crate::action::{Action, ActionError};
use crate::entity::EntityRuntime;
use crate::state::GameState;

/// Checks whether `action` may be applied to `state`.
///
/// # Errors
///
/// Returns the specific [`ActionError`] describing why the action is refused.
pub fn validate(state: &GameState, action: Action) -> Result<(), ActionError> {
    let player = state.player().ok_or(ActionError::NoPlayer)?;
    match action {
        Action::Wait => Ok(()),
        Action::MoveTo(target) => validate_move(state, player, target),
    }
}

fn validate_move(
    state: &GameState,
    player: &EntityRuntime,
    target: Hex,
) -> Result<(), ActionError> {
    let from = player.position();

    if target == from {
        return Err(ActionError::SameHex);
    }
    if !state.grid().contains(target) {
        return Err(ActionError::OutOfBounds {
            at: target.to_offset(),
        });
    }

    let distance = from.distance(target);
    if distance != 1 {
        return Err(ActionError::NotAdjacent {
            at: target.to_offset(),
            distance,
        });
    }
    if !state.grid().is_passable(target) {
        return Err(ActionError::Impassable {
            at: target.to_offset(),
        });
    }
    if state.is_blocked(target, Some(player.id())) {
        return Err(ActionError::Occupied {
            at: target.to_offset(),
        });
    }

    Ok(())
}

/// The hexes the player may move to right now, in canonical direction order.
///
/// Built by running [`validate`] over the six neighbours, so it can never
/// disagree with what an actual command would do.
#[must_use]
pub fn legal_moves(state: &GameState) -> Vec<Hex> {
    let Some(player) = state.player() else {
        return Vec::new();
    };
    player
        .position()
        .neighbors()
        .into_iter()
        .filter(|target| validate(state, Action::MoveTo(*target)).is_ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use hex_world::{testing, OffsetCoord, TemplateRegistry, TileSetDefinition, WorldDefinition};

    use crate::state::GameState;

    fn game(world: WorldDefinition, tile_set: TileSetDefinition) -> GameState {
        GameState::create(&world, &tile_set, &TemplateRegistry::builtin(), 1).expect("valid world")
    }

    fn sample() -> GameState {
        game(testing::sample_world(), testing::sample_tile_set())
    }

    fn hex(col: i32, row: i32) -> Hex {
        Hex::from_offset(OffsetCoord::new(col, row))
    }

    #[test]
    fn an_adjacent_passable_free_hex_is_a_legal_move() {
        let state = sample();
        let target = state.player_position().expect("player").neighbors()[0];
        assert_eq!(validate(&state, Action::MoveTo(target)), Ok(()));
    }

    #[test]
    fn waiting_is_always_legal_when_a_player_exists() {
        assert_eq!(validate(&sample(), Action::Wait), Ok(()));
    }

    #[test]
    fn distant_hexes_are_refused() {
        let state = sample();
        let far = hex(9, 9);
        assert!(matches!(
            validate(&state, Action::MoveTo(far)),
            Err(ActionError::NotAdjacent { .. })
        ));
    }

    #[test]
    fn the_players_own_hex_is_refused() {
        let state = sample();
        let here = state.player_position().expect("player");
        assert_eq!(
            validate(&state, Action::MoveTo(here)),
            Err(ActionError::SameHex)
        );
    }

    #[test]
    fn hexes_outside_the_map_are_refused() {
        // Put the player in the top-left corner so that some neighbours are off-map.
        let mut world = testing::sample_world();
        world.entities[0].at = OffsetCoord::new(0, 0);
        let state = game(world, testing::sample_tile_set());

        let outside = hex(0, 0).neighbors()[3]; // West of column 0
        assert!(matches!(
            validate(&state, Action::MoveTo(outside)),
            Err(ActionError::OutOfBounds { .. })
        ));
    }

    #[test]
    fn impassable_tiles_are_refused() {
        let mut world = testing::sample_world();
        // Stand the player right next to the water cell.
        world.entities[0].at = OffsetCoord::new(4, 5);
        let state = game(world, testing::sample_tile_set());

        let water = Hex::from_offset(testing::WATER_CELL);
        assert!(state.player_position().expect("player").is_adjacent(water));
        assert!(matches!(
            validate(&state, Action::MoveTo(water)),
            Err(ActionError::Impassable { .. })
        ));
    }

    #[test]
    fn hexes_held_by_a_blocking_entity_are_refused() {
        let mut world = testing::sample_world();
        world.entities[0].at = OffsetCoord::new(2, 2);
        world.entities[1].at = OffsetCoord::new(3, 2);
        let state = game(world, testing::sample_tile_set());

        let monster_hex = state.monsters().next().expect("monster").position();
        assert!(matches!(
            validate(&state, Action::MoveTo(monster_hex)),
            Err(ActionError::Occupied { .. })
        ));
    }

    #[test]
    fn legal_moves_agree_with_validate_on_every_neighbour() {
        let mut world = testing::sample_world();
        world.entities[0].at = OffsetCoord::new(4, 5); // next to water
        let state = game(world, testing::sample_tile_set());

        let legal = legal_moves(&state);
        let player = state.player_position().expect("player");
        for neighbour in player.neighbors() {
            let allowed = validate(&state, Action::MoveTo(neighbour)).is_ok();
            assert_eq!(
                legal.contains(&neighbour),
                allowed,
                "disagreement on {neighbour}"
            );
        }
        assert!(!legal.contains(&Hex::from_offset(testing::WATER_CELL)));
    }

    #[test]
    fn a_corner_position_has_fewer_legal_moves_than_an_open_one() {
        // In an odd-r layout the top-left corner keeps only its East and
        // South-East neighbours; the other four fall off the map.
        let mut cornered = testing::sample_world();
        cornered.entities[0].at = OffsetCoord::new(0, 0);
        let cornered = game(cornered, testing::sample_tile_set());
        assert_eq!(
            legal_moves(&cornered),
            vec![hex(1, 0), hex(0, 1)],
            "corner moves must be listed in canonical direction order"
        );

        let open = sample();
        assert_eq!(legal_moves(&open).len(), 6);
    }
}
