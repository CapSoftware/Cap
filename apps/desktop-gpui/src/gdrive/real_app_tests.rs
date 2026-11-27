//! The real app against `FakeGoogle`, signed out of Cap and set to share links
//! with Google Drive. Each case needs a built app and screen recording
//! permission, so they are ignored by default:
//!
//! ```sh
//! CAP_GPUI_REAL_APP_BIN=target/debug/cap-gpui \
//!   cargo test --locked --bin cap-gpui gdrive::real_app -- --ignored --test-threads=1
//! ```

use cap_gdrive::fake::{FakeFile, FakeGoogle, Fault};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::{Child, Command},
    time::{Duration, Instant},
};

const REFRESH_TOKEN: &str = "fake-refresh-token";
const DEADLINE: Duration = Duration::from_secs(300);

struct Sandbox {
    root: tempfile::TempDir,
    closed_server: String,
}

impl Sandbox {
    fn new(fake: &FakeGoogle) -> Self {
        let root = match std::env::var_os("CAP_GPUI_REAL_APP_ARTIFACTS") {
            Some(directory) => {
                std::fs::create_dir_all(&directory).unwrap();
                tempfile::Builder::new()
                    .prefix("gdrive-sandbox-")
                    .disable_cleanup(true)
                    .tempdir_in(directory)
                    .unwrap()
            }
            None => tempfile::tempdir().unwrap(),
        };
        std::fs::create_dir_all(root.path().join("recordings")).unwrap();
        std::fs::create_dir_all(root.path().join("logs")).unwrap();
        let closed_server = closed_server();
        std::fs::write(
            root.path().join("store"),
            serde_json::to_vec(&json!({
                "general_settings": {
                    "serverUrl": closed_server,
                    "shareLinkProvider": "googleDrive",
                    "enableNotifications": false,
                    "hasCompletedOnboarding": true,
                    "hasCompletedStartup": true,
                    "recordingCountdown": 0,
                    "enableTelemetry": false,
                },
                "recording_start_safety": {
                    "confirmBeforeRecordingWithoutMicrophone": false,
                },
            }))
            .unwrap(),
        )
        .unwrap();
        fake.issue_code("fake-code", REFRESH_TOKEN, cap_gdrive::DRIVE_FILE_SCOPE);
        let account = root.path().join(super::account::DIR);
        std::fs::create_dir_all(&account).unwrap();
        std::fs::write(
            account.join(super::account::FILE),
            serde_json::to_vec(&json!({
                "version": 1,
                "client": { "clientId": "fake-client.apps.googleusercontent.com", "clientSecret": "fake-secret" },
                "account": {
                    "email": "person@example.com",
                    "refreshToken": REFRESH_TOKEN,
                    "scope": cap_gdrive::DRIVE_FILE_SCOPE,
                    "connectedAtMs": 0,
                },
                "folder": { "name": "Cap" },
            }))
            .unwrap(),
        )
        .unwrap();
        Self {
            root,
            closed_server,
        }
    }

    fn set_general(&self, key: &str, value: Value) {
        let path = self.root.path().join("store");
        let mut store: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        store["general_settings"][key] = value;
        std::fs::write(path, serde_json::to_vec(&store).unwrap()).unwrap();
    }

    fn launch(&self, name: &str, fake: &FakeGoogle, env: &[(&str, &str)]) -> App {
        let binary = std::env::var("CAP_GPUI_REAL_APP_BIN")
            .expect("set CAP_GPUI_REAL_APP_BIN to the built cap-gpui binary");
        let log = std::fs::File::create(self.log_path(name)).unwrap();
        let mut command = Command::new(binary);
        command
            .env("CAP_GPUI_APP_DATA_DIR", self.root.path())
            .env("CAP_GPUI_RECORDINGS_DIR", self.recordings())
            .env("CAP_GPUI_LOG_DIR", self.root.path().join("logs"))
            .env("CAP_GPUI_NO_TRAY", "1")
            .env("CAP_GPUI_NO_MENUS", "1")
            .env("CAP_GPUI_AUTO_NO_MIC", "1")
            .env("CAP_GDRIVE_API_BASE", fake.base())
            .env("RUST_LOG", "cap_gpui=info,cap_recording=info")
            .stdout(log.try_clone().unwrap())
            .stderr(log);
        for (key, value) in env {
            command.env(key, value);
        }
        App(Some(command.spawn().unwrap()))
    }

    fn log_path(&self, name: &str) -> PathBuf {
        let mut file = name.to_string();
        file.push_str(".log");
        self.root.path().join(file)
    }

    fn log(&self, name: &str) -> String {
        std::fs::read_to_string(self.log_path(name)).unwrap_or_default()
    }

    fn recordings(&self) -> PathBuf {
        self.root.path().join("recordings")
    }

    fn project(&self) -> PathBuf {
        std::fs::read_dir(self.recordings())
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .find(|path| path.extension().is_some_and(|extension| extension == "cap"))
            .expect("the recording")
    }
}

fn closed_server() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let mut url = String::from("http://");
    url.push_str(&address.to_string());
    url
}

struct App(Option<Child>);

impl Drop for App {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            if let Err(error) = child.kill() {
                eprintln!("could not stop the app: {error}");
            }
            if let Err(error) = child.wait() {
                eprintln!("could not reap the app: {error}");
            }
        }
    }
}

