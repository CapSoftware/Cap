mod bounds;
mod platform;

use std::str::FromStr;

pub use platform::{DisplayIdImpl, DisplayImpl};
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Clone, Copy)]
pub struct Display(DisplayImpl);

impl Display {
    pub fn list() -> Vec<Self> {
        DisplayImpl::list().into_iter().map(Self).collect()
    }

    pub fn raw_handle(&self) -> &DisplayImpl {
        &self.0
    }

    pub fn raw_id(&self) -> DisplayId {
        DisplayId(self.0.raw_id())
    }

    pub fn id(&self) -> String {
        self.0.id()
    }

    pub fn from_id(id: DisplayId) -> Option<Self> {
        Self::list().into_iter().find(|d| d.raw_id() == id)
    }

    pub fn get_at_cursor() -> Option<Self> {
        DisplayImpl::get_display_at_cursor().map(Self)
    }
}

#[derive(Serialize, Deserialize, Type, Clone, PartialEq)]
pub struct DisplayId(
    #[serde(with = "serde_display_id")]
    #[specta(type = String)]
    DisplayIdImpl,
);

impl std::fmt::Display for DisplayId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for DisplayId {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse::<DisplayIdImpl>().map(Self)
    }
}

mod serde_display_id {
    use serde::{Deserialize, Deserializer, Serializer};

    use crate::platform::DisplayIdImpl;

    pub fn serialize<S>(this: &DisplayIdImpl, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&this.to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<DisplayIdImpl, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        s.parse::<DisplayIdImpl>().map_err(serde::de::Error::custom)
    }
}
