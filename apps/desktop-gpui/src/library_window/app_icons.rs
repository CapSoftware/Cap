//! The icons of the meeting apps installed on this computer (Zoom, Teams,
//! WhatsApp...), read from the system at runtime: Cap ships no third-party
//! logos. Each app is looked up once, off the main thread, and kept for the
//! window's life. An app that is not installed (or has no icon) is remembered
//! as missing, and the row shows a plain meeting glyph instead.

use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    sync::Arc,
};

use cap_meetings::apps::AppInfo;
use gpui::RenderImage;

/// Pixels per side: a 32 pt icon on a 2x display.
pub const ICON_PX: u32 = 64;

#[derive(Default)]
pub struct AppIcons {
    ready: HashMap<&'static str, Option<Arc<RenderImage>>>,
    loading: HashSet<&'static str>,
    wanted: RefCell<Vec<&'static AppInfo>>,
}

pub enum Icon {
    Image(Arc<RenderImage>),
    /// Draws nothing, but keeps its slot's size so rows don't shift when
    /// the icon arrives.
    Pending,
    Missing,
}

impl AppIcons {
    pub fn get(&self, app: &'static AppInfo) -> Icon {
        match self.ready.get(app.id) {
            Some(Some(image)) => Icon::Image(image.clone()),
            Some(None) => Icon::Missing,
            None => {
                if !self.loading.contains(app.id) {
                    self.wanted.borrow_mut().push(app);
                }
                Icon::Pending
            }
        }
    }

    pub fn take_wanted(&mut self) -> Vec<&'static AppInfo> {
        let mut wanted = std::mem::take(self.wanted.get_mut());
        wanted.sort_by_key(|a| a.id);
        wanted.dedup_by_key(|a| a.id);
        wanted.retain(|a| !self.ready.contains_key(a.id) && self.loading.insert(a.id));
        wanted
    }

    pub fn insert(&mut self, app: &'static AppInfo, image: Option<Arc<RenderImage>>) {
        self.loading.remove(app.id);
        self.ready.insert(app.id, image);
    }
}

/// Reads the installed app's icon at `size` x `size` pixels. Blocking: call
/// it on a background thread.
pub fn lookup(app: &AppInfo, size: u32) -> Option<image::RgbaImage> {
    platform::lookup(app, size)
}

#[cfg(target_os = "macos")]
mod platform {
    use cap_meetings::apps::AppInfo;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};

    /// NSWorkspace finds the app by bundle id (any of the ids the app ships
    /// under); the icon is drawn into a bitmap this thread owns, which AppKit
    /// allows off the main thread.
    pub fn lookup(app: &AppInfo, size: u32) -> Option<image::RgbaImage> {
        app.macos_ids
            .iter()
            .filter(|id| !id.contains('*'))
            .find_map(|id| icon_for_bundle(id, size))
    }

    fn icon_for_bundle(bundle_id: &str, size: u32) -> Option<image::RgbaImage> {
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
            let side = size as isize;
            let rep: *mut AnyObject = msg_send![class!(NSBitmapImageRep), alloc];
            let color_space = NSString::from_str("NSDeviceRGBColorSpace");
            let null_planes: *mut *mut u8 = std::ptr::null_mut();
            let rep: *mut AnyObject = msg_send![
                rep,
                initWithBitmapDataPlanes: null_planes,
                pixelsWide: side,
                pixelsHigh: side,
                bitsPerSample: 8isize,
                samplesPerPixel: 4isize,
                hasAlpha: true,
                isPlanar: false,
                colorSpaceName: &*color_space,
                bytesPerRow: side * 4,
                bitsPerPixel: 32isize
            ];
            let rep: Retained<AnyObject> = Retained::from_raw(rep)?;
            let context: *mut AnyObject = msg_send![
                class!(NSGraphicsContext),
                graphicsContextWithBitmapImageRep: &*rep
            ];
            if context.is_null() {
                return None;
            }
            let _: () = msg_send![class!(NSGraphicsContext), saveGraphicsState];
            let _: () = msg_send![class!(NSGraphicsContext), setCurrentContext: context];
            let zero = NSRect::new(NSPoint::new(0., 0.), NSSize::new(0., 0.));
            let side_f = size as f64;
            let _: () = msg_send![
                icon,
                drawInRect: NSRect::new(NSPoint::new(0., 0.), NSSize::new(side_f, side_f)),
                fromRect: zero,
                operation: 2usize,
                fraction: 1.0f64
            ];
            let _: () = msg_send![context, flushGraphics];
            let _: () = msg_send![class!(NSGraphicsContext), restoreGraphicsState];
            let data: *const u8 = msg_send![&*rep, bitmapData];
            if data.is_null() {
                return None;
            }
            let len = (size * size * 4) as usize;
            let mut pixels = std::slice::from_raw_parts(data, len).to_vec();
            super::unpremultiply(&mut pixels);
            image::RgbaImage::from_raw(size, size, pixels)
        })
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use cap_meetings::apps::AppInfo;

    pub fn lookup(app: &AppInfo, size: u32) -> Option<image::RgbaImage> {
        let dirs = super::freedesktop::Dirs::from_env();
        let path = super::freedesktop::icon_path(&dirs, app.linux_names, app.name, size)?;
        super::freedesktop::load(&path, size)
    }
}

