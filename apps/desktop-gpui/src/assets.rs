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

/// Exactly the three faces the webview loads -- `unplugin-fonts` is configured
/// for `weights: [400, 500, 700]` (`packages/ui-solid/vite.js:31-33`) and
/// nothing else. Deliberately *not* four: there is no SemiBold here because
/// there is none over there, so a Tailwind `font-semibold` (600) finds no 600
/// face and CSS font-matching resolves it up to 700. Embedding a real 600 would
/// let this app render a weight the original cannot, which is how the two
/// drift apart.
const FONTS: &[(&str, &[u8])] = assets!("fonts":
    "Geist.ttf",
    "Geist-Medium.ttf",
    "Geist-Bold.ttf",
);

/// Mostly Cap's own icon set, lifted from `packages/ui-solid/icons`. gpui
/// rasterises an SVG and keeps only its alpha, tinting the result with the
/// element's text colour, so these must be single-colour glyphs -- a full-colour
/// illustration would come out as a filled silhouette.
const ICONS: &[(&str, &[u8])] = assets!("icons":
    "app-window-mac.svg",
    "area.svg",
    "arrows.svg",
    "audio-on.svg",
    "bell.svg",
    "building-2.svg",
    "camera.svg",
    "caret-down.svg",
    "captions.svg",
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
    // The config sidebar's field glyphs. Four are Cap's own
    // (`packages/ui-solid/icons/{padding,corners,shadow,bg-blur}.svg`); the
    // rest of the background section's are Lucide, drawn here from the same
    // 24x24 originals `~icons/lucide/*` resolves to -- laptop (MacBook notch),
    // wind (motion blur), image-off (the "None" source tile). `shuffle` is the
    // gradient editor's own inline randomise glyph (`GradientEditor.tsx:237-253`),
    // which is Lucide `shuffle` with its paths spelled out in the TSX.
    "padding.svg",
    "corners.svg",
    "shadow.svg",
    "bg-blur.svg",
    "laptop.svg",
    "wind.svg",
    "image-off.svg",
    "shuffle.svg",
    "gift.svg",
    "history.svg",
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
    "minimize.svg",
    "minus.svg",
    "monitor.svg",
    "more-vertical.svg",
    "move-left.svg",
    "next.svg",
    // The timeline's track glyphs. `trackIcons` (`TL/index.tsx:70-80`) and
    // `getSceneIcon` (`TL/SceneTrack.tsx:80-96`) are Lucide, and the app has
    // no Cap equivalent for most of them, so these nine are the Lucide 24x24
    // originals: type, box-select (an alias of square-dashed since Lucide
    // 0.5xx), music, video, rotate-3d, clock, monitor, columns-2, panel-right.
    "box-select.svg",
    "clock.svg",
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
    // The onboarding permissions surface's header badge.
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
    // E5b's field glyphs: the rest of the sidebar's Lucide set, drawn from the
    // same 24x24 originals `~icons/lucide/*` resolves to. `ease-curve` stands
    // in for `~icons/hugeicons/ease-curve-control-points`, which is the one
    // non-Lucide glyph in the sidebar (Smooth Movement's header).
    "align-center.svg",
    "align-left.svg",
    "align-right.svg",
    "arrow-left-right.svg",
    "download.svg",
    "ease-curve.svg",
    "flip-vertical-2.svg",
    "grid.svg",
    "grip.svg",
    "italic.svg",
    "maximize.svg",
    "moon.svg",
    "mouse-pointer-2.svg",
    "move.svg",
    "move-right.svg",
    "palette.svg",
    "rabbit.svg",
    "ratio.svg",
    "refresh-cw.svg",
    "rotate-ccw.svg",
    "rotate-cw.svg",
    "sliders-horizontal.svg",
    "sparkles.svg",
    "timer.svg",
    "volume-2.svg",
    "volume-x.svg",
    "diamond.svg",
    "x-mark.svg",
    "zap.svg",
    "zoom-in.svg",
    "zoom-out.svg",
    // The settings Recordings page. `link` is Cap's own
    // (`packages/ui-solid/icons/link.svg`, which is Lucide's glyph); `import`
    // and `edit` are the Lucide 24x24 originals `~icons/lucide/*` resolves to;
    // `record-fill` and `warning-bold` are Phosphor's 256x256 originals, which
    // is what `IconPhRecordFill` / `IconPhWarningBold` are in `recordings.tsx`.
    "link.svg",
    "import.svg",
    "edit.svg",
    "copy.svg",
    "record-fill.svg",
    "warning-bold.svg",
    // The main window's hand-drawn traffic lights: the x and expand glyphs
    // `CaptionControlsMacOS.tsx` inlines, shown while the group is hovered.
    "traffic-close.svg",
    "traffic-zoom.svg",
    // The remaining settings pages (`settings_pages.rs`). `circle-check` is
    // Cap's own (`packages/ui-solid/icons/circle-check.svg`, hotkeys.tsx's
    // IconCapCircleCheck); the rest are the Lucide 24x24 originals the pages'
    // `~icons/lucide/*` imports resolve to, except `google-drive`, which is
    // integrations/index.tsx's inline multi-colour logo flattened to one fill
    // (gpui's `svg()` keeps only the alpha).
    "circle-check.svg",
    // The screenshot editor's annotation toolbar, layers panel and header
    // (`AnnotationTools.tsx`, `LayersPanel.tsx`, `Header.tsx`). Lucide 24x24
    // originals, matching the `~icons/lucide/*` imports over there.
    "pencil.svg",
    "arrow-up-right.svg",
    "more-horizontal.svg",
    "save.svg",
    "grip-vertical.svg",
    "chevron-up.svg",
    "arrow-left.svg",
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

/// The background-source tiles' fallback art, copied from
/// `apps/desktop/src/assets/illustrations/`. Full-colour, so `img()` not
/// `svg()`, and webp because that is what the app ships -- 4 KB for the pair,
/// against 25 MB if the wallpapers themselves were embedded (see the README).
///
/// **Two of `BACKGROUND_ICONS`' four are dead in the shipping app.**
/// `renderBackgroundSourceIcon` returns a live swatch for `color` and a live
/// gradient for `gradient` before it ever reaches the map
/// (`ConfigSidebar.tsx:2076-2089`), so `colorBg` and `gradientBg` are imported
/// and never drawn; only `imageBg` (desktop and wallpaper) and
/// `transparentBg` (image) are.
const ILLUSTRATIONS: &[(&str, &[u8])] = assets!("illustrations":
    "image.webp",
    "transparent.webp",
);

pub struct Assets;

impl Assets {
    fn all() -> impl Iterator<Item = &'static (&'static str, &'static [u8])> {
        FONTS
            .iter()
            .chain(ICONS.iter())
            .chain(IMAGES.iter())
            .chain(ILLUSTRATIONS.iter())
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
    /// Register the embedded Geist faces with the text system.
    ///
    /// gpui resolves `.font_family("Geist")` against whatever the platform text
    /// system knows about, so this has to run before the first window renders or
    /// text silently falls back to the system UI font.
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
        // The timeline's nine track glyphs and its scene-mode icons are named
        // in the strip's own module, not in the window that hosts it.
        include_str!("editor_timeline.rs"),
        // The config sidebar's field glyphs and the background section's
        // source tiles, same split.
        include_str!("editor_sidebar.rs"),
        // The five later tabs, the colour-grade section and the eight segment
        // panels each name their own glyphs.
        include_str!("editor_tabs.rs"),
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
        // `ui::SelectionHeader` names the check and the trash itself.
        include_str!("ui/selection_header.rs"),
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

    /// And for the background-source tiles' art, which resolves through the
    /// same `AssetSource` and fails just as silently.
    #[test]
    fn every_referenced_illustration_is_embedded_and_vice_versa() {
        let source = ICON_SOURCES.concat();
        let source = source.as_str();

        let referenced: Vec<&str> = source
            .match_indices("\"illustrations/")
            .filter_map(|(start, _)| source[start + 1..].split('"').next())
            .collect();
        assert!(
            !referenced.is_empty(),
            "found no illustration references to check"
        );

        let missing: Vec<&str> = referenced
            .into_iter()
            .filter(|path| Assets.load(path).unwrap().is_none())
            .collect();
        assert!(
            missing.is_empty(),
            "illustrations referenced but not embedded: {missing:?}"
        );

        let unused: Vec<&str> = ILLUSTRATIONS
            .iter()
            .map(|(path, _)| *path)
            .filter(|path| !source.contains(path))
            .collect();
        assert!(
            unused.is_empty(),
            "illustrations embedded but never drawn: {unused:?}"
        );
    }

    #[test]
    fn fonts_and_icons_resolve() {
        assert!(Assets.load("fonts/Geist.ttf").unwrap().is_some());
        assert!(Assets.load("icons/camera.svg").unwrap().is_some());
        assert!(Assets.load("icons/nope.svg").unwrap().is_none());
        assert!(Assets.load("images/auto.jpg").unwrap().is_some());
        assert_eq!(Assets.list("fonts").unwrap().len(), FONTS.len());
        assert_eq!(Assets.list("icons").unwrap().len(), ICONS.len());
        assert_eq!(Assets.list("images").unwrap().len(), IMAGES.len());
        assert!(Assets.load("illustrations/image.webp").unwrap().is_some());
        assert_eq!(
            Assets.list("illustrations").unwrap().len(),
            ILLUSTRATIONS.len()
        );
    }
}
