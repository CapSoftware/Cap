use tracing::Level;

// TODO: More flexible configuration? For instance, using a custom `CAP_LOGGING_LEVEL` (or something similar)
pub fn logging_level() -> Level {
    #[cfg(debug_assertions)]
    {
        let maybe_level = std::env::var("RUST_LOG").unwrap_or("INFO".into());
        if let Ok(level) = str::parse(&maybe_level) {
            return level;
        }
    }

    Level::INFO
}

pub fn is_local_mode() -> bool {
    match dotenv_codegen::dotenv!("NEXT_PUBLIC_LOCAL_MODE") {
        "true" => true,
        _ => false,
    }
}
