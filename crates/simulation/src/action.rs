//! Player actions and the reasons they get rejected.

use hex_world::{Hex, OffsetCoord};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Something the player asks the engine to do.
///
/// Actions are the *only* way Angular changes the simulation. Each accepted
/// action costs exactly one tick (see `docs/adr/ADR-0004-tick-simulation.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Step the player onto an adjacent hex.
    MoveTo(Hex),
    /// Spend a tick without moving.
    Wait,
}

/// Why an action was refused.
///
/// A rejected action leaves the world untouched: the tick does not advance and
/// no entity moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum ActionError {
    /// The world defines no player entity.
    #[error("this world has no player entity")]
    NoPlayer,
    /// The target hex is the player's own hex.
    #[error("the player is already on that hex")]
    SameHex,
    /// The target hex lies outside the map.
    #[error("hex {at} is outside the map")]
    OutOfBounds {
        /// Offending position.
        at: OffsetCoord,
    },
    /// The target hex is further than one step away.
    #[error("hex {at} is {distance} steps away; only adjacent hexes can be entered")]
    NotAdjacent {
        /// Offending position.
        at: OffsetCoord,
        /// Measured hex distance.
        distance: u32,
    },
    /// The target tile cannot be entered.
    #[error("hex {at} is impassable")]
    Impassable {
        /// Offending position.
        at: OffsetCoord,
    },
    /// Another blocking entity stands on the target hex.
    #[error("hex {at} is occupied")]
    Occupied {
        /// Offending position.
        at: OffsetCoord,
    },
}

impl ActionError {
    /// A stable, machine-readable code for the UI to branch on.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            ActionError::NoPlayer => "noPlayer",
            ActionError::SameHex => "sameHex",
            ActionError::OutOfBounds { .. } => "outOfBounds",
            ActionError::NotAdjacent { .. } => "notAdjacent",
            ActionError::Impassable { .. } => "impassable",
            ActionError::Occupied { .. } => "occupied",
        }
    }
}

/// A rejection rendered for the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rejection {
    /// Stable code, e.g. `"impassable"`.
    pub code: String,
    /// Human readable explanation.
    pub message: String,
}

impl From<ActionError> for Rejection {
    fn from(error: ActionError) -> Self {
        Self {
            code: error.code().to_owned(),
            message: error.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_stable_and_messages_are_human_readable() {
        let error = ActionError::Impassable {
            at: OffsetCoord::new(3, 4),
        };
        assert_eq!(error.code(), "impassable");
        assert_eq!(error.to_string(), "hex [3, 4] is impassable");

        let rejection = Rejection::from(error);
        assert_eq!(rejection.code, "impassable");
        assert!(rejection.message.contains("[3, 4]"));
    }

    #[test]
    fn not_adjacent_reports_the_measured_distance() {
        let error = ActionError::NotAdjacent {
            at: OffsetCoord::new(9, 9),
            distance: 4,
        };
        assert!(error.to_string().contains("4 steps away"));
    }
}