async fn wait_for_uploads(fake: &FakeGoogle, sandbox: &Sandbox, name: &str, count: usize) {
    let mut completed = fake.completed();
    let waited = tokio::time::timeout(DEADLINE, completed.wait_for(|done| *done >= count)).await;
    assert!(
        matches!(waited, Ok(Ok(_))),
        "the fake never saw {count} finished upload(s)\n{}",
        sandbox.log(name)
    );
}

fn sharing(project: &Path) -> Option<Value> {
    let bytes = std::fs::read(project.join("recording-meta.json")).ok()?;
    let meta: Value = serde_json::from_slice(&bytes).ok()?;
    meta.get("sharing")
        .filter(|sharing| !sharing.is_null())
        .cloned()
}

async fn wait_for_sharing(sandbox: &Sandbox, name: &str, project: &Path) -> Value {
    let deadline = Instant::now() + DEADLINE;
    loop {
        if let Some(sharing) = sharing(project) {
            return sharing;
        }
        assert!(
            Instant::now() < deadline,
            "the recording never got its sharing metadata\n{}",
            sandbox.log(name)
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn uploaded_video(fake: &FakeGoogle) -> FakeFile {
    let videos: Vec<FakeFile> = fake
        .files()
        .into_iter()
        .filter(|file| file.mime_type != cap_gdrive::FOLDER_MIME)
        .collect();
    assert_eq!(videos.len(), 1, "{videos:#?}");
    videos.into_iter().next().unwrap()
}

fn assert_shared_as(sharing: &Value, file: &FakeFile) {
    let mut id = String::from("gdrive:");
    id.push_str(&file.id);
    assert_eq!(sharing["id"], json!(id));
    assert_eq!(
        sharing["link"],
        json!(cap_gdrive::fake::web_view_link(&file.id))
    );
}

fn assert_no_cap_server(sandbox: &Sandbox, name: &str) {
    let log = sandbox.log(name);
    assert!(!log.contains("prepare_instant_upload"), "{log}");
    let address = sandbox.closed_server.trim_start_matches("http://");
    assert!(!log.contains(address), "{log}");
}

async fn instant_on_drive(name: &str, faults: Vec<Fault>) -> (FakeGoogle, Sandbox, PathBuf) {
    let fake = FakeGoogle::start();
    for fault in faults {
        fake.push_fault(fault);
    }
    let sandbox = Sandbox::new(&fake);
    let app = sandbox.launch(name, &fake, &[("CAP_GPUI_AUTO_RECORD", "instant:3")]);
    wait_for_uploads(&fake, &sandbox, name, 1).await;
    let project = sandbox.project();
    let sharing = wait_for_sharing(&sandbox, name, &project).await;
    drop(app);

    let file = uploaded_video(&fake);
    let output = project.join("content").join("output.mp4");
    assert_eq!(file.bytes, std::fs::read(&output).unwrap());
    assert_shared_as(&sharing, &file);
    assert_no_cap_server(&sandbox, name);
    (fake, sandbox, project)
}

#[ignore]
#[tokio::test(flavor = "multi_thread")]
async fn real_app_signed_out_instant_uploads_to_drive_and_keeps_the_file() {
    let (fake, _sandbox, _project) = instant_on_drive("instant", Vec::new()).await;
    let file = uploaded_video(&fake);
    assert_eq!(
        file.permissions,
        vec![json!({"role": "reader", "type": "anyone", "allowFileDiscovery": false})]
    );
}

#[ignore]
#[tokio::test(flavor = "multi_thread")]
async fn real_app_studio_overlay_share_uploads_the_render_to_drive() {
    let fake = FakeGoogle::start();
    let sandbox = Sandbox::new(&fake);
    sandbox.set_general("postStudioRecordingBehaviour", json!("showOverlay"));
    let app = sandbox.launch(
        "studio",
        &fake,
        &[
            ("CAP_GPUI_AUTO_RECORD", "studio:3"),
            ("CAP_GPUI_AUTO_RECORDINGS_OVERLAY", "share"),
        ],
    );
    wait_for_uploads(&fake, &sandbox, "studio", 1).await;
    let project = sandbox.project();
    let sharing = wait_for_sharing(&sandbox, "studio", &project).await;
    drop(app);

    let file = uploaded_video(&fake);
    let render = project.join("output").join("result.mp4");
    assert_eq!(file.bytes, std::fs::read(&render).unwrap());
    assert_shared_as(&sharing, &file);
}

#[ignore]
#[tokio::test(flavor = "multi_thread")]
async fn real_app_instant_resumes_a_dropped_upload_in_the_same_session() {
    let (fake, _sandbox, _project) = instant_on_drive(
        "resume",
        vec![Fault::DropConnectionAfter { bytes: 300_000 }],
    )
    .await;
    assert_eq!(fake.sessions_started(), 1);
}

#[ignore]
#[tokio::test(flavor = "multi_thread")]
async fn real_app_instant_keeps_a_private_link_when_sharing_is_refused() {
    let (_fake, sandbox, _project) = instant_on_drive(
        "private",
        vec![Fault::PermissionStatus {
            status: 400,
            reason: "invalidSharingRequest",
        }],
    )
    .await;
    let log = sandbox.log("private");
    assert!(log.contains("Google Drive link is private"), "{log}");
}