/// Windows: not read yet, so meetings show the meeting glyph there.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod platform {
    use cap_meetings::apps::AppInfo;

    pub fn lookup(_app: &AppInfo, _size: u32) -> Option<image::RgbaImage> {
        None
    }
}

/// AppKit hands back premultiplied pixels; `image` and the GPU atlas want
/// straight alpha.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn unpremultiply(pixels: &mut [u8]) {
    for px in pixels.chunks_exact_mut(4) {
        let a = px[3] as u32;
        if a != 0 && a != 255 {
            for c in &mut px[..3] {
                *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
}

/// The freedesktop way: the app's `.desktop` entry names an icon, found in
/// the icon theme folders. Plain file reads, so it is tested on every OS.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) mod freedesktop {
    use std::path::{Path, PathBuf};

    pub struct Dirs {
        /// `.../share` roots, most specific first.
        pub data: Vec<PathBuf>,
    }

    impl Dirs {
        pub fn from_env() -> Self {
            let mut data = Vec::new();
            let home = std::env::var_os("HOME").map(PathBuf::from);
            match std::env::var_os("XDG_DATA_HOME") {
                Some(dir) if !dir.is_empty() => data.push(PathBuf::from(dir)),
                _ => {
                    if let Some(home) = &home {
                        data.push(home.join(".local/share"));
                    }
                }
            }
            if let Some(home) = &home {
                data.push(home.join(".local/share/flatpak/exports/share"));
            }
            data.push(PathBuf::from("/var/lib/flatpak/exports/share"));
            data.push(PathBuf::from("/var/lib/snapd/desktop"));
            let system = std::env::var("XDG_DATA_DIRS")
                .ok()
                .filter(|d| !d.is_empty())
                .unwrap_or_else(|| "/usr/local/share:/usr/share".into());
            data.extend(
                system
                    .split(':')
                    .filter(|d| !d.is_empty())
                    .map(PathBuf::from),
            );
            Self { data }
        }
    }

    /// The icon file for the first installed `.desktop` entry that matches
    /// one of the app's Linux names (file name or `Exec` binary), or failing
    /// that its display name.
    pub fn icon_path(dirs: &Dirs, names: &[&str], display: &str, size: u32) -> Option<PathBuf> {
        let icon = desktop_icon(dirs, names, display)?;
        let as_path = Path::new(&icon);
        if as_path.is_absolute() {
            return as_path.is_file().then(|| as_path.to_path_buf());
        }
        themed(dirs, &icon, size)
    }

    fn desktop_icon(dirs: &Dirs, names: &[&str], display: &str) -> Option<String> {
        let mut by_name = None;
        for root in &dirs.data {
            let Ok(entries) = std::fs::read_dir(root.join("applications")) else {
                continue;
            };
            let mut entries: Vec<PathBuf> = entries
                .filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|e| e == "desktop"))
                .collect();
            entries.sort();
            for path in entries {
                let stem = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default();
                let Ok(text) = std::fs::read_to_string(&path) else {
                    continue;
                };
                let entry = Entry::parse(&text);
                let Some(icon) = entry.icon else {
                    continue;
                };
                let matches_id = names.iter().any(|n| {
                    stem.eq_ignore_ascii_case(n)
                        || entry
                            .exec
                            .as_deref()
                            .is_some_and(|exec| exec.eq_ignore_ascii_case(n))
                });
                if matches_id {
                    return Some(icon);
                }
                if by_name.is_none()
                    && entry
                        .name
                        .as_deref()
                        .is_some_and(|n| n.eq_ignore_ascii_case(display))
                {
                    by_name = Some(icon);
                }
            }
        }
        by_name
    }

    #[derive(Default)]
    struct Entry {
        name: Option<String>,
        icon: Option<String>,
        /// The binary's file name from `Exec`, not the whole command line.
        exec: Option<String>,
    }

    impl Entry {
        fn parse(text: &str) -> Self {
            let mut entry = Entry::default();
            let mut in_main = false;
            for line in text.lines() {
                let line = line.trim();
                if line.starts_with('[') {
                    in_main = line == "[Desktop Entry]";
                    continue;
                }
                if !in_main {
                    continue;
                }
                let Some((key, value)) = line.split_once('=') else {
                    continue;
                };
                let value = value.trim();
                match key.trim() {
                    "Name" if entry.name.is_none() => entry.name = Some(value.to_string()),
                    "Icon" if !value.is_empty() => entry.icon = Some(value.to_string()),
                    "Exec" => {
                        entry.exec = value
                            .split_whitespace()
                            .find(|w| !w.contains('='))
                            .map(|w| w.trim_matches('"'))
                            .and_then(|w| w.rsplit('/').next())
                            .map(str::to_string);
                    }
                    _ => {}
                }
            }
            entry
        }
    }

    /// `hicolor` is where apps install their own icons; pixmaps is the old
    /// fallback. The nearest size at or above `size` wins, then the biggest
    /// below it, then a scalable SVG.
    fn themed(dirs: &Dirs, icon: &str, size: u32) -> Option<PathBuf> {
        const SIZES: [u32; 9] = [16, 22, 24, 32, 48, 64, 96, 128, 256];
        let mut order: Vec<u32> = SIZES.iter().copied().filter(|s| *s >= size).collect();
        order.extend(SIZES.iter().rev().copied().filter(|s| *s < size));
        let mut roots: Vec<PathBuf> = dirs.data.iter().map(|d| d.join("icons")).collect();
        if let Some(home) = std::env::var_os("HOME") {
            roots.insert(0, PathBuf::from(home).join(".icons"));
        }
        for root in &roots {
            let theme = root.join("hicolor");
            for s in &order {
                let png = theme.join(format!("{s}x{s}/apps/{icon}.png"));
                if png.is_file() {
                    return Some(png);
                }
            }
            let svg = theme.join(format!("scalable/apps/{icon}.svg"));
            if svg.is_file() {
                return Some(svg);
            }
        }
        for root in &dirs.data {
            for ext in ["png", "svg"] {
                let path = root.join(format!("pixmaps/{icon}.{ext}"));
                if path.is_file() {
                    return Some(path);
                }
            }
        }
        None
    }

    /// The icon file as `size` x `size` straight-alpha pixels.
    pub fn load(path: &Path, size: u32) -> Option<image::RgbaImage> {
        if path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("svg"))
        {
            let data = std::fs::read(path).ok()?;
            let tree =
                resvg::usvg::Tree::from_data(&data, &resvg::usvg::Options::default()).ok()?;
            let mut pixmap = resvg::tiny_skia::Pixmap::new(size, size)?;
            let bounds = tree.size();
            let scale = (size as f32 / bounds.width()).min(size as f32 / bounds.height());
            let transform = resvg::tiny_skia::Transform::from_translate(
                (size as f32 - bounds.width() * scale) / 2.0,
                (size as f32 - bounds.height() * scale) / 2.0,
            )
            .pre_scale(scale, scale);
            resvg::render(&tree, transform, &mut pixmap.as_mut());
            let mut pixels = pixmap.take();
            super::unpremultiply(&mut pixels);
            return image::RgbaImage::from_raw(size, size, pixels);
        }
        let decoded = image::open(path).ok()?.into_rgba8();
        Some(if decoded.width() == size && decoded.height() == size {
            decoded
        } else {
            image::imageops::resize(&decoded, size, size, image::imageops::FilterType::Lanczos3)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(id: &str) -> &'static AppInfo {
        cap_meetings::apps::app_by_id(id).expect("known app")
    }

    #[test]
    fn an_app_is_looked_up_once_and_a_missing_icon_is_remembered() {
        let mut icons = AppIcons::default();
        let zoom = app("zoom");
        assert!(matches!(icons.get(zoom), Icon::Pending));
        assert!(matches!(icons.get(zoom), Icon::Pending));
        let wanted = icons.take_wanted();
        assert_eq!(wanted.len(), 1);
        assert_eq!(wanted[0].id, "zoom");
        icons.get(zoom);
        assert!(icons.take_wanted().is_empty(), "never twice while loading");
        icons.insert(zoom, None);
        assert!(matches!(icons.get(zoom), Icon::Missing));
        assert!(
            icons.take_wanted().is_empty(),
            "a missing app is not retried"
        );
    }

    #[test]
    fn premultiplied_pixels_come_back_straight() {
        let mut px = vec![64, 32, 0, 128, 10, 20, 30, 255, 0, 0, 0, 0];
        unpremultiply(&mut px);
        assert_eq!(px, vec![128, 64, 0, 128, 10, 20, 30, 255, 0, 0, 0, 0]);
    }

    mod freedesktop_lookup {
        use super::super::freedesktop::{Dirs, icon_path, load};
        use std::path::Path;

        fn write(path: &Path, bytes: &[u8]) {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }

        fn png(path: &Path, side: u32) {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            image::RgbaImage::from_pixel(side, side, image::Rgba([10, 140, 250, 255]))
                .save(path)
                .unwrap();
        }

        #[test]
        fn the_desktop_entry_names_a_themed_icon_and_the_nearest_size_wins() {
            let tmp = tempfile::tempdir().unwrap();
            let share = tmp.path().join("share");
            write(
                &share.join("applications/Zoom.desktop"),
                b"[Desktop Entry]\nName=Zoom Workplace\nExec=/opt/zoom/ZoomLauncher %U\nIcon=Zoom\n[Desktop Action New]\nIcon=other\n",
            );
            png(&share.join("icons/hicolor/32x32/apps/Zoom.png"), 32);
            png(&share.join("icons/hicolor/128x128/apps/Zoom.png"), 128);
            let dirs = Dirs {
                data: vec![share.clone()],
            };
            let found = icon_path(&dirs, &["zoom"], "Zoom", 64).expect("found by file name");
            assert!(found.ends_with("128x128/apps/Zoom.png"), "{found:?}");
            let image = load(&found, 64).unwrap();
            assert_eq!(image.dimensions(), (64, 64));
        }

        #[test]
        fn exec_binary_and_display_name_also_match_and_absolute_icons_work() {
            let tmp = tempfile::tempdir().unwrap();
            let share = tmp.path().join("share");
            let abs = tmp.path().join("opt/slack/icon.png");
            png(&abs, 64);
            write(
                &share.join("applications/com.slack.Slack.desktop"),
                format!(
                    "[Desktop Entry]\nName=Slack\nExec=env FOO=1 /usr/bin/slack %U\nIcon={}\n",
                    abs.display()
                )
                .as_bytes(),
            );
            write(
                &share.join("applications/whatever.desktop"),
                b"[Desktop Entry]\nName=Signal\nExec=signal-desktop\nIcon=signal\n",
            );
            png(&share.join("pixmaps/signal.png"), 48);
            let dirs = Dirs {
                data: vec![share.clone()],
            };
            assert_eq!(icon_path(&dirs, &["slack"], "Slack", 64), Some(abs));
            let signal = icon_path(&dirs, &["not-installed"], "Signal", 64).unwrap();
            assert!(signal.ends_with("pixmaps/signal.png"));
            assert_eq!(load(&signal, 64).unwrap().dimensions(), (64, 64));
        }

        #[test]
        fn a_scalable_svg_is_rendered_and_a_missing_app_finds_nothing() {
            let tmp = tempfile::tempdir().unwrap();
            let share = tmp.path().join("share");
            write(
                &share.join("applications/discord.desktop"),
                b"[Desktop Entry]\nName=Discord\nExec=Discord\nIcon=discord\n",
            );
            write(
                &share.join("icons/hicolor/scalable/apps/discord.svg"),
                br##"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#5865f2"/></svg>"##,
            );
            let dirs = Dirs {
                data: vec![share.clone()],
            };
            let svg = icon_path(&dirs, &["discord"], "Discord", 64).unwrap();
            let image = load(&svg, 64).unwrap();
            assert_eq!(image.get_pixel(32, 32).0, [0x58, 0x65, 0xf2, 255]);
            assert_eq!(icon_path(&dirs, &["teams"], "Microsoft Teams", 64), None);
        }
    }

    /// Real installed apps on this Mac: every app the meeting detector knows
    /// that is installed gives a full-size icon with real pixels.
    #[cfg(target_os = "macos")]
    #[test]
    fn installed_mac_apps_give_real_icons_off_the_main_thread() {
        let facetime = app("facetime");
        let image = std::thread::spawn(move || lookup(facetime, ICON_PX))
            .join()
            .unwrap()
            .expect("FaceTime ships with macOS");
        assert_eq!(image.dimensions(), (ICON_PX, ICON_PX));
        let opaque = image.pixels().filter(|p| p.0[3] > 200).count();
        assert!(
            opaque > (ICON_PX * ICON_PX / 3) as usize,
            "{opaque} opaque pixels"
        );
        if let Some(dir) = std::env::var_os("CAP_AU_ICON_DUMP") {
            for app in cap_meetings::apps::all_apps() {
                if let Some(image) = lookup(app, ICON_PX) {
                    image
                        .save(std::path::Path::new(&dir).join(format!("{}.png", app.id)))
                        .unwrap();
                }
            }
        }
    }
}
