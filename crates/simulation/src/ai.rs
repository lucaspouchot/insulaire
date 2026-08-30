//! Engine-driven entity behaviour.
//!
//! # The chase rule
//!
//! [`Behavior::ChasePlayer`](insulaire_world::Behavior::ChasePlayer) is intentionally
//! the simplest thing that produces visible, reproducible pressure on the
//! player. Once per tick, each chaser:
//!
//! 1. reads the player's current hex;
//! 2. walks its six neighbours in
//!    [canonical direction order](insulaire_world::DIRECTIONS) — E, NE, NW, W, SW, SE;
//! 3. keeps a neighbour only if it is inside the map, passable, free of other
//!    blocking entities, and **strictly closer** to the player than the chaser's
//!    current hex;
//! 4. steps onto the **first** such neighbour.
//!
//! Because step 4 takes the first match in a fixed order, ties are broken by the
//! lowest direction index. Nothing here consumes randomness: given the same
//! state, a chaser always makes the same move.
//!
//! A step can only ever reduce hex distance by one, so every candidate that
//! survives step 3 is equally good — the tie-break is a genuine free choice, not
//! an approximation.
//!
//! If no neighbour qualifies (a wall, or the player standing right next to the
//! chaser, whose hex is blocked) the chaser holds its position and the tick
//! records a [`SimEvent::EntityHeld`].
//!
//! # Deliberately not implemented
//!
//! No pathfinding: a chaser walks into dead ends and waits there. Adding A* is a
//! later, isolated change to this module — see `docs/adr/ADR-0010-engine-api.md`
//! for why the rule lives behind the engine facade rather than in Angular.

use insulaire_world::Hex;

use crate::entity::{EntityId, EntityRuntime};
use crate::event::SimEvent;
use crate::state::GameState;

/// Returns the hex a chaser at `from` should step onto, or `None` when it should
/// hold.
///
/// Exposed separately from [`step_chaser`] so the rule can be unit-tested
/// without mutating a game.
#[must_use]
pub fn chase_step(state: &GameState, actor: EntityId, from: Hex, target: Hex) -> Option<Hex> {
    let current_distance = from.distance(target);
    if current_distance == 0 {
        return None;
    }

    from.neighbors().into_iter().find(|candidate| {
        candidate.distance(target) < current_distance
            && state.grid().is_passable(*candidate)
            && !state.is_blocked(*candidate, Some(actor))
    })
}

/// Applies one chase step to `actor`, recording what happened in `events`.
pub(crate) fn step_chaser(state: &mut GameState, actor: EntityId, events: &mut Vec<SimEvent>) {
    let Some(target) = state.player_position() else {
        return;
    };
    let Some(entity) = state.entities().get(actor) else {
        return;
    };
    let from = entity.position();
    let content_id = entity.content_id().to_owned();

    match chase_step(state, actor, from, target) {
        Some(destination) => {
            state.entities_mut().move_to(actor, destination);
            events.push(SimEvent::EntityMoved {
                entity: actor.raw(),
                content_id,
                from: from.to_offset(),
                to: destination.to_offset(),
            });
        }
        None => events.push(SimEvent::EntityHeld {
            entity: actor.raw(),
            content_id,
            at: from.to_offset(),
        }),
    }
}

/// The chasers that will act this tick, in the order they will act.
///
/// Order is drawn from the game's RNG, which is the MVP's one gameplay use of
/// randomness: with several monsters, who moves first decides who gets the good
/// hex. With a single monster the shuffle consumes no randomness at all.
pub(crate) fn roll_initiative(state: &mut GameState) -> Vec<EntityId> {
    let mut actors = state
        .entities()
        .with_behavior(insulaire_world::Behavior::ChasePlayer);
    state.rng_mut().shuffle(&mut actors);
    actors
}

/// Convenience accessor used by tests and by the engine facade.
#[must_use]
pub fn chaser_positions(state: &GameState) -> Vec<(String, Hex)> {
    state
        .monsters()
        .map(|entity| (entity.content_id().to_owned(), entity.position()))
        .collect()
}

/// Returns the chaser closest to the player, if any.
#[must_use]
pub fn nearest_chaser(state: &GameState) -> Option<&EntityRuntime> {
    let player = state.player_position()?;
    state
        .monsters()
        .min_by_key(|entity| entity.position().distance(player))
}

