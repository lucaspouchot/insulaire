//! The mutable runtime state of a play session.
//!
//! [`GameState`] deliberately holds the authored world behind an [`Arc`]: the
//! [`WorldGrid`] is immutable reference data shared with the engine, while
//! everything that changes during play lives in this struct
//! (see `docs/data-model.md`).

use std::sync::Arc;

use insulaire_world::{
    validate_world, EntityKind, GridError, Hex, MapLinkDefinition, TemplateRegistry,
    TileSetDefinition, ValidationReport, WorldDefinition, WorldGrid,
};
use thiserror::Error;

use crate::entity::{EntityId, EntityRuntime, EntityStore};
use crate::rng::Rng;

/// Why a game could not be created.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum GameSetupError {
    /// The world failed content validation.
    #[error("world `{world_id}` is invalid: {summary}")]
    InvalidWorld {
        /// Id of the offending world.
        world_id: String,
        /// One-line summary of the errors.
        summary: String,
        /// Full report, for the editor's issue list.
        report: Box<ValidationReport>,
    },
    /// The world passed validation but could not be flattened.
    #[error("world `{world_id}` could not be prepared: {source}")]
    Grid {
        /// Id of the offending world.
        world_id: String,
        /// Underlying failure.
        #[source]
        source: GridError,
    },
}

/// Everything that changes while a game is played.
#[derive(Debug, Clone)]
pub struct GameState {
    tick: u64,
    world_id: String,
    seed: u64,
    /// Immutable authored reference data.
    grid: Arc<WorldGrid>,
    /// The current map's links, copied from the authored world.
    ///
    /// Held here rather than in [`WorldGrid`] because a link is a rule input,
    /// not a rendering input: the grid crosses to JavaScript as packed buffers,
    /// while links are read only by the tick pipeline.
    links: Vec<MapLinkDefinition>,
    entities: EntityStore,
    rng: Rng,
}

impl GameState {
    /// Creates a game from an authored world.
    ///
    /// The world is validated first, so a `GameState` can only exist for content
    /// the engine fully understands.
    ///
    /// # Errors
    ///
    /// Returns [`GameSetupError::InvalidWorld`] when validation reports errors,
    /// or [`GameSetupError::Grid`] when flattening fails.
    pub fn create(
        world: &WorldDefinition,
        tile_set: &TileSetDefinition,
        templates: &TemplateRegistry,
        seed: u64,
    ) -> Result<Self, GameSetupError> {
        let report = validate_world(world, Some(tile_set), templates);
        if !report.valid {
            return Err(GameSetupError::InvalidWorld {
                world_id: world.id.clone(),
                summary: report.summary(),
                report: Box::new(report),
            });
        }

        let grid = WorldGrid::build(world, tile_set).map_err(|source| GameSetupError::Grid {
            world_id: world.id.clone(),
            source,
        })?;

        let mut entities = EntityStore::default();
        for definition in &world.entities {
            // Validation already proved every template exists.
            if let Some(template) = templates.get(&definition.template_id) {
                entities.spawn(definition, template);
            }
        }

        Ok(Self {
            tick: 0,
            world_id: world.id.clone(),
            seed,
            grid: Arc::new(grid),
            links: world.links.clone(),
            entities,
            rng: Rng::from_seed(seed),
        })
    }

    /// Moves the session onto another authored map.
    ///
    /// This is the whole of "changing map" as far as the simulation is
    /// concerned: the new world is instantiated exactly as
    /// [`create`](Self::create) would, then the *session* values that must
    /// survive a map change are carried across — the tick counter, the RNG
    /// stream and the player's position, which becomes `arrival`.
    ///
    /// The player entity itself is the one the target map authors, so every map
    /// stays independently playable and a link needs no knowledge of the
    /// traveller (`docs/adr/ADR-0017-map-links.md`). When the player gains
    /// runtime state of its own — health, inventory — this method is the single
    /// seam that has to carry it.
    ///
    /// # Errors
    ///
    /// The same failures as [`create`](Self::create): the target world must be
    /// valid and flattenable. The current state is left untouched when it is not.
    pub fn enter_world(
        &mut self,
        world: &WorldDefinition,
        tile_set: &TileSetDefinition,
        templates: &TemplateRegistry,
        arrival: Hex,
    ) -> Result<(), GameSetupError> {
        let mut next = Self::create(world, tile_set, templates, self.seed)?;
        next.tick = self.tick;
        next.rng = self.rng.clone();
        if let Some(player) = next.entities.player() {
            let id = player.id();
            next.entities.move_to(id, arrival);
        }
        *self = next;
        Ok(())
    }

    /// The number of ticks elapsed since the game started.
    #[must_use]
    pub const fn tick(&self) -> u64 {
        self.tick
    }

    /// Id of the authored world being played.
    #[must_use]
    pub fn world_id(&self) -> &str {
        &self.world_id
    }

    /// The seed this game was created with.
    #[must_use]
    pub const fn seed(&self) -> u64 {
        self.seed
    }

    /// The immutable world grid.
    #[must_use]
    pub fn grid(&self) -> &WorldGrid {
        &self.grid
    }

    /// A cheap shared handle to the world grid.
    #[must_use]
    pub fn grid_handle(&self) -> Arc<WorldGrid> {
        Arc::clone(&self.grid)
    }

    /// All runtime entities.
    #[must_use]
    pub const fn entities(&self) -> &EntityStore {
        &self.entities
    }

    /// Mutable access to the entity store; used by the tick pipeline only.
    pub(crate) fn entities_mut(&mut self) -> &mut EntityStore {
        &mut self.entities
    }

