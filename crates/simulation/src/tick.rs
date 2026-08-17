//! The tick pipeline.
//!
//! One accepted player action == one tick. The resolution order is fixed by
//! `docs/adr/ADR-0004-tick-simulation.md` and implemented literally in
//! [`apply`], phase by phase, including the phases the MVP leaves empty. The
//! empty phases are kept as named, commented steps on purpose: they are where
//! the scenario runtime and the trigger system will plug in, and their position
//! in the order is the decision, not their contents.

use insulaire_world::{Hex, OffsetCoord};

use crate::action::{Action, ActionError, Rejection};
use crate::ai;
use crate::event::SimEvent;
use crate::rules;
use crate::state::GameState;

/// A map link the player stepped on during this tick.
///
/// The simulation cannot follow it: the target world lives in the host's
/// content registry, which this crate has no access to by design
/// (`docs/adr/ADR-0017-map-links.md`). The tick therefore *reports* the
/// transition and the host resolves it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingTransition {
    /// Authored id of the link that fired.
    pub link_id: String,
    /// Id of the world to enter.
    pub target_world: String,
    /// Where the player arrives in that world.
    pub target_at: OffsetCoord,
}

/// What resolving an action produced.
#[derive(Debug, Clone, PartialEq)]
pub struct ActionOutcome {
    /// `true` when the action was applied and the tick advanced.
    pub accepted: bool,
    /// Present only when `accepted` is `false`.
    pub rejection: Option<ActionError>,
    /// Ordered, observable state changes.
    pub events: Vec<SimEvent>,
    /// A map change the host must carry out once the tick is complete.
    pub transition: Option<PendingTransition>,
}

impl ActionOutcome {
    fn rejected(reason: ActionError) -> Self {
        Self {
            accepted: false,
            rejection: Some(reason),
            events: vec![SimEvent::ActionRejected {
                reason: Rejection::from(reason),
            }],
            transition: None,
        }
    }
}

/// Resolves one player action against `state`.
///
/// A rejected action is a no-op: the tick counter, every entity position and the
/// RNG are all left exactly as they were.
pub fn apply(state: &mut GameState, action: Action) -> ActionOutcome {
    // Phase 1 — validate.
    if let Err(reason) = rules::validate(state, action) {
        return ActionOutcome::rejected(reason);
    }

    let mut events = Vec::new();

    // Phase 2 — apply the player action.
    let entered = apply_player_action(state, action, &mut events);

    // Phase 3 — resolve immediate effects.
    // The only one the MVP has: entering a hex that carries a map link.
    let transition = entered.and_then(|hex| triggered_link(state, hex, &mut events));

    // Phase 4 — advance world systems.
    state.advance_tick();
    events.push(SimEvent::TickAdvanced { tick: state.tick() });
    run_actors(state, &mut events);

    // Phase 5 — advance the scenario.
    // Empty until the data-driven scenario runtime lands (ADR-0005).

    // Phase 6 — resolve triggers and events.
    // Empty for the same reason.

    // Phase 7 — the collected events *are* the observable state changes.
    ActionOutcome {
        accepted: true,
        rejection: None,
        events,
        transition,
    }
}

/// Reports the link on the hex the player just entered, if any.
///
/// The tick is *not* cut short when one fires: phases 4 to 6 still run on the
/// map being left, so the pipeline's order stays the same whether or not a link
/// is involved (ADR-0004). The host applies the map change afterwards.
fn triggered_link(
    state: &GameState,
    entered: Hex,
    events: &mut Vec<SimEvent>,
) -> Option<PendingTransition> {
    let link = state.link_entered_at(entered)?;

    events.push(SimEvent::LinkTriggered {
        link: link.id.clone(),
        to_world: link.target_world.clone(),
        to: link.target_at,
    });

    Some(PendingTransition {
        link_id: link.id.clone(),
        target_world: link.target_world.clone(),
        target_at: link.target_at,
    })
}

/// Applies the player's action, returning the hex it moved the player *into*.
///
/// The return value is what phase 3 keys off: a link fires when the player
/// enters its cell, not while standing on it, so arriving next to a door — or
/// waiting on one — cannot bounce the session between two maps.
fn apply_player_action(
    state: &mut GameState,
    action: Action,
    events: &mut Vec<SimEvent>,
) -> Option<Hex> {
    let Action::MoveTo(destination) = action else {
        return None; // `Wait` spends the tick without touching the map.
    };
    let player = state.player()?; // Unreachable: validation already required one.

    let id = player.id();
    let content_id = player.content_id().to_owned();
    let from = state.entities_mut().move_to(id, destination)?;
    events.push(SimEvent::EntityMoved {
        entity: id.raw(),
        content_id,
        from: from.to_offset(),
        to: destination.to_offset(),
    });
    Some(destination)
}

