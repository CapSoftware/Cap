//! The real app against `MockCap`: record, crash, cancel and recover Instant
//! recordings, then check what reached the mock server and what was left on
//! disk. Each case needs a built app and screen recording permission, so they
//! are ignored by default:
//!
//! ```sh
//! CAP_GPUI_REAL_APP_BIN=target/debug/cap-gpui \
//!   cargo test --bin cap-gpui real_app -- --ignored --test-threads=1
//! ```

use super::verify_tests::{API_KEY, Fault, MockCap, OWNER, Route, rule};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::{Child, Command},
    time::{Duration, Instant, SystemTime},
};

const JOURNAL: &str = "gpui-instant-cleanup.json";
const STATE: &str = "instant-upload.json";

struct Sandbox {
    root: tempfile::TempDir,
}

impl Sandbox {
    /// Kept under `CAP_GPUI_REAL_APP_ARTIFACTS` when that is set, so a failed
    /// run leaves the app's logs and recordings behind.
    fn new(server: &str, countdown: u32) -> Self {
        let root = match std::env::var_os("CAP_GPUI_REAL_APP_ARTIFACTS") {
            Some(directory) => {
                std::fs::create_dir_all(&directory).unwrap();
                tempfile::Builder::new()
                    .prefix("sandbox-")
                    .disable_cleanup(true)
                    .tempdir_in(directory)
                    .unwrap()
            }
            None => tempfile::tempdir().unwrap(),
        };
        std::fs::create_dir_all(root.path().join("recordings")).unwrap();
        std::fs::create_dir_all(root.path().join("logs")).unwrap();
        std::fs::write(
            root.path().join("store"),
            serde_json::to_vec(&json!({
                "general_settings": {
                    "serverUrl": server,
                    "enableNotifications": false,
                    "hasCompletedOnboarding": true,
                    "recordingCountdown": countdown,
                    "enableTelemetry": false,
                },
                "recording_start_safety": {
                    "confirmBeforeRecordingWithoutMicrophone": false,
                },
                "auth": {
                    "secret": { "api_key": API_KEY },
                    "user_id": OWNER,
                    "plan": { "upgraded": true, "manual": true },
                    "organizations": [],
                },
            }))
            .unwrap(),
        )
        .unwrap();
        Self { root }
    }

    fn set_general(&self, key: &str, value: Value) {
        let path = self.root.path().join("store");
        let mut store: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        store["general_settings"][key] = value;
        std::fs::write(path, serde_json::to_vec(&store).unwrap()).unwrap();
    }

    fn launch(&self, name: &str, env: &[(&str, &str)]) -> App {
        let binary = std::env::var("CAP_GPUI_REAL_APP_BIN")
            .expect("set CAP_GPUI_REAL_APP_BIN to the built cap-gpui binary");
        let log = std::fs::File::create(self.root.path().join(format!("{name}.log"))).unwrap();
        let mut command = Command::new(binary);
        command
            .env("CAP_GPUI_APP_DATA_DIR", self.root.path())
            .env("CAP_GPUI_RECORDINGS_DIR", self.recordings())
            .env("CAP_GPUI_LOG_DIR", self.root.path().join("logs"))
            .env("CAP_GPUI_NO_TRAY", "1")
            .env("CAP_GPUI_NO_MENUS", "1")
            .env("CAP_GPUI_AUTO_NO_MIC", "1")
            .env("RUST_LOG", "cap_gpui=info,cap_recording=info")
            .stdout(log.try_clone().unwrap())
            .stderr(log);
        for (key, value) in env {
            command.env(key, value);
        }
        App(Some(command.spawn().unwrap()))
    }

    fn log(&self, name: &str) -> String {
        std::fs::read_to_string(self.root.path().join(format!("{name}.log"))).unwrap_or_default()
    }

    fn recordings(&self) -> PathBuf {
        self.root.path().join("recordings")
    }

