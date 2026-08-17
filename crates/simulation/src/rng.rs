//! Deterministic, serialisable pseudo-random number generator.
//!
//! The engine owns the seed and the RNG state; the browser's `Math.random()` is
//! never involved in simulation (see
//! `docs/adr/ADR-0011-deterministic-rng.md`).
//!
//! The algorithm is PCG-XSH-RR 64/32 (O'Neill, 2014): 128 bits of state, 32 bits
//! of output, small enough to serialise into every save and fast enough to be
//! irrelevant to frame time. It is chosen over a cryptographic generator on
//! purpose — reproducibility matters here, unpredictability does not.

use serde::{Deserialize, Serialize};

/// PCG's multiplier constant.
const MULTIPLIER: u64 = 6_364_136_223_846_793_005;
/// SplitMix64's golden-ratio increment, used to expand a short user seed.
const SPLITMIX_GAMMA: u64 = 0x9E37_79B9_7F4A_7C15;

/// A deterministic random number generator.
///
/// # Examples
///
/// ```
/// use insulaire_simulation::Rng;
///
/// let mut a = Rng::from_seed(42);
/// let mut b = Rng::from_seed(42);
/// assert_eq!(a.next_u32(), b.next_u32());
/// ```
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rng {
    state: u64,
    /// Stream selector; always odd.
    increment: u64,
    /// Number of values drawn so far. Purely diagnostic, but it makes
    /// "did the engine actually run?" observable from the UI.
    draws: u64,
}

impl Rng {
    /// Creates a generator from a user-visible seed.
    ///
    /// The seed is expanded through SplitMix64 so that neighbouring seeds
    /// (`1`, `2`, `3`, ...) still produce well-separated streams.
    #[must_use]
    pub fn from_seed(seed: u64) -> Self {
        let mut splitmix = seed;
        let mut next = move || {
            splitmix = splitmix.wrapping_add(SPLITMIX_GAMMA);
            let mut z = splitmix;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        };

        let initial_state = next();
        let stream = next();

        let mut rng = Self {
            state: 0,
            increment: (stream << 1) | 1,
            draws: 0,
        };
        rng.step();
        rng.state = rng.state.wrapping_add(initial_state);
        rng.step();
        rng.draws = 0;
        rng
    }

    /// Advances the internal LCG one step and returns the previous state.
    fn step(&mut self) -> u64 {
        let previous = self.state;
        self.state = previous
            .wrapping_mul(MULTIPLIER)
            .wrapping_add(self.increment);
        previous
    }

    /// Draws the next 32-bit value.
    pub fn next_u32(&mut self) -> u32 {
        let previous = self.step();
        self.draws += 1;
        // XSH-RR output permutation: xorshift high bits down, then rotate by the
        // top 5 bits of the old state.
        let xorshifted = (((previous >> 18) ^ previous) >> 27) as u32;
        let rotation = (previous >> 59) as u32;
        xorshifted.rotate_right(rotation)
    }

    /// Draws a value in `0..bound`, without modulo bias.
    ///
    /// Returns `0` when `bound` is `0`, which keeps callers branch-free.
    pub fn below(&mut self, bound: u32) -> u32 {
        if bound == 0 {
            return 0;
        }
        // Reject the first `2^32 mod bound` values so every residue is equally likely.
        let threshold = bound.wrapping_neg() % bound;
        loop {
            let drawn = self.next_u32();
            if drawn >= threshold {
                return drawn % bound;
            }
        }
    }

    /// Shuffles `items` in place using Fisher-Yates.
    ///
    /// Slices of zero or one element consume no randomness, so a single-monster
    /// world advances the RNG only when something genuinely needs deciding.
    pub fn shuffle<T>(&mut self, items: &mut [T]) {
        for index in (1..items.len()).rev() {
            let swap_with = self.below((index + 1) as u32) as usize;
            items.swap(index, swap_with);
        }
    }

    /// The number of values drawn since the generator was seeded.
    #[must_use]
    pub const fn draws(&self) -> u64 {
        self.draws
    }

    /// The raw LCG state, for snapshots and saves.
    #[must_use]
    pub const fn state(&self) -> u64 {
        self.state
    }

    /// The stream selector, for snapshots and saves.
    #[must_use]
    pub const fn increment(&self) -> u64 {
        self.increment
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_seeds_produce_identical_streams() {
        let mut a = Rng::from_seed(2026);
        let mut b = Rng::from_seed(2026);
        let left: Vec<u32> = (0..32).map(|_| a.next_u32()).collect();
        let right: Vec<u32> = (0..32).map(|_| b.next_u32()).collect();
        assert_eq!(left, right);
    }

    #[test]
    fn different_seeds_produce_different_streams() {
        let mut a = Rng::from_seed(1);
        let mut b = Rng::from_seed(2);
        let left: Vec<u32> = (0..16).map(|_| a.next_u32()).collect();
        let right: Vec<u32> = (0..16).map(|_| b.next_u32()).collect();
        assert_ne!(left, right);
    }

    #[test]
    fn adjacent_seeds_are_well_separated() {
        // A naive `state = seed` seeding makes seeds 1 and 2 emit correlated
        // first draws; SplitMix64 expansion is what prevents that.
        let first: Vec<u32> = (0..8).map(|seed| Rng::from_seed(seed).next_u32()).collect();
        let unique: std::collections::BTreeSet<u32> = first.iter().copied().collect();
        assert_eq!(unique.len(), first.len(), "seeds 0..8 collided: {first:?}");
    }

    #[test]
    fn serialised_state_resumes_the_same_stream() {
        let mut original = Rng::from_seed(7);
        for _ in 0..5 {
            original.next_u32();
        }

        let json = serde_json::to_string(&original).expect("serialise");
        let mut restored: Rng = serde_json::from_str(&json).expect("deserialise");

        assert_eq!(original, restored);
        let expected: Vec<u32> = (0..10).map(|_| original.next_u32()).collect();
        let actual: Vec<u32> = (0..10).map(|_| restored.next_u32()).collect();
        assert_eq!(expected, actual);
    }

    #[test]
    fn below_stays_in_range_and_covers_it() {
        let mut rng = Rng::from_seed(99);
        let mut seen = [false; 6];
        for _ in 0..10_000 {
            let value = rng.below(6);
            assert!(value < 6);
            seen[value as usize] = true;
        }
        assert!(
            seen.iter().all(|hit| *hit),
            "expected every residue to appear"
        );
        assert_eq!(rng.below(0), 0);
    }

    #[test]
    fn shuffle_is_a_permutation_and_is_reproducible() {
        let mut rng = Rng::from_seed(5);
        let mut items = [1, 2, 3, 4, 5, 6, 7, 8];
        rng.shuffle(&mut items);

        let mut sorted = items;
        sorted.sort_unstable();
        assert_eq!(sorted, [1, 2, 3, 4, 5, 6, 7, 8]);

        let mut replay_rng = Rng::from_seed(5);
        let mut replay = [1, 2, 3, 4, 5, 6, 7, 8];
        replay_rng.shuffle(&mut replay);
        assert_eq!(items, replay);
    }

    #[test]
    fn shuffling_short_slices_consumes_no_randomness() {
        let mut rng = Rng::from_seed(11);
        rng.shuffle(&mut [0u8; 0]);
        rng.shuffle(&mut [7u8]);
        assert_eq!(rng.draws(), 0);

        rng.shuffle(&mut [1u8, 2]);
        assert_eq!(rng.draws(), 1);
    }
}
