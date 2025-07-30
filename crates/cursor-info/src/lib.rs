//! Cap Cursor Info: A crate for getting cursor information, assets and hotspot information.

/// Information about a resolved cursor shape
#[derive(Debug, Clone)]
pub struct ResolvedCursor {
    /// Raw svg definition of the cursor asset
    pub raw: &'static str,
    /// The location of the hotspot within the cursor asset
    pub hotspot: (f64, f64),
}

impl ResolvedCursor {
    /// Resolve the SVG asset from a given cursor hash
    ///
    /// We hash the cursor's image on macOS as `NSCursor`'s can't be reliably compared.
    pub fn from_hash(s: String) -> Option<ResolvedCursor> {
        Some(match s.as_str() {
            //  https://developer.apple.com/documentation/appkit/nscursor/arrow
            "de2d1f4a81e520b65fd1317b845b00a1c51a4d1f71cca3cd4ccdab52b98d1ac9" => ResolvedCursor {
                raw: include_str!("../assets/mac/arrow.svg"),
                hotspot: (0.235, 0.174), // 40.0/170.0, 40.0/230.0
            },
            // https://developer.apple.com/documentation/appkit/nscursor/contextualmenu
            "ab26ca862492d41355b711c58544687a799dd7ae14cf161959ca524bbc97c322" => ResolvedCursor {
                raw: include_str!("../assets/mac/contextual_menu.svg"),
                hotspot: (0.179, 0.125), // 10.0/56.0, 10.0/80.0
            },
            // https://developer.apple.com/documentation/appkit/nscursor/closedhand
            "fbb165d4603dd8808b536f45bb74a9a72d9358ad19714b318bb7c06358a7d3c2" => ResolvedCursor {
                raw: include_str!("../assets/mac/closed_hand.svg"),
                hotspot: (0.5, 0.5), // 32.0/64.0, 32.0/64.0
            },
            // https://developer.apple.com/documentation/appkit/nscursor/crosshair
            "c583f776531f4e7b76ea7ba2ab159765e2da11fd63cb897cc10362183859d1d8" => ResolvedCursor {
                raw: include_str!("../assets/mac/crosshair.svg"),
                hotspot: (0.458, 0.458), // 22.0/48.0, 22.0/48.0
            },
            // https://developer.apple.com/documentation/appkit/nscursor/disappearingitem
            "67c369820fbc37af9b59b840c675ca24117ca8dfdccec7702b10894058617951" => return None,
            // https://developer.apple.com/documentation/appkit/nscursor/dragcopy
            "af060876004c8647d82411eeac1bbd613d2991d46794aba16b56c91d3081e128" => ResolvedCursor {
                raw: include_str!("../assets/mac/drag_copy.svg"),
                hotspot: (0.179, 0.125), // 10.0/56.0, 10.0/80.0
            },
            // https://developer.apple.com/documentation/appkit/nscursor/draglink
            "59ac2483461f4ad577a0a6b68be89fe663c36263b583c5f038eee2ae6a5ad98f" => ResolvedCursor {
                raw: include_str!("../assets/mac/drag_link.svg"),
                hotspot: (0.688, 0.143), // 22.0/32.0, 6.0/42.0
            },
            // https://developer.apple.com/documentation/appkit/nscursor/ibeam
            "492dca0bb6751a30607ac728803af992ba69365052b7df2dff1c0dfe463e653c" => ResolvedCursor {
                raw: include_str!("../assets/mac/ibeam.svg"),
                hotspot: (0.444, 0.5), // 40.0/90.0, 90.0/180.0
            },
            // https://developer.apple.com/documentation/appkit/nscursor/openhand
            "3f6a5594a3c9334065944b9c56d9f73fd5fe5f02108a5e28f37e222e770be476" => ResolvedCursor {
                raw: include_str!("../assets/mac/open_hand.svg"),
                hotspot: (0.5, 0.5), // 32.0/64.0, 32.0/64.0
            },
            // https://developer.apple.com/documentation/appkit/nscursor/operationnotallowed
            "37287ef1d097704d3e9d0be9c1049ce1fb6dfabd6d210af0429b1b6ec7084c59" => ResolvedCursor {
                raw: include_str!("../assets/mac/operation_not_allowed.svg"),
                hotspot: (0.179, 0.125), // 10.0/56.0, 10.0/80.0
            },
            // https://developer.apple.com/documentation/appkit/nscursor/pointinghand
            "b0443e9f72e724cb6d94b879bf29c6cb18376d0357c6233e5a7561cf8a9943c6" => ResolvedCursor {
                raw: include_str!("../assets/mac/pointing_hand.svg"),
                hotspot: (0.406, 0.25), // 26.0/64.0, 16.0/64.0
            },
            // https://developer.apple.com/documentation/appkit/nscursor/resizedown
            "3c9bf0ce893b64fe9e4363793b406140d4b3900b7beafa1c409e78cf5a8cf954" => ResolvedCursor {
                raw: include_str!("../assets/mac/resize_down.svg"),
                hotspot: (0.5, 0.5), // 24.0/48.0, 24.0/48.0
            },
            // https://developer.apple.com/documentation/appkit/nscursor/resizeleft
            "50431d8fd537119aefb4c3673f9b9ff00d3cd1d2bf6c35e5dfb09ed40cfd5e7c" => ResolvedCursor {
                raw: include_str!("../assets/mac/resize_left.svg"),
                hotspot: (0.5, 0.5), // 24.0/48.0, 24.0/48.0
            },
            // https://developer.apple.com/documentation/appkit/nscursor/resizeleftright
            "0fdaea89910bcbe34ad0d4d63a6ada2095489df18537bbf54dd0d0769588b381" => ResolvedCursor {
                raw: include_str!("../assets/mac/resize_left_right.svg"),
                hotspot: (0.5, 0.5), // 24.0/48.0, 24.0/48.0
            },
            // https://developer.apple.com/documentation/appkit/nscursor/resizeright
            "e74de88f863f059e5beb27152b2dfc2cd1e8dcc458ce775607765e9a4859667e" => ResolvedCursor {
                raw: include_str!("../assets/mac/resize_right.svg"),
                hotspot: (0.5, 0.5), // 24.0/48.0, 24.0/48.0
            },
            // https://developer.apple.com/documentation/appkit/nscursor/resizeup
            "912ca42451a9624f6fb8c1d53c29c26782b7590d383a66075a6768c4409024d9" => ResolvedCursor {
                raw: include_str!("../assets/mac/resize_up.svg"),
                hotspot: (0.5, 0.5), // 24.0/48.0, 24.0/48.0
            },
            // https://developer.apple.com/documentation/appkit/nscursor/resizeupdown
            "9c93eb53df68d7fd86298ba1eb3e3b32ccd34d168b81a31a6fc4bb79f131331f" => ResolvedCursor {
                raw: include_str!("../assets/mac/resize_up_down.svg"),
                hotspot: (0.5, 0.5), // 24.0/48.0, 24.0/48.0
            },
            // https://developer.apple.com/documentation/appkit/nscursor/ibeamcursorforverticallayout
            "024e1d486a7f16368669d419e69c9a326e464ec1b8ed39645e5c89cb183e03c5" => ResolvedCursor {
                raw: include_str!("../assets/mac/ibeam_vertical.svg"),
                hotspot: (0.389, 0.25), // 14.0/36.0, 8.0/32.0
            },
            _ => return None,
        })
    }
}
