#![recursion_limit = "256"]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;

use cap_desktop_lib::DynLoggingLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

fn main() {
    #[cfg(debug_assertions)]
    unsafe {
        std::env::set_var("RUST_LOG", "trace");
    }

    // We have to hold onto the ClientInitGuard until the very end
    let _sentry_guard = std::option_env!("CAP_DESKTOP_SENTRY_URL").map(|url| {
        let sentry_client = sentry::init((
            url,
            sentry::ClientOptions {
                release: sentry::release_name!(),
                debug: cfg!(debug_assertions),
                // Disable backtrace capture to prevent secondary panics during backtrace collection
                // on Windows, which can cause "panic in a function that cannot unwind" errors
                attach_stacktrace: false,
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
        // Wrap minidump initialization in catch_unwind to prevent panics from propagating
        let _guard = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            tauri_plugin_sentry::minidump::init(&sentry_client)
        }))
        .unwrap_or_else(|e| {
            eprintln!("Failed to initialize Sentry minidump handler: {:?}", e);
            None
        });

        (sentry_client, _guard)
    });

    let (reload_layer, handle) = tracing_subscriber::reload::Layer::new(None::<DynLoggingLayer>);

    let logs_dir = {
        #[cfg(target_os = "macos")]
        let path = dirs::home_dir()
            .unwrap()
            .join("Library/Logs")
            .join("so.cap.desktop");

        #[cfg(not(target_os = "macos"))]
        let path = dirs::data_local_dir()
            .unwrap()
            .join("so.cap.desktop")
            .join("logs");

        path
    };

    // Ensure logs directory exists
    std::fs::create_dir_all(&logs_dir).unwrap_or_else(|e| {
        eprintln!("Failed to create logs directory: {e}");
    });

    let file_appender = tracing_appender::rolling::daily(&logs_dir, "cap-desktop.log");
    let (non_blocking, _logger_guard) = tracing_appender::non_blocking(file_appender);

    let (otel_layer, _tracer) = if cfg!(debug_assertions) {
        use opentelemetry::trace::TracerProvider;
        use opentelemetry_otlp::WithExportConfig;
        use tracing_subscriber::Layer;

        let tracer = opentelemetry_sdk::trace::SdkTracerProvider::builder()
            .with_batch_exporter(
                opentelemetry_otlp::SpanExporter::builder()
                    .with_http()
                    .with_protocol(opentelemetry_otlp::Protocol::HttpJson)
                    .build()
                    .unwrap(),
            )
            .with_resource(
                opentelemetry_sdk::Resource::builder()
                    .with_service_name("cap-desktop")
                    .build(),
            )
            .build();

        let layer = tracing_opentelemetry::layer()
            .with_tracer(tracer.tracer("cap-desktop"))
            .boxed();

        opentelemetry::global::set_tracer_provider(tracer.clone());
        (Some(layer), Some(tracer))
    } else {
        (None, None)
    };

    #[cfg(debug_assertions)]
    let level_filter = tracing_subscriber::filter::LevelFilter::TRACE;
    #[cfg(not(debug_assertions))]
    let level_filter = tracing_subscriber::filter::LevelFilter::INFO;

    tracing_subscriber::registry()
        .with(tracing_subscriber::filter::filter_fn(
            (|v| v.target().starts_with("cap_")) as fn(&tracing::Metadata) -> bool,
        ))
        .with(reload_layer)
        .with(level_filter)
        .with(otel_layer)
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(true)
                .with_target(true),
        )
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_target(true)
                .with_writer(non_blocking),
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
        .block_on(cap_desktop_lib::run(handle, logs_dir));
}