    fn journal(&self) -> Vec<Value> {
        std::fs::read(self.root.path().join(JOURNAL))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|journal| journal["entries"].as_array().cloned())
            .unwrap_or_default()
    }

    fn projects(&self) -> Vec<PathBuf> {
        let mut projects: Vec<_> = std::fs::read_dir(self.recordings())
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.path())
                    .filter(|path| path.extension().is_some_and(|extension| extension == "cap"))
                    .collect()
            })
            .unwrap_or_default();
        projects.sort();
        projects
    }

    fn project_for(&self, video_id: &str) -> Option<PathBuf> {
        self.projects()
            .into_iter()
            .find(|project| state(project).is_some_and(|state| state["video_id"] == video_id))
    }

    /// Moves every journal entry and upload state an hour into the past, as
    /// if the crashed session ended long before the relaunch.
    fn age(&self) {
        let path = self.root.path().join(JOURNAL);
        if let Ok(bytes) = std::fs::read(&path) {
            let mut journal: Value = serde_json::from_slice(&bytes).unwrap();
            let past = chrono::Utc::now().timestamp() - 3600;
            for entry in journal["entries"].as_array_mut().into_iter().flatten() {
                entry["created_at"] = json!(past);
                entry["next_attempt_at"] = json!(past);
            }
            std::fs::write(&path, serde_json::to_vec(&journal).unwrap()).unwrap();
        }
        for project in self.projects() {
            let state = project.join(STATE);
            if state.exists() {
                std::fs::File::options()
                    .write(true)
                    .open(&state)
                    .unwrap()
                    .set_modified(SystemTime::now() - Duration::from_secs(3600))
                    .unwrap();
            }
        }
    }
}

fn state(project: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(project.join(STATE)).ok()?).ok()
}

fn meta(project: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(project.join("recording-meta.json")).ok()?).ok()
}

fn media_files(project: &Path) -> usize {
    fn walk(directory: &Path, depth: usize) -> usize {
        let Ok(entries) = std::fs::read_dir(directory) else {
            return 0;
        };
        entries
            .flatten()
            .map(|entry| {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                if path.is_dir() {
                    if depth > 0 { walk(&path, depth - 1) } else { 0 }
                } else {
                    let sized = entry.metadata().is_ok_and(|metadata| metadata.len() > 0);
                    let segment = name.ends_with(".m4s")
                        || name.ends_with(".m4s.tmp")
                        || name.ends_with(".m4s.unsealed");
                    usize::from(
                        sized && (segment || (name.ends_with(".mp4") && !name.starts_with("init"))),
                    )
                }
            })
            .sum()
    }
    walk(&project.join("content"), 3)
}

fn finished_segments(project: &Path) -> usize {
    std::fs::read(project.join("content/display/manifest.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|manifest| {
            manifest["segments"].as_array().map(|segments| {
                segments
                    .iter()
                    .filter(|segment| segment["is_complete"] == true)
                    .count()
            })
        })
        .unwrap_or(0)
}

