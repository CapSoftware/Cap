use strum::{EnumString, IntoStaticStr};

use crate::ResolvedCursor;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, EnumString, IntoStaticStr)]
pub enum CursorShapeMacOS {
    /// https://developer.apple.com/documentation/appkit/nscursor/arrow
    Arrow,
    /// https://developer.apple.com/documentation/appkit/nscursor/contextualmenu
    ContextualMenu,
    /// https://developer.apple.com/documentation/appkit/nscursor/closedhand
    ClosedHand,
    /// https://developer.apple.com/documentation/appkit/nscursor/crosshair
    Crosshair,
    /// https://developer.apple.com/documentation/appkit/nscursor/disappearingitem
    DisappearingItem,
    /// https://developer.apple.com/documentation/appkit/nscursor/dragcopy
    DragCopy,
    /// https://developer.apple.com/documentation/appkit/nscursor/draglink
    DragLink,
    /// https://developer.apple.com/documentation/appkit/nscursor/ibeam
    IBeam,
    /// https://developer.apple.com/documentation/appkit/nscursor/openhand
    OpenHand,
    /// https://developer.apple.com/documentation/appkit/nscursor/operationnotallowed
    OperationNotAllowed,
    /// https://developer.apple.com/documentation/appkit/nscursor/pointinghand
    PointingHand,
    /// https://developer.apple.com/documentation/appkit/nscursor/resizedown
    ResizeDown,
    /// https://developer.apple.com/documentation/appkit/nscursor/resizeleft
    ResizeLeft,
    /// https://developer.apple.com/documentation/appkit/nscursor/resizeleftright
    ResizeLeftRight,
    /// https://developer.apple.com/documentation/appkit/nscursor/resizeright
    ResizeRight,
    /// https://developer.apple.com/documentation/appkit/nscursor/resizeup
    ResizeUp,
    /// https://developer.apple.com/documentation/appkit/nscursor/resizeupdown
    ResizeUpDown,
    /// https://developer.apple.com/documentation/appkit/nscursor/ibeamcursorforverticallayout
    IBeamVerticalForVerticalLayout,
}

impl CursorShapeMacOS {
    pub fn info(&self) -> Option<ResolvedCursor> {
        Some(match self {
            CursorShapeMacOS::Arrow => ResolvedCursor {
                raw: include_str!("../assets/mac/arrow.svg"),
                hotspot: (0.235, 0.174), // 40.0/170.0, 40.0/230.0
            },
            CursorShapeMacOS::ContextualMenu => ResolvedCursor {
                raw: include_str!("../assets/mac/contextual_menu.svg"),
                hotspot: (0.179, 0.125), // 10.0/56.0, 10.0/80.0
            },
            CursorShapeMacOS::ClosedHand => ResolvedCursor {
                raw: include_str!("../assets/mac/closed_hand.svg"),
                hotspot: (0.5, 0.5), // 32.0/64.0, 32.0/64.0
            },
            CursorShapeMacOS::Crosshair => ResolvedCursor {
                raw: include_str!("../assets/mac/crosshair.svg"),
                hotspot: (0.458, 0.458), // 22.0/48.0, 22.0/48.0
            },
            CursorShapeMacOS::DragCopy => ResolvedCursor {
                raw: include_str!("../assets/mac/drag_copy.svg"),
                hotspot: (0.179, 0.125), // 10.0/56.0, 10.0/80.0
            },
            CursorShapeMacOS::DragLink => ResolvedCursor {
                raw: include_str!("../assets/mac/drag_link.svg"),
                hotspot: (0.688, 0.143), // 22.0/32.0, 6.0/42.0
            },
            CursorShapeMacOS::IBeam => ResolvedCursor {
                raw: include_str!("../assets/mac/ibeam.svg"),
                hotspot: (0.444, 0.5), // 40.0/90.0, 90.0/180.0
            },
            CursorShapeMacOS::OpenHand => ResolvedCursor {
                raw: include_str!("../assets/mac/open_hand.svg"),
                hotspot: (0.5, 0.5), // 32.0/64.0, 32.0/64.0
            },
            CursorShapeMacOS::OperationNotAllowed => ResolvedCursor {
                raw: include_str!("../assets/mac/operation_not_allowed.svg"),
                hotspot: (0.179, 0.125), // 10.0/56.0, 10.0/80.0
            },
            CursorShapeMacOS::PointingHand => ResolvedCursor {
                raw: include_str!("../assets/mac/pointing_hand.svg"),
                hotspot: (0.406, 0.25), // 26.0/64.0, 16.0/64.0
            },
            CursorShapeMacOS::ResizeDown => ResolvedCursor {
                raw: include_str!("../assets/mac/resize_down.svg"),
                hotspot: (0.5, 0.5), // 24.0/48.0, 24.0/48.0
            },
            CursorShapeMacOS::ResizeLeft => ResolvedCursor {
                raw: include_str!("../assets/mac/resize_left.svg"),
                hotspot: (0.5, 0.5), // 24.0/48.0, 24.0/48.0
            },
            CursorShapeMacOS::ResizeLeftRight => ResolvedCursor {
                raw: include_str!("../assets/mac/resize_left_right.svg"),
                hotspot: (0.5, 0.5), // 24.0/48.0, 24.0/48.0
            },
            CursorShapeMacOS::ResizeRight => ResolvedCursor {
                raw: include_str!("../assets/mac/resize_right.svg"),
                hotspot: (0.5, 0.5), // 24.0/48.0, 24.0/48.0
            },
            CursorShapeMacOS::ResizeUp => ResolvedCursor {
                raw: include_str!("../assets/mac/resize_up.svg"),
                hotspot: (0.5, 0.5), // 24.0/48.0, 24.0/48.0
            },
            CursorShapeMacOS::ResizeUpDown => ResolvedCursor {
                raw: include_str!("../assets/mac/resize_up_down.svg"),
                hotspot: (0.5, 0.5), // 24.0/48.0, 24.0/48.0
            },
            CursorShapeMacOS::IBeamVerticalForVerticalLayout => ResolvedCursor {
                raw: include_str!("../assets/mac/ibeam_vertical.svg"),
                hotspot: (0.389, 0.25), // 14.0/36.0, 8.0/32.0
            },
            // Missing asset for it
            CursorShapeMacOS::DisappearingItem => return None,
            _ => return None,
        })
    }
}

