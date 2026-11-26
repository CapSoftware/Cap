use std::time::Duration;

use gpui::{App, Window};

use super::model::Rect;

#[derive(Clone, Debug, PartialEq)]
pub struct Screen {
    pub id: String,
    pub frame: Rect,
    pub visible: Rect,
}

#[cfg(target_os = "macos")]
pub use mac::*;

#[cfg(not(target_os = "macos"))]
pub use portable::*;

#[cfg(target_os = "macos")]
mod mac {
    use std::ptr::NonNull;
    use std::time::Duration;

    use gpui::{App, Window};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObjectProtocol, ProtocolObject};
    use objc2::{class, msg_send};
    use objc2_app_kit::NSWindow;
    use objc2_foundation::{
        NSData, NSNotification, NSNotificationCenter, NSOperationQueue, NSPoint, NSRect, NSSize,
        NSString,
    };

    use super::{Rect, Screen};

    fn primary_height_of(geometries: &[crate::platform::ScreenGeometry]) -> f64 {
        geometries
            .iter()
            .find(|screen| screen.frame.0 == 0. && screen.frame.1 == 0.)
            .or(geometries.first())
            .map_or(0., |screen| screen.frame.3)
    }

    fn primary_height() -> f64 {
        primary_height_of(&crate::platform::screen_geometries())
    }

    fn flip(rect: (f64, f64, f64, f64), primary: f64) -> Rect {
        Rect {
            x: rect.0,
            y: primary - (rect.1 + rect.3),
            w: rect.2,
            h: rect.3,
        }
    }

    pub fn screens(_cx: &App) -> Vec<Screen> {
        let geometries = crate::platform::screen_geometries();
        let primary = primary_height_of(&geometries);
        geometries
            .iter()
            .map(|screen| Screen {
                id: screen.id.to_string(),
                frame: flip(screen.frame, primary),
                visible: flip(screen.visible, primary),
            })
            .collect()
    }

    pub fn cursor(_cx: &App) -> Option<(f64, f64)> {
        let location: NSPoint = unsafe { msg_send![class!(NSEvent), mouseLocation] };
        Some((location.x, primary_height() - location.y))
    }

    #[derive(Clone)]
    pub struct Panel(Retained<NSWindow>);

    impl Panel {
        pub fn of(window: &Window) -> Option<Self> {
            crate::platform::ns_window(window).map(Self)
        }

        fn appkit_rect(rect: Rect) -> NSRect {
            let primary = primary_height();
            NSRect::new(
                NSPoint::new(rect.x, primary - (rect.y + rect.h)),
                NSSize::new(rect.w, rect.h),
            )
        }

        pub fn frame(&self) -> Rect {
            let frame = self.0.frame();
            flip(
                (
                    frame.origin.x,
                    frame.origin.y,
                    frame.size.width,
                    frame.size.height,
                ),
                primary_height(),
            )
        }

        pub fn place(&self, rect: Rect, alpha: f64) {
            self.0.setFrame_display(Self::appkit_rect(rect), true);
            self.0.setAlphaValue(alpha);
        }

        pub fn animate(&self, rect: Rect, alpha: f64, duration: Duration) {
            if duration.is_zero() {
                self.place(rect, alpha);
                return;
            }
            let frame = Self::appkit_rect(rect);
            unsafe {
                let context_class = class!(NSAnimationContext);
                let _: () = msg_send![context_class, beginGrouping];
                let context: *mut AnyObject = msg_send![context_class, currentContext];
                if !context.is_null() {
                    let _: () = msg_send![context, setDuration: duration.as_secs_f64()];
                    let name = NSString::from_str("easeOut");
                    let timing: *mut AnyObject =
                        msg_send![class!(CAMediaTimingFunction), functionWithName: &*name];
                    if !timing.is_null() {
                        let _: () = msg_send![context, setTimingFunction: timing];
                    }
                }
                let animator: *mut AnyObject = msg_send![&*self.0, animator];
                if animator.is_null() {
                    let _: () = msg_send![context_class, endGrouping];
                    self.place(rect, alpha);
                    return;
                }
                let _: () = msg_send![animator, setFrame: frame, display: true];
                let _: () = msg_send![animator, setAlphaValue: alpha];
                let _: () = msg_send![context_class, endGrouping];
            }
        }

        pub fn show(&self) {
            self.0.orderFrontRegardless();
        }

        pub fn hide(&self) {
            self.0.orderOut(None);
        }
    }

    pub fn app_icon_png(bundle_id: &str) -> Option<Vec<u8>> {
        objc2::rc::autoreleasepool(|_| unsafe {
            let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
            if workspace.is_null() {
                return None;
            }
            let bundle = NSString::from_str(bundle_id);
            let url: *mut AnyObject =
                msg_send![workspace, URLForApplicationWithBundleIdentifier: &*bundle];
            if url.is_null() {
                return None;
            }
            let path: *mut AnyObject = msg_send![url, path];
            if path.is_null() {
                return None;
            }
            let icon: *mut AnyObject = msg_send![workspace, iconForFile: path];
            if icon.is_null() {
                return None;
            }
            let side = 32.;
            let canvas: *mut AnyObject = msg_send![class!(NSImage), alloc];
            let canvas: *mut AnyObject = msg_send![canvas, initWithSize: NSSize::new(side, side)];
            let canvas = Retained::from_raw(canvas)?;
            let _: () = msg_send![&*canvas, lockFocus];
            let zero = NSRect::new(NSPoint::new(0., 0.), NSSize::new(0., 0.));
            let _: () = msg_send![
                icon,
                drawInRect: NSRect::new(NSPoint::new(0., 0.), NSSize::new(side, side)),
                fromRect: zero,
                operation: 2usize,
                fraction: 1.0f64
            ];
            let _: () = msg_send![&*canvas, unlockFocus];
            let tiff: *mut AnyObject = msg_send![&*canvas, TIFFRepresentation];
            if tiff.is_null() {
                return None;
            }
            let rep: *mut AnyObject = msg_send![class!(NSBitmapImageRep), imageRepWithData: tiff];
            if rep.is_null() {
                return None;
            }
            let properties: *mut AnyObject = msg_send![class!(NSDictionary), dictionary];
            let png: *mut NSData =
                msg_send![rep, representationUsingType: 4usize, properties: properties];
            let png = Retained::retain(png)?;
            Some(png.to_vec())
        })
    }

    pub struct Observer {
        tokens: Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
    }

    impl Drop for Observer {
        fn drop(&mut self) {
            let center = NSNotificationCenter::defaultCenter();
            for token in &self.tokens {
                unsafe { center.removeObserver(AsRef::<AnyObject>::as_ref(&**token)) };
            }
        }
    }

    pub fn observe(names: &[&str], tx: flume::Sender<()>) -> Observer {
        let center = NSNotificationCenter::defaultCenter();
        let queue = NSOperationQueue::mainQueue();
        let mut tokens = Vec::new();
        for name in names {
            let tx = tx.clone();
            let block = block2::RcBlock::new(move |_: NonNull<NSNotification>| {
                let _ = tx.send(());
            });
            let name = NSString::from_str(name);
            let token = unsafe {
                center.addObserverForName_object_queue_usingBlock(
                    Some(&name),
                    None,
                    Some(&queue),
                    &block,
                )
            };
            tokens.push(token);
        }
        Observer { tokens }
    }

    pub const SCREENS_CHANGED: &str = "NSApplicationDidChangeScreenParametersNotification";
    pub const APP_ACTIVE: &str = "NSApplicationDidBecomeActiveNotification";
    pub const APP_INACTIVE: &str = "NSApplicationDidResignActiveNotification";

    pub fn app_is_active() -> bool {
        unsafe {
            let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            !app.is_null() && msg_send![app, isActive]
        }
    }

    pub fn install_glass(native: &crate::platform::NativeWindow, radius: f64) -> bool {
        crate::platform::install_window_material(native, radius).is_some()
    }
}

