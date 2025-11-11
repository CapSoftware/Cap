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

            // macOS Tahoe
            "57a1d610df3e421ebef670ba58c97319d2ab6990d64dca34d28140e4527fd54d" => Self::TahoeArrow,
            "24ae740b1b618e08ccf3f54375e6f072da5eb47048426460d0500e21a8be0963" => {
                Self::ContextualMenu
            }
            "e8dcb6cb19ebfa9336297a61950674a365e19ff01b8bf1a327a2f83851f3bc6c" => {
                Self::TahoeClosedHand
            }
            "c5bc204d864e56fce70bca01f309b6cf21e1c77b4389c32883c1c140621bc024" => {
                Self::TahoeCrosshair
            }
            "45bc17d1d3754c60229ebf534ba62827af72815dd4a100d20464ce8072b87fea" => {
                Self::TahoeDisappearingItem
            }
            "ef6d71540be9ba0eac3f45328171cb3c864e267d29ee24c15467a353f958529d" => {
                Self::TahoeDragCopy
            }
            "f5299f02b606041ce03a39c518feafaf977d3d178f73849be00e5e6468ca2f09" => {
                Self::TahoeDragLink
            }
            "3de4a52b22f76f28db5206dc4c2219dff28a6ee5abfb9c5656a469f2140f7eaa" => Self::TahoeIBeam,
            "e335333967dc50a93683f85da145e3e4858f0618a81e5d2ca93d496d9159fbf1" => {
                Self::TahoeOpenHand
            }
            "57f34c3b50a051f7504b165226f552d009378f1cd20f16ba6568216f3982fd59" => {
                Self::TahoeOperationNotAllowed
            }
            "65d626a50079c3111f3c3da9ad8a98220331a592332e00afcf61c0c9c77402f2" => {
                Self::TahoePointingHand
            }
            // As calculated from `NSCursor` directly
            "de549b270ba98c1d02ee6b72ec8019001d09e6a750aa65b012c529d90eb2aeea" |
            // As reported when hovering on HTML cursor tester
            "d0cceb4314b74f8f0bc82d206e28c0e5f84ec441c62882542ab2ab2a4b5bd033" => Self::ResizeDown,
            // As calculated from `NSCursor` directly
            "ac46c5f4d94cc2ec68ca760e197d3467e2113efd18808cc3da88dd35045d7b49" |
            // As reported when hovering on HTML cursor tester
            "2a527730da48b7943c4b1ad844eba0a12fcc81147114b47a4eb1e0fef01241a9" => Self::ResizeLeft,
            // As calculated from `NSCursor` directly
            "b94c84b13da63547851b41fbd7897a423cf87d30c19b1c7f67f69c266f614268" |
            // As reported when hovering on HTML cursor tester
            "4c4dae9b638d0c74629e6073f1301a6a36cd4b47602cff7bf168559e4c745903" => {
                Self::ResizeLeftRight
            }
            // As calculated from `NSCursor` directly
            "324b63acd82ca78ba13e69f65eb21c7f047f87dbb49d2d552b3c112e425fbfb6" |
            // As reported when hovering on HTML cursor tester
            "3a8abc0eeeeb0ded8a2070bc9af9cd7da4e3eff057aa13b5721db2748f6c340a" => Self::ResizeRight,
            // As calculated from `NSCursor` directly
            "d07eda9c435c22c0874a6c9953cecd886dee38c5f115c3b8c754a99ebab76ad5" |
            // As reported when hovering on HTML cursor tester
            "78e3453975ac617f3dd108e5f39574e51955cf234b5c4f1971b73dc6836c928b" => Self::ResizeUp,
            // As calculated from `NSCursor` directly
            "b3b52be9bbdc48f26b5f2b6d808c9d9facd8d11f5d5eaad4ebe21ec2b7ec1e98" |
            // As reported when hovering on HTML cursor tester
            "1fbfd7a8b9bdb0ed9455d88726bcbefe031893a523ac74d27ab7f993c0239f1d" => {
                Self::ResizeUpDown
            }
            "c715df2b1e5956f746fea3cdbe259136f3349773e9dbf26cc65b122905c4eb1c" => {
                Self::IBeamVerticalForVerticalLayout
            }
            "08bb474d7bdb5ee4be6e3a797a7fd05ebd8e4e813e92a685a91f33dbc32c572a" => Self::TahoeZoomIn,
            "411f5864a498e2d7533d462e85fe2bfe44bcad5b4120300fdf3c3f9f541dade0" => {
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