#[cfg(target_os = "macos")]
impl TryFrom<&objc2_app_kit::NSCursor> for super::CursorShape {
    type Error = ();

    #[allow(deprecated)]
    fn try_from(cursor: &objc2_app_kit::NSCursor) -> Result<Self, Self::Error> {
        use objc2::rc::Id;

        println!(
            "{:?} {:?} {:?} {:?} {:?} {:?} {:?} {:?}",
            cursor,
            *cursor == *objc2_app_kit::NSCursor::resizeLeftRightCursor(),
            *cursor == *objc2_app_kit::NSCursor::arrowCursor(),
            cursor
                .class()
                .eq(objc2_app_kit::NSCursor::resizeLeftRightCursor().class()),
            cursor
                .class()
                .eq(objc2_app_kit::NSCursor::arrowCursor().class()),
            cursor.class().name(),
            objc2_app_kit::NSCursor::resizeLeftRightCursor()
                .class()
                .name(),
            objc2_app_kit::NSCursor::arrowCursor().class().name(),
        );

        Ok(super::CursorShape::MacOS(
            if *cursor == *objc2_app_kit::NSCursor::arrowCursor() {
                CursorShapeMacOS::Arrow
            } else if *cursor == *objc2_app_kit::NSCursor::contextualMenuCursor() {
                CursorShapeMacOS::ContextualMenu
            } else if *cursor == *objc2_app_kit::NSCursor::closedHandCursor() {
                CursorShapeMacOS::ClosedHand
            } else if *cursor == *objc2_app_kit::NSCursor::crosshairCursor() {
                CursorShapeMacOS::Crosshair
            } else if *cursor == *objc2_app_kit::NSCursor::disappearingItemCursor() {
                CursorShapeMacOS::DisappearingItem
            } else if *cursor == *objc2_app_kit::NSCursor::dragCopyCursor() {
                CursorShapeMacOS::DragCopy
            } else if *cursor == *objc2_app_kit::NSCursor::dragLinkCursor() {
                CursorShapeMacOS::DragLink
            } else if *cursor == *objc2_app_kit::NSCursor::IBeamCursor() {
                CursorShapeMacOS::IBeam
            } else if *cursor == *objc2_app_kit::NSCursor::openHandCursor() {
                CursorShapeMacOS::OpenHand
            } else if *cursor == *objc2_app_kit::NSCursor::operationNotAllowedCursor() {
                CursorShapeMacOS::OperationNotAllowed
            } else if *cursor == *objc2_app_kit::NSCursor::pointingHandCursor() {
                CursorShapeMacOS::PointingHand
            } else if *cursor == *objc2_app_kit::NSCursor::resizeDownCursor() {
                CursorShapeMacOS::ResizeDown
            } else if *cursor == *objc2_app_kit::NSCursor::resizeLeftCursor() {
                CursorShapeMacOS::ResizeLeft
            } else if *cursor == *objc2_app_kit::NSCursor::resizeLeftRightCursor() {
                CursorShapeMacOS::ResizeLeftRight
            } else if *cursor == *objc2_app_kit::NSCursor::resizeRightCursor() {
                CursorShapeMacOS::ResizeRight
            } else if *cursor == *objc2_app_kit::NSCursor::resizeUpCursor() {
                CursorShapeMacOS::ResizeUp
            } else if *cursor == *objc2_app_kit::NSCursor::resizeUpDownCursor() {
                CursorShapeMacOS::ResizeUpDown
            } else if *cursor == *objc2_app_kit::NSCursor::IBeamCursorForVerticalLayout() {
                CursorShapeMacOS::IBeamVerticalForVerticalLayout
            } else {
                return Err(());
            },
        ))
    }
}
