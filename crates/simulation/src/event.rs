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
