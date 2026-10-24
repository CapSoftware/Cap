use std::sync::{
    OnceLock,
    atomic::{AtomicU8, Ordering},
};

use gpui::App;

include!(concat!(env!("OUT_DIR"), "/i18n.rs"));

pub const SETTING_KEY: &str = "uiLanguage";
/// Wins over the setting and the system language, for example
/// `CAP_GPUI_LOCALE=ja` (or `pseudo` in a debug build).
pub const LOCALE_ENV: &str = "CAP_GPUI_LOCALE";
const SYSTEM_SETTING: &str = "system";
/// Shows the language picker in a release build. Release builds hide it until
/// the main surfaces are translated; `uiLanguage` and [`LOCALE_ENV`] work
/// either way.
pub const PICKER_ENV: &str = "CAP_GPUI_LANGUAGE_PICKER";

static CURRENT: AtomicU8 = AtomicU8::new(Locale::En as u8);

fn index() -> usize {
    CURRENT.load(Ordering::Relaxed) as usize
}

pub fn current() -> Locale {
    Locale::ALL[index()]
}

/// What the language picker stores: follow the system, or one catalog.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Preference {
    System,
    Fixed(Locale),
}

impl Preference {
    /// Absent, `"system"` and codes this build has no catalog for (written by
    /// a newer build, or `pseudo` from a debug one) all follow the system.
    /// The stored value is left as it is until the picker writes a new one.
    pub fn from_setting(value: Option<&str>) -> Self {
        value
            .and_then(Locale::from_code)
            .map_or(Self::System, Self::Fixed)
    }

    pub fn setting(self) -> &'static str {
        match self {
            Self::System => SYSTEM_SETTING,
            Self::Fixed(locale) => locale.code(),
        }
    }

    /// Picker order: System default, then every catalog.
    pub fn options() -> impl Iterator<Item = Self> {
        std::iter::once(Self::System).chain(Locale::ALL.into_iter().map(Self::Fixed))
    }
}

/// Read once: the General page asks on every render.
pub fn picker_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        cfg!(debug_assertions) || std::env::var(PICKER_ENV).is_ok_and(|value| value == "1")
    })
}

/// Before the first lookup: `main` calls this ahead of the theme, menus and
/// tray.
pub fn init(setting: Option<&str>) {
    set(resolve(Preference::from_setting(setting)));
}

pub fn resolve(preference: Preference) -> Locale {
    if let Some(locale) = std::env::var(LOCALE_ENV)
        .ok()
        .as_deref()
        .and_then(match_tag)
    {
        return locale;
    }
    resolve_preference(preference, picker_enabled(), system)
}

/// Without the picker a release build stays English on a non-English system,
/// so nobody gets a half-translated app they can't switch back from.
fn resolve_preference(
    preference: Preference,
    picker_enabled: bool,
    system: impl FnOnce() -> Locale,
) -> Locale {
    match preference {
        Preference::Fixed(locale) => locale,
        Preference::System if picker_enabled => system(),
        Preference::System => Locale::En,
    }
}

/// The first of the user's preferred system languages that has a catalog,
/// read once: the picker labels its System default row with it every render.
pub fn system() -> Locale {
    static SYSTEM: OnceLock<Locale> = OnceLock::new();
    *SYSTEM.get_or_init(|| first_supported(sys_locale::get_locales()))
}

fn first_supported(tags: impl IntoIterator<Item = String>) -> Locale {
    tags.into_iter()
        .find_map(|tag| match_tag(&tag))
        .unwrap_or(Locale::En)
}

/// A BCP 47 (`zh-Hans-CN`) or POSIX (`de_DE.UTF-8`) tag to a catalog, by
/// language subtag. Simplified Chinese (`Hans`, `CN`, `SG`, or no qualifier)
/// is `zh-CN`. Traditional Chinese has no catalog, so it returns `None` and
/// the next preferred language is tried rather than showing Simplified.
fn match_tag(tag: &str) -> Option<Locale> {
    let tag = tag.split(['.', '@']).next().unwrap_or_default();
    let mut subtags = tag.split(['-', '_']).filter(|subtag| !subtag.is_empty());
    let language = subtags.next()?;
    if language.eq_ignore_ascii_case("zh") {
        for subtag in subtags {
            if ["hans", "cn", "sg"]
                .iter()
                .any(|simplified| subtag.eq_ignore_ascii_case(simplified))
            {
                return Some(Locale::ZhCn);
            }
            if ["hant", "tw", "hk", "mo"]
                .iter()
                .any(|traditional| subtag.eq_ignore_ascii_case(traditional))
            {
                return None;
            }
        }
        return Some(Locale::ZhCn);
    }
    Locale::ALL
        .into_iter()
        .find(|locale| locale.code().eq_ignore_ascii_case(language))
}

fn set(locale: Locale) {
    CURRENT.store(locale as u8, Ordering::Relaxed);
}

/// Switch languages without a restart. Rendered text reads the new tables on
/// the next frame; the menu bar and the tray hold their strings natively, so
/// they are rebuilt, and every window is redrawn past its view caches.
pub fn apply(preference: Preference, cx: &mut App) {
    let locale = resolve(preference);
    if locale == current() {
        return;
    }
    set(locale);
    tracing::info!(locale = locale.code(), "ui language changed");
    crate::menus::refresh(cx);
    crate::tray::refresh_menu(cx);
    cx.refresh_windows();
}

#[cfg(test)]
mod surface_tests;
#[cfg(test)]
mod tests;
