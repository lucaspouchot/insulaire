//! Engine errors, shaped for crossing a language boundary.
//!
//! Every error carries a stable [`code`](EngineError::code) so the UI can branch
//! without string-matching messages, and content errors carry the full
//! [`ValidationReport`] so the editor can list every issue at once.

use insulaire_world::ValidationReport;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Something the engine refused to do.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum EngineError {
    /// A content file could not be parsed.
    #[error("could not parse {what}: {message}")]
    Parse {
        /// What was being parsed, e.g. `"world"`.
        what: String,
        /// The underlying `serde_json` message.
        message: String,
    },
    /// A content file parsed but failed validation.
    #[error("{what} is invalid: {}", report.summary())]
    Invalid {
        /// What was being validated, e.g. ``"world `demo_world`"``.
        what: String,
        /// Every finding.
        report: Box<ValidationReport>,
    },
    /// A referenced content id is not registered.
    #[error("unknown {kind} `{id}`")]
    UnknownContent {
        /// `"world"` or `"tile set"`.
        kind: String,
        /// The id that was looked up.
        id: String,
    },
    /// An operation needed a running game and there was none.
    #[error("no game is running; call createGame first")]
    NoGame,
    /// A game could not be created from otherwise valid content.
    #[error("{0}")]
    Setup(#[from] insulaire_simulation::GameSetupError),
}

impl EngineError {
    /// A stable, machine-readable code.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            EngineError::Parse { .. } => "parse",
            EngineError::Invalid { .. } => "invalidContent",
            EngineError::UnknownContent { .. } => "unknownContent",
            EngineError::NoGame => "noGame",
            EngineError::Setup(_) => "setup",
        }
    }

    /// The validation report, when this error carries one.
    #[must_use]
    pub fn report(&self) -> Option<&ValidationReport> {
        match self {
            EngineError::Invalid { report, .. } => Some(report),
            EngineError::Setup(insulaire_simulation::GameSetupError::InvalidWorld {
                report,
                ..
            }) => Some(report),
            _ => None,
        }
    }

    /// Converts to the wire representation sent across the WASM boundary.
    #[must_use]
    pub fn to_payload(&self) -> EngineErrorPayload {
        EngineErrorPayload {
            code: self.code().to_owned(),
            message: self.to_string(),
            report: self.report().cloned(),
        }
    }
}

/// The JSON shape a host application receives when a call fails.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineErrorPayload {
    /// Stable code, e.g. `"invalidContent"`.
    pub code: String,
    /// Human readable message.
    pub message: String,
    /// Present for content errors.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<ValidationReport>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use insulaire_world::{Severity, ValidationIssue};

    #[test]
    fn parse_errors_carry_no_report() {
        let error = EngineError::Parse {
            what: "world".into(),
            message: "expected value".into(),
        };
        assert_eq!(error.code(), "parse");
        assert!(error.report().is_none());
        assert_eq!(error.to_payload().report, None);
    }

    #[test]
    fn content_errors_carry_the_full_report() {
        let report = ValidationReport {
            valid: false,
            issues: vec![ValidationIssue {
                code: "world.missingPlayer".into(),
                severity: Severity::Error,
                path: "entities".into(),
                message: "no player".into(),
            }],
        };
        let error = EngineError::Invalid {
            what: "world `demo`".into(),
            report: Box::new(report),
        };

        assert_eq!(error.code(), "invalidContent");
        assert!(error.to_string().contains("no player"));

        let payload = error.to_payload();
        assert_eq!(payload.report.map(|report| report.issues.len()), Some(1));
    }

    #[test]
    fn payloads_serialise_to_the_documented_shape() {
        let payload = EngineError::NoGame.to_payload();
        let json = serde_json::to_string(&payload).expect("serialise");
        assert_eq!(
            json,
            r#"{"code":"noGame","message":"no game is running; call createGame first"}"#
        );
    }
}
