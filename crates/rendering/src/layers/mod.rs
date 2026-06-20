mod background;
mod blur;
mod camera;
mod captions;
mod cursor;
mod display;
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
        (font_system.locale().to_string(), font_system.db().clone())
    });

    glyphon::FontSystem::new_with_locale_and_db(locale.clone(), db.clone())
}

pub use background::*;
pub use blur::*;
pub use camera::*;
pub use captions::*;
pub use cursor::*;
pub use display::*;
pub use keyboard::*;
pub use mask::*;
pub use text::*;
