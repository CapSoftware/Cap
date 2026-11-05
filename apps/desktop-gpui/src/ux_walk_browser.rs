#[cfg(target_os = "macos")]
mod owned {
    use cap_recording::diagnostics::redact_home_paths;
    use serde_json::{Value, json};
    use std::{
        io::{BufRead, BufReader, ErrorKind, Read, Write},
        path::{Path, PathBuf},
        process::{Child, ChildStdin, Command, ExitStatus, Stdio},
        sync::{Mutex, OnceLock, mpsc},
        time::{Duration, Instant},
    };

    const COLLECTOR_CLOSED: &str = "The walk browser collector closed.";
    const STDERR_TAIL_BYTES: usize = 16 * 1024;
    const REDACTED_LINE: &str = "[line redacted]";
    const SECRET_MARKERS: &[&str] = &[
        "authorization",
        "cookie",
        "bearer",
        "password",
        "passwd",
        "token",
        "secret",
        "api_key",
        "api-key",
        "apikey",
        "otp",
    ];

    struct Browser {
        capture_id: String,
        window_id: Option<String>,
        journal: Option<PathBuf>,
        child: Option<Child>,
        input: Option<ChildStdin>,
        replies: mpsc::Receiver<Result<Value, String>>,
    }

    impl Drop for Browser {
        fn drop(&mut self) {
            self.input.take();
            if let Some(mut child) = self.child.take() {
                std::thread::spawn(move || {
                    for _ in 0..100 {
                        if child.try_wait().ok().flatten().is_some() {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    let _ = child.kill();
                    let _ = child.wait();
                });
            }
        }
    }

    impl Browser {
        fn command(&mut self, mut message: Value, timeout: Duration) -> Result<(), String> {
            let id = crate::store::new_uuid_v4();
            message["id"] = json!(id);
            message["captureId"] = json!(self.capture_id);
            let input = self.input.as_mut().ok_or("The walk browser closed.")?;
            let mut bytes = serde_json::to_vec(&message).map_err(|error| error.to_string())?;
            bytes.push(b'\n');
            input.write_all(&bytes).map_err(|error| error.to_string())?;
            input.flush().map_err(|error| error.to_string())?;
            let started = Instant::now();
            loop {
                let reply = self
                    .replies
                    .recv_timeout(timeout.saturating_sub(started.elapsed()))
                    .map_err(|_| "The walk browser did not acknowledge its control request.")??;
                if reply["id"].as_str() != Some(&id) {
                    continue;
                }
                return if reply["ok"] == true {
                    Ok(())
                } else {
                    Err(reply["error"]
                        .as_str()
                        .unwrap_or("The walk browser refused its control request.")
                        .to_string())
                };
            }
        }
    }

    fn browsers() -> &'static Mutex<Vec<Browser>> {
        static BROWSERS: OnceLock<Mutex<Vec<Browser>>> = OnceLock::new();
        BROWSERS.get_or_init(|| Mutex::new(Vec::new()))
    }

    fn engine() -> Result<PathBuf, String> {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        Ok(executable
            .parent()
            .and_then(Path::parent)
            .ok_or("The app bundle is unavailable.")?
            .join("Resources/ux-walk"))
    }

