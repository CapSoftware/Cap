//! Embedded assets.
//!
//! There are only a handful of files, so they are baked in with `include_bytes!`
//! rather than pulling in `rust_embed` for a directory walk we can spell out by
//! hand. The [`AssetSource`] impl is still worth having: gpui's `svg()` element
//! and image loader resolve paths through it.

use std::borrow::Cow;

use gpui::{App, AssetSource, Result, SharedString};

/// Every embedded asset, keyed by the path `AssetSource` consumers ask for.
const ASSETS: &[(&str, &[u8])] = &[
    (
        "fonts/Geist.ttf",
        include_bytes!("../assets/fonts/Geist.ttf"),
    ),
    (
        "fonts/Geist-Medium.ttf",
        include_bytes!("../assets/fonts/Geist-Medium.ttf"),
    ),
    (
        "fonts/Geist-SemiBold.ttf",
        include_bytes!("../assets/fonts/Geist-SemiBold.ttf"),
    ),
    (
        "fonts/Geist-Bold.ttf",
        include_bytes!("../assets/fonts/Geist-Bold.ttf"),
    ),
];

pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        Ok(ASSETS
            .iter()
            .find(|(name, _)| *name == path)
            .map(|(_, bytes)| Cow::Borrowed(*bytes)))
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        Ok(ASSETS
            .iter()
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
        let fonts = ASSETS
            .iter()
            .filter(|(name, _)| name.ends_with(".ttf"))
            .map(|(_, bytes)| Cow::Borrowed(*bytes))
            .collect();

        cx.text_system().add_fonts(fonts)
    }
}
