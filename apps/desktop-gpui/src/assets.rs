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
    "Geist.ttf",
    "Geist-Medium.ttf",
    "Geist-SemiBold.ttf",
    "Geist-Bold.ttf",
);

/// Mostly Cap's own icon set, lifted from `packages/ui-solid/icons`. gpui
/// rasterises an SVG and keeps only its alpha, tinting the result with the
/// element's text colour, so these must be single-colour glyphs -- a full-colour
/// illustration would come out as a filled silhouette.
const ICONS: &[(&str, &[u8])] = assets!("icons":
    "area.svg",
    "bell.svg",
    "camera.svg",
    "check.svg",
    "chevron-down.svg",
    "circle-help.svg",
    "circle-x.svg",
    "enlarge.svg",
    "film-cut.svg",
    "history.svg",
    "image.svg",
    "info.svg",
    "instant.svg",
    "logo-full-dark.svg",
    "logo-full.svg",
    "microphone.svg",
    "minimize.svg",
    "move-left.svg",
    "play-circle.svg",
    "scan-text.svg",
    "screen.svg",
    "screenshot.svg",
    "stop-circle.svg",
    "search.svg",
    "settings.svg",
    "window.svg",
);

pub struct Assets;

impl Assets {
    fn all() -> impl Iterator<Item = &'static (&'static str, &'static [u8])> {
        FONTS.iter().chain(ICONS.iter())
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

    /// Every icon `main_window` asks for must be in the table. gpui draws
    /// nothing at all for a path it cannot resolve, and does not log, so a typo
    /// here is otherwise only visible by looking at the window.
    #[test]
    fn every_referenced_icon_is_embedded() {
        let source = include_str!("main_window.rs");

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
        let source = include_str!("main_window.rs");

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

    #[test]
    fn fonts_and_icons_resolve() {
        assert!(Assets.load("fonts/Geist.ttf").unwrap().is_some());
        assert!(Assets.load("icons/camera.svg").unwrap().is_some());
        assert!(Assets.load("icons/nope.svg").unwrap().is_none());
        assert_eq!(Assets.list("fonts").unwrap().len(), FONTS.len());
        assert_eq!(Assets.list("icons").unwrap().len(), ICONS.len());
    }
}