#[cfg(not(target_os = "macos"))]
mod portable {
    use std::time::Duration;

    use gpui::{App, Window};

    use super::{Rect, Screen};

    pub fn screens(cx: &App) -> Vec<Screen> {
        cx.displays()
            .into_iter()
            .map(|display| {
                let frame = display.bounds();
                let visible = display.visible_bounds();
                let rect = |bounds: gpui::Bounds<gpui::Pixels>| Rect {
                    x: f64::from(f32::from(bounds.origin.x)),
                    y: f64::from(f32::from(bounds.origin.y)),
                    w: f64::from(f32::from(bounds.size.width)),
                    h: f64::from(f32::from(bounds.size.height)),
                };
                Screen {
                    id: format!("{:?}", display.id()),
                    frame: rect(frame),
                    visible: rect(visible),
                }
            })
            .collect()
    }

    pub fn cursor(_cx: &App) -> Option<(f64, f64)> {
        let display = scap_targets::Display::get_containing_cursor()?;
        let bounds = display.raw_handle().logical_bounds()?;
        Some((
            bounds.position().x() + bounds.size().width() / 2.,
            bounds.position().y() + bounds.size().height() / 2.,
        ))
    }

    #[derive(Clone)]
    pub struct Panel;

    impl Panel {
        pub fn of(_window: &Window) -> Option<Self> {
            None
        }

