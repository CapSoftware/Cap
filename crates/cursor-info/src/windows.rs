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

#[cfg(target_os = "windows")]
impl TryFrom<&windows::Win32::UI::WindowsAndMessaging::HCURSOR> for super::CursorShape {
    type Error = ();

    fn try_from(cursor: &objc2_app_kit::NSCursor) -> Result<Self, Self::Error> {
        #[inline]
        fn load_cursor(lpcursorname: PCWSTR) -> *mut std::ffi::c_void {
            unsafe { LoadCursorW(None, lpcursorname) }
                .expect("Failed to load default system cursors")
                .0
        }

        Ok(super::CursorShape::Windows(match cursor.0 {
            ptr if ptr == load_cursor(IDC_ARROW) => CursorShape::Arrow,
            ptr if ptr == cursors.ibeam => CursorShape::IBeam,
            ptr if ptr == cursors.wait => CursorShape::Wait,
            ptr if ptr == cursors.cross => CursorShape::Crosshair,
            ptr if ptr == cursors.up_arrow => CursorShape::ResizeUp,
            ptr if ptr == cursors.size_we => CursorShape::ResizeLeftRight,
            ptr if ptr == cursors.size_ns => CursorShape::ResizeUpDown,
            ptr if ptr == cursors.size_nwse => CursorShape::ResizeUpLeftAndDownRight,
            ptr if ptr == cursors.size_nesw => CursorShape::ResizeUpRightAndDownLeft,
            ptr if ptr == cursors.size_all => CursorShape::ResizeAll,
            ptr if ptr == cursors.hand => CursorShape::OpenHand,
            ptr if ptr == cursors.no => CursorShape::NotAllowed,
            ptr if ptr == cursors.appstarting => CursorShape::Appstarting,
            ptr if ptr == cursors.help => CursorShape::Help,
            ptr if ptr == cursors.pin || ptr == cursors.person => CursorShape::OpenHand,
            // Usually 0, meaning the cursor is hidden. On Windows 8+, a value of 2 means the cursor is supressed
            // as the user is using touch input instead.
            _ => CursorShape::Hidden,
        }))
    }
}

// TODO: #[cfg(target_os = "windows")]

// pub fn get_cursor_shape(cursors: &DefaultCursors) -> CursorShape {
//     let mut cursor_info = CURSORINFO {
//         cbSize: std::mem::size_of::<CURSORINFO>() as u32,
//         ..Default::default()
//     };
//     match unsafe { GetCursorInfo(&mut cursor_info) } {
//         Ok(_) => match cursor_info.hCursor.0 {
//             ptr if ptr == cursors.arrow => CursorShape::Arrow,
//             ptr if ptr == cursors.ibeam => CursorShape::IBeam,
//             ptr if ptr == cursors.wait => CursorShape::Wait,
//             ptr if ptr == cursors.cross => CursorShape::Crosshair,
//             ptr if ptr == cursors.up_arrow => CursorShape::ResizeUp,
//             ptr if ptr == cursors.size_we => CursorShape::ResizeLeftRight,
//             ptr if ptr == cursors.size_ns => CursorShape::ResizeUpDown,
//             ptr if ptr == cursors.size_nwse => CursorShape::ResizeUpLeftAndDownRight,
//             ptr if ptr == cursors.size_nesw => CursorShape::ResizeUpRightAndDownLeft,
//             ptr if ptr == cursors.size_all => CursorShape::ResizeAll,
//             ptr if ptr == cursors.hand => CursorShape::OpenHand,
//             ptr if ptr == cursors.no => CursorShape::NotAllowed,
//             ptr if ptr == cursors.appstarting => CursorShape::Appstarting,
//             ptr if ptr == cursors.help => CursorShape::Help,
//             ptr if ptr == cursors.pin || ptr == cursors.person => CursorShape::OpenHand,
//             // Usually 0, meaning the cursor is hidden. On Windows 8+, a value of 2 means the cursor is supressed
//             // as the user is using touch input instead.
//             _ => CursorShape::Hidden,
//         },
//         Err(_) => CursorShape::Unknown,
//     }
// }

// /// Keeps handles to default cursor.
// /// Read more: [MS Doc - About Cursors](https://learn.microsoft.com/en-us/windows/win32/menurc/about-cursors)
// pub struct DefaultCursors {
//     arrow: *mut c_void,
//     ibeam: *mut c_void,
//     wait: *mut c_void,
//     cross: *mut c_void,
//     up_arrow: *mut c_void,
//     size_nwse: *mut c_void,
//     size_nesw: *mut c_void,
//     size_we: *mut c_void,
//     size_ns: *mut c_void,
//     size_all: *mut c_void,
//     no: *mut c_void,
//     hand: *mut c_void,
//     appstarting: *mut c_void,
//     help: *mut c_void,
//     pin: *mut c_void,
//     person: *mut c_void,
// }

// impl Default for DefaultCursors {
//     fn default() -> Self {

//         DefaultCursors {
//             arrow: load_cursor(IDC_ARROW),
//             ibeam: load_cursor(IDC_IBEAM),
//             cross: load_cursor(IDC_CROSS),
//             hand: load_cursor(IDC_HAND),
//             help: load_cursor(IDC_HELP),
//             no: load_cursor(IDC_NO),
//             size_all: load_cursor(IDC_SIZEALL),
//             size_ns: load_cursor(IDC_SIZENS),
//             size_we: load_cursor(IDC_SIZEWE),
//             size_nwse: load_cursor(IDC_SIZENWSE),
//             size_nesw: load_cursor(IDC_SIZENESW),
//             up_arrow: load_cursor(IDC_UPARROW),
//             wait: load_cursor(IDC_WAIT),
//             appstarting: load_cursor(IDC_APPSTARTING),
//             pin: load_cursor(IDC_PIN),
//             person: load_cursor(IDC_PERSON),
//         }
//     }
// }
