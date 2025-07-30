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
                raw: include_str!("../assets/mac/left_ptr.svg"),
                hotspot: todo!(),
            },
            CursorShapeMacOS::ContextualMenu => todo!(),
            CursorShapeMacOS::ClosedHand => todo!(),
            CursorShapeMacOS::Crosshair => todo!(),
            CursorShapeMacOS::DisappearingItem => todo!(),
            CursorShapeMacOS::DragCopy => todo!(),
            CursorShapeMacOS::DragLink => todo!(),
            CursorShapeMacOS::IBeam => todo!(),
            CursorShapeMacOS::OpenHand => todo!(),
            CursorShapeMacOS::OperationNotAllowed => todo!(),
            CursorShapeMacOS::PointingHand => todo!(),
            CursorShapeMacOS::ResizeDown => todo!(),
            CursorShapeMacOS::ResizeLeft => todo!(),
            CursorShapeMacOS::ResizeLeftRight => todo!(),
            CursorShapeMacOS::ResizeRight => todo!(),
            CursorShapeMacOS::ResizeUp => todo!(),
            CursorShapeMacOS::ResizeUpDown => todo!(),
            CursorShapeMacOS::IBeamVerticalForVerticalLayout => todo!(),
            _ => return None,
        })
    }
}

#[cfg(target_os = "macos")]
impl TryFrom<&objc2_app_kit::NSCursor> for super::CursorShape {
    type Error = ();

    #[allow(deprecated)]
    fn try_from(cursor: &objc2_app_kit::NSCursor) -> Result<Self, Self::Error> {
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
