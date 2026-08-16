//! Observable state changes produced by a tick.
//!
//! Events are what the UI animates and logs. They carry **offset** coordinates
//! rather than axial ones because they are consumed by presentation code, and
//! offset is the coordinate space the author and the editor think in.

use hex_world::OffsetCoord;
use serde::{Deserialize, Serialize};

use crate::action::Rejection;

/// Something that happened while resolving an action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SimEvent {
    /// The action was refused; nothing else in this list will appear.
    ActionRejected {
        /// Why it was refused.
        reason: Rejection,
    },
    /// An entity changed hex.
    EntityMoved {
        /// Runtime handle.
        entity: u32,
        /// Authored id.
        content_id: String,
        /// Hex left behind.
        from: OffsetCoord,
        /// Hex entered.
        to: OffsetCoord,
    },
    /// An engine-driven entity had no move worth making.
    EntityHeld {
        /// Runtime handle.
        entity: u32,
        /// Authored id.
        content_id: String,
        /// Where it stayed.
        at: OffsetCoord,
    },
    /// The world clock advanced.
    TickAdvanced {
        /// The new tick value.
        tick: u64,
    },
    /// The player ended a move on a map link, which will change the map.
    ///
    /// Emitted by the tick pipeline, which knows the link exists but cannot
    /// reach the target world — only the host's content registry can. The swap
    /// itself is reported by [`SimEvent::WorldEntered`]
    /// (`docs/adr/ADR-0017-map-links.md`).
    LinkTriggered {
        /// Authored id of the link.
        link: String,
        /// Id of the world the player is being sent to.
        to_world: String,
        /// Where the player will arrive in that world.
        to: OffsetCoord,
    },
    /// The session moved to another map.
    WorldEntered {
        /// Id of the map that was left.
        from_world: String,
        /// Id of the map now being played.
        to_world: String,
        /// Where the player arrived.
        at: OffsetCoord,
    },
    /// A triggered link could not be followed, so the map did not change.
    ///
    /// Content validation is meant to make this unreachable
    /// (`link.unknownTargetWorld`); it is an event rather than an error so that
    /// a partially loaded project degrades instead of ending the session.
    LinkUnresolved {
        /// Authored id of the link.
        link: String,
        /// Id of the world that could not be entered.
        to_world: String,
        /// Why it could not be entered.
        reason: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_serialise_with_a_discriminating_type_field() {
        let event = SimEvent::TickAdvanced { tick: 3 };
        assert_eq!(
            serde_json::to_string(&event).expect("serialise"),
            r#"{"type":"tickAdvanced","tick":3}"#
        );

        let moved = SimEvent::EntityMoved {
            entity: 1,
            content_id: "monster_1".into(),
            from: OffsetCoord::new(1, 1),
            to: OffsetCoord::new(2, 1),
        };
        let json = serde_json::to_string(&moved).expect("serialise");
        assert!(json.contains(r#""type":"entityMoved""#));
        assert!(json.contains(r#""contentId":"monster_1""#));
        assert!(json.contains(r#""from":[1,1]"#));
    }
}
