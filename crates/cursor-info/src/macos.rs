use crate::{CursorShape, ResolvedCursor};
use strum::{EnumString, IntoStaticStr};

#[cfg(target_os = "macos")]
use std::{collections::HashMap, sync::OnceLock};

/// macOS Cursors
/// https://developer.apple.com/documentation/appkit/nscursor
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Hash, Ord, EnumString, IntoStaticStr)]
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

    // macOS Tahoe Cursors
    TahoeArrow,
    TahoeContextualMenu,
    TahoeClosedHand,
    TahoeCrosshair,
    TahoeDisappearingItem,
    TahoeDragCopy,
    TahoeDragLink,
    TahoeIBeam,
    TahoeOpenHand,
    TahoeOperationNotAllowed,
    TahoePointingHand,
    TahoeResizeDown,
    TahoeResizeLeft,
    TahoeResizeLeftRight,
    TahoeResizeRight,
    TahoeResizeUp,
    TahoeResizeUpDown,
    TahoeIBeamVerticalForVerticalLayout,
    TahoeZoomOut,
    TahoeZoomIn,
}

impl CursorShapeMacOS {
    pub fn resolve(&self) -> Option<ResolvedCursor> {
        Some(match self {
            Self::Arrow => ResolvedCursor {
                raw: include_str!("../assets/mac/arrow.svg"),
                hotspot: (0.302, 0.226),
            },
            Self::ContextualMenu => ResolvedCursor {
                raw: include_str!("../assets/mac/contextual_menu.svg"),
                hotspot: (0.278, 0.295),
            },
            Self::ClosedHand => ResolvedCursor {
                raw: include_str!("../assets/mac/closed_hand.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::Crosshair => ResolvedCursor {
                raw: include_str!("../assets/mac/crosshair.svg"),
                hotspot: (0.52, 0.51),
            },
            Self::DisappearingItem => return None,
            Self::DragCopy => ResolvedCursor {
                raw: include_str!("../assets/mac/drag_copy.svg"),
                hotspot: (0.255, 0.1),
            },
            Self::DragLink => ResolvedCursor {
                raw: include_str!("../assets/mac/drag_link.svg"),
                hotspot: (0.621, 0.309),
            },
            Self::IBeam => ResolvedCursor {
                raw: include_str!("../assets/mac/ibeam.svg"),
                hotspot: (0.484, 0.520),
            },
            Self::OpenHand => ResolvedCursor {
                raw: include_str!("../assets/mac/open_hand.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::OperationNotAllowed => ResolvedCursor {
                raw: include_str!("../assets/mac/operation_not_allowed.svg"),
                hotspot: (0.24, 0.1),
            },
            Self::PointingHand => ResolvedCursor {
                raw: include_str!("../assets/mac/pointing_hand.svg"),
                hotspot: (0.342, 0.172),
            },
            Self::ResizeDown => ResolvedCursor {
                raw: include_str!("../assets/mac/resize_down.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::ResizeLeft => ResolvedCursor {
                raw: include_str!("../assets/mac/resize_left.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::ResizeLeftRight => ResolvedCursor {
                raw: include_str!("../assets/mac/resize_left_right.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::ResizeRight => ResolvedCursor {
                raw: include_str!("../assets/mac/resize_right.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::ResizeUpDown => ResolvedCursor {
                raw: include_str!("../assets/mac/resize_up_down.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::ResizeUp => ResolvedCursor {
                raw: include_str!("../assets/mac/resize_up.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::IBeamVerticalForVerticalLayout => ResolvedCursor {
                raw: include_str!("../assets/mac/ibeam_vertical.svg"),
                hotspot: (0.51, 0.49),
            },
            // Tahoe cursor variants
            Self::TahoeArrow => ResolvedCursor {
                raw: include_str!("../assets/mac/tahoe/default.svg"),
                hotspot: (0.320, 0.192),
            },
            Self::TahoeContextualMenu => ResolvedCursor {
                raw: include_str!("../assets/mac/tahoe/context-menu.svg"),
                hotspot: (0.495, 0.352),
            },
            Self::TahoeClosedHand => ResolvedCursor {
                raw: include_str!("../assets/mac/tahoe/grabbing.svg"),
                hotspot: (0.539, 0.498),
            },
            Self::TahoeCrosshair => ResolvedCursor {
                raw: include_str!("../assets/mac/tahoe/crosshair.svg"),
                hotspot: (0.52, 0.51),
            },
            Self::TahoeDisappearingItem => return None,
            Self::TahoeDragCopy => ResolvedCursor {
                raw: include_str!("../assets/mac/drag_copy.svg"),
                hotspot: (0.255, 0.1),
            },
            Self::TahoeDragLink => ResolvedCursor {
                raw: include_str!("../assets/mac/drag_link.svg"),
                hotspot: (0.621, 0.309),
            },

            Self::TahoeIBeam => ResolvedCursor {
                raw: include_str!("../assets/mac/tahoe/text.svg"),
                hotspot: (0.493, 0.464),
            },
            Self::TahoeOpenHand => ResolvedCursor {
                raw: include_str!("../assets/mac/tahoe/grab.svg"),
                hotspot: (0.543, 0.515),
            },
            Self::TahoeOperationNotAllowed => ResolvedCursor {
                raw: include_str!("../assets/mac/operation_not_allowed.svg"),
                hotspot: (0.24, 0.1),
            },
            Self::TahoePointingHand => ResolvedCursor {
                raw: include_str!("../assets/mac/tahoe/pointer.svg"),
                hotspot: (0.425, 0.167),
            },
            Self::TahoeResizeDown => ResolvedCursor {
                raw: include_str!("../assets/mac/tahoe/resize-s.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::TahoeResizeLeft => ResolvedCursor {
                raw: include_str!("../assets/mac/tahoe/resize-w.svg"),
                hotspot: (0.5, 0.5),
            },

            Self::TahoeResizeLeftRight => ResolvedCursor {
                raw: include_str!("../assets/mac/tahoe/resize-ew.svg"),
                hotspot: (0.5, 0.5),
            },

            Self::TahoeResizeRight => ResolvedCursor {
                raw: include_str!("../assets/mac/tahoe/resize-e.svg"),
                hotspot: (0.5, 0.5),
            },

            Self::TahoeResizeUpDown => ResolvedCursor {
                raw: include_str!("../assets/mac/tahoe/resize-ns.svg"),
                hotspot: (0.5, 0.5),
            },

            Self::TahoeResizeUp => ResolvedCursor {
                raw: include_str!("../assets/mac/tahoe/resize-n.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::TahoeIBeamVerticalForVerticalLayout => ResolvedCursor {
                raw: include_str!("../assets/mac/ibeam_vertical.svg"),
                hotspot: (0.51, 0.49),
            },
            Self::TahoeZoomIn => ResolvedCursor {
                raw: include_str!("../assets/mac/tahoe/zoom-in.svg"),
                hotspot: (0.549, 0.550),
            },
            Self::TahoeZoomOut => ResolvedCursor {
                raw: include_str!("../assets/mac/tahoe/zoom-out.svg"),
                hotspot: (0.551, 0.552),
            },
        })
    }

    #[cfg(target_os = "macos")]
    pub fn is_tahoe() -> bool {
        let info = os_info::get();
        let version_str = info.version().to_string();
        const MACOS_TAHOE_MAJOR_VERSION: &str = "26";

        if version_str.starts_with(MACOS_TAHOE_MAJOR_VERSION) {
            return true;
        }
        false
    }

    #[cfg(target_os = "macos")]
    pub fn get_cursor_cache() -> &'static HashMap<String, CursorShapeMacOS> {
        use objc2::rc::Retained;
        use objc2_app_kit::NSCursor;
        use sha2::{Digest, Sha256};

        static CURSOR_CACHE: OnceLock<HashMap<String, CursorShapeMacOS>> = OnceLock::new();

        CURSOR_CACHE.get_or_init(|| {
            #[inline]
            fn load_cursor(cursor: Retained<NSCursor>) -> String {
                // runtime get a give cursor to hash String
                unsafe {
                    hex::encode(Sha256::digest(
                        cursor
                            .image()
                            .TIFFRepresentation()
                            .expect("Failed to get TIFF representation of build-in cursor")
                            .as_bytes_unchecked(),
                    ))
                }
            }

            let cursors: Vec<(String, CursorShapeMacOS)> = if CursorShapeMacOS::is_tahoe() {
                // tahoe cursor
                vec![
                    (
                        load_cursor(NSCursor::arrowCursor()),
                        CursorShapeMacOS::TahoeArrow,
                    ),
                    (
                        load_cursor(NSCursor::contextualMenuCursor()),
                        CursorShapeMacOS::TahoeContextualMenu,
                    ),
                    (
                        load_cursor(NSCursor::closedHandCursor()),
                        CursorShapeMacOS::TahoeClosedHand,
                    ),
                    (
                        load_cursor(NSCursor::crosshairCursor()),
                        CursorShapeMacOS::TahoeCrosshair,
                    ),
                    (
                        load_cursor(NSCursor::disappearingItemCursor()),
                        CursorShapeMacOS::TahoeDisappearingItem,
                    ),
                    (
                        load_cursor(NSCursor::dragCopyCursor()),
                        CursorShapeMacOS::TahoeDragCopy,
                    ),
                    (
                        load_cursor(NSCursor::dragLinkCursor()),
                        CursorShapeMacOS::TahoeDragLink,
                    ),
                    (
                        load_cursor(NSCursor::IBeamCursor()),
                        CursorShapeMacOS::TahoeIBeam,
                    ),
                    (
                        load_cursor(NSCursor::openHandCursor()),
                        CursorShapeMacOS::TahoeOpenHand,
                    ),
                    (
                        load_cursor(NSCursor::operationNotAllowedCursor()),
                        CursorShapeMacOS::TahoeOperationNotAllowed,
                    ),
                    (
                        load_cursor(NSCursor::pointingHandCursor()),
                        CursorShapeMacOS::TahoePointingHand,
                    ),
                    (
                        load_cursor(NSCursor::resizeDownCursor()),
                        CursorShapeMacOS::TahoeResizeDown,
                    ),
                    (
                        load_cursor(NSCursor::resizeLeftCursor()),
                        CursorShapeMacOS::TahoeResizeLeft,
                    ),
                    (
                        load_cursor(NSCursor::resizeLeftRightCursor()),
                        CursorShapeMacOS::TahoeResizeLeftRight,
                    ),
                    (
                        load_cursor(NSCursor::resizeRightCursor()),
                        CursorShapeMacOS::TahoeResizeRight,
                    ),
                    (
                        load_cursor(NSCursor::resizeUpCursor()),
                        CursorShapeMacOS::TahoeResizeUp,
                    ),
                    (
                        load_cursor(NSCursor::resizeUpDownCursor()),
                        CursorShapeMacOS::TahoeResizeUpDown,
                    ),
                    (
                        load_cursor(NSCursor::IBeamCursorForVerticalLayout()),
                        CursorShapeMacOS::TahoeIBeamVerticalForVerticalLayout,
                    ),
                    (
                        unsafe { load_cursor(NSCursor::zoomOutCursor()) },
                        CursorShapeMacOS::TahoeZoomOut,
                    ),
                    (
                        unsafe { load_cursor(NSCursor::zoomInCursor()) },
                        CursorShapeMacOS::TahoeZoomIn,
                    ),
                ]
            } else {
                vec![
                    (
                        load_cursor(NSCursor::arrowCursor()),
                        CursorShapeMacOS::Arrow,
                    ),
                    (
                        load_cursor(NSCursor::contextualMenuCursor()),
                        CursorShapeMacOS::ContextualMenu,
                    ),
                    (
                        load_cursor(NSCursor::closedHandCursor()),
                        CursorShapeMacOS::ClosedHand,
                    ),
                    (
                        load_cursor(NSCursor::crosshairCursor()),
                        CursorShapeMacOS::Crosshair,
                    ),
                    (
                        load_cursor(NSCursor::disappearingItemCursor()),
                        CursorShapeMacOS::DisappearingItem,
                    ),
                    (
                        load_cursor(NSCursor::dragCopyCursor()),
                        CursorShapeMacOS::DragCopy,
                    ),
                    (
                        load_cursor(NSCursor::dragLinkCursor()),
                        CursorShapeMacOS::DragLink,
                    ),
                    (
                        load_cursor(NSCursor::IBeamCursor()),
                        CursorShapeMacOS::IBeam,
                    ),
                    (
                        load_cursor(NSCursor::openHandCursor()),
                        CursorShapeMacOS::OpenHand,
                    ),
                    (
                        load_cursor(NSCursor::operationNotAllowedCursor()),
                        CursorShapeMacOS::OperationNotAllowed,
                    ),
                    (
                        load_cursor(NSCursor::pointingHandCursor()),
                        CursorShapeMacOS::PointingHand,
                    ),
                    (
                        load_cursor(NSCursor::resizeDownCursor()),
                        CursorShapeMacOS::ResizeDown,
                    ),
                    (
                        load_cursor(NSCursor::resizeLeftCursor()),
                        CursorShapeMacOS::ResizeLeft,
                    ),
                    (
                        load_cursor(NSCursor::resizeLeftRightCursor()),
                        CursorShapeMacOS::ResizeLeftRight,
                    ),
                    (
                        load_cursor(NSCursor::resizeRightCursor()),
                        CursorShapeMacOS::ResizeRight,
                    ),
                    (
                        load_cursor(NSCursor::resizeUpCursor()),
                        CursorShapeMacOS::ResizeUp,
                    ),
                    (
                        load_cursor(NSCursor::resizeUpDownCursor()),
                        CursorShapeMacOS::ResizeUpDown,
                    ),
                    (
                        load_cursor(NSCursor::IBeamCursorForVerticalLayout()),
                        CursorShapeMacOS::IBeamVerticalForVerticalLayout,
                    ),
                ]
            };

            let mut cursors_map = HashMap::new();

            for (hash, cursor) in cursors {
                cursors_map.insert(hash, cursor);
            }

            cursors_map
        })
    }
}

#[cfg(target_os = "macos")]
mod macos_only {
    use super::*;

    /// Derive the cursor type from a hash
    /// macOS doesn't allow comparing `NSCursor` instances directly so we hash the image data.
    /// macOS cursor are also resolution-independent so this works.
    impl TryFrom<&String> for super::CursorShape {
        type Error = ();

        fn try_from(hash: &String) -> Result<Self, Self::Error> {
            match CursorShapeMacOS::get_cursor_cache().get(hash) {
                Some(cursor_shape) => Ok(super::CursorShape::MacOS(*cursor_shape)),
                None => Err(()),
            }
        }
    }
}

impl From<CursorShapeMacOS> for CursorShape {
    fn from(value: CursorShapeMacOS) -> Self {
        CursorShape::MacOS(value)
    }
}
