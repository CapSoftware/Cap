use strum::{EnumString, IntoStaticStr};

use crate::ResolvedCursor;

// https://learn.microsoft.com/en-us/windows/win32/menurc/about-cursors
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, EnumString, IntoStaticStr)]
pub enum CursorShapeWindows {
    /// IDC_ARROW
    Arrow,
    /// IDC_IBEAM
    IBeam,
    /// IDC_WAIT
    Wait,
    /// IDC_CROSS
    Cross,
    /// IDC_UPARROW
    UpArrow,
    /// IDC_SIZENWSE
    SizeNWSE,
    /// IDC_SIZENESW
    SizeNESW,
    /// IDC_SIZEWE
    SizeWE,
    /// IDC_SIZENS
    SizeNS,
    /// IDC_SIZEALL
    SizeAll,
    /// IDC_NO
    No,
    /// IDC_HAND
    Hand,
    /// IDC_APPSTARTING
    AppStarting,
    /// IDC_HELP
    Help,
    /// IDC_PIN
    Pin,
    /// IDC_PERSON
    Person,
    /// MAKEINTRESOURCE(32631)
    Pen,
    /// MAKEINTRESOURCE(32652)
    ScrolNS,
    /// MAKEINTRESOURCE(32653)
    ScrollWE,
    /// MAKEINTRESOURCE(32654)
    ScrollNSEW,
    /// MAKEINTRESOURCE(32655)
    ScrollN,
    /// MAKEINTRESOURCE(32656)
    ScrollS,
    /// MAKEINTRESOURCE(32657)
    ScrollW,
    /// MAKEINTRESOURCE(32658)
    ScrollE,
    /// MAKEINTRESOURCE(32659)
    ScrollNW,
    /// MAKEINTRESOURCE(32660)
    ScrollNE,
    /// MAKEINTRESOURCE(32661)
    ScrollSW,
    /// MAKEINTRESOURCE(32662)
    ScrollSE,
    /// MAKEINTRESOURCE(32663)
    ArrowCD,
}

impl CursorShapeWindows {
    pub fn info(&self) -> Option<ResolvedCursor> {
        Some(match self {
            CursorShapeWindows::Arrow => ResolvedCursor {
                raw: include_str!("../assets/windows/arrow.svg"),
                hotspot: todo!(),
            },
            CursorShapeWindows::IBeam => ResolvedCursor {
                raw: include_str!("../assets/windows/ibeam.svg"),
                hotspot: todo!(),
            },
            CursorShapeWindows::Wait => ResolvedCursor {
                raw: include_str!("../assets/windows/wait.svg"),
                hotspot: todo!(),
            },
            CursorShapeWindows::Cross => ResolvedCursor {
                raw: include_str!("../assets/windows/cross.svg"),
                hotspot: todo!(),
            },
            CursorShapeWindows::UpArrow => todo!(),
            CursorShapeWindows::SizeNWSE => todo!(),
            CursorShapeWindows::SizeNESW => ResolvedCursor {
                raw: include_str!("../assets/windows/size-nesw.svg"),
                hotspot: todo!(),
            },
            CursorShapeWindows::SizeWE => todo!(),
            CursorShapeWindows::SizeNS => ResolvedCursor {
                raw: include_str!("../assets/windows/size-ns.svg"),
                hotspot: todo!(),
            },
            CursorShapeWindows::SizeAll => todo!(),
            CursorShapeWindows::No => ResolvedCursor {
                raw: include_str!("../assets/windows/no.svg"),
                hotspot: todo!(),
            },
            CursorShapeWindows::Hand => ResolvedCursor {
                raw: include_str!("../assets/windows/hand.svg"),
                hotspot: todo!(),
            },
            CursorShapeWindows::AppStarting => todo!(),
            CursorShapeWindows::Help => todo!(),
            CursorShapeWindows::Pin => todo!(),
            CursorShapeWindows::Person => todo!(),
            CursorShapeWindows::Pen => ResolvedCursor {
                raw: include_str!("../assets/windows/pen.svg"),
                hotspot: todo!(),
            },
            CursorShapeWindows::ScrolNS => todo!(),
            CursorShapeWindows::ScrollWE => todo!(),
            CursorShapeWindows::ScrollNSEW => todo!(),
            CursorShapeWindows::ScrollN => todo!(),
            CursorShapeWindows::ScrollS => todo!(),
            CursorShapeWindows::ScrollW => todo!(),
            CursorShapeWindows::ScrollE => todo!(),
            CursorShapeWindows::ScrollNW => todo!(),
            CursorShapeWindows::ScrollNE => todo!(),
            CursorShapeWindows::ScrollSW => todo!(),
            CursorShapeWindows::ScrollSE => todo!(),
            CursorShapeWindows::ArrowCD => todo!(),
            _ => return None,
        })
    }

    /// Get the hotspot of the cursor shape.
    pub fn hotspot(&self) -> (f64, f64) {
        match self {
            // TODO: Implement this
            _ => (0.0, 0.0),
        }
    }
}
