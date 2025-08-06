use strum::{EnumString, IntoStaticStr};

use crate::{CursorShape, ResolvedCursor};

/// macOS Cursors
/// https://developer.apple.com/documentation/appkit/nscursor
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
    pub fn resolve(&self) -> Option<ResolvedCursor> {
        Some(match self {
            Self::Arrow => ResolvedCursor {
                raw: include_str!("../assets/mac/arrow.svg"),
                hotspot: (0.347, 0.33),
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
                hotspot: (0.525, 0.52),
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
                hotspot: (0.406, 0.25),
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
        })
    }

    /// Derive the cursor type from a hash
    /// macOS doesn't allow comparing `NSCursor` instances directly so we hash the image data.
    /// macOS cursor are also resolution-independent so this works.
    pub fn from_hash(hash: &str) -> Option<Self> {
        Some(match hash {
            "de2d1f4a81e520b65fd1317b845b00a1c51a4d1f71cca3cd4ccdab52b98d1ac9" => Self::Arrow,
            "ab26ca862492d41355b711c58544687a799dd7ae14cf161959ca524bbc97c322" => {
                Self::ContextualMenu
            }
            "fbb165d4603dd8808b536f45bb74a9a72d9358ad19714b318bb7c06358a7d3c2" => Self::ClosedHand,
            "c583f776531f4e7b76ea7ba2ab159765e2da11fd63cb897cc10362183859d1d8" => Self::Crosshair,
            "67c369820fbc37af9b59b840c675ca24117ca8dfdccec7702b10894058617951" => {
                Self::DisappearingItem
            }
            "af060876004c8647d82411eeac1bbd613d2991d46794aba16b56c91d3081e128" => Self::DragCopy,
            "59ac2483461f4ad577a0a6b68be89fe663c36263b583c5f038eee2ae6a5ad98f" => Self::DragLink,
            "492dca0bb6751a30607ac728803af992ba69365052b7df2dff1c0dfe463e653c" => Self::IBeam,
            "3f6a5594a3c9334065944b9c56d9f73fd5fe5f02108a5e28f37e222e770be476" => Self::OpenHand,
            "37287ef1d097704d3e9d0be9c1049ce1fb6dfabd6d210af0429b1b6ec7084c59" => {
                Self::OperationNotAllowed
            }
            "b0443e9f72e724cb6d94b879bf29c6cb18376d0357c6233e5a7561cf8a9943c6" => {
                Self::PointingHand
            }
            "3c9bf0ce893b64fe9e4363793b406140d4b3900b7beafa1c409e78cf5a8cf954" => Self::ResizeDown,
            "50431d8fd537119aefb4c3673f9b9ff00d3cd1d2bf6c35e5dfb09ed40cfd5e7c" => Self::ResizeLeft,
            "0fdaea89910bcbe34ad0d4d63a6ada2095489df18537bbf54dd0d0769588b381" => {
                Self::ResizeLeftRight
            }
            "e74de88f863f059e5beb27152b2dfc2cd1e8dcc458ce775607765e9a4859667e" => Self::ResizeRight,
            "912ca42451a9624f6fb8c1d53c29c26782b7590d383a66075a6768c4409024d9" => Self::ResizeUp,
            "9c93eb53df68d7fd86298ba1eb3e3b32ccd34d168b81a31a6fc4bb79f131331f" => {
                Self::ResizeUpDown
            }
            "024e1d486a7f16368669d419e69c9a326e464ec1b8ed39645e5c89cb183e03c5" => {
                Self::IBeamVerticalForVerticalLayout
            }
            _ => return None,
        })
    }
}

impl From<CursorShapeMacOS> for CursorShape {
    fn from(value: CursorShapeMacOS) -> Self {
        CursorShape::MacOS(value)
    }
}
