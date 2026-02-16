use strum::{EnumString, IntoStaticStr};

use crate::{CursorShape, ResolvedCursor};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, EnumString, IntoStaticStr)]
pub enum CursorShapeLinux {
    Default,
    Arrow,
    Text,
    Pointer,
    Wait,
    Crosshair,
    NotAllowed,
    Grab,
    Grabbing,
    EResize,
    WResize,
    NResize,
    SResize,
    EwResize,
    NsResize,
    NeswResize,
    NwseResize,
    ColResize,
    RowResize,
    Move,
    Help,
    Progress,
    ContextMenu,
    ZoomIn,
    ZoomOut,
    Copy,
    Alias,
    VerticalText,
    Cell,
    AllScroll,
    NoDrop,
}

impl CursorShapeLinux {
    pub fn resolve(&self) -> Option<ResolvedCursor> {
        use crate::macos::CursorShapeMacOS;

        let macos_equivalent = match self {
            Self::Default | Self::Arrow => Some(CursorShapeMacOS::Arrow),
            Self::Text => Some(CursorShapeMacOS::IBeam),
            Self::Pointer => Some(CursorShapeMacOS::PointingHand),
            Self::Crosshair => Some(CursorShapeMacOS::Crosshair),
            Self::NotAllowed | Self::NoDrop => Some(CursorShapeMacOS::OperationNotAllowed),
            Self::Grab => Some(CursorShapeMacOS::OpenHand),
            Self::Grabbing => Some(CursorShapeMacOS::ClosedHand),
            Self::EResize | Self::WResize | Self::EwResize | Self::ColResize => {
                Some(CursorShapeMacOS::ResizeLeftRight)
            }
            Self::NResize | Self::SResize | Self::NsResize | Self::RowResize => {
                Some(CursorShapeMacOS::ResizeUpDown)
            }
            Self::Move | Self::AllScroll => Some(CursorShapeMacOS::OpenHand),
            Self::Help => Some(CursorShapeMacOS::Arrow),
            Self::Wait | Self::Progress => Some(CursorShapeMacOS::Arrow),
            Self::ContextMenu => Some(CursorShapeMacOS::ContextualMenu),
            Self::Copy => Some(CursorShapeMacOS::DragCopy),
            Self::Alias => Some(CursorShapeMacOS::DragLink),
            Self::VerticalText => Some(CursorShapeMacOS::IBeamVerticalForVerticalLayout),
            _ => Some(CursorShapeMacOS::Arrow),
        };

        macos_equivalent.and_then(|cursor| cursor.resolve())
    }
}

impl From<CursorShapeLinux> for CursorShape {
    fn from(cursor: CursorShapeLinux) -> Self {
        CursorShape::Linux(cursor)
    }
}
