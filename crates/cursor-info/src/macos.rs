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

            // Tahoe cursor variants
            Self::TahoeArrow => ResolvedCursor {
                raw: include_str!("../assets/mac/tahoe/default.svg"),
                hotspot: (0.495, 0.463),
            },
            Self::TahoeContextualMenu => ResolvedCursor {
                raw: include_str!("../assets/mac/tahoe/context-menu.svg"),
                hotspot: (0.495, 0.352),
            },
            Self::TahoeClosedHand => ResolvedCursor {
                raw: include_str!("../assets/mac/tahoe/grabbing.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::TahoeCrosshair => ResolvedCursor {
                raw: include_str!("../assets/mac/tahoe/crosshair.svg"),
                hotspot: (0.52, 0.51),
            },
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
                hotspot: (0.525, 0.52),
            },
            Self::TahoeOpenHand => ResolvedCursor {
                raw: include_str!("../assets/mac/tahoe/grab.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::TahoeOperationNotAllowed => ResolvedCursor {
                raw: include_str!("../assets/mac/operation_not_allowed.svg"),
                hotspot: (0.24, 0.1),
            },
            Self::TahoePointingHand => ResolvedCursor {
                raw: include_str!("../assets/mac/tahoe/pointer.svg"),
                hotspot: (0.5, 0.4),
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
                hotspot: (0.548, 0.544),
            },
            Self::TahoeZoomOut => ResolvedCursor {
                raw: include_str!("../assets/mac/tahoe/zoom-out.svg"),
                hotspot: (0.551, 0.544),
            },
        })
    }

    /// Derive the cursor type from a hash
    /// macOS doesn't allow comparing `NSCursor` instances directly so we hash the image data.
    /// macOS cursor are also resolution-independent so this works.
    pub fn from_hash(hash: &str) -> Option<Self> {
        Some(match hash {
            // Regular macOS cursor hashes
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

            //Hash values obtained from a macOS Tahoe system.
            "57a1d610df3e421ebef670ba58c97319d2ab6990d64dca34d28140e4527fd54d" => Self::TahoeArrow,
            "877e1c153d942d18ddfe88e72e2f34ad4435a6839fc447c1a32a71e6bbe1104c" => {
                Self::TahoeContextualMenu
            }
            "bc1a01ced20ea38eda8f0eb1976bfe74ac39150ed9a044d3df918faf3dff15ae" => {
                Self::TahoeClosedHand
            }
            "0aa0d950a742ed4802ed44095cbf5834de3eea84bf78026cacb8e2c37d244f46" => {
                Self::TahoeCrosshair
            }
            "f44a524d6fcfe5a1b1bebf23fcb12fbfeaea0ecf92beb7f69fdf586c319dd8ab" => {
                Self::TahoeDisappearingItem
            }
            "93d05bf80e702fdf5d6924447c91a0ab5fb196251d5758e98c5b6a5f08f0e960" => {
                Self::TahoeDragCopy
            }
            "00cdb9c59246bf98172a027a94b323498bf8d82c701c4d0d85c6e452549fa351" => {
                Self::TahoeDragLink
            }
            "3de4a52b22f76f28db5206dc4c2219dff28a6ee5abfb9c5656a469f2140f7eaa" => Self::TahoeIBeam,
            "a6f87e2749a5a6799c04ca8e1782194b770a2b5f966e70b79c7c245222176ec5" => {
                Self::TahoeOpenHand
            }
            "48941d14eefe97e53fe38531c0f927d71fbd3e63b32e1e10e0a4ff729d64e320" => {
                Self::TahoeOperationNotAllowed
            }
            "cb0277925fa3ecca8bc54bc98b3ef1d5c08cfd4c6086733f4d849c675f68bf6f" => {
                Self::TahoePointingHand
            }
            "825236ff95d98fd49868da5a588ad7077ea507e15ad0a4924495511d05c1bc35" => {
                Self::TahoeResizeDown
            }
            "8a8608a42590e7c518f410aa0750894d2296c7a72e74e3a9dcceb72bc3bc2daf" => {
                Self::TahoeResizeLeft
            }
            "1db16810eb4c14a9c86807b15633d891298e4decd22ed650d8d5d2375f94d27e" => {
                Self::TahoeResizeLeftRight
            }
            "426e4d72be3d8b97fadca5e1067c5a5c2c939e0bbe9c686947c60e3350f386cb" => {
                Self::TahoeResizeRight
            }
            "95b05d0dd57d3a5c7198c7e8fbcf001c316530dd65de9ec26dde42ba9922e11b" => {
                Self::TahoeResizeUp
            }
            "f919de8ef1e36cd95ec8805f6731e831cb5996a4e4403f7c62b6ff994d429451" => {
                Self::TahoeResizeUpDown
            }
            "5113d2b572347a56228457ca3e96102934eb394c7d26c3d985d4ee146959d34a" => {
                Self::TahoeIBeamVerticalForVerticalLayout
            }
            "e539c32a13a6b2caf0e0a991a21d31f8d16cb9feee61fb4efc27a21d6dd6a177" => Self::TahoeZoomIn,
            "d2324ade560f68ce638bb2fd98e9ba2f08d219593afab6b94fb647b1c243d049" => {
                Self::TahoeZoomOut
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
