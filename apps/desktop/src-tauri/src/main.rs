#![recursion_limit = "256"]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;

use cap_desktop_lib::DynLoggingLayer;
use tracing_subscriber::{Layer, layer::SubscriberExt, util::SubscriberInitExt};

const TOKIO_WORKER_THREAD_STACK_SIZE: usize = 16 * 1024 * 1024;

fn main() {
    #[cfg(target_os = "linux")]
    if let Some(threads) = cap_utils::linux_runtime::llvmpipe_thread_count() {
        // Mesa counts host CPUs inside containers; configure it before spawning threads or bundled children.
        unsafe {
            std::env::set_var("LP_NUM_THREADS", threads.to_string());
        }
    }

    #[cfg(target_os = "linux")]
    if let Some(config) = cap_utils::linux_package::appimage_alsa_config_path() {
        // Configure ALSA before starting threads or handing off to a bundled child process.
        unsafe {
            std::env::set_var("ALSA_CONFIG_PATH", config);
        }
    }

    #[cfg(target_os = "linux")]
    if let Err(error) = cap_cli_install::appimage::dispatch_cli() {
        eprintln!("{error}");
        std::process::exit(1);
    }

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

        #[cfg(debug_assertions)]
        let path =
            match cap_desktop_lib::initialize_stop_editor_benchmark(create_benchmark_log_directory)
            {
                Ok(directory) => directory.unwrap_or(path),
                Err(error) => {
                    eprintln!("Invalid Stop benchmark invocation: {error}");
                    std::process::exit(2);
                }
            };

        path
    };

    let (info_file_writer, _info_logger_guard) =
        match create_log_appender(&logs_dir, "cap-desktop.log") {
            Some(appender) => {
                let (writer, guard) = tracing_appender::non_blocking(
                    cap_utils::diagnostic_writer::DiagnosticWriter::new(
                        appender,
                        &logs_dir,
                        "cap-desktop.log",
                    ),
                );
                let queue_errors = writer.error_counter();
                cap_utils::operation_diagnostics::install_queue_loss_counter(move || {
                    queue_errors.dropped_lines()
                });
                let diagnostic_writer = writer.clone();
                cap_utils::operation_diagnostics::install_sink(
                    cap_utils::operation_diagnostics::AppInfo {
                        flavor: "tauri",
                        version: env!("CARGO_PKG_VERSION"),
                        source_revision: option_env!("CAP_BUILD_REVISION"),
                        debug_build: cfg!(debug_assertions),
                        source_dirty: option_env!("CAP_BUILD_DIRTY").map(|value| value == "true"),
                    },
                    move |bytes| {
                        use std::io::Write;
                        let _ = diagnostic_writer.clone().write_all(bytes);
                    },
                );
                (Some(writer), Some(guard))
            }
            None => (None, None),
        };

    let errors_file_appender = create_log_appender(&logs_dir, "cap-desktop-errors.log");

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
        .with(info_file_writer.map(|writer| {
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_target(true)
                .with_writer(writer)
        }))
        .with(errors_file_appender.map(|appender| {
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_target(true)
                .with_writer(appender)
                .with_filter(tracing_subscriber::filter::LevelFilter::WARN)
        }))
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
        .block_on(async move {
            drop(tokio::spawn(
                cap_utils::operation_diagnostics::run_checkpoints(),
            ));
            cap_desktop_lib::run(handle, logs_dir).await;
        });
}

fn create_log_appender(
    directory: &std::path::Path,
    prefix: &str,
) -> Option<tracing_appender::rolling::RollingFileAppender> {
    use std::io::Write;

    match tracing_appender::rolling::RollingFileAppender::builder()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix(prefix)
        .build(directory)
    {
        Ok(appender) => Some(appender),
        Err(error) => {
            let _ = writeln!(
                std::io::stderr(),
                "Could not open {prefix} in {}: {error}; console logging remains enabled",
                directory.display()
            );
            None
        }
    }
}

