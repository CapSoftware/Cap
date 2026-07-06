mod background;
mod blur;
mod camera;
mod captions;
mod cursor;
mod display;
mod frame;
mod keyboard;
mod mask;
mod text;

use std::sync::OnceLock;

/// Building a `glyphon::FontSystem` scans and parses every installed system font,
/// which costs hundreds of milliseconds to over a second on macOS. cosmic-text
/// explicitly documents that it should be created once and shared. We previously
/// built three of them per `RendererLayers` (text, captions, keyboard) and a fresh
/// `RendererLayers` per editor/screenshot instance, so every open paid that scan
/// several times over.
///
/// Instead, scan the system fonts a single time per process, then cheaply clone the
/// resulting font database (memory-mapped faces are reference counted) for each new
/// `FontSystem`.
pub(crate) fn new_font_system() -> glyphon::FontSystem {
    static FONT_TEMPLATE: OnceLock<(String, glyphon::fontdb::Database)> = OnceLock::new();

    let (locale, db) = FONT_TEMPLATE.get_or_init(|| {
        let font_system = glyphon::FontSystem::new();
        let mut db = font_system.db().clone();
        // Pin the generic families to the fonts the editor webview resolves
        // them to. fontdb's stock defaults (e.g. "Arial") often don't match
        // any installed face, in which case cosmic-text silently shapes with
        // an arbitrary fallback font — and canvas overlays measured in the
        // webview no longer match what the renderer draws.
        #[cfg(target_os = "macos")]
        {
            // WKWebView: sans-serif → Helvetica, serif → Times, monospace →
            // Courier.
            db.set_sans_serif_family("Helvetica");
            db.set_serif_family("Times New Roman");
            db.set_monospace_family("Courier New");
        }
        #[cfg(windows)]
        {
            // WebView2 (Chromium): sans-serif → Arial, serif → Times New
            // Roman, monospace → Consolas.
            db.set_sans_serif_family("Arial");
            db.set_serif_family("Times New Roman");
            db.set_monospace_family("Consolas");
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            db.set_sans_serif_family("DejaVu Sans");
            db.set_serif_family("DejaVu Serif");
            db.set_monospace_family("DejaVu Sans Mono");
        }
        (font_system.locale().to_string(), db)
    });

    glyphon::FontSystem::new_with_locale_and_db(locale.clone(), db.clone())
}

pub use background::*;
pub use blur::*;
pub use camera::*;
pub use captions::*;
pub use cursor::*;
pub use display::*;
pub use frame::*;
pub use keyboard::*;
pub use mask::*;
pub use text::*;

#[cfg(test)]
mod font_tests {
    use super::*;

    /// Text overlays are measured in the editor webview with the CSS generic
    /// `sans-serif`; the renderer must resolve the same generic to a real
    /// (and matching) font or boxes and line wrapping diverge from the
    /// rendered pixels.
    #[test]
    fn generic_families_resolve_to_real_fonts() {
        let font_system = new_font_system();
        for family in [
            glyphon::fontdb::Family::SansSerif,
            glyphon::fontdb::Family::Serif,
            glyphon::fontdb::Family::Monospace,
        ] {
            for weight in [400u16, 700] {
                let query = glyphon::fontdb::Query {
                    families: &[family],
                    weight: glyphon::fontdb::Weight(weight),
                    ..Default::default()
                };
                let id = font_system.db().query(&query);
                let families = id
                    .and_then(|id| font_system.db().face(id))
                    .map(|face| face.families.clone());
                println!("{family:?} weight {weight}: {families:?}");
                assert!(
                    families.is_some(),
                    "{family:?} (weight {weight}) resolved to no font"
                );
            }
        }
    }
}
