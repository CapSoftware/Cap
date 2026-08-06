#![recursion_limit = "256"]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;

use cap_desktop_lib::DynLoggingLayer;
use tracing_subscriber::{Layer, layer::SubscriberExt, util::SubscriberInitExt};

const TOKIO_WORKER_THREAD_STACK_SIZE: usize = 16 * 1024 * 1024;

fn main() {
    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    if std::env::var_os("ORT_DYLIB_PATH").is_none()
        && let Some(path) = cap_camera_effects::onnx_runtime_library_path()
    {
        unsafe {
            std::env::set_var("ORT_DYLIB_PATH", path);
        }
    }

    #[cfg(debug_assertions)]
    unsafe {
        std::env::set_var("RUST_LOG", "trace");
    }

    #[cfg(target_os = "linux")]
    unsafe {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    // We have to hold onto the ClientInitGuard until the very end
    let _sentry_guard = std::option_env!("CAP_DESKTOP_SENTRY_URL").map(|url| {
        // Crashpad minidump initialization is intentionally disabled. Its process-wide SEH
        // handler terminates through TerminateProcess, bypassing panic hooks, Tauri exit
        // events, and Windows Error Reporting. Re-enable it by binding this guard and
        // passing it to tauri_plugin_sentry::minidump::init once the WER trace is captured.
        sentry::init((
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
        ))
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

    let info_file_appender = tracing_appender::rolling::daily(&logs_dir, "cap-desktop.log");
    let (info_file_writer, _info_logger_guard) = tracing_appender::non_blocking(info_file_appender);

    let errors_file_appender =
        tracing_appender::rolling::daily(&logs_dir, "cap-desktop-errors.log");

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
                .with_writer(info_file_writer),
        )
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_target(true)
                .with_writer(errors_file_appender)
                .with_filter(tracing_subscriber::filter::LevelFilter::WARN),
        )
        .init();

    install_panic_hook(logs_dir.clone());

    #[cfg(debug_assertions)]
    sentry::configure_scope(|scope| {
        scope.set_user(Some(sentry::User {
            username: Some("_DEV_".into()),
            ..Default::default()
        }));
    });

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_stack_size(TOKIO_WORKER_THREAD_STACK_SIZE)
        .build()
        .expect("Failed to build multi threaded tokio runtime")
        .block_on(cap_desktop_lib::run(handle, logs_dir));
}

fn install_panic_hook(logs_dir: std::path::PathBuf) {
    let prev = std::panic::take_hook();
    let panics_log = logs_dir.join("panics.log");
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<no message>".to_string());
        let backtrace = std::backtrace::Backtrace::force_capture();
        let thread = std::thread::current();
        let thread_name = thread.name().unwrap_or("<unnamed>").to_string();
        let timestamp = chrono::Utc::now().to_rfc3339();
        let pid = std::process::id();

        write_panic_record(
            &panics_log,
            &timestamp,
            pid,
            &thread_name,
            &location,
            &message,
            &backtrace,
        );

        tracing::error!(
            target: "cap_desktop_panic",
            location = %location,
            thread = %thread_name,
            message = %message,
            backtrace = %backtrace,
            "panic"
        );
        eprintln!(
            "[cap-desktop panic] thread '{thread_name}' at {location}: {message}\nbacktrace:\n{backtrace}"
        );
        prev(info);
    }));
}

fn write_panic_record(
    path: &std::path::Path,
    timestamp: &str,
    pid: u32,
    thread_name: &str,
    location: &str,
    message: &str,
    backtrace: &std::backtrace::Backtrace,
) {
    use std::io::Write;
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    else {
        return;
    };
    let _ = writeln!(
        file,
        "[{timestamp}] pid={pid} thread='{thread_name}' at {location}: {message}\n{backtrace}\n----"
    );
    let _ = file.flush();
}