#[cfg(debug_assertions)]
fn create_benchmark_log_directory(
    output: &std::path::Path,
    directory: &std::path::Path,
) -> std::io::Result<std::path::PathBuf> {
    use std::{io, path::Component};

    if !output.is_absolute()
        || !directory.is_absolute()
        || output == directory
        || [output, directory].into_iter().any(|path| {
            path.components().any(|component| {
                !matches!(
                    component,
                    Component::Prefix(_) | Component::RootDir | Component::Normal(_)
                )
            })
        })
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Benchmark paths must be distinct absolute paths without traversal",
        ));
    }
    let parent = directory.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Benchmark log directory has no parent",
        )
    })?;
    if output.parent() != Some(parent) || parent.canonicalize()? != parent || !parent.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Benchmark output and logs must share an existing canonical parent",
        ));
    }
    for path in [output, directory] {
        match std::fs::symlink_metadata(path) {
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "Benchmark output and log paths must be new",
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    let builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = builder;
        builder.mode(0o700);
        builder
    };
    builder.create(directory)?;
    Ok(directory.to_path_buf())
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

#[cfg(test)]
mod logging_tests {
    use super::create_log_appender;
    use std::{io::Write, path::PathBuf};

    struct LogDirectory(PathBuf);

    impl LogDirectory {
        fn new() -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let directory = std::env::temp_dir().join(format!(
                "cap-desktop-logging-{}-{nonce}",
                std::process::id()
            ));
            std::fs::create_dir_all(&directory).unwrap();
            Self(directory)
        }
    }

    impl Drop for LogDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn healthy_log_destination_preserves_existing_records() {
        let directory = LogDirectory::new();
        let destination = directory.0.join("nested");
        for record in ["first\n", "second\n"] {
            let mut appender = create_log_appender(&destination, "cap.log").unwrap();
            appender.write_all(record.as_bytes()).unwrap();
            appender.flush().unwrap();
        }
        let records: String = std::fs::read_dir(destination)
            .unwrap()
            .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap())
            .collect();
        assert!(records.contains("first\n"));
        assert!(records.contains("second\n"));
    }

    #[test]
    fn unavailable_log_directory_disables_only_file_logging() {
        let directory = LogDirectory::new();
        let destination = directory.0.join("blocked");
        std::fs::write(&destination, "existing file").unwrap();
        assert!(create_log_appender(&destination, "cap.log").is_none());
        assert_eq!(
            std::fs::read_to_string(destination).unwrap(),
            "existing file"
        );
    }

    #[test]
    fn unavailable_daily_log_file_disables_only_file_logging() {
        let directory = LogDirectory::new();
        let today = chrono::Utc::now().date_naive();
        for days in [-1, 0, 1] {
            let date = today + chrono::Duration::days(days);
            std::fs::create_dir(directory.0.join(format!("cap.log.{date}"))).unwrap();
        }
        assert!(create_log_appender(&directory.0, "cap.log").is_none());
        assert!(create_log_appender(&directory.0, "other.log").is_some());
    }
}

#[cfg(all(test, debug_assertions))]
mod benchmark_log_directory_tests {
    use super::create_benchmark_log_directory;

    #[test]
    fn benchmark_logs_use_a_new_private_sibling_without_creating_output() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let output = root.join("benchmark.json");
        let logs = root.join("logs");
        assert_eq!(
            create_benchmark_log_directory(&output, &logs).unwrap(),
            logs
        );
        assert!(logs.is_dir());
        assert!(!output.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(logs.metadata().unwrap().permissions().mode() & 0o777, 0o700);
        }
    }

    #[test]
    fn existing_or_foreign_benchmark_paths_are_preserved() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let output = root.join("benchmark.json");
        let logs = root.join("logs");
        std::fs::write(&output, "retained evidence").unwrap();
        assert!(create_benchmark_log_directory(&output, &logs).is_err());
        assert_eq!(
            std::fs::read_to_string(&output).unwrap(),
            "retained evidence"
        );
        assert!(!logs.exists());
        std::fs::create_dir(&logs).unwrap();
        assert!(create_benchmark_log_directory(&root.join("new.json"), &logs).is_err());
        assert!(
            create_benchmark_log_directory(&root.join("new.json"), &root.join("other/logs"))
                .is_err()
        );
        assert!(
            create_benchmark_log_directory(
                std::path::Path::new("relative.json"),
                &root.join("fresh")
            )
            .is_err()
        );
        assert!(
            create_benchmark_log_directory(&root.join("new.json"), &root.join("nested/../fresh"))
                .is_err()
        );
        assert!(!root.join("fresh").exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_benchmark_parents_are_rejected_without_writes() {
        use std::os::unix::fs::symlink;
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let actual = root.join("actual");
        let alias = root.join("alias");
        std::fs::create_dir(&actual).unwrap();
        symlink(&actual, &alias).unwrap();
        assert!(
            create_benchmark_log_directory(&alias.join("result.json"), &alias.join("logs"))
                .is_err()
        );
        assert!(!actual.join("logs").exists());
        assert!(!actual.join("result.json").exists());
    }
}
