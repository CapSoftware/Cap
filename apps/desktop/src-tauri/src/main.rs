// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;

#[tokio::main]
async fn main() {
    let _guard = sentry::init((
        env!("CAP_DESKTOP_SENTRY_URL"),
        sentry::ClientOptions {
            release: sentry::release_name!(),
            debug: cfg!(debug_assertions),
            before_send: Some(Arc::new(|mut event| {
                #[cfg(debug_assertions)]
                return None;

                #[cfg(not(debug_assertions))]
                {
                    Some(event)
                }
            })),
            ..Default::default()
        },
    ));

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Failed to build multi threaded tokio runtime")
        .block_on(desktop_solid_lib::run);
}