/// Runs every engine-driven entity once, in initiative order.
fn run_actors(state: &mut GameState, events: &mut Vec<SimEvent>) {
    for actor in ai::roll_initiative(state) {
        ai::step_chaser(state, actor, events);
    }
}

#[cfg(test)]
mod tests {
    use insulaire_world::{testing, Hex, OffsetCoord, TemplateRegistry, WorldDefinition};

    use super::*;
    use crate::rules::legal_moves;

    fn game(world: &WorldDefinition, seed: u64) -> GameState {
        GameState::create(
            world,
            &testing::sample_tile_set(),
            &TemplateRegistry::builtin(),
            seed,
        )
        .expect("valid world")
    }

    fn sample() -> GameState {
        game(&testing::sample_world(), 1)
    }

    fn hex(col: i32, row: i32) -> Hex {
        Hex::from_offset(OffsetCoord::new(col, row))
    }

    fn monster_at(state: &GameState) -> Hex {
        state.monsters().next().expect("monster").position()
    }

    #[test]
    fn a_valid_move_advances_the_tick_and_moves_the_player() {
        let mut state = sample();
        let target = legal_moves(&state)[0];

        let outcome = apply(&mut state, Action::MoveTo(target));

        assert!(outcome.accepted);
        assert_eq!(outcome.rejection, None);
        assert_eq!(state.tick(), 1);
        assert_eq!(state.player_position(), Some(target));
    }

    #[test]
    fn stepping_on_a_link_reports_a_transition_without_following_it() {
        // The simulation names the target; only the host can reach it.
        let mut state = game(&testing::linked_world(), 1);
        let door = Hex::from_offset(testing::DOOR_CELL);

        let outcome = apply(&mut state, Action::MoveTo(door));

        assert!(outcome.accepted);
        assert_eq!(
            outcome.transition,
            Some(PendingTransition {
                link_id: "door_house".to_owned(),
                target_world: "interior_world".to_owned(),
                target_at: testing::INTERIOR_ARRIVAL,
            })
        );
        assert!(outcome.events.iter().any(|event| matches!(
            event,
            SimEvent::LinkTriggered { link, .. } if link == "door_house"
        )));
        assert_eq!(
            state.world_id(),
            "linked_world",
            "the tick must not change the map by itself"
        );
    }

    #[test]
    fn a_move_that_misses_the_link_reports_nothing() {
        let mut state = game(&testing::linked_world(), 1);
        let elsewhere = legal_moves(&state)
            .into_iter()
            .find(|hex| hex.to_offset() != testing::DOOR_CELL)
            .expect("another legal move");

        let outcome = apply(&mut state, Action::MoveTo(elsewhere));

        assert!(outcome.accepted);
        assert_eq!(outcome.transition, None);
    }

    #[test]
    fn standing_on_a_link_does_not_retrigger_it() {
        // A link fires on entry. Arriving on a door — which is exactly what the
        // door on the other side sends you to — must not bounce the session.
        let mut state = game(&testing::linked_world(), 1);
        let door = Hex::from_offset(testing::DOOR_CELL);
        apply(&mut state, Action::MoveTo(door));

        let outcome = apply(&mut state, Action::Wait);

        assert!(outcome.accepted);
        assert_eq!(outcome.transition, None);
    }

    #[test]
    fn a_rejected_move_onto_a_link_triggers_nothing() {
        let mut state = game(&testing::linked_world(), 1);
        // Two hexes away: the move is refused, so phase 3 never runs.
        let outcome = apply(&mut state, Action::MoveTo(hex(9, 9)));
        assert!(!outcome.accepted);
        assert_eq!(outcome.transition, None);
    }

    #[test]
    fn an_invalid_move_advances_nothing_at_all() {
        let mut state = sample();
        let before_player = state.player_position();
        let before_monster = monster_at(&state);
        let before_rng = state.rng().clone();

        let outcome = apply(&mut state, Action::MoveTo(hex(9, 9)));

        assert!(!outcome.accepted);
        assert!(matches!(
            outcome.rejection,
            Some(ActionError::NotAdjacent { .. })
        ));
        assert_eq!(state.tick(), 0, "a rejected action must not consume a tick");
        assert_eq!(state.player_position(), before_player);
        assert_eq!(
            monster_at(&state),
            before_monster,
            "monsters must not act on a rejection"
        );
        assert_eq!(
            state.rng(),
            &before_rng,
            "a rejection must not consume randomness"
        );
        assert!(matches!(
            outcome.events.as_slice(),
            [SimEvent::ActionRejected { .. }]
        ));
    }

