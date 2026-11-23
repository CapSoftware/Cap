pub mod active;
pub mod apps;
pub mod browser;
pub mod detect;
pub mod dictionary;
pub mod library;
pub mod names;
pub mod prompt;
pub mod segment;
pub mod session;
pub mod settings;
pub mod sources;
pub mod templates;
pub mod transcript;

mod serde_util;
#[cfg(test)]
mod test_rng;
mod text;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[serde(transparent)]
pub struct Millis(pub u64);

impl Millis {
    pub const ZERO: Millis = Millis(0);

    pub fn plus(self, ms: u64) -> Millis {
        Millis(self.0.saturating_add(ms))
    }

    pub fn since(self, earlier: Millis) -> u64 {
        self.0.saturating_sub(earlier.0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Now {
    pub mono: Millis,
    pub wall: DateTime<Utc>,
}

impl Now {
    pub fn new(mono: Millis, wall: DateTime<Utc>) -> Self {
        Self { mono, wall }
    }
}
