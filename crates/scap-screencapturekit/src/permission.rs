/// Requests screen capture access permission from the user.
///
/// On first call, this displays a system permission dialog. On subsequent calls,
/// it returns the current permission status without showing the dialog.
pub fn request_permission() -> bool {
    unsafe { CGRequestScreenCaptureAccess() == 1 }
}

/// Checks whether screen capture access permission has been granted.
///
/// This is a non-blocking check that doesn't prompt the user.
pub fn has_permission() -> bool {
    unsafe { (CGPreflightScreenCaptureAccess() & 1) == 1 }
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    // Screen Capture Access
    fn CGRequestScreenCaptureAccess() -> i32;
    fn CGPreflightScreenCaptureAccess() -> i32;
}
