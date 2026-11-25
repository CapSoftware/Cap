use std::sync::OnceLock;
#[cfg(feature = "experimental-redesign")]
use std::sync::atomic::{AtomicBool, Ordering};

pub const UNLOCK_DEFAULTS_KEY: &str = "_CapEnableExperimentalDesktopRedesignOption";
pub const UNLOCK_ENV_VAR: &str = "CAP_EXPERIMENTAL_DESKTOP_REDESIGN";

fn env_var_enables(val: Option<&str>) -> bool {
    val.is_some_and(|v| {
        let v = v.trim();
        v == "1" || v.eq_ignore_ascii_case("true")
    })
}

#[cfg(target_os = "macos")]
fn defaults_unlocked() -> bool {
    use objc2_foundation::{NSString, NSUserDefaults};
    NSUserDefaults::standardUserDefaults().boolForKey(&NSString::from_str(UNLOCK_DEFAULTS_KEY))
}

#[cfg(not(target_os = "macos"))]
fn defaults_unlocked() -> bool {
    false
}

pub fn is_desktop_redesign_unlocked() -> bool {
    static UNLOCKED: OnceLock<bool> = OnceLock::new();
    *UNLOCKED.get_or_init(|| {
        env_var_enables(std::env::var(UNLOCK_ENV_VAR).ok().as_deref()) || defaults_unlocked()
    })
}

#[cfg(feature = "experimental-redesign")]
fn cached_redesign_setting() -> &'static AtomicBool {
    static ENABLED: OnceLock<AtomicBool> = OnceLock::new();
    ENABLED.get_or_init(|| {
        AtomicBool::new(crate::store::GeneralSettings::load().experimental_desktop_redesign)
    })
}

#[cfg(feature = "experimental-redesign")]
pub fn is_desktop_redesign_enabled_cached() -> bool {
    is_desktop_redesign_unlocked() && cached_redesign_setting().load(Ordering::Relaxed)
}

#[cfg(not(feature = "experimental-redesign"))]
pub fn is_desktop_redesign_enabled_cached() -> bool {
    false
}

#[cfg(feature = "experimental-redesign")]
pub fn set_desktop_redesign_enabled_cached(enabled: bool) {
    cached_redesign_setting().store(enabled, Ordering::Relaxed);
}

#[cfg(not(feature = "experimental-redesign"))]
pub fn set_desktop_redesign_enabled_cached(enabled: bool) {
    let _ = enabled;
}

#[cfg(feature = "experimental-redesign")]
pub fn is_desktop_redesign_enabled(settings: &crate::store::GeneralSettings) -> bool {
    is_desktop_redesign_unlocked() && settings.experimental_desktop_redesign
}

#[cfg(not(feature = "experimental-redesign"))]
pub fn is_desktop_redesign_enabled(settings: &crate::store::GeneralSettings) -> bool {
    let _ = settings;
    false
}

#[macro_export]
macro_rules! cfg_redesign {
    (feature = $feat:literal, { $($item:item)* }) => {
        $(
            #[cfg(all(feature = "experimental-redesign", feature = $feat))]
            $item
        )*
    };
    ({ $($item:item)* }) => {
        $(
            #[cfg(feature = "experimental-redesign")]
            $item
        )*
    };
    ($($item:item)*) => {
        $(
            #[cfg(feature = "experimental-redesign")]
            $item
        )*
    };
}

#[macro_export]
macro_rules! cfg_redesign_expr {
    (feature = $feat:literal, $new:expr, $fallback:expr) => {{
        #[cfg(all(feature = "experimental-redesign", feature = $feat))]
        {
            $new
        }
        #[cfg(not(all(feature = "experimental-redesign", feature = $feat)))]
        {
            $fallback
        }
    }};
    ($new:expr, $fallback:expr) => {{
        #[cfg(feature = "experimental-redesign")]
        {
            $new
        }
        #[cfg(not(feature = "experimental-redesign"))]
        {
            $fallback
        }
    }};
}

#[macro_export]
macro_rules! if_redesign {
    (feature = $feat:literal, $enabled:expr, { $($new:tt)* }, { $($fallback:tt)* }) => {{
        #[cfg(all(feature = "experimental-redesign", feature = $feat))]
        {
            if $enabled { $($new)* } else { $($fallback)* }
        }
        #[cfg(not(all(feature = "experimental-redesign", feature = $feat)))]
        {
            let _ = $enabled;
            { $($fallback)* }
        }
    }};
    ($enabled:expr, { $($new:tt)* }, { $($fallback:tt)* }) => {{
        #[cfg(feature = "experimental-redesign")]
        {
            if $enabled { $($new)* } else { $($fallback)* }
        }
        #[cfg(not(feature = "experimental-redesign"))]
        {
            let _ = $enabled;
            { $($fallback)* }
        }
    }};
}

#[macro_export]
macro_rules! apply_redesign {
    ($el:expr, $enabled:expr, feature = $feat:literal, $f:expr) => {{
        #[cfg(all(feature = "experimental-redesign", feature = $feat))]
        {
            let el = $el;
            if $enabled { ($f)(el) } else { el }
        }
        #[cfg(not(all(feature = "experimental-redesign", feature = $feat)))]
        {
            let _ = $enabled;
            $el
        }
    }};
    ($el:expr, $enabled:expr, $f:expr) => {{
        #[cfg(feature = "experimental-redesign")]
        {
            let el = $el;
            if $enabled { ($f)(el) } else { el }
        }
        #[cfg(not(feature = "experimental-redesign"))]
        {
            let _ = $enabled;
            $el
        }
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_var_parsing() {
        assert!(env_var_enables(Some("1")));
        assert!(env_var_enables(Some("true")));
        assert!(env_var_enables(Some("TRUE")));
        assert!(env_var_enables(Some(" True ")));
        assert!(!env_var_enables(Some("0")));
        assert!(!env_var_enables(Some("")));
        assert!(!env_var_enables(Some("yes")));
        assert!(!env_var_enables(None));
    }

    #[test]
    fn cfg_redesign_items() {
        cfg_redesign! {
            const GATED: u8 = 1;
        }
        cfg_redesign!(feature = "experimental-redesign", {
            const GATED_FEATURE: u8 = 2;
        });
        #[cfg(feature = "experimental-redesign")]
        assert_eq!(GATED + GATED_FEATURE, 3);
        assert_eq!(
            cfg_redesign_expr!(1, 2),
            if cfg!(feature = "experimental-redesign") {
                1
            } else {
                2
            }
        );
    }

    #[test]
    fn if_redesign_selects_branch() {
        let on = if_redesign!(true, { 1 }, { 2 });
        let off = if_redesign!(false, { 1 }, { 2 });
        let featured = if_redesign!(feature = "experimental-redesign", true, { 10 }, { 20 });
        if cfg!(feature = "experimental-redesign") {
            assert_eq!((on, off, featured), (1, 2, 10));
        } else {
            assert_eq!((on, off, featured), (2, 2, 20));
        }
    }

    #[test]
    fn apply_redesign_chains() {
        let on = apply_redesign!(1, true, |v| v + 10);
        let off = apply_redesign!(1, false, |v| v + 10);
        let featured = apply_redesign!(1, true, feature = "experimental-redesign", |v| v + 100);
        if cfg!(feature = "experimental-redesign") {
            assert_eq!((on, off, featured), (11, 1, 101));
        } else {
            assert_eq!((on, off, featured), (1, 1, 1));
        }
    }
}
