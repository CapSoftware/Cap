//! Embedded assets.
//!
//! There are only a few dozen files, so they are baked in with `include_bytes!`
//! rather than pulling in `rust_embed` for a directory walk we can spell out by
//! hand. The [`AssetSource`] impl is load-bearing, not just tidy: gpui's `svg()`
//! element resolves every icon path through it, and an unregistered path fails
//! silently -- the element lays out at its declared size and draws nothing.

use std::borrow::Cow;

use gpui::{App, AssetSource, Result, SharedString};

/// Expands to `(path, bytes)` pairs rooted at `assets/`.
macro_rules! assets {
    ($dir:literal: $($name:literal),* $(,)?) => {
        &[$((
            concat!($dir, "/", $name),
            include_bytes!(concat!("../assets/", $dir, "/", $name)) as &[u8],
        )),*]
    };
}

const FONTS: &[(&str, &[u8])] = assets!("fonts":
    "Inter.ttf",
    "FacultyGlyphic-Regular.ttf",
);

const UI_ASSETS: &[(&str, &[u8])] = assets!("ui":
    "tooltip-pointer.svg",
);

const SOLAR_ICONS: &[(&str, &[u8])] = assets!("solar":
    "settings-bold.svg",
    "bell-bold.svg",
);

/// The generic glyphs are generated from the MIT-licensed Hugeicons free
/// Stroke Rounded package. GPUI uses each SVG's alpha as a tintable glyph;
/// brand art and native window controls are left in their original form.
const ICONS: &[(&str, &[u8])] = assets!("icons":
    "app-window-mac.svg",
    "app-window.svg",
    "ban.svg",
    "globe.svg",
    "area.svg",
    "arrows.svg",
    "audio-on.svg",
    "bell.svg",
    "brush.svg",
    "camera.svg",
    "caret-down.svg",
    "captions.svg",
    "caption-close-windows.svg",
    "caption-maximize-windows.svg",
    "caption-minimize-windows.svg",
    "caption-restore-windows.svg",
    "circle.svg",
    "check.svg",
    "clapperboard.svg",
    "chevron-down.svg",
    "crop.svg",
    "cursor.svg",
    "chevron-left.svg",
    "chevron-right.svg",
    "circle-help.svg",
    "circle-plus.svg",
    "circle-x.svg",
    "enlarge.svg",
    "eye-off.svg",
    "film-cut.svg",
    "flip-horizontal-2.svg",
    "folder.svg",
    "gauge.svg",
    "gear.svg",
    "padding.svg",
    "corners.svg",
    "shadow.svg",
    "bg-blur.svg",
    "laptop.svg",
    "shuffle.svg",
    "gift.svg",
    "hotkeys.svg",
    "image.svg",
    "info.svg",
    "instant.svg",
    "keyboard.svg",
    "layers.svg",
    "layout.svg",
    "logo-full-dark.svg",
    "logo-full.svg",
    "message-bubble.svg",
    "message-square-plus.svg",
    "mic-off.svg",
    "microphone.svg",
    "minus.svg",
    "monitor.svg",
    "more-vertical.svg",
    "next.svg",
    "box-select.svg",
    "columns-2.svg",
    "monitor-outline.svg",
    "music.svg",
    "panel-right.svg",
    "rotate-3d.svg",
    "type.svg",
    "video.svg",
    "pause.svg",
    "pause-circle.svg",
    "person-standing.svg",
    "play.svg",
    "play-circle.svg",
    "plus.svg",
    "presets.svg",
    "prev.svg",
    "rectangle-horizontal.svg",
    "redo.svg",
    "restart.svg",
    "scissors.svg",
    "square.svg",
    "square-play.svg",
    "terminal.svg",
    "trash.svg",
    "triangle-alert.svg",
    "scan-text.svg",
    "screen.svg",
    "screenshot.svg",
    "shield.svg",
    "stop-circle.svg",
    "search.svg",
    "settings.svg",
    "settings-2.svg",
    "undo.svg",
    "unplug.svg",
    "upload-arrow.svg",
    "user-round.svg",
    "window.svg",
    "x.svg",
    "align-center.svg",
    "align-left.svg",
    "align-right.svg",
    "arrow-left-right.svg",
    "download.svg",
    "flip-vertical-2.svg",
    "maximize.svg",
    "mouse-pointer-2.svg",
    "mouse-pointer-ban.svg",
    "move.svg",
    "move-right.svg",
    "palette.svg",
    "ratio.svg",
    "refresh-cw.svg",
    "rotate-ccw.svg",
    "reset.svg",
    "volume-x.svg",
    "gem.svg",
    "sliders-horizontal.svg",
    "zap.svg",
    "zoom-in.svg",
    "zoom-out.svg",
    "link.svg",
    "import.svg",
    "edit.svg",
    "copy.svg",
    "record-fill.svg",
    "warning-bold.svg",
    "traffic-close.svg",
    "circle-check.svg",
    "lock.svg",
    "pencil.svg",
    "arrow-up-right.svg",
    "more-horizontal.svg",
    "save.svg",
    "grip-vertical.svg",
    "chevron-up.svg",
    "arrow-left.svg",
    "arrow-left-to-line.svg",
    "arrow-right-to-line.svg",
    "film.svg",
    "folder-open.svg",
    "folder-down.svg",
    "cloud-upload.svg",
    "webhook.svg",
    "database.svg",
    "google-drive.svg",
);