    fn read_tail(mut stderr: impl Read) -> String {
        let mut tail = Vec::new();
        let mut chunk = [0; 4096];
        let mut truncated = false;
        loop {
            match stderr.read(&mut chunk) {
                Ok(0) => break,
                Ok(count) => {
                    tail.extend_from_slice(&chunk[..count]);
                    if tail.len() > STDERR_TAIL_BYTES {
                        tail.drain(..tail.len() - STDERR_TAIL_BYTES);
                        truncated = true;
                    }
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(error) => {
                    tracing::warn!(%error, "could not read walk browser collector stderr");
                    break;
                }
            }
        }
        let text = String::from_utf8_lossy(&tail);
        // A cut can split "Bearer abc" and leave a bare token that no rule below recognizes.
        let text = if truncated {
            text.split_once('\n').map_or("", |(_, rest)| rest)
        } else {
            text.as_ref()
        };
        text.trim().to_string()
    }

    // Stderr bypasses the collector's redactBrowserText, so an uncaught error or
    // a library warning can carry anything. Lines fail closed on these markers.
    fn redact_stderr(text: &str) -> String {
        text.lines()
            .map(|line| {
                let lower = line.to_lowercase();
                if SECRET_MARKERS.iter().any(|marker| lower.contains(marker)) {
                    return REDACTED_LINE.to_string();
                }
                let words: Vec<&str> = line
                    .split(' ')
                    .map(|word| {
                        if word.contains("://") && !word.contains("file://") {
                            "[url]"
                        } else if word.contains('@') && word.contains('.') {
                            "[email]"
                        } else {
                            word
                        }
                    })
                    .collect();
                redact_home_paths(&words.join(" "))
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn startup_failure(stderr: &str, status: Option<ExitStatus>) -> String {
        if stderr
            .lines()
            .any(|line| line.trim_start().starts_with("dyld"))
        {
            return "The bundled Node runtime could not load. Rebuild or reinstall the app.".into();
        }
        let redacted = redact_stderr(stderr);
        let lines: Vec<&str> = redacted
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && *line != REDACTED_LINE)
            .collect();
        let summary = lines
            .iter()
            .find(|line| {
                line.split_whitespace()
                    .next()
                    .is_some_and(|word| word.trim_end_matches(':').ends_with("Error"))
            })
            .or(lines.last());
        match (summary, status) {
            (Some(summary), _) => format!(
                "The walk browser collector stopped before it was ready: {}",
                summary.chars().take(300).collect::<String>()
            ),
            (None, Some(status)) => {
                format!("The walk browser collector stopped before it was ready ({status}).")
            }
            (None, None) => "The walk browser collector stopped before it was ready.".into(),
        }
    }

    fn exit_status(browser: &mut Browser) -> Option<ExitStatus> {
        let child = browser.child.as_mut()?;
        for _ in 0..50 {
            if let Some(status) = child.try_wait().ok().flatten() {
                return Some(status);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        None
    }

    fn spawn() -> Result<Browser, String> {
        let engine = engine()?;
        let capture_id = crate::store::new_uuid_v4();
        let work_dir = crate::store::app_data_dir()
            .join("walk-browser")
            .join(&capture_id);
        std::fs::create_dir_all(&work_dir).map_err(|error| error.to_string())?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&work_dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
        let mut command = Command::new(engine.join("bin/node"));
        command
            .arg(engine.join("native-browser.mjs"))
            .arg(&capture_id)
            .arg(work_dir)
            .env(
                "CAP_UX_WALK_CONFIG_DIR",
                crate::ux_walk::config_path()
                    .parent()
                    .ok_or("Invalid walk settings folder.")?,
            );
        start_collector(command, capture_id)
    }

    fn start_collector(mut command: Command, capture_id: String) -> Result<Browser, String> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                format!(
                    "Could not start the bundled Node runtime: {error}. Rebuild or reinstall the app."
                )
            })?;
        let input = child
            .stdin
            .take()
            .ok_or("Browser control input unavailable.")?;
        let output = child
            .stdout
            .take()
            .ok_or("Browser control output unavailable.")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("Browser diagnostic output unavailable.")?;
        let (send_stderr, stderr_tail) = mpsc::channel();
        // Runs until the child exits, however long that is, so a full pipe can never block it.
        std::thread::spawn(move || {
            let tail = read_tail(stderr);
            if !tail.is_empty() {
                tracing::warn!(
                    stderr = %redact_stderr(&tail),
                    "walk browser collector wrote to stderr"
                );
            }
            let _ = send_stderr.send(tail);
        });
        let (send, replies) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let response = line.map_err(|error| error.to_string()).and_then(|line| {
                    if line.len() > 65536 {
                        Err("Browser control response was too large.".into())
                    } else {
                        serde_json::from_str(&line).map_err(|error| error.to_string())
                    }
                });
                if send.send(response).is_err() {
                    return;
                }
            }
            let _ = send.send(Err(COLLECTOR_CLOSED.into()));
        });
        let mut browser = Browser {
            capture_id,
            window_id: None,
            journal: None,
            child: Some(child),
            input: Some(input),
            replies,
        };
        let ready = match browser.replies.recv_timeout(Duration::from_secs(25)) {
            Ok(Ok(ready)) => ready,
            Ok(Err(error)) if error == COLLECTOR_CLOSED => {
                let stderr = stderr_tail
                    .recv_timeout(Duration::from_secs(2))
                    .unwrap_or_default();
                return Err(startup_failure(&stderr, exit_status(&mut browser)));
            }
            Ok(Err(error)) => return Err(error),
            Err(_) => return Err("The walk browser could not start in time.".into()),
        };
        if ready["ready"] != true || ready["captureId"].as_str() != Some(&browser.capture_id) {
            return Err(ready["error"]
                .as_str()
                .unwrap_or(
                    "The walk browser could not start. Check that Google Chrome is installed.",
                )
                .to_string());
        }
        Ok(browser)
    }