#[cfg(test)]
mod tests {
    use super::*;
    use insulaire_world::{testing, OffsetCoord, TemplateRegistry, WorldDefinition};

    use crate::action::Action;
    use crate::tick;

    fn game(world: &WorldDefinition, seed: u64) -> GameState {
        GameState::create(
            world,
            &testing::sample_tile_set(),
            &TemplateRegistry::builtin(),
            seed,
        )
        .expect("valid world")
    }

    fn hex(col: i32, row: i32) -> Hex {
        Hex::from_offset(OffsetCoord::new(col, row))
    }

    fn monster_at(state: &GameState) -> Hex {
        state.monsters().next().expect("monster").position()
    }

    #[test]
    fn a_chaser_steps_strictly_closer_to_the_player() {
        let state = game(&testing::sample_world(), 1);
        let player = state.player_position().expect("player");
        let monster = state.monsters().next().expect("monster");
        let before = monster.position().distance(player);

        let step =
            chase_step(&state, monster.id(), monster.position(), player).expect("a move exists");
        assert_eq!(step.distance(player), before - 1);
    }

    #[test]
    fn ties_are_broken_by_the_lowest_direction_index() {
        // Player due East of the monster at distance 2: NE and SE both close the
        // gap as well as E does, but E has the lowest canonical index.
        let mut world = testing::sample_world();
        world.entities[0].at = OffsetCoord::new(6, 4);
        world.entities[1].at = OffsetCoord::new(4, 4);
        world.tiles.clear(); // remove the water cell from the sample world
        let state = game(&world, 1);

        let monster = state.monsters().next().expect("monster");
        let step = chase_step(
            &state,
            monster.id(),
            monster.position(),
            state.player_position().expect("player"),
        )
        .expect("a move exists");
        assert_eq!(
            step,
            monster.position().neighbors()[0],
            "East must win the tie"
        );
        assert_eq!(step, hex(5, 4));
    }

    #[test]
    fn a_chaser_never_enters_impassable_terrain() {
        let world = testing::walled_world();
        let mut state = game(&world, 1);
        let wall_column = 3;

        for _ in 0..12 {
            tick::apply(&mut state, Action::Wait);
            let at = monster_at(&state).to_offset();
            assert_ne!(at.col, wall_column, "the chaser walked into the water wall");
        }
    }

    #[test]
    fn a_blocked_chaser_holds_its_position_and_says_so() {
        let world = testing::walled_world();
        let mut state = game(&world, 1);

        // Run until the chaser is pinned against the wall.
        for _ in 0..12 {
            tick::apply(&mut state, Action::Wait);
        }
        let pinned_at = monster_at(&state);

        let outcome = tick::apply(&mut state, Action::Wait);
        assert_eq!(monster_at(&state), pinned_at);
        assert!(outcome
            .events
            .iter()
            .any(|event| matches!(event, SimEvent::EntityHeld { .. })));
    }

    #[test]
    fn a_chaser_stops_next_to_the_player_instead_of_stepping_onto_it() {
        let mut state = game(&testing::sample_world(), 1);
        for _ in 0..20 {
            tick::apply(&mut state, Action::Wait);
        }

        let player = state.player_position().expect("player");
        assert_eq!(
            monster_at(&state).distance(player),
            1,
            "the chaser should close in and then stall adjacent to the player"
        );
    }

    #[test]
    fn chasing_is_reproducible_for_a_given_seed() {
        let world = testing::sample_world();
        let script = [
            Action::MoveTo(hex(3, 2)),
            Action::Wait,
            Action::MoveTo(hex(3, 3)),
            Action::Wait,
        ];

        let replay = |seed: u64| {
            let mut state = game(&world, seed);
            for action in script {
                tick::apply(&mut state, action);
            }
            chaser_positions(&state)
        };

        assert_eq!(replay(1234), replay(1234));
    }

    #[test]
    fn nearest_chaser_picks_the_closest_monster() {
        let mut world = testing::sample_world();
        let mut far = world.entities[1].clone();
        far.id = "monster_2".into();
        far.at = OffsetCoord::new(9, 9);
        world.entities.push(far);

        let state = game(&world, 1);
        assert_eq!(
            nearest_chaser(&state).map(EntityRuntime::content_id),
            Some("monster_1")
        );
    }
}