/// Waits for `done` while the app runs. If the app does not get there in
/// time, its threads are sampled into the sandbox before the test fails, so a
/// hang can be diagnosed from the artifacts.
async fn wait_for_app(
    sandbox: &Sandbox,
    app: &App,
    what: &str,
    timeout: Duration,
    mut done: impl FnMut() -> bool,
) {
    let deadline = Instant::now() + timeout;
    while !done() {
        if Instant::now() >= deadline {
            let report = sandbox.root.path().join("hang-sample.txt");
            #[cfg(target_os = "macos")]
            let _ = Command::new("sample")
                .args([&app.id().to_string(), "5", "-file"])
                .arg(&report)
                .status();
            panic!(
                "timed out waiting for {what}; app {} sampled to {}",
                app.id(),
                report.display()
            );
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// A launched app, killed when dropped, so a failing test never leaves it
/// running into the next one.
struct App(Option<Child>);

impl App {
    fn id(&self) -> u32 {
        self.0.as_ref().map_or(0, Child::id)
    }
}

impl Drop for App {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn kill(app: App) {
    drop(app);
}

fn without_ansi(line: &str) -> String {
    let mut plain = String::with_capacity(line.len());
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            plain.push(c);
        }
    }
    plain
}

/// A normal Instant recording uploads, verifies, and leaves nothing for the
/// cleanup journal.
#[ignore]
#[tokio::test(flavor = "multi_thread")]
async fn real_app_instant_recording_uploads_and_verifies() {
    let mock = MockCap::start(Vec::new()).await;
    let sandbox = Sandbox::new(&mock.url, 0);
    let app = sandbox.launch("record", &[("CAP_GPUI_AUTO_RECORD", "instant:6")]);
    wait_for_app(
        &sandbox,
        &app,
        "a verified upload",
        Duration::from_secs(180),
        || {
            sandbox
                .projects()
                .first()
                .and_then(|project| state(project))
                .is_some_and(|state| state["phase"] == "Verified")
        },
    )
    .await;
    kill(app);
    let video = mock.created();
    assert_eq!(video.len(), 1, "{video:?}");
    assert!(
        mock.confirmations()
            .iter()
            .any(|confirmation| confirmation["videoId"] == video[0].as_str())
    );
    assert!(mock.deleted().is_empty(), "{:?}", mock.deleted());
    assert!(sandbox.journal().is_empty(), "{:?}", sandbox.journal());
}

/// An Instant recording with the camera on uploads and verifies. On Linux the
/// camera is drawn into the screen video, so a camera that stalls or sends a
/// bad frame stops the recording. Runs only with `CAP_GPUI_REAL_APP_CAMERA=1`,
/// since it needs a camera attached; the CI job feeds a virtual one and checks
/// its picture reached the video.
#[ignore]
#[tokio::test(flavor = "multi_thread")]
async fn real_app_instant_recording_with_camera_uploads_and_verifies() {
    if std::env::var("CAP_GPUI_REAL_APP_CAMERA").is_err() {
        eprintln!("skipped: set CAP_GPUI_REAL_APP_CAMERA=1 where a camera is attached");
        return;
    }
    let mock = MockCap::start(Vec::new()).await;
    let sandbox = Sandbox::new(&mock.url, 0);
    let app = sandbox.launch(
        "camera",
        &[
            ("CAP_GPUI_AUTO_CAMERA", "1"),
            ("CAP_GPUI_AUTO_RECORD", "instant:60"),
        ],
    );
    // On X11 a window recorded with the camera hides Cap's controls, and the
    // recording waits for the Stop shortcut to start; the same shortcut stops
    // it, well before the automatic stop.
    #[cfg(target_os = "linux")]
    {
        let press = || {
            let status = Command::new("xdotool")
                .args(["key", "ctrl+shift+F9"])
                .status()
                .expect("install xdotool");
            assert!(status.success());
        };
        let sandbox = &sandbox;
        let logged = |line: &'static str| move || sandbox.log("camera").contains(line);
        let start = Duration::from_secs(60);
        wait_for_app(
            sandbox,
            &app,
            "the start press",
            start,
            logged("overlay start pressed"),
        )
        .await;
        tokio::time::sleep(Duration::from_secs(2)).await;
        press();
        wait_for_app(
            sandbox,
            &app,
            "the recording to start",
            start,
            logged("recording started"),
        )
        .await;
        tokio::time::sleep(Duration::from_secs(8)).await;
        press();
    }
    wait_for_app(
        &sandbox,
        &app,
        "a verified upload",
        Duration::from_secs(180),
        || {
            sandbox
                .projects()
                .first()
                .and_then(|project| state(project))
                .is_some_and(|state| state["phase"] == "Verified")
        },
    )
    .await;
    kill(app);
    let log = sandbox.log("camera");
    assert!(log.contains("auto-selecting camera"), "no camera selected");
    let video = mock.created();
    assert_eq!(video.len(), 1, "{video:?}");
    assert!(
        mock.confirmations()
            .iter()
            .any(|confirmation| confirmation["videoId"] == video[0].as_str())
    );
    let project = sandbox.projects().remove(0);
    assert!(finished_segments(&project) >= 3, "{}", project.display());
    assert!(mock.deleted().is_empty(), "{:?}", mock.deleted());
    assert!(sandbox.journal().is_empty(), "{:?}", sandbox.journal());
    assert!(!log.contains("panicked at"), "the app panicked");
}

/// The After an Instant recording outcome decides whether the main window,
/// hidden at start, comes back once the recording finishes: only Show Cap
/// takes the reshow, so opening the link never leaves it on screen behind the
/// browser. The reshow itself lands on onboarding here (the runner grants no
/// Accessibility), so the check reads the decisions the app logs. Linux
/// restores the window through its clean-capture lease instead, so the check
/// is macOS only.
#[cfg(target_os = "macos")]
#[ignore]
#[tokio::test(flavor = "multi_thread")]
async fn real_app_instant_outcome_decides_whether_main_window_returns() {
    for (name, disable_open, show_main, returns) in [
        ("open-link", false, false, false),
        ("show-cap", true, true, true),
        ("copy-link", true, false, false),
    ] {
        let mock = MockCap::start(Vec::new()).await;
        let sandbox = Sandbox::new(&mock.url, 0);
        sandbox.set_general("disableAutoOpenLinks", json!(disable_open));
        sandbox.set_general("showMainWindowAfterInstantRecording", json!(show_main));
        let app = sandbox.launch(name, &[("CAP_GPUI_AUTO_RECORD", "instant:3")]);
        wait_for_app(
            &sandbox,
            &app,
            "a verified upload",
            Duration::from_secs(180),
            || {
                sandbox
                    .projects()
                    .first()
                    .and_then(|project| state(project))
                    .is_some_and(|state| state["phase"] == "Verified")
            },
        )
        .await;
        tokio::time::sleep(Duration::from_secs(2)).await;
        kill(app);
        let log = without_ansi(&sandbox.log(name));
        let (_, after) = log
            .split_once("recording finished")
            .expect("the recording finished");
        let kept_hidden = after.contains("main window kept hidden after the Instant recording");
        let reshown = after.contains("showing the main window");
        assert_eq!(kept_hidden, !returns, "{name}: {after}");
        assert_eq!(reshown, returns, "{name}: {after}");
        assert_eq!(mock.created().len(), 1, "{name}");
    }
}

/// Kills the app at points from the server video's creation through the
/// first seconds of capture, then relaunches long after. Each recording's state
/// is noted right after its kill, before anything else runs: a recording that
/// held media keeps its folder, its media and its server video, and every
/// crashed recording that held none in a folder still in progress has its
/// server video deleted.
#[ignore]
#[tokio::test(flavor = "multi_thread")]
async fn real_app_crashes_never_delete_a_recording_with_media() {
    struct Crashed {
        video: String,
        project: Option<PathBuf>,
        media: usize,
        in_progress: bool,
    }
    let mock = MockCap::start(Vec::new()).await;
    let sandbox = Sandbox::new(&mock.url, 2);
    let mut crashed = Vec::new();
    for (attempt, offset_ms) in [0u64, 150, 400, 800, 1500, 2500, 4000, 7000]
        .into_iter()
        .enumerate()
    {
        let created = mock.created().len();
        let app = sandbox.launch(
            &format!("crash-{attempt}"),
            &[("CAP_GPUI_AUTO_RECORD", "instant:60")],
        );
        wait_for_app(
            &sandbox,
            &app,
            "the server video",
            Duration::from_secs(60),
            || mock.created().len() > created,
        )
        .await;
        tokio::time::sleep(Duration::from_millis(offset_ms)).await;
        kill(app);
        let video = mock.created()[created].clone();
        let project = sandbox.project_for(&video);
        crashed.push(Crashed {
            media: project.as_deref().map(media_files).unwrap_or(0),
            in_progress: project
                .as_deref()
                .and_then(meta)
                .is_some_and(|meta| meta.get("recording").is_some()),
            video,
            project,
        });
    }
    sandbox.age();
    let app = sandbox.launch("sweep", &[]);
    tokio::time::sleep(Duration::from_secs(20)).await;
    kill(app);

    let deleted = mock.deleted();
    for recording in &crashed {
        let video = &recording.video;
        if recording.media > 0 {
            assert!(
                !deleted.contains(video),
                "{video} was deleted although its recording held media"
            );
            let project = recording.project.as_deref().unwrap();
            assert!(project.is_dir(), "{video}'s recording was removed");
            assert!(
                media_files(project) >= recording.media,
                "{video}'s recording lost media"
            );
        } else if recording.project.is_some() && recording.in_progress {
            assert!(
                deleted.contains(video),
                "{video} crashed before capturing anything but was kept"
            );
        }
    }
}

/// Kills the app mid-recording with media saved, then relaunches and presses
/// Recover: the recovered recording uploads under the same video id.
#[ignore]
#[tokio::test(flavor = "multi_thread")]
async fn real_app_recovered_recording_uploads() {
    let mock = MockCap::start(Vec::new()).await;
    let sandbox = Sandbox::new(&mock.url, 0);
    let app = sandbox.launch("record", &[("CAP_GPUI_AUTO_RECORD", "instant:120")]);
    wait_for_app(
        &sandbox,
        &app,
        "four finished segments",
        Duration::from_secs(120),
        || {
            sandbox
                .projects()
                .first()
                .is_some_and(|project| finished_segments(project) >= 4)
        },
    )
    .await;
    kill(app);
    let project = sandbox.projects().remove(0);
    let video = state(&project).unwrap()["video_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(mock.confirmations().is_empty());

    let app = sandbox.launch("recover", &[("CAP_GPUI_AUTO_RECOVER", "1")]);
    wait_for_app(
        &sandbox,
        &app,
        "the recovered upload to verify",
        Duration::from_secs(240),
        || state(&project).is_some_and(|state| state["phase"] == "Verified"),
    )
    .await;
    kill(app);
    assert!(project.join("content/output.mp4").is_file());
    assert!(
        mock.confirmations()
            .iter()
            .any(|confirmation| confirmation["videoId"] == video.as_str())
    );
    for index in 1..=4 {
        assert!(
            mock.object(&format!("{video}/segments/video/segment_{index:03}.m4s"))
                .is_some(),
            "segment {index} missing"
        );
    }
    assert!(!mock.deleted().contains(&video));
}

/// Stops the recording while its start is still in flight: the server video
/// it created is deleted and nothing is left behind. A stop that lands after
/// capture began exercises nothing, so the case retries until one lands
/// during the start, and fails if none does.
#[ignore]
#[tokio::test(flavor = "multi_thread")]
async fn real_app_cancelled_start_deletes_its_video() {
    let mock = MockCap::start(Vec::new()).await;
    let sandbox = Sandbox::new(&mock.url, 2);
    for attempt in 0..5 {
        let name = format!("cancel-{attempt}");
        let before = mock.created().len();
        let app = sandbox.launch(&name, &[("CAP_GPUI_AUTO_RECORD", "instant:2")]);
        wait_for_app(
            &sandbox,
            &app,
            "the server video",
            Duration::from_secs(60),
            || mock.created().len() > before,
        )
        .await;
        tokio::time::sleep(Duration::from_secs(15)).await;
        kill(app);
        let video = mock.created()[before].clone();
        if sandbox.log(&name).contains("recording started") {
            eprintln!("attempt {attempt}: the stop landed after capture began, retrying");
            continue;
        }
        assert!(mock.deleted().contains(&video), "{video} was not deleted");
        assert!(sandbox.project_for(&video).is_none());
        assert!(
            sandbox
                .journal()
                .iter()
                .all(|entry| entry["video_id"] != video.as_str()),
            "{:?}",
            sandbox.journal()
        );
        return;
    }
    panic!("no stop landed while the start was in flight");
}

/// The start cue tells the user they are recording. An Instant start first
/// waits for the server to create its video, which takes seconds when earlier
/// takes are still uploading. The cue must wait for capture too: it used to
/// play and arm the start gate long before the pipeline existed, so the
/// opening words of the take were never recorded.
#[ignore]
#[tokio::test(flavor = "multi_thread")]
async fn real_app_start_cue_waits_for_a_slow_server_video() {
    let mock = MockCap::start(vec![rule(
        Route::Api("video/create"),
        Fault::Delay(Duration::from_secs(4)),
    )])
    .await;
    let sandbox = Sandbox::new(&mock.url, 0);
    let app = sandbox.launch("slow-create", &[("CAP_GPUI_AUTO_RECORD", "instant:6")]);
    wait_for_app(
        &sandbox,
        &app,
        "a verified upload",
        Duration::from_secs(180),
        || {
            sandbox
                .projects()
                .first()
                .and_then(|project| state(project))
                .is_some_and(|state| state["phase"] == "Verified")
        },
    )
    .await;
    kill(app);
    let log = sandbox.log("slow-create");
    let line = |needle: &str| {
        log.lines()
            .position(|line| line.contains(needle))
            .unwrap_or_else(|| panic!("no {needle:?} in the app log:\n{log}"))
    };
    let building = line("starting recording");
    assert!(
        line("Recording start cue playing") > building,
        "the start cue played before capture was being built"
    );
    // Capture that is already running when the cue ends holds its first frame
    // behind the start gate. A cue that played first opened the gate before
    // any capture existed, so nothing was ever held.
    let first_frame = log
        .lines()
        .map(without_ansi)
        .find(|line| {
            line.contains("Start gate")
                && (line.contains("video frame") || line.contains("frame on screen"))
        })
        .unwrap_or_else(|| panic!("no first video frame in the app log:\n{log}"));
    let held = first_frame
        .split("held_frames=")
        .nth(1)
        .and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|count| count.parse::<u64>().ok())
        .unwrap_or_else(|| panic!("no held_frames in {first_frame:?}"));
    assert!(
        held >= 1,
        "capture was not running when the start cue ended: {first_frame}"
    );
    assert_eq!(mock.created().len(), 1);
}
