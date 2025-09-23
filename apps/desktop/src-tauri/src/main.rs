// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;

use cap_desktop_lib::DynLoggingLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

fn main() {
    unsafe {
        std::env::set_var("RUST_LOG", "trace");
    }

    // We have to hold onto the ClientInitGuard until the very end
    let _guard = std::option_env!("CAP_DESKTOP_SENTRY_URL").map(|url| {
        let sentry_client = sentry::init((
            url,
            sentry::ClientOptions {
                release: sentry::release_name!(),
                debug: cfg!(debug_assertions),
                before_send: Some(Arc::new(|mut event| {
                    // this is irrelevant to us + users probably don't want us knowing their computer names
                    event.server_name = None;

                    #[cfg(debug_assertions)]
                    {
                        let msg = event.message.clone().unwrap_or("No message".into());
                        println!("Sentry captured {}: {}", &event.level, &msg);
                        println!("-- user: {:?}", &event.user);
                        println!("-- event tags: {:?}", &event.tags);
                        println!("-- event contexts: {:?}", &event.contexts);
                        None
                    }

                    #[cfg(not(debug_assertions))]
                    {
                        Some(event)
                    }
                })),
                ..Default::default()
            },
        ));

        // Caution! Everything before here runs in both app and crash reporter processes
        let _guard = tauri_plugin_sentry::minidump::init(&sentry_client);

        (sentry_client, _guard)
    });

    let (layer, handle) = tracing_subscriber::reload::Layer::new(None::<DynLoggingLayer>);

    let registry = tracing_subscriber::registry().with(tracing_subscriber::filter::filter_fn(
        (|v| v.target().starts_with("cap_")) as fn(&tracing::Metadata) -> bool,
    ));

    registry
        .with(layer)
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(true)
                .with_target(true),
        )
        .init();

    #[cfg(debug_assertions)]
    sentry::configure_scope(|scope| {
        scope.set_user(Some(sentry::User {
            username: Some("_DEV_".into()),
            ..Default::default()
        }));
    });

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Failed to build multi threaded tokio runtime")
        .block_on(cap_desktop_lib::run(handle));
}