    /// The deterministic RNG owned by this game.
    #[must_use]
    pub const fn rng(&self) -> &Rng {
        &self.rng
    }

    /// Mutable RNG access; used by the tick pipeline only.
    pub(crate) fn rng_mut(&mut self) -> &mut Rng {
        &mut self.rng
    }

    /// The player entity, if any.
    #[must_use]
    pub fn player(&self) -> Option<&EntityRuntime> {
        self.entities.player()
    }

    /// The player's current hex, if there is a player.
    #[must_use]
    pub fn player_position(&self) -> Option<Hex> {
        self.player().map(EntityRuntime::position)
    }

    /// Returns `true` when a blocking entity other than `ignored` stands on `hex`.
    #[must_use]
    pub fn is_blocked(&self, hex: Hex, ignored: Option<EntityId>) -> bool {
        self.entities.blocker_at(hex, ignored).is_some()
    }

    /// Advances the tick counter. Called once per accepted action.
    pub(crate) fn advance_tick(&mut self) {
        self.tick += 1;
    }

    /// The map links authored on the current map.
    #[must_use]
    pub fn links(&self) -> &[MapLinkDefinition] {
        &self.links
    }

    /// The link that fires when the player ends a move on `hex`, if any.
    #[must_use]
    pub fn link_entered_at(&self, hex: Hex) -> Option<&MapLinkDefinition> {
        let at = hex.to_offset();
        self.links
            .iter()
            .find(|link| link.at == at && link.trigger == insulaire_world::LinkTrigger::Enter)
    }

    /// Every monster currently on the map.
    pub fn monsters(&self) -> impl Iterator<Item = &EntityRuntime> {
        self.entities
            .all()
            .iter()
            .filter(|entity| entity.kind() == EntityKind::Monster)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use insulaire_world::testing;

    fn state(seed: u64) -> GameState {
        GameState::create(
            &testing::sample_world(),
            &testing::sample_tile_set(),
            &TemplateRegistry::builtin(),
            seed,
        )
        .expect("sample world is valid")
    }

    #[test]
    fn a_new_game_starts_at_tick_zero_with_authored_positions() {
        let state = state(1);
        assert_eq!(state.tick(), 0);
        assert_eq!(state.world_id(), "sample_world");
        assert_eq!(
            state.player_position(),
            Some(Hex::from_offset(testing::PLAYER_START))
        );
        assert_eq!(state.monsters().count(), 1);
        assert_eq!(state.grid().width(), 10);
    }

    #[test]
    fn invalid_worlds_are_refused_with_a_report() {
        let mut world = testing::sample_world();
        world.entities.clear();

        let error = GameState::create(
            &world,
            &testing::sample_tile_set(),
            &TemplateRegistry::builtin(),
            1,
        )
        .expect_err("a world without a player must not start");

        match error {
            GameSetupError::InvalidWorld { report, .. } => {
                assert!(report
                    .issues
                    .iter()
                    .any(|issue| issue.code == "world.missingPlayer"));
            }
            other => panic!("unexpected error: {other}"),
        }
    }

    #[test]
    fn the_seed_determines_the_rng_stream() {
        assert_eq!(state(7).rng(), state(7).rng());
        assert_ne!(state(7).rng(), state(8).rng());
        assert_eq!(state(7).seed(), 7);
    }

    #[test]
    fn blocking_lookup_ignores_the_queried_entity() {
        let state = state(1);
        let player = state.player().expect("player");
        assert!(state.is_blocked(player.position(), None));
        assert!(!state.is_blocked(player.position(), Some(player.id())));
    }

    #[test]
    fn entering_a_world_carries_the_session_and_places_the_player() {
        let mut state = GameState::create(
            &testing::linked_world(),
            &testing::sample_tile_set(),
            &TemplateRegistry::builtin(),
            42,
        )
        .expect("linked world is valid");
        state.advance_tick();
        state.advance_tick();
        let rng_before = state.rng().clone();

        let arrival = Hex::from_offset(testing::INTERIOR_ARRIVAL);
        state
            .enter_world(
                &testing::interior_world(),
                &testing::sample_tile_set(),
                &TemplateRegistry::builtin(),
                arrival,
            )
            .expect("the interior is valid");

        assert_eq!(state.world_id(), "interior_world");
        assert_eq!(state.player_position(), Some(arrival));
        assert_eq!(state.grid().width(), 5, "the new map replaced the old one");
        assert_eq!(state.tick(), 2, "the session clock keeps running");
        assert_eq!(state.rng(), &rng_before, "one RNG stream per session");
        assert_eq!(state.seed(), 42);
        assert_eq!(state.links().len(), 1, "the new map's links are in force");
    }

    #[test]
    fn entering_an_invalid_world_leaves_the_session_untouched() {
        let mut state = state(1);
        let mut broken = testing::interior_world();
        broken.entities.clear();

        let error = state
            .enter_world(
                &broken,
                &testing::sample_tile_set(),
                &TemplateRegistry::builtin(),
                Hex::from_offset(testing::INTERIOR_ARRIVAL),
            )
            .expect_err("a world without a player must not be entered");

        assert!(matches!(error, GameSetupError::InvalidWorld { .. }));
        assert_eq!(state.world_id(), "sample_world");
        assert_eq!(
            state.player_position(),
            Some(Hex::from_offset(testing::PLAYER_START))
        );
    }

    #[test]
    fn the_world_grid_is_shared_rather_than_copied() {
        let state = state(1);
        let handle = state.grid_handle();
        assert!(Arc::ptr_eq(&handle, &state.grid_handle()));
    }
}