/// Full-colour art, which `svg()` cannot draw -- it keeps only the alpha. The
/// three theme previews in the settings window's Appearance section are the
/// app's own `~/assets/theme-previews/*.jpg`, drawn with `img()`.
const IMAGES: &[(&str, &[u8])] = assets!("images":
    "auto.jpg",
    "light.jpg",
    "dark.jpg",
);

const ONBOARDING: &[(&str, &[u8])] = &[
    ("onboarding/cloud-1.png", include_bytes!("../../desktop/src/assets/illustrations/cloud-1.png")),
    ("onboarding/cloud-2.png", include_bytes!("../../desktop/src/assets/illustrations/cloud-2.png")),
    ("onboarding/cloud-3.png", include_bytes!("../../desktop/src/assets/illustrations/cloud-3.png")),
    ("onboarding/logo.svg", include_bytes!("../../../packages/ui-solid/icons/logo.svg")),
    ("onboarding/music.mp3", include_bytes!("../../desktop/src/assets/tears-and-fireflies-adi-goldstein.mp3")),
    ("onboarding/cursor-macos.svg", include_bytes!("../../../packages/ui-solid/icons/cursor-macos.svg")),
    ("onboarding/cursor-windows.svg", include_bytes!("../../../packages/ui-solid/icons/cursor-windows.svg")),
    ("onboarding/volume-2.svg", include_bytes!("../assets/icons/volume-2.svg")),
    ("onboarding/volume-x.svg", include_bytes!("../assets/icons/volume-x.svg")),
    ("onboarding/grain.svg", br##"<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><filter id="noiseFilter"><feTurbulence type="fractalNoise" baseFrequency="1.5" numOctaves="3" stitchTiles="stitch"/></filter><rect width="100%" height="100%" filter="url(#noiseFilter)"/></svg>"##),
];

pub struct Assets;

impl Assets {
    fn all() -> impl Iterator<Item = &'static (&'static str, &'static [u8])> {
        FONTS
            .iter()
            .chain(UI_ASSETS.iter())
            .chain(SOLAR_ICONS.iter())
            .chain(ICONS.iter())
            .chain(IMAGES.iter())
            .chain(ONBOARDING.iter())
    }
}

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        Ok(Self::all()
            .find(|(name, _)| *name == path)
            .map(|(_, bytes)| Cow::Borrowed(*bytes)))
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        Ok(Self::all()
            .filter(|(name, _)| name.starts_with(path))
            .map(|(name, _)| SharedString::from(*name))
            .collect())
    }
}

