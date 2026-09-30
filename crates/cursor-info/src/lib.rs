//! Cap Cursor Info: A crate for getting cursor information, assets and hotspot information.

mod macos;
mod windows;

use std::{fmt, str::FromStr};

pub use macos::CursorShapeMacOS;
use serde::{Deserialize, Serialize};
use specta::Type;
pub use windows::CursorShapeWindows;

/// Information about a resolved cursor shape
#[derive(Debug, Clone)]
pub struct ResolvedCursor {
    /// Raw svg definition of the cursor asset
    pub raw: &'static str,
    /// The location of the hotspot within the cursor asset
    pub hotspot: (f64, f64),
}

/// Defines the shape of the cursor
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CursorShape {
    MacOS(CursorShapeMacOS),
    Windows(CursorShapeWindows),
}

impl CursorShape {
    /// Resolve a cursor identifier to an asset and hotspot information
    pub fn resolve(&self) -> Option<ResolvedCursor> {
        match self {
            CursorShape::MacOS(cursor) => cursor.resolve(),
            CursorShape::Windows(cursor) => cursor.resolve(),
        }
    }
}

impl fmt::Display for CursorShape {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let kind = match self {
            CursorShape::MacOS(_) => "MacOS",
            CursorShape::Windows(_) => "Windows",
        };

        let variant: &'static str = match self {
            CursorShape::MacOS(cursor) => cursor.into(),
            CursorShape::Windows(cursor) => cursor.into(),
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

/// A visual family of cursor assets. Any recording can be re-rendered in any
/// family by cross-mapping its recorded shapes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CursorFamily {
    MacOS,
    MacOSTahoe,
    Windows,
}

impl CursorFamily {
    pub fn arrow(self) -> CursorShape {
        match self {
            Self::MacOS => CursorShape::MacOS(CursorShapeMacOS::Arrow),
            Self::MacOSTahoe => CursorShape::MacOS(CursorShapeMacOS::TahoeArrow),
            Self::Windows => CursorShape::Windows(CursorShapeWindows::Arrow),
        }
    }
}

impl CursorShape {
    pub fn family(self) -> CursorFamily {
        match self {
            Self::MacOS(cursor) => {
                if cursor.is_tahoe() {
                    CursorFamily::MacOSTahoe
                } else {
                    CursorFamily::MacOS
                }
            }
            Self::Windows(_) => CursorFamily::Windows,
        }
    }

    /// The equivalent shape in another family; identity within the family.
    /// Shapes with no counterpart, and any whose asset is missing, fall back
    /// to the target family's arrow so the renderer always has something to
    /// draw.
    pub fn in_family(self, family: CursorFamily) -> CursorShape {
        let mapped = match (self, family) {
            (Self::MacOS(cursor), CursorFamily::MacOS) => Self::MacOS(cursor.to_classic()),
            (Self::MacOS(cursor), CursorFamily::MacOSTahoe) => Self::MacOS(cursor.to_tahoe()),
            (Self::MacOS(cursor), CursorFamily::Windows) => {
                Self::Windows(cursor.to_classic().to_windows())
            }
            (Self::Windows(cursor), CursorFamily::Windows) => Self::Windows(cursor),
            (Self::Windows(cursor), CursorFamily::MacOS) => Self::MacOS(cursor.to_macos()),
            (Self::Windows(cursor), CursorFamily::MacOSTahoe) => {
                Self::MacOS(cursor.to_macos().to_tahoe())
            }
        };

        if mapped.resolve().is_none() {
            family.arrow()
        } else {
            mapped
        }
    }
}

#[cfg(test)]
mod family_tests {
    use super::*;
    use strum::IntoEnumIterator;

    fn all_shapes() -> Vec<CursorShape> {
        CursorShapeMacOS::iter()
            .map(CursorShape::MacOS)
            .chain(CursorShapeWindows::iter().map(CursorShape::Windows))
            .collect()
    }

    #[test]
    fn family_classifies_every_shape() {
        for shape in all_shapes() {
            let family = shape.family();
            match shape {
                CursorShape::Windows(_) => assert_eq!(family, CursorFamily::Windows),
                CursorShape::MacOS(cursor) => {
                    let name: &'static str = cursor.into();
                    if name.starts_with("Tahoe") {
                        assert_eq!(family, CursorFamily::MacOSTahoe, "{shape}");
                    } else {
                        assert_eq!(family, CursorFamily::MacOS, "{shape}");
                    }
                }
            }
        }
    }

