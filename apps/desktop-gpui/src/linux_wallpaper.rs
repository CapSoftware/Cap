//! The desktop's wallpaper on Linux, for the editor's "Use the wallpaper from
//! your desktop" background. Every desktop keeps it somewhere else: GNOME and
//! its forks in GSettings, Plasma in its applets config, XFCE in xfconf, COSMIC
//! in its config dir, and wlroots compositors in whichever program draws it
//! (swaybg, swww, hyprpaper).

use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Source {
    Gnome,
    Cinnamon,
    Mate,
    Plasma,
    Xfce,
    Cosmic,
    Swaybg,
    Swww,
    Hyprpaper,
}

/// Where to look, in order, for an `XDG_CURRENT_DESKTOP` value. GSettings is
/// only read for desktops that use it: elsewhere its schema still answers,
/// with GNOME's default picture rather than the one on screen.
fn sources(current_desktop: &str) -> Vec<Source> {
    let desktops: Vec<String> = current_desktop
        .split(':')
        .map(|desktop| desktop.trim().to_ascii_lowercase())
        .collect();
    let has = |names: &[&str]| desktops.iter().any(|desktop| names.contains(&desktop.as_str()));
    let mut sources = Vec::new();
    if has(&["kde"]) {
        sources.push(Source::Plasma);
    }
    if has(&["x-cinnamon", "cinnamon"]) {
        sources.push(Source::Cinnamon);
    }
    if has(&["mate"]) {
        sources.push(Source::Mate);
    }
    if has(&["xfce"]) {
        sources.push(Source::Xfce);
    }
    if has(&["cosmic"]) {
        sources.push(Source::Cosmic);
    }
    if sources.is_empty() && has(&["gnome", "unity", "budgie", "pantheon", "ubuntu"]) {
        sources.push(Source::Gnome);
    }
    sources.extend([Source::Swaybg, Source::Swww, Source::Hyprpaper]);
    sources
}

pub fn current() -> Option<PathBuf> {
    let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")));
    for source in sources(&desktop) {
        let found = match source {
            Source::Gnome => gnome(),
            Source::Cinnamon => gsettings("org.cinnamon.desktop.background", "picture-uri")
                .and_then(|value| file_uri_path(&value)),
            Source::Mate => gsettings("org.mate.background", "picture-filename")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from),
            Source::Plasma => config.as_deref().and_then(plasma),
            Source::Xfce => xfce(),
            Source::Cosmic => config.as_deref().and_then(cosmic),
            Source::Swaybg => swaybg(),
            Source::Swww => run("swww", &["query"]).and_then(|out| swww_image(&out)),
            Source::Hyprpaper => std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE")
                .and_then(|_| run("hyprctl", &["hyprpaper", "listactive"]))
                .and_then(|out| hyprpaper_image(&out)),
        };
        if let Some(path) = found.and_then(|path| resolve(&path)) {
            tracing::info!(?source, path = %path.display(), "found the desktop wallpaper");
            return Some(path);
        }
    }
    tracing::info!(%desktop, "found no desktop wallpaper");
    None
}

fn resolve(path: &Path) -> Option<PathBuf> {
    if path.is_dir() {
        return wallpaper_package_image(path);
    }
    if is_xml(path) {
        // One step only: a slideshow that names another slideshow, or
        // itself, is not followed.
        let xml = std::fs::read_to_string(path).ok()?;
        return slideshow_image(&xml).filter(|image| image.is_file() && !is_xml(image));
    }
    path.is_file().then(|| path.to_path_buf())
}

fn is_xml(path: &Path) -> bool {
    path.extension().is_some_and(|extension| extension == "xml")
}

/// Runs a desktop's settings tool for one value. Two seconds at most: the
/// wallpaper is never worth a stuck editor.
fn run(program: &str, args: &[&str]) -> Option<String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => return None,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    Some(out)
}

fn gsettings(schema: &str, key: &str) -> Option<String> {
    run("gsettings", &["get", schema, key]).and_then(|out| gvariant_string(&out))
}