impl Assets {
    pub fn load_fonts(&self, cx: &App) -> Result<()> {
        cx.text_system().add_fonts(
            FONTS
                .iter()
                .map(|(_, bytes)| Cow::Borrowed(*bytes))
                .collect(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every source file that draws icons; both directions of the asset checks
    /// scan the same list.
    const ICON_SOURCES: &[&str] = &[
        include_str!("main_window.rs"),
        // Not a window: the Recents card's per-kind pill and fallback glyphs
        // are named on `MediaKind`, next to the `Recents.tsx` lines they come
        // from, so the table has to scan here too.
        include_str!("library.rs"),
        include_str!("controls_window.rs"),
        include_str!("camera_window.rs"),
        include_str!("target_overlay.rs"),
        include_str!("settings_window.rs"),
        include_str!("settings_pages.rs"),
        include_str!("mode_select_window.rs"),
        include_str!("teleprompter_window.rs"),
        include_str!("editor_window.rs"),
        include_str!("editor_window/frame.rs"),
        include_str!("editor_window/scenes.rs"),
        // The timeline's nine track glyphs and its scene-mode icons are named
        // in the strip's own module, not in the window that hosts it.
        include_str!("editor_timeline.rs"),
        // The config sidebar's field glyphs and the background section's
        // source tiles, same split.
        include_str!("editor_sidebar.rs"),
        // The five later tabs, the colour-grade section and the eight segment
        // panels each name their own glyphs.
        include_str!("editor_tabs.rs"),
        // The cursor tab's style picker and ripple section live one directory
        // down, and the ripple field names its own glyph.
        include_str!("editor_sidebar/cursor.rs"),
        include_str!("editor_color.rs"),
        include_str!("editor_panels.rs"),
        // The crop dialog's ratio / Full / Reset glyphs and the chevron
        // between its two panes.
        include_str!("editor_crop.rs"),
        // The clips sidebar's cards, import menu and record modal.
        include_str!("editor_clips.rs"),
        // The export page's destination cards and share-status glyphs.
        include_str!("editor_export.rs"),
        // The screenshot editor's toolbar, popovers and zoom HUD; the
        // annotation module names the tool and layer glyphs.
        include_str!("screenshot_editor.rs"),
        include_str!("screenshot_annotations.rs"),
        // The crop overlay's own ratio glyph.
        include_str!("screenshot_crop.rs"),
        // `ui::SelectionHeader` names the check and the trash itself.
        include_str!("ui/selection_header.rs"),
        include_str!("ui/radio_cards.rs"),
        include_str!("ui/windows_caption.rs"),
        // The onboarding window's welcome cards and permissions surface; the
        // per-permission row glyphs are named on `OSPermission::icon`.
        include_str!("onboarding_window.rs"),
        include_str!("permissions.rs"),
    ];

    /// Every icon a window asks for must be in the table. gpui draws
    /// nothing at all for a path it cannot resolve, and does not log, so a typo
    /// here is otherwise only visible by looking at the window.
    #[test]
    fn every_referenced_icon_is_embedded() {
        let source = ICON_SOURCES.concat();
        let source = source.as_str();

        let referenced: Vec<&str> = source
            .match_indices("\"icons/")
            .filter_map(|(start, _)| {
                let rest = &source[start + 1..];
                rest.split('"').next()
            })
            .filter(|path| path.ends_with(".svg"))
            .collect();

        assert!(
            !referenced.is_empty(),
            "found no icon references to check -- has main_window.rs stopped \
             spelling paths as string literals?"
        );

        let missing: Vec<&str> = referenced
            .into_iter()
            .filter(|path| Assets.load(path).unwrap().is_none())
            .collect();

        assert!(
            missing.is_empty(),
            "icons referenced but not embedded: {missing:?}"
        );
    }

    /// And the other direction: an icon that stopped being drawn during a
    /// refactor is dead weight in the binary, and nothing else would notice.
    #[test]
    fn every_embedded_icon_is_referenced() {
        let source = ICON_SOURCES.concat();
        let source = source.as_str();

        let unused: Vec<&str> = ICONS
            .iter()
            .map(|(path, _)| *path)
            .filter(|path| !source.contains(path))
            .collect();

        assert!(
            unused.is_empty(),
            "icons embedded but never drawn: {unused:?}"
        );
    }

    /// Same contract for the bitmaps, which `img()` resolves through the
    /// identical `AssetSource` path and fails just as silently.
    #[test]
    fn every_referenced_image_is_embedded_and_vice_versa() {
        let source = ICON_SOURCES.concat();
        let source = source.as_str();

        let referenced: Vec<&str> = source
            .match_indices("\"images/")
            .filter_map(|(start, _)| source[start + 1..].split('"').next())
            .collect();
        assert!(!referenced.is_empty(), "found no image references to check");

        let missing: Vec<&str> = referenced
            .into_iter()
            .filter(|path| Assets.load(path).unwrap().is_none())
            .collect();
        assert!(
            missing.is_empty(),
            "images referenced but not embedded: {missing:?}"
        );

        let unused: Vec<&str> = IMAGES
            .iter()
            .map(|(path, _)| *path)
            .filter(|path| !source.contains(path))
            .collect();
        assert!(
            unused.is_empty(),
            "images embedded but never drawn: {unused:?}"
        );
    }

    #[test]
    fn fonts_and_icons_resolve() {
        assert!(Assets.load("fonts/Inter.ttf").unwrap().is_some());
        assert!(
            Assets
                .load("fonts/FacultyGlyphic-Regular.ttf")
                .unwrap()
                .is_some()
        );
        assert!(Assets.load("icons/camera.svg").unwrap().is_some());
        assert!(Assets.load("icons/nope.svg").unwrap().is_none());
        assert!(Assets.load("images/auto.jpg").unwrap().is_some());
        assert_eq!(Assets.list("fonts").unwrap().len(), FONTS.len());
        assert_eq!(Assets.list("icons").unwrap().len(), ICONS.len());
        assert_eq!(Assets.list("images").unwrap().len(), IMAGES.len());
    }

    #[test]
    fn generated_hugeicons_are_valid_tintable_svgs() {
        let preserved = [
            "icons/logo-full.svg",
            "icons/logo-full-dark.svg",
            "icons/google-drive.svg",
            "icons/caption-close-windows.svg",
            "icons/caption-maximize-windows.svg",
            "icons/caption-minimize-windows.svg",
            "icons/caption-restore-windows.svg",
            "icons/traffic-close.svg",
            // Aeris's drawing-tool brush, kept at its own 28px grid.
            "icons/brush.svg",
            // Aeris's filled Solar reset glyph.
            "icons/reset.svg",
        ];
        let mut count = 0;
        for (path, bytes) in ICONS {
            if preserved.contains(path) {
                continue;
            }
            let svg = std::str::from_utf8(bytes).unwrap();
            assert!(svg.contains("viewBox=\"0 0 24 24\""), "{path}");
            assert!(svg.contains("currentColor"), "{path}");
            resvg::usvg::Tree::from_str(svg, &resvg::usvg::Options::default())
                .unwrap_or_else(|error| panic!("{path}: {error}"));
            count += 1;
        }
        assert_eq!(count, 134);
    }
}
