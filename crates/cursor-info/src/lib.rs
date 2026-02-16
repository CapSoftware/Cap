mod linux;
mod macos;
mod windows;

use std::{fmt, str::FromStr};

pub use linux::CursorShapeLinux;
pub use macos::CursorShapeMacOS;
use serde::{Deserialize, Serialize};
use specta::Type;
pub use windows::CursorShapeWindows;

#[derive(Debug, Clone)]
pub struct ResolvedCursor {
    pub raw: &'static str,
    pub hotspot: (f64, f64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CursorShape {
    MacOS(CursorShapeMacOS),
    Windows(CursorShapeWindows),
    Linux(CursorShapeLinux),
}

impl CursorShape {
    pub fn resolve(&self) -> Option<ResolvedCursor> {
        match self {
            CursorShape::MacOS(cursor) => cursor.resolve(),
            CursorShape::Windows(cursor) => cursor.resolve(),
            CursorShape::Linux(cursor) => cursor.resolve(),
        }
    }
}

impl fmt::Display for CursorShape {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let kind = match self {
            CursorShape::MacOS(_) => "MacOS",
            CursorShape::Windows(_) => "Windows",
            CursorShape::Linux(_) => "Linux",
        };

        let variant: &'static str = match self {
            CursorShape::MacOS(cursor) => cursor.into(),
            CursorShape::Windows(cursor) => cursor.into(),
            CursorShape::Linux(cursor) => cursor.into(),
        };

        write!(f, "{kind}|{variant}")
    }
}

impl Serialize for CursorShape {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for CursorShape {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let string = String::deserialize(deserializer)?;

        let Some((kind, variant)) = string.split_once("|") else {
            return Err(serde::de::Error::custom(
                "Invalid CursorShape. Missing delimiter",
            ));
        };

        match kind {
            "MacOS" => Ok(CursorShape::MacOS(
                CursorShapeMacOS::from_str(variant).map_err(|err| {
                    serde::de::Error::custom(
                        format!("Failed to parse MacOS cursor variant: {err}",),
                    )
                })?,
            )),
            "Windows" => Ok(CursorShape::Windows(
                CursorShapeWindows::from_str(variant).map_err(|err| {
                    serde::de::Error::custom(format!(
                        "Failed to parse Windows cursor variant: {err}",
                    ))
                })?,
            )),
            "Linux" => Ok(CursorShape::Linux(
                CursorShapeLinux::from_str(variant).map_err(|err| {
                    serde::de::Error::custom(format!(
                        "Failed to parse Linux cursor variant: {err}",
                    ))
                })?,
            )),
            _ => Err(serde::de::Error::custom("Failed to parse CursorShape kind")),
        }
    }
}

impl Type for CursorShape {
    fn inline(
        types: &mut specta::TypeMap,
        generics: specta::Generics,
    ) -> specta::datatype::DataType {
        String::inline(types, generics)
    }
}