/// GNOME shows `picture-uri-dark` under the dark style, when it is set.
fn gnome() -> Option<PathBuf> {
    let dark = gsettings("org.gnome.desktop.interface", "color-scheme")
        .is_some_and(|scheme| scheme == "prefer-dark");
    let schema = "org.gnome.desktop.background";
    dark.then(|| gsettings(schema, "picture-uri-dark"))
        .flatten()
        .and_then(|value| file_uri_path(&value))
        .or_else(|| gsettings(schema, "picture-uri").and_then(|value| file_uri_path(&value)))
}

/// `gsettings get` prints a GVariant: `'file:///a/b.png'`, quotes escaped.
fn gvariant_string(printed: &str) -> Option<String> {
    let printed = printed.trim();
    let inner = printed
        .strip_prefix('\'')
        .and_then(|rest| rest.strip_suffix('\''))
        .or_else(|| printed.strip_prefix('"').and_then(|rest| rest.strip_suffix('"')))?;
    let mut value = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            value.extend(chars.next());
        } else {
            value.push(c);
        }
    }
    Some(value)
}

fn file_uri_path(value: &str) -> Option<PathBuf> {
    let value = value.trim();
    if value.starts_with('/') {
        return Some(PathBuf::from(value));
    }
    let rest = value.strip_prefix("file://")?;
    let path = rest.strip_prefix("localhost").unwrap_or(rest);
    if !path.starts_with('/') {
        return None;
    }
    let bytes = path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && let Some(byte) = bytes
                .get(index + 1..index + 3)
                .and_then(|hex| std::str::from_utf8(hex).ok())
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
        {
            decoded.push(byte);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    use std::os::unix::ffi::OsStringExt;
    Some(PathBuf::from(std::ffi::OsString::from_vec(decoded)))
}

/// The first `Image=` of a desktop containment's wallpaper; Plasma's own
/// default package when it has none.
fn plasma(config: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(config.join("plasma-org.kde.plasma.desktop-appletsrc"))
        .unwrap_or_default();
    plasma_image(&text).or_else(|| {
        let default = PathBuf::from("/usr/share/wallpapers/Next");
        default.is_dir().then_some(default)
    })
}

fn plasma_image(appletsrc: &str) -> Option<PathBuf> {
    let mut in_image_section = false;
    for line in appletsrc.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_image_section = line.starts_with("[Containments]")
                && line.ends_with("[Wallpaper][org.kde.image][General]");
            continue;
        }
        if in_image_section
            && let Some(value) = line.strip_prefix("Image=")
            && let Some(path) = file_uri_path(value)
        {
            return Some(path);
        }
    }
    None
}

fn wallpaper_package_image(package: &Path) -> Option<PathBuf> {
    let images = std::fs::read_dir(package.join("contents/images")).ok()?;
    images
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .max_by_key(|path| {
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .and_then(|stem| stem.split_once('x'))
                .and_then(|(width, height)| Some(width.parse::<u64>().ok()? * height.parse::<u64>().ok()?))
                .unwrap_or(0)
        })
}

fn slideshow_image(xml: &str) -> Option<PathBuf> {
    let mut best: Option<(u64, &str)> = None;
    for part in xml.split("<size").skip(1) {
        let Some((attributes, rest)) = part.split_once('>') else {
            continue;
        };
        let Some((path, _)) = rest.split_once("</size>") else {
            continue;
        };
        let attribute = |name: &str| {
            attributes
                .split_once(&format!("{name}=\""))
                .and_then(|(_, value)| value.split_once('"'))
                .and_then(|(value, _)| value.parse::<u64>().ok())
                .unwrap_or(0)
        };
        let area = attribute("width") * attribute("height");
        if best.is_none_or(|(largest, _)| area > largest) {
            best = Some((area, path.trim()));
        }
    }
    if let Some((_, path)) = best {
        return Some(PathBuf::from(xml_text(path)));
    }
    let (_, rest) = xml.split_once("<file>")?;
    let (path, _) = rest.split_once("</file>")?;
    Some(PathBuf::from(xml_text(path.trim())))
}

