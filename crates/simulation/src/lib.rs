//! Deterministic tick-based simulation for an authored hex world.
//!
//! This crate holds every game rule the MVP has: what a player may do, what a
//! tick consists of, how monsters chase, and where randomness comes from. It
//! knows nothing about JavaScript, the DOM, or rendering, and it is exercised
//! entirely by native `cargo test`.
//!
//! # Example
//!
//! ```
//! # use hex_simulation::{Action, GameState, tick, rules};
//! # use hex_world::{TemplateRegistry, TileSetDefinition, WorldDefinition};
//! # let tile_set: TileSetDefinition = serde_json::from_str(r#"{
//! #   "id": "t", "schemaVersion": 1, "tiles": [
//! #     { "id": "grass", "terrain": "grass", "movementCost": 1,
//! #       "visual": { "visualId": "terrain.grass", "fallbackColor": "green" } }]}"#)?;
//! # let world: WorldDefinition = serde_json::from_str(r#"{
//! #   "id": "w", "schemaVersion": 1, "width": 8, "height": 8,
//! #   "tileSetId": "t", "defaultTile": "grass", "entities": [
//! #     { "id": "p", "templateId": "player", "at": [2, 2] },
//! #     { "id": "m", "templateId": "monster", "at": [6, 2] }]}"#)?;
//! let mut state = GameState::create(&world, &tile_set, &TemplateRegistry::builtin(), 42)?;
//! assert_eq!(state.tick(), 0);
//!
//! let target = rules::legal_moves(&state)[0];
//! let outcome = tick::apply(&mut state, Action::MoveTo(target));
//!
//! assert!(outcome.accepted);
//! assert_eq!(state.tick(), 1);
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```

#![forbid(unsafe_code)]

pub mod action;
pub mod ai;
pub mod entity;
pub mod event;
pub mod rng;
pub mod rules;
pub mod state;
pub mod tick;

pub use action::{Action, ActionError, Rejection};
pub use entity::{EntityId, EntityRuntime, EntityStore};
pub use event::SimEvent;
pub use rng::Rng;
pub use state::{GameSetupError, GameState};
pub use tick::ActionOutcome;