    #[test]
    fn in_family_always_resolves() {
        for shape in all_shapes() {
            for family in [
                CursorFamily::MacOS,
                CursorFamily::MacOSTahoe,
                CursorFamily::Windows,
            ] {
                let mapped = shape.in_family(family);
                assert_eq!(mapped.family(), family, "{shape} -> {family:?}");
                assert!(
                    mapped.resolve().is_some(),
                    "{shape} -> {family:?} produced unresolvable {mapped}"
                );
            }
        }
    }

    #[test]
    fn in_family_is_identity_within_family() {
        for shape in all_shapes() {
            if shape.resolve().is_none() {
                continue;
            }
            assert_eq!(shape.in_family(shape.family()), shape, "{shape}");
        }
    }

    #[test]
    fn unresolvable_shapes_become_the_family_arrow() {
        for shape in [
            CursorShape::MacOS(CursorShapeMacOS::DisappearingItem),
            CursorShape::MacOS(CursorShapeMacOS::TahoeDisappearingItem),
            CursorShape::Windows(CursorShapeWindows::ArrowCD),
        ] {
            assert_eq!(
                shape.in_family(shape.family()),
                shape.family().arrow(),
                "{shape}"
            );
        }
    }

    #[test]
    fn windows_macos_round_trips_are_exact() {
        let pairs = [
            (CursorShapeWindows::Arrow, CursorShapeMacOS::Arrow),
            (CursorShapeWindows::IBeam, CursorShapeMacOS::IBeam),
            (CursorShapeWindows::Hand, CursorShapeMacOS::PointingHand),
            (CursorShapeWindows::Cross, CursorShapeMacOS::Crosshair),
            (
                CursorShapeWindows::No,
                CursorShapeMacOS::OperationNotAllowed,
            ),
            (
                CursorShapeWindows::SizeWE,
                CursorShapeMacOS::ResizeLeftRight,
            ),
            (CursorShapeWindows::SizeNS, CursorShapeMacOS::ResizeUpDown),
            (CursorShapeWindows::SizeAll, CursorShapeMacOS::OpenHand),
        ];

        for (win, mac) in pairs {
            let win = CursorShape::Windows(win);
            let mac = CursorShape::MacOS(mac);
            assert_eq!(win.in_family(CursorFamily::MacOS), mac, "{win} -> macos");
            assert_eq!(
                mac.in_family(CursorFamily::Windows),
                win,
                "{mac} -> windows"
            );
            assert_eq!(
                win.in_family(CursorFamily::MacOS)
                    .in_family(CursorFamily::Windows),
                win,
                "{win} round trip"
            );
        }
    }

    #[test]
    fn tahoe_round_trips_by_name() {
        let mac = CursorShape::MacOS(CursorShapeMacOS::PointingHand);
        let tahoe = CursorShape::MacOS(CursorShapeMacOS::TahoePointingHand);

        assert_eq!(mac.in_family(CursorFamily::MacOSTahoe), tahoe);
        assert_eq!(tahoe.in_family(CursorFamily::MacOS), mac);
        assert_eq!(
            tahoe.in_family(CursorFamily::Windows),
            CursorShape::Windows(CursorShapeWindows::Hand)
        );
    }

    #[test]
    fn tahoe_only_shapes_fall_back_to_classic_arrow() {
        let zoom = CursorShape::MacOS(CursorShapeMacOS::TahoeZoomIn);

        assert_eq!(
            zoom.in_family(CursorFamily::MacOS),
            CursorShape::MacOS(CursorShapeMacOS::Arrow)
        );
        assert_eq!(
            zoom.in_family(CursorFamily::Windows),
            CursorShape::Windows(CursorShapeWindows::Arrow)
        );
    }

    #[test]
    fn every_family_arrow_resolves() {
        for family in [
            CursorFamily::MacOS,
            CursorFamily::MacOSTahoe,
            CursorFamily::Windows,
        ] {
            let arrow = family.arrow();
            assert_eq!(arrow.family(), family, "{arrow}");
            assert!(arrow.resolve().is_some(), "{arrow} has no asset");
        }
    }
}