fn xml_text(text: &str) -> String {
    let mut decoded = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        decoded.push_str(&rest[..start]);
        rest = &rest[start..];
        let entity = rest.find(';').map(|end| (&rest[1..end], end));
        let character = entity.and_then(|(name, _)| match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => name
                .strip_prefix("#x")
                .or_else(|| name.strip_prefix("#X"))
                .map(|hex| u32::from_str_radix(hex, 16))
                .or_else(|| name.strip_prefix('#').map(str::parse::<u32>))
                .and_then(Result::ok)
                .and_then(char::from_u32),
        });
        match (character, entity) {
            (Some(character), Some((_, end))) => {
                decoded.push(character);
                rest = &rest[end + 1..];
            }
            _ => {
                decoded.push('&');
                rest = &rest[1..];
            }
        }
    }
    decoded.push_str(rest);
    decoded
}

fn xfce() -> Option<PathBuf> {
    let properties = run("xfconf-query", &["-c", "xfce4-desktop", "-l"])?;
    let mut images: Vec<&str> = properties
        .lines()
        .map(str::trim)
        .filter(|property| property.ends_with("/last-image"))
        .collect();
    images.sort_unstable();
    images.into_iter().find_map(|property| {
        run("xfconf-query", &["-c", "xfce4-desktop", "-p", property])
            .map(|value| PathBuf::from(value.trim()))
            .filter(|path| path.is_absolute())
    })
}

fn cosmic(config: &Path) -> Option<PathBuf> {
    let text =
        std::fs::read_to_string(config.join("cosmic/com.system76.CosmicBackground/v1/all")).ok()?;
    cosmic_image(&text)
}

fn cosmic_image(entry: &str) -> Option<PathBuf> {
    let (_, rest) = entry.split_once("Path(\"")?;
    let (path, _) = rest.split_once("\")")?;
    Some(PathBuf::from(path))
}

/// The picture swaybg draws, as Omarchy runs it. Only a swaybg of this user,
/// on this Wayland display when both name one: another session's swaybg
/// shows another session's wallpaper.
fn swaybg() -> Option<PathBuf> {
    use std::os::unix::fs::MetadataExt;
    let uid = std::fs::metadata("/proc/self").ok()?.uid();
    let display = std::env::var_os("WAYLAND_DISPLAY");
    for entry in std::fs::read_dir("/proc").ok()?.filter_map(Result::ok) {
        let dir = entry.path();
        if std::fs::read_to_string(dir.join("comm")).is_ok_and(|comm| comm.trim() == "swaybg")
            && std::fs::metadata(&dir).is_ok_and(|metadata| metadata.uid() == uid)
            && same_display(
                display.as_deref(),
                std::fs::read(dir.join("environ")).ok().as_deref(),
            )
            && let Ok(cmdline) = std::fs::read(dir.join("cmdline"))
            && let Some(image) = swaybg_image(&cmdline)
        {
            if image.is_absolute() {
                return Some(image);
            }
            if let Ok(cwd) = std::fs::read_link(dir.join("cwd")) {
                return Some(cwd.join(image));
            }
        }
    }
    None
}

fn same_display(ours: Option<&std::ffi::OsStr>, environ: Option<&[u8]>) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let theirs = environ.and_then(|environ| {
        environ
            .split(|byte| *byte == 0)
            .find_map(|variable| variable.strip_prefix(b"WAYLAND_DISPLAY="))
    });
    match (ours, theirs) {
        (Some(ours), Some(theirs)) => ours.as_bytes() == theirs,
        _ => true,
    }
}

fn swaybg_image(cmdline: &[u8]) -> Option<PathBuf> {
    let mut args = cmdline
        .split(|byte| *byte == 0)
        .map(|arg| String::from_utf8_lossy(arg).into_owned());
    while let Some(arg) = args.next() {
        if arg == "-i" || arg == "--image" {
            return args.next().map(PathBuf::from);
        }
        if let Some(path) = arg.strip_prefix("--image=") {
            return Some(PathBuf::from(path));
        }
    }
    None
}

fn swww_image(query: &str) -> Option<PathBuf> {
    query.lines().find_map(|line| {
        let (_, path) = line.split_once("image: ")?;
        let path = PathBuf::from(path.trim());
        path.is_absolute().then_some(path)
    })
}

fn hyprpaper_image(listed: &str) -> Option<PathBuf> {
    listed.lines().find_map(|line| {
        let (_, path) = line.split_once(" = ")?;
        let path = PathBuf::from(path.trim());
        path.is_absolute().then_some(path)
    })
}