    pub fn open() -> Result<crate::devices::WindowOption, String> {
        let settings = crate::ux_walk::load()?;
        let url = reqwest::Url::parse(crate::ux_walk::text(&settings, "url")).map_err(|_| {
            fork_brand::mode_text_static("Enter a valid start page in %walk% settings.")
        })?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err("Use an http or https start page.".into());
        }
        let before: Vec<String> = scap_targets::Window::list()
            .into_iter()
            .map(|window| window.id().to_string())
            .collect();
        let mut browser = spawn()?;
        let marker = format!("UX Walk {}", browser.capture_id);
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(15) {
            let matches: Vec<_> = crate::devices::list_window_targets()
                .into_iter()
                .filter(|(option, window)| {
                    window.raw_handle().bundle_identifier().as_deref() == Some("com.google.Chrome")
                        && option.label.contains(&marker)
                })
                .map(|(option, _)| option)
                .collect();
            if let Some(id) = crate::ux_walk_browser_target::new_window(
                &before,
                matches.iter().map(|window| window.id.to_string()).collect(),
            )? {
                let mut window = matches
                    .into_iter()
                    .find(|window| window.id.to_string() == id)
                    .ok_or("The new browser window disappeared.")?;
                browser.command(
                    json!({ "op": "bind", "windowId": id }),
                    Duration::from_secs(3),
                )?;
                browser.window_id = Some(id);
                browser.command(
                    json!({ "op": "navigate", "url": url.as_str() }),
                    Duration::from_secs(15),
                )?;
                window.label = format!(
                    "{} · {}",
                    fork_brand::WALK_MODE_NAME,
                    url.host_str().unwrap_or("Chrome")
                );
                browsers()
                    .lock()
                    .map_err(|_| "Browser ownership is unavailable.")?
                    .push(browser);
                return Ok(window);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err("The browser opened, but its window could not be selected. Choose Window in the recorder and check Screen Recording permission.".into())
    }

    fn unavailable(journal: &crate::ux_walk_journal::Journal, reason: &str) {
        let file = journal.request.directory.join("browser-evidence.json");
        let mut value = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .unwrap_or_else(|| json!({ "schemaVersion": 1 }));
        value["state"] = json!(if value.get("captureId").is_some() {
            "failed"
        } else {
            "unavailable"
        });
        value["reason"] = json!(reason);
        let temporary = file.with_extension("json.tmp");
        use std::os::unix::fs::OpenOptionsExt;
        let result = (|| -> Result<(), String> {
            let mut output = std::fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .mode(0o600)
                .open(&temporary)
                .map_err(|error| error.to_string())?;
            output
                .write_all(&serde_json::to_vec_pretty(&value).map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())?;
            output.sync_all().map_err(|error| error.to_string())?;
            std::fs::rename(temporary, file).map_err(|error| error.to_string())
        })();
        if let Err(error) = result {
            tracing::warn!(%error, "could not save browser coverage status");
        }
    }

    pub fn begin(
        journal: &crate::ux_walk_journal::Journal,
        window_id: Option<String>,
    ) -> Result<(), String> {
        let mut browsers = browsers()
            .lock()
            .map_err(|_| "Browser ownership is unavailable.")?;
        let Some(browser) = browsers
            .iter_mut()
            .find(|browser| browser.window_id == window_id && window_id.is_some())
        else {
            unavailable(
                journal,
                "The selected source is not the browser window opened for this walk",
            );
            return Ok(());
        };
        match browser.command(
            json!({ "op": "start", "file": journal.file(), "windowId": window_id }),
            Duration::from_secs(3),
        ) {
            Ok(()) => {
                browser.journal = Some(journal.file());
                Ok(())
            }
            Err(error) => {
                drop(browser.input.take());
                unavailable(journal, &error);
                Err(error)
            }
        }
    }

    pub fn clock(journal: &crate::ux_walk_journal::Journal, offset_ms: u64, paused: bool) {
        let Ok(mut browsers) = browsers().lock() else {
            return;
        };
        let Some(browser) = browsers
            .iter_mut()
            .find(|browser| browser.journal.as_ref() == Some(&journal.file()))
        else {
            return;
        };
        let wall_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        if let Err(error) = browser.command(json!({ "op": "clock", "file": journal.file(), "wallMs": wall_ms, "offsetMs": offset_ms, "paused": paused }), Duration::from_secs(2)) {
            drop(browser.input.take());
            unavailable(journal, &error);
        }
    }

    pub fn finish(journal: &crate::ux_walk_journal::Journal, aborted: bool) {
        let Ok(mut browsers) = browsers().lock() else {
            return;
        };
        let Some(browser) = browsers
            .iter_mut()
            .find(|browser| browser.journal.as_ref() == Some(&journal.file()))
        else {
            return;
        };
        let operation = if aborted { "abort" } else { "stop" };
        if let Err(error) = browser.command(
            json!({ "op": operation, "file": journal.file() }),
            Duration::from_secs(10),
        ) {
            drop(browser.input.take());
            unavailable(journal, &error);
        }
        browser.journal = None;
    }

    // Dropping a Browser closes its collector's stdin, and the collector then closes the one
    // Chrome it launched. Nothing here can reach a Chrome this app did not start.
    fn release_prepared(browsers: &mut Vec<Browser>) {
        browsers.retain(|browser| browser.journal.is_some());
    }

    fn release_window(browsers: &mut Vec<Browser>, id: &str) {
        browsers.retain(|browser| {
            browser.journal.is_some() || browser.window_id.as_deref() != Some(id)
        });
    }

    /// Stops every Chrome this app started for a walk once that walk is over, including windows
    /// the walk never recorded.
    pub fn end_walk(journal: &crate::ux_walk_journal::Journal, aborted: bool) {
        finish(journal, aborted);
        if let Ok(mut browsers) = browsers().lock() {
            release_prepared(&mut browsers);
        }
    }

    /// Stops the walk Chromes that no recording is using.
    pub fn close_prepared() {
        if let Ok(mut browsers) = browsers().lock() {
            release_prepared(&mut browsers);
        }
    }

    /// Stops one walk Chrome whose window nobody will use, such as a superseded open.
    pub fn close_window(id: &str) {
        if let Ok(mut browsers) = browsers().lock() {
            release_window(&mut browsers, id);
        }
    }

    pub fn window_is_owned(id: &str) -> bool {
        browsers().lock().is_ok_and(|browsers| {
            browsers
                .iter()
                .any(|browser| browser.window_id.as_deref() == Some(id))
        })
    }

    pub fn interrupt(journal: &crate::ux_walk_journal::Journal, reason: &str) {
        finish(journal, true);
        unavailable(journal, reason);
    }

    pub fn health(journal: &crate::ux_walk_journal::Journal) -> Option<String> {
        if let Ok(mut browsers) = browsers().lock()
            && let Some(browser) = browsers
                .iter_mut()
                .find(|browser| browser.journal.as_ref() == Some(&journal.file()))
            && browser
                .child
                .as_mut()
                .is_none_or(|child| child.try_wait().ok().flatten().is_some())
        {
            unavailable(
                journal,
                "The walk browser collector exited during recording; browser evidence is partial",
            );
            browser.journal = None;
        }
        let metadata = std::fs::read(journal.request.directory.join("browser-evidence.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())?;
        (metadata["state"] == "failed").then(|| {
            metadata["reason"]
                .as_str()
                .unwrap_or("Browser evidence is partial")
                .to_string()
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn shell(script: &str) -> Result<Browser, String> {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", script]);
            start_collector(command, "stderr-test".into())
        }

        fn collector_until_stdin_closes(marker: &Path) -> Browser {
            let script = format!(
                r#"printf '{{"ready":true,"captureId":"stderr-test"}}\n'
                cat >/dev/null
                : > '{}'"#,
                marker.display()
            );
            shell(&script).ok().unwrap()
        }

        fn stopped(marker: &Path) -> bool {
            let started = Instant::now();
            while started.elapsed() < Duration::from_secs(5) {
                if marker.exists() {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            false
        }

        #[test]
        fn a_walk_stops_only_the_collectors_no_recording_is_using() {
            let directory = std::env::temp_dir().join(format!(
                "ux-walk-browser-release-{}-{}",
                std::process::id(),
                crate::store::new_uuid_v4()
            ));
            std::fs::create_dir_all(&directory).unwrap();
            let [prepared, recording, other] =
                ["prepared", "recording", "other"].map(|name| directory.join(name));
            let mut first = collector_until_stdin_closes(&prepared);
            first.window_id = Some("1".into());
            let mut second = collector_until_stdin_closes(&recording);
            second.window_id = Some("2".into());
            second.journal = Some(directory.join("journal.json"));
            let mut third = collector_until_stdin_closes(&other);
            third.window_id = Some("3".into());
            let mut browsers = vec![first, second, third];

            release_window(&mut browsers, "1");
            assert!(stopped(&prepared));
            release_window(&mut browsers, "2");
            assert_eq!(browsers.len(), 2);
            assert!(!other.exists() && !recording.exists());

            release_prepared(&mut browsers);
            assert!(stopped(&other));
            assert_eq!(browsers.len(), 1);
            std::thread::sleep(Duration::from_millis(200));
            assert!(!recording.exists());

            browsers.clear();
            assert!(stopped(&recording));
            std::fs::remove_dir_all(directory).unwrap();
        }

        #[test]
        fn noisy_stderr_cannot_block_the_ready_handshake() {
            let browser = shell(
                r#"head -c 300000 /dev/zero | tr '\0' x >&2
                printf '{"ready":true,"captureId":"stderr-test"}\n'"#,
            );
            assert!(browser.is_ok());
        }

        #[test]
        fn a_load_failure_blames_the_runtime_and_not_chrome() {
            let error = shell(
                "echo 'dyld[7]: Library not loaded: @rpath/libnode.127.dylib' >&2; kill -ABRT $$",
            )
            .err()
            .unwrap();
            assert!(error.contains("bundled Node runtime"), "{error}");
            assert!(!error.contains("Chrome"), "{error}");
        }

        #[test]
        fn an_uncaught_error_is_summarized_without_its_secrets() {
            let error = shell(
                r#"cat >&2 <<'EOF'
Authorization: abc123-header
    throw new Error("nope")

TypeError: request to https://me:hunter2@example.com/a failed for someone@example.com
    at run (file:///app/native-browser.mjs:1:1)
EOF
                exit 1"#,
            )
            .err()
            .unwrap();
            assert!(error.contains("TypeError: request to [url]"), "{error}");
            for secret in ["abc123", "hunter2", "someone@"] {
                assert!(!error.contains(secret), "{error}");
            }
        }

        #[test]
        fn a_silent_exit_reports_its_status() {
            let error = shell("exit 3").err().unwrap();
            assert!(error.contains("exit status: 3"), "{error}");
        }

        #[test]
        fn the_collectors_own_redacted_error_is_kept() {
            let error = shell(
                r#"echo 'stray warning' >&2
                printf '{"ready":false,"error":"Chromium is not installed"}\n'
                exit 1"#,
            )
            .err()
            .unwrap();
            assert_eq!(error, "Chromium is not installed");
        }

        #[test]
        fn redaction_drops_lines_with_credentials_and_keeps_stack_frames() {
            let redacted = redact_stderr(
                "x-api-key: abc\nsession cookie=abc\nconnect postgres://me:abc@db/app failed\n    at file:///app/src/browser.mjs:1:1",
            );
            assert!(!redacted.contains("abc"), "{redacted}");
            assert!(redacted.ends_with("at file:///app/src/browser.mjs:1:1"));
        }

        #[test]
        fn the_tail_is_bounded_and_never_starts_inside_a_line() {
            let mut stream = format!("Bearer {}\n", "s".repeat(STDERR_TAIL_BYTES)).into_bytes();
            stream.extend_from_slice(b"Error: the last words\n");
            let tail = read_tail(std::io::Cursor::new(stream));
            assert_eq!(tail, "Error: the last words");
            let endless = vec![b's'; STDERR_TAIL_BYTES * 3];
            assert_eq!(read_tail(std::io::Cursor::new(endless)), "");
        }

        #[test]
        fn exited_collector_marks_partial_without_touching_media_or_notes() {
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let directory = std::env::temp_dir().join(format!(
                "ux-walk-browser-health-{}-{unique}",
                std::process::id()
            ));
            let mut journal = crate::ux_walk_journal::Journal::begin(
                crate::ux_walk_journal::Request {
                    directory: directory.clone(),
                    topic: "Health contract".into(),
                    url: "https://example.com".into(),
                    speakers: Vec::new(),
                    kind: crate::ux_walk_journal::Kind::Walk,
                },
                directory.with_extension("cap"),
                100000,
            )
            .unwrap();
            journal.add("note", "Preserve this finding", 10).unwrap();
            std::fs::create_dir(&journal.source_project).unwrap();
            let media = journal.source_project.join("source.mp4");
            std::fs::write(&media, b"synthetic media bytes").unwrap();
            let before = std::fs::read(journal.file()).unwrap();
            std::fs::write(
                directory.join("browser-evidence.json"),
                br#"{"schemaVersion":1,"captureId":"test","state":"recording"}"#,
            )
            .unwrap();
            let mut child = Command::new("/usr/bin/true").spawn().unwrap();
            child.wait().unwrap();
            let (_send, replies) = mpsc::channel();
            browsers().lock().unwrap().push(Browser {
                capture_id: "test".into(),
                window_id: Some("17".into()),
                journal: Some(journal.file()),
                child: Some(child),
                input: None,
                replies,
            });
            assert!(
                health(&journal)
                    .unwrap()
                    .contains("exited during recording")
            );
            let metadata: Value = serde_json::from_slice(
                &std::fs::read(directory.join("browser-evidence.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(metadata["state"], "failed");
            assert_eq!(std::fs::read(journal.file()).unwrap(), before);
            assert_eq!(std::fs::read(media).unwrap(), b"synthetic media bytes");
            browsers()
                .lock()
                .unwrap()
                .retain(|browser| browser.capture_id != "test");
            std::fs::remove_dir_all(directory).unwrap();
            std::fs::remove_dir_all(journal.source_project).unwrap();
        }
    }
}

#[cfg(target_os = "macos")]
pub use owned::{
    begin, clock, close_prepared, close_window, end_walk, finish, health, interrupt, open,
    window_is_owned,
};

#[cfg(not(target_os = "macos"))]
pub fn open() -> Result<crate::devices::WindowOption, String> {
    Err("Automatic browser windows are available on macOS.".into())
}

#[cfg(not(target_os = "macos"))]
pub fn begin(
    _journal: &crate::ux_walk_journal::Journal,
    _window_id: Option<String>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn clock(_journal: &crate::ux_walk_journal::Journal, _offset_ms: u64, _paused: bool) {}

#[cfg(not(target_os = "macos"))]
pub fn finish(_journal: &crate::ux_walk_journal::Journal, _aborted: bool) {}

#[cfg(not(target_os = "macos"))]
pub fn end_walk(_journal: &crate::ux_walk_journal::Journal, _aborted: bool) {}

#[cfg(not(target_os = "macos"))]
pub fn close_prepared() {}

#[cfg(not(target_os = "macos"))]
pub fn close_window(_id: &str) {}

#[cfg(not(target_os = "macos"))]
pub fn window_is_owned(_id: &str) -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub fn interrupt(_journal: &crate::ux_walk_journal::Journal, _reason: &str) {}

#[cfg(not(target_os = "macos"))]
pub fn health(_journal: &crate::ux_walk_journal::Journal) -> Option<String> {
    None
}
