use strum::{EnumString, IntoStaticStr};

use crate::{CursorShape, ResolvedCursor};

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
    pub fn resolve(&self) -> Option<ResolvedCursor> {
        Some(match self {
            Self::Arrow => ResolvedCursor {
                raw: include_str!("../assets/windows/arrow.svg"),
                hotspot: (0.055, 0.085),
            },
            Self::IBeam => ResolvedCursor {
                raw: include_str!("../assets/windows/ibeam.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::Wait => ResolvedCursor {
                raw: include_str!("../assets/windows/wait.svg"),
                hotspot: (0.5, 0.52),
            },
            Self::Cross => ResolvedCursor {
                raw: include_str!("../assets/windows/cross.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::UpArrow => ResolvedCursor {
                raw: include_str!("../assets/windows/uparrow.svg"),
                hotspot: (0.5, 0.05),
            },
            Self::SizeNWSE => ResolvedCursor {
                raw: include_str!("../assets/windows/idcsizenwse.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::SizeNESW => ResolvedCursor {
                raw: include_str!("../assets/windows/size-nesw.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::SizeWE => ResolvedCursor {
                raw: include_str!("../assets/windows/idcsizewe.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::SizeNS => ResolvedCursor {
                raw: include_str!("../assets/windows/size-ns.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::SizeAll => ResolvedCursor {
                raw: include_str!("../assets/windows/sizeall.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::No => ResolvedCursor {
                raw: include_str!("../assets/windows/no.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::Hand => ResolvedCursor {
                raw: include_str!("../assets/windows/hand.svg"),
                hotspot: (0.42, 0.0),
            },
            Self::AppStarting => ResolvedCursor {
                raw: include_str!("../assets/windows/appstarting.svg"),
                hotspot: (0.055, 0.368),
            },
            Self::Help => ResolvedCursor {
                raw: include_str!("../assets/windows/idchelp.svg"),
                hotspot: (0.056, 0.127),
            },
            Self::Pin => ResolvedCursor {
                raw: include_str!("../assets/windows/idcpin.svg"),
                hotspot: (0.245, 0.05),
            },
            Self::Person => ResolvedCursor {
                raw: include_str!("../assets/windows/idcperson.svg"),
                hotspot: (0.235, 0.05),
            },
            Self::Pen => ResolvedCursor {
                raw: include_str!("../assets/windows/pen.svg"),
                hotspot: (0.055, 0.945),
            },
            // Self::ScrolNS => todo!(),
            // Self::ScrollWE => todo!(),
            // Self::ScrollNSEW => todo!(),
            // Self::ScrollN => todo!(),
            // Self::ScrollS => todo!(),
            // Self::ScrollW => todo!(),
            // Self::ScrollE => todo!(),
            // Self::ScrollNW => todo!(),
            // Self::ScrollNE => todo!(),
            // Self::ScrollSW => todo!(),
            // Self::ScrollSE => todo!(),
            // Self::ArrowCD => todo!(),
            _ => return None,
        })
    }
}

#[cfg(target_os = "windows")]
impl TryFrom<&windows::Win32::UI::WindowsAndMessaging::HCURSOR> for super::CursorShape {
    type Error = ();

    fn try_from(
        cursor: &windows::Win32::UI::WindowsAndMessaging::HCURSOR,
    ) -> Result<Self, Self::Error> {
        use windows::{
            Win32::UI::WindowsAndMessaging::{
                IDC_APPSTARTING, IDC_ARROW, IDC_CROSS, IDC_HAND, IDC_HELP, IDC_IBEAM, IDC_NO,
                IDC_PERSON, IDC_PIN, IDC_SIZEALL, IDC_SIZENESW, IDC_SIZENS, IDC_SIZENWSE,
                IDC_SIZEWE, IDC_UPARROW, IDC_WAIT, LoadCursorW,
            },
            core::PCWSTR,
        };

        #[inline]
        fn load_cursor(lpcursorname: PCWSTR) -> *mut std::ffi::c_void {
            unsafe { LoadCursorW(None, lpcursorname) }
                .expect("Failed to load default system cursors")
                .0
        }

        Ok(super::CursorShape::Windows(match cursor.0 {
            ptr if ptr == load_cursor(IDC_ARROW) => CursorShapeWindows::Arrow,
            ptr if ptr == load_cursor(IDC_IBEAM) => CursorShapeWindows::IBeam,
            ptr if ptr == load_cursor(IDC_WAIT) => CursorShapeWindows::Wait,
            ptr if ptr == load_cursor(IDC_CROSS) => CursorShapeWindows::Cross,
            ptr if ptr == load_cursor(IDC_UPARROW) => CursorShapeWindows::UpArrow,
            ptr if ptr == load_cursor(IDC_SIZENWSE) => CursorShapeWindows::SizeNWSE,
            ptr if ptr == load_cursor(IDC_SIZENESW) => CursorShapeWindows::SizeNESW,
            ptr if ptr == load_cursor(IDC_SIZEWE) => CursorShapeWindows::SizeWE,
            ptr if ptr == load_cursor(IDC_SIZENS) => CursorShapeWindows::SizeNS,
            ptr if ptr == load_cursor(IDC_SIZEALL) => CursorShapeWindows::SizeAll,
            ptr if ptr == load_cursor(IDC_NO) => CursorShapeWindows::No,
            ptr if ptr == load_cursor(IDC_HAND) => CursorShapeWindows::Hand,
            ptr if ptr == load_cursor(IDC_APPSTARTING) => CursorShapeWindows::AppStarting,
            ptr if ptr == load_cursor(IDC_HELP) => CursorShapeWindows::Help,
            ptr if ptr == load_cursor(IDC_PIN) => CursorShapeWindows::Pin,
            ptr if ptr == load_cursor(IDC_PERSON) => CursorShapeWindows::Person,
            ptr if ptr == load_cursor(PCWSTR(32631u16 as _)) => CursorShapeWindows::Pen,
            ptr if ptr == load_cursor(PCWSTR(32652u16 as _)) => CursorShapeWindows::ScrolNS,
            ptr if ptr == load_cursor(PCWSTR(32653u16 as _)) => CursorShapeWindows::ScrollWE,
            ptr if ptr == load_cursor(PCWSTR(32654u16 as _)) => CursorShapeWindows::ScrollNSEW,
            ptr if ptr == load_cursor(PCWSTR(32655u16 as _)) => CursorShapeWindows::ScrollN,
            ptr if ptr == load_cursor(PCWSTR(32656u16 as _)) => CursorShapeWindows::ScrollS,
            ptr if ptr == load_cursor(PCWSTR(32657u16 as _)) => CursorShapeWindows::ScrollW,
            ptr if ptr == load_cursor(PCWSTR(32658u16 as _)) => CursorShapeWindows::ScrollE,
            ptr if ptr == load_cursor(PCWSTR(32659u16 as _)) => CursorShapeWindows::ScrollNW,
            ptr if ptr == load_cursor(PCWSTR(32660u16 as _)) => CursorShapeWindows::ScrollNE,
            ptr if ptr == load_cursor(PCWSTR(32661u16 as _)) => CursorShapeWindows::ScrollSW,
            ptr if ptr == load_cursor(PCWSTR(32662u16 as _)) => CursorShapeWindows::ScrollSE,
            ptr if ptr == load_cursor(PCWSTR(32663u16 as _)) => CursorShapeWindows::ArrowCD,
            _ => return Err(()),
        }))
    }
}

impl From<CursorShapeWindows> for CursorShape {
    fn from(value: CursorShapeWindows) -> Self {
        CursorShape::Windows(value)
    }
}
