use sentry::types::Dsn;
use std::env;
use tracing::Level;

// TODO: More flexible configuration? For instance, using a custom `CAP_LOGGING_LEVEL` (or something similar)
pub fn logging_level() -> Level {
    #[cfg(debug_assertions)]
    {
        let maybe_level = env::var("RUST_LOG").unwrap_or("INFO".into());
        if let Ok(level) = str::parse(&maybe_level) {
            if level == Level::TRACE && env::var("RUST_BACKTRACE").is_err() {
                env::set_var("RUST_BACKTRACE", "1");
            }
            return level;
        }
    }

    Level::INFO
}

#[inline]
pub fn is_local_mode() -> bool {
    match dotenvy_macro::dotenv!("NEXT_PUBLIC_LOCAL_MODE") {
        "true" => true,
        _ => false,
    }
}

#[inline]
pub fn sentry_dsn() -> Option<Dsn> {
    str::parse(dotenvy_macro::dotenv!("CAP_DESKTOP_SENTRY_URL")).ok()
}