        pub fn frame(&self) -> Rect {
            Rect::default()
        }

        pub fn place(&self, _rect: Rect, _alpha: f64) {}

        pub fn animate(&self, _rect: Rect, _alpha: f64, _duration: Duration) {}

        pub fn show(&self) {}

        pub fn hide(&self) {}
    }

    pub fn app_icon_png(_bundle_id: &str) -> Option<Vec<u8>> {
        None
    }

    pub struct Observer;

    pub fn observe(_names: &[&str], _tx: flume::Sender<()>) -> Observer {
        Observer
    }

    pub const SCREENS_CHANGED: &str = "";
    pub const APP_ACTIVE: &str = "";
    pub const APP_INACTIVE: &str = "";

    pub fn app_is_active() -> bool {
        false
    }

    pub fn install_glass(_native: &crate::platform::NativeWindow, _radius: f64) -> bool {
        false
    }
}

pub const SLIDE_IN: Duration = Duration::from_millis(220);
pub const FADE_OUT: Duration = Duration::from_millis(160);
pub const REFLOW: Duration = Duration::from_millis(220);

pub fn motion(cx: &App, duration: Duration) -> Duration {
    if cx.reduce_motion() {
        Duration::ZERO
    } else {
        duration
    }
}

pub fn window_title(window: &mut Window, title: &str) {
    window.set_window_title(title);
}

pub fn can_move_windows() -> bool {
    cfg!(target_os = "macos")
}

/// Off macOS GPUI can only resize a window from its left edge. For a window
/// that sits against the right of the screen, resize it keeping its right
/// edge where it is (Windows and X11). False where the platform cannot place
/// windows (macOS uses its own panel; Wayland never lets apps position), so
/// the caller resizes the ordinary way.
pub fn resize_keeping_right_edge(window: &Window, width: f64, height: f64) -> bool {
    #[cfg(target_os = "windows")]
    {
        let Some(native) = crate::platform::native_window(window) else {
            return false;
        };
        let scale = f64::from(window.scale_factor());
        let (x, y, w, _) = crate::platform::window_frame(&native);
        if w <= 0. {
            return false;
        }
        let new_w = (width * scale).round();
        crate::platform::set_window_frame(
            &native,
            x + w - new_w,
            y,
            new_w,
            (height * scale).round(),
        );
        true
    }
    #[cfg(target_os = "linux")]
    {
        x11_resize_keeping_right_edge(window, width, height).unwrap_or(false)
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = (window, width, height);
        false
    }
}

#[cfg(target_os = "linux")]
fn x11_resize_keeping_right_edge(window: &Window, width: f64, height: f64) -> anyhow::Result<bool> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{ConfigureWindowAux, ConnectionExt};

    let id = match HasWindowHandle::window_handle(window)?.as_raw() {
        RawWindowHandle::Xlib(handle) => u32::try_from(handle.window)?,
        RawWindowHandle::Xcb(handle) => handle.window.get(),
        _ => return Ok(false),
    };
    let (connection, screen) = x11rb::connect(None)?;
    let root = connection.setup().roots[screen].root;
    let geometry = connection.get_geometry(id)?.reply()?;
    let at = connection.translate_coordinates(id, root, 0, 0)?.reply()?;
    let scale = f64::from(window.scale_factor());
    let new_w = (width * scale).round().max(1.) as u32;
    let new_h = (height * scale).round().max(1.) as u32;
    let x = i32::from(at.dst_x) + i32::from(geometry.width) - new_w as i32;
    let y = i32::from(at.dst_y);
    if connection.query_tree(id)?.reply()?.parent != root {
        // Framed by a window manager: ConfigureWindow positions would be
        // the frame's, so leave it to the ordinary resize. (The indicator is
        // an override-redirect popup, which no manager frames.)
        return Ok(false);
    }
    connection
        .configure_window(
            id,
            &ConfigureWindowAux::new()
                .x(x)
                .y(y)
                .width(new_w)
                .height(new_h),
        )?
        .check()?;
    connection.flush()?;
    Ok(true)
}