    #[test]
    fn every_rejection_reason_leaves_the_tick_alone() {
        let mut world = testing::sample_world();
        world.entities[0].at = OffsetCoord::new(4, 5); // adjacent to water
        world.entities[1].at = OffsetCoord::new(5, 5); // adjacent to the player
        let mut state = game(&world, 1);
        let player = state.player_position().expect("player");

        let refused = [
            Action::MoveTo(player),                                // SameHex
            Action::MoveTo(hex(0, 0)),                             // NotAdjacent
            Action::MoveTo(Hex::from_offset(testing::WATER_CELL)), // Impassable
            Action::MoveTo(monster_at(&state)),                    // Occupied
        ];

        for action in refused {
            let outcome = apply(&mut state, action);
            assert!(!outcome.accepted, "{action:?} should have been refused");
            assert_eq!(state.tick(), 0);
        }
    }

    #[test]
    fn waiting_costs_a_tick_and_still_lets_monsters_act() {
        let mut state = sample();
        let before = monster_at(&state);

        let outcome = apply(&mut state, Action::Wait);

        assert!(outcome.accepted);
        assert_eq!(state.tick(), 1);
        assert_ne!(monster_at(&state), before);
    }

    #[test]
    fn the_monster_closes_in_after_each_tick() {
        let mut state = sample();
        let player = state.player_position().expect("player");
        let mut distance = monster_at(&state).distance(player);

        for _ in 0..3 {
            apply(&mut state, Action::Wait);
            let now = monster_at(&state).distance(player);
            assert_eq!(now, distance - 1, "the chaser should gain one hex per tick");
            distance = now;
        }
    }

    #[test]
    fn events_are_emitted_in_causal_order() {
        let mut state = sample();
        let target = legal_moves(&state)[0];

        let outcome = apply(&mut state, Action::MoveTo(target));

        assert!(
            matches!(outcome.events[0], SimEvent::EntityMoved { .. }),
            "player first"
        );
        assert!(
            matches!(outcome.events[1], SimEvent::TickAdvanced { tick: 1 }),
            "then the clock"
        );
        assert!(
            matches!(
                outcome.events[2],
                SimEvent::EntityMoved { .. } | SimEvent::EntityHeld { .. }
            ),
            "then the monsters"
        );
    }

    #[test]
    fn identical_seeds_and_inputs_produce_identical_worlds() {
        let world = testing::sample_world();
        let script = [
            Action::MoveTo(hex(3, 2)),
            Action::MoveTo(hex(3, 3)),
            Action::Wait,
            Action::MoveTo(hex(9, 9)), // rejected, must not desynchronise the replay
            Action::MoveTo(hex(2, 3)),
        ];

        let run = |seed: u64| {
            let mut state = game(&world, seed);
            let outcomes: Vec<bool> = script
                .iter()
                .map(|a| apply(&mut state, *a).accepted)
                .collect();
            (
                outcomes,
                state.tick(),
                state.player_position(),
                ai::chaser_positions(&state),
                state.rng().clone(),
            )
        };

        assert_eq!(run(4242), run(4242));
        assert_eq!(
            run(4242).1,
            4,
            "four of the five scripted actions are legal"
        );
    }

    #[test]
    fn several_monsters_act_in_a_seed_dependent_order() {
        // Two chasers competing for the same approach hex: which one gets it
        // depends on initiative, which is drawn from the RNG.
        let mut world = testing::sample_world();
        world.tiles.clear();
        world.entities[0].at = OffsetCoord::new(5, 5);
        world.entities[1].at = OffsetCoord::new(5, 3);
        let mut second = world.entities[1].clone();
        second.id = "monster_2".into();
        second.at = OffsetCoord::new(6, 3);
        world.entities.push(second);

        let outcome_for = |seed: u64| {
            let mut state = game(&world, seed);
            apply(&mut state, Action::Wait);
            (ai::chaser_positions(&state), state.rng().draws())
        };

        let (_, draws) = outcome_for(1);
        assert!(
            draws > 0,
            "initiative among several monsters must consume randomness"
        );
        assert_eq!(outcome_for(1).0, outcome_for(1).0, "same seed, same result");
    }
}