/// JPEG XL, GNOME's own wallpaper format, which the image crate cannot read.
/// `None` for any other file.
pub fn decode_jpeg_xl(path: &Path) -> Option<Result<image::DynamicImage, String>> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut signature = [0u8; 12];
    let read = file.read(&mut signature).ok()?;
    if !is_jpeg_xl(&signature[..read]) {
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    Some(
        jxl_oxide::integration::JxlDecoder::new(std::io::BufReader::new(file))
            .and_then(image::DynamicImage::from_decoder)
            .map_err(|error| format!("Failed to decode JPEG XL image: {error}")),
    )
}

fn is_jpeg_xl(head: &[u8]) -> bool {
    head.starts_with(&[0xFF, 0x0A])
        || head.starts_with(&[0, 0, 0, 0x0C, b'J', b'X', b'L', b' ', 0x0D, 0x0A, 0x87, 0x0A])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_desktop_reads_its_own_setting_then_the_wallpaper_programs() {
        let programs = [Source::Swaybg, Source::Swww, Source::Hyprpaper];
        let with = |first: &[Source]| [first, &programs[..]].concat();
        assert_eq!(sources("ubuntu:GNOME"), with(&[Source::Gnome]));
        assert_eq!(sources("Budgie:GNOME"), with(&[Source::Gnome]));
        assert_eq!(sources("KDE"), with(&[Source::Plasma]));
        assert_eq!(sources("X-Cinnamon"), with(&[Source::Cinnamon]));
        assert_eq!(sources("MATE"), with(&[Source::Mate]));
        assert_eq!(sources("XFCE"), with(&[Source::Xfce]));
        assert_eq!(sources("COSMIC"), with(&[Source::Cosmic]));
        // Hyprland, niri, sway: GSettings would answer with GNOME's default.
        assert_eq!(sources("Hyprland"), with(&[]));
        assert_eq!(sources("niri"), with(&[]));
        assert_eq!(sources(""), with(&[]));
    }

    #[test]
    fn gsettings_values_and_file_uris_become_paths() {
        assert_eq!(
            gvariant_string("'file:///usr/share/backgrounds/gnome/adwaita-l.jxl'\n").as_deref(),
            Some("file:///usr/share/backgrounds/gnome/adwaita-l.jxl")
        );
        assert_eq!(gvariant_string(r"'it\'s'").as_deref(), Some("it's"));
        assert_eq!(gvariant_string("''").as_deref(), Some(""));
        assert_eq!(gvariant_string("@as []"), None);
        assert_eq!(
            file_uri_path("file:///home/a/My%20Pictures/caf%C3%A9.png"),
            Some(PathBuf::from("/home/a/My Pictures/café.png"))
        );
        assert_eq!(
            file_uri_path("file://localhost/a.png"),
            Some(PathBuf::from("/a.png"))
        );
        assert_eq!(file_uri_path("/a/b.png"), Some(PathBuf::from("/a/b.png")));
        assert_eq!(file_uri_path("100%.png"), None);
        assert_eq!(file_uri_path("https://example.com/a.png"), None);
        assert_eq!(file_uri_path(""), None);
    }

    #[test]
    fn plasma_reads_the_desktop_containments_image() {
        let appletsrc = "\
[Containments][1][General]
Image=file:///not/this.png

[Containments][2][Wallpaper][org.kde.image][General]
Image=file:///usr/share/wallpapers/Mountain/
SlidePaths=/usr/share/wallpapers/

[Containments][3][Wallpaper][org.kde.image][General]
Image=/home/a/second.png
";
        assert_eq!(
            plasma_image(appletsrc),
            Some(PathBuf::from("/usr/share/wallpapers/Mountain/"))
        );
        assert_eq!(plasma_image("[Containments][2][Applets]\nImage=/x.png\n"), None);
    }

    #[test]
    fn wallpaper_packages_and_slideshows_give_their_largest_picture() {
        let root = tempfile::tempdir().unwrap();
        let images = root.path().join("Next/contents/images");
        std::fs::create_dir_all(&images).unwrap();
        for name in ["1920x1080.png", "5120x2880.png", "1366x768.png", "screenshot.png"] {
            std::fs::write(images.join(name), b"x").unwrap();
        }
        assert_eq!(
            resolve(&root.path().join("Next")),
            Some(images.join("5120x2880.png"))
        );

        let slideshow = format!(
            "<wallpapers><wallpaper><filename>{}</filename></wallpaper></wallpapers>\
             <background><static><file>\
             <size width=\"1024\" height=\"768\">/small.png</size>\
             <size width=\"3840\" height=\"2160\">{}</size>\
             </file></static></background>",
            "/ignored.png",
            images.join("1920x1080.png").display()
        );
        let xml = root.path().join("show.xml");
        std::fs::write(&xml, slideshow).unwrap();
        assert_eq!(resolve(&xml), Some(images.join("1920x1080.png")));
        assert_eq!(
            slideshow_image("<static><file>\n  /a/day.jpg\n</file></static>"),
            Some(PathBuf::from("/a/day.jpg"))
        );
        assert_eq!(resolve(&root.path().join("missing.png")), None);

        // A slideshow naming itself or another slideshow stops there.
        let looping = root.path().join("loop.xml");
        std::fs::write(
            &looping,
            format!("<static><file>{}</file></static>", looping.display()),
        )
        .unwrap();
        assert_eq!(resolve(&looping), None);
    }

    #[test]
    fn slideshow_paths_decode_xml_text() {
        assert_eq!(
            slideshow_image("<static><file>/a/Sea &amp; Sky &#233;t&#xE9;.jpg</file></static>"),
            Some(PathBuf::from("/a/Sea & Sky été.jpg"))
        );
        assert_eq!(xml_text("&lt;&gt;&quot;&apos;"), "<>\"'");
        assert_eq!(xml_text("AT&T &bogus; 5 & 6"), "AT&T &bogus; 5 & 6");
    }

    #[test]
    fn swaybg_is_only_read_on_this_wayland_display() {
        let ours = Some(std::ffi::OsStr::new("wayland-1"));
        assert!(same_display(ours, Some(b"HOME=/h\0WAYLAND_DISPLAY=wayland-1\0")));
        assert!(!same_display(ours, Some(b"WAYLAND_DISPLAY=wayland-0\0")));
        assert!(same_display(ours, Some(b"HOME=/h\0")));
        assert!(same_display(ours, None));
        assert!(same_display(None, Some(b"WAYLAND_DISPLAY=wayland-0\0")));
    }

    #[test]
    fn wallpaper_programs_name_their_picture() {
        assert_eq!(
            swaybg_image(b"swaybg\0-i\0/home/a/.config/omarchy/current/background\0-m\0fill\0"),
            Some(PathBuf::from("/home/a/.config/omarchy/current/background"))
        );
        assert_eq!(
            swaybg_image(b"swaybg\0-o\0DP-1\0--image=/a.png\0"),
            Some(PathBuf::from("/a.png"))
        );
        assert_eq!(swaybg_image(b"swaybg\0-c\0#000000\0"), None);
        assert_eq!(
            swww_image("eDP-1: 2880x1800, scale: 2, currently displaying: image: /w/a.jpg\n"),
            Some(PathBuf::from("/w/a.jpg"))
        );
        assert_eq!(
            swww_image("eDP-1: 2880x1800, scale: 2, currently displaying: color: 000000\n"),
            None
        );
        assert_eq!(
            hyprpaper_image("eDP-1 = /w/b.png\nDP-2 = /w/c.png\n"),
            Some(PathBuf::from("/w/b.png"))
        );
        assert_eq!(hyprpaper_image("no wallpapers active\n"), None);
        assert_eq!(
            cosmic_image("(\n    output: \"all\",\n    source: Path(\"/usr/share/backgrounds/cosmic/a.jpg\"),\n)"),
            Some(PathBuf::from("/usr/share/backgrounds/cosmic/a.jpg"))
        );
    }

    #[test]
    fn jpeg_xl_is_recognised_by_its_signature() {
        assert!(is_jpeg_xl(&[0xFF, 0x0A, 0x00]));
        assert!(is_jpeg_xl(&[
            0, 0, 0, 0x0C, b'J', b'X', b'L', b' ', 0x0D, 0x0A, 0x87, 0x0A
        ]));
        assert!(!is_jpeg_xl(&[0x89, b'P', b'N', b'G']));
        assert!(!is_jpeg_xl(&[0xFF, 0xD8, 0xFF]));
        assert!(!is_jpeg_xl(&[]));
    }
}
