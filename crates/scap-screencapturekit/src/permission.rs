pub fn request_permission() -> bool {
    unsafe { CGRequestScreenCaptureAccess() == 1 }
}

pub fn has_permission() -> bool {
    unsafe { (CGPreflightScreenCaptureAccess() & 1) == 1 }
}

#[cfg_attr(feature = "link", link(name = "CoreGraphics", kind = "framework"))]
unsafe extern "C" {
    // Screen Capture Access
    fn CGRequestScreenCaptureAccess() -> i32;
    fn CGPreflightScreenCaptureAccess() -> i32;
}
