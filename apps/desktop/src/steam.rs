//! The seam where Steam plugs in, and the stub that stands in its place.
//!
//! # Why a seam and not an integration
//!
//! The Steamworks SDK is not redistributable, so it cannot live in this
//! repository, and a build that required it would not compile on a machine
//! without a Steamworks account. The `steam` cargo feature is therefore off by
//! default: the game builds and runs without Steam, and a store build turns the
//! feature on (`cargo tauri build --features steam`).
//!
//! # Why the facade is this small
//!
//! Everything a store integration eventually needs — achievements, cloud saves,
//! rich presence, the overlay — is reached through a client handle whose only
//! interesting property, from the game's point of view, is whether it exists.
//! Naming that in one type keeps the rest of the shell free of `#[cfg]`: the
//! window, the commands and the callers see [`Steam`] either way, and only this
//! file knows which half is compiled.
//!
//! The methods deliberately never fail the game. Steam not running, the game
//! launched outside the client, an unknown achievement id — all of these are
//! normal, and none of them is a reason to refuse to play.

/// The Steam client, or a truthful admission that there is none.
pub struct Steam {
    #[cfg(feature = "steam")]
    client: Option<steamworks::Client>,
}

impl Steam {
    /// Connects to a running Steam client, if this build has Steam at all.
    pub fn start() -> Self {
        #[cfg(feature = "steam")]
        {
            // `init` takes the AppID from `steam_appid.txt` next to the
            // executable during development, and from the launching client in
            // production. It fails when Steam is not running, which is not an
            // error: the game is playable outside the store.
            let client = match steamworks::Client::init() {
                Ok(client) => Some(client),
                Err(error) => {
                    eprintln!("[insulaire] steam unavailable: {error}");
                    None
                }
            };
            Self { client }
        }

        #[cfg(not(feature = "steam"))]
        Self {}
    }

    /// Whether Steam services are actually reachable in this run.
    ///
    /// Unused so far by design: this is a seam waiting for the game features
    /// that will report to Steam, not a dead end (ADR-0017).
    #[allow(dead_code)]
    pub fn is_available(&self) -> bool {
        #[cfg(feature = "steam")]
        {
            self.client.is_some()
        }

        #[cfg(not(feature = "steam"))]
        false
    }

    /// One line for the startup log, so a build's Steam status is never a guess.
    pub fn describe(&self) -> &'static str {
        #[cfg(feature = "steam")]
        {
            if self.is_available() {
                "connected"
            } else {
                "compiled in, client not reachable"
            }
        }

        #[cfg(not(feature = "steam"))]
        "not compiled in (build with --features steam)"
    }

    /// Unlocks an achievement, and shrugs if Steam is not there.
    ///
    /// Returns whether the unlock reached Steam, for callers that want to log
    /// it; the game itself is expected to ignore the answer.
    #[allow(dead_code)]
    pub fn unlock_achievement(&self, id: &str) -> bool {
        #[cfg(feature = "steam")]
        {
            let Some(client) = self.client.as_ref() else {
                return false;
            };
            let stats = client.user_stats();
            if let Err(error) = stats.achievement(id).set() {
                eprintln!("[insulaire] steam achievement {id} failed: {error}");
                return false;
            }
            // Nothing is visible to the player until the stats are stored.
            if let Err(error) = stats.store_stats() {
                eprintln!("[insulaire] steam stats not stored: {error}");
                return false;
            }
            true
        }

        #[cfg(not(feature = "steam"))]
        {
            let _ = id;
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Steam;

    /// The default build must be inert: no Steam, no panic, no refusal to play.
    #[test]
    fn a_build_without_steam_is_available_to_no_one_and_still_answers() {
        let steam = Steam::start();

        #[cfg(not(feature = "steam"))]
        {
            assert!(!steam.is_available());
            assert!(!steam.unlock_achievement("FIRST_TICK"));
            assert!(steam.describe().contains("not compiled in"));
        }

        // With the feature on, the outcome depends on a running client, so the
        // only invariant left is that asking does not panic.
        #[cfg(feature = "steam")]
        {
            let _ = steam.is_available();
            let _ = steam.unlock_achievement("FIRST_TICK");
        }
    }
}
