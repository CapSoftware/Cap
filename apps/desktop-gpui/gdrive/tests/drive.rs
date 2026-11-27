use std::{
    collections::BTreeMap,
    fs,
    future::Future,
    net::TcpListener,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use cap_gdrive::{
    CHUNK_ALIGN, DriveError, DriveShare, Endpoints, FOLDER_MIME, LinkVisibility, PrivateReason,
    Progress, SESSION_MAX_AGE, ShareFileRequest, StaticToken, TokenSource, UploadOptions,
    VIDEO_MIME,
    api::{self, DriveHttp},
    fake::{FAKE_EMAIL, FakeFile, FakeGoogle, FakeRequest, Fault, web_view_link},
    file_id_from_sharing, share_file, sharing_id,
    sidecar::{self, Sidecar},
    upload::{self, FileMetadata, UploadFailure, UploadSource},
};
use serde_json::{Value, json};

const CHUNK: usize = 2 * CHUNK_ALIGN;
const TOTAL: usize = 2 * CHUNK + 12_345;
const SOURCE: &str = "output/result.mp4";
const PERMISSION_BODY: &str = r#"{"role":"reader","type":"anyone","allowFileDiscovery":false}"#;

fn options() -> UploadOptions {
    UploadOptions {
        chunk_size: CHUNK,
        max_attempts: 3,
        backoff_base: Duration::ZERO,
        backoff_max: Duration::ZERO,
    }
}

fn pattern(len: usize, seed: usize) -> Vec<u8> {
    (0..len).map(|i| ((i * 31 + seed) % 251) as u8).collect()
}

fn ms_since_epoch(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

fn now_ms() -> i64 {
    ms_since_epoch(SystemTime::now())
}

struct Project {
    _root: tempfile::TempDir,
    dir: PathBuf,
    file: PathBuf,
    bytes: Vec<u8>,
    modified: SystemTime,
}

impl Project {
    fn new(len: usize) -> Self {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("recording.cap");
        fs::create_dir_all(dir.join("output")).unwrap();
        let file = dir.join(SOURCE);
        let bytes = pattern(len, 7);
        fs::write(&file, &bytes).unwrap();
        let modified = fs::metadata(&file).unwrap().modified().unwrap();
        Self {
            _root: root,
            dir,
            file,
            bytes,
            modified,
        }
    }

    fn rewrite(&mut self, len: usize) {
        self.bytes = pattern(len, 99);
        fs::write(&self.file, &self.bytes).unwrap();
        self.modified = fs::metadata(&self.file).unwrap().modified().unwrap();
    }

    fn request(&self) -> ShareFileRequest<'_> {
        ShareFileRequest {
            file: &self.file,
            sidecar_dir: &self.dir,
            name: "My recording",
            description: Some("Recorded with Cap"),
            folder_name: "Cap",
            known_folder_id: None,
            account_email: Some(FAKE_EMAIL),
            options: options(),
        }
    }

    fn sidecar(&self) -> Sidecar {
        sidecar::load(&self.dir).expect("a sidecar")
    }

    fn assert_untouched(&self) {
        let meta = fs::metadata(&self.file).expect("the source file still exists");
        assert_eq!(meta.len(), self.bytes.len() as u64);
        assert_eq!(meta.modified().unwrap(), self.modified);
        assert_eq!(fs::read(&self.file).unwrap(), self.bytes);
    }
}

struct CountingTokens {
    forced: AtomicUsize,
}

impl CountingTokens {
    fn new() -> Self {
        Self {
            forced: AtomicUsize::new(0),
        }
    }
}

impl TokenSource for CountingTokens {
    fn access_token(
        &self,
        force_refresh: bool,
    ) -> impl Future<Output = Result<String, DriveError>> + Send {
        if force_refresh {
            self.forced.fetch_add(1, Ordering::SeqCst);
        }
        std::future::ready(Ok(if force_refresh { "fresh" } else { "stale" }.to_string()))
    }
}

fn token() -> StaticToken {
    StaticToken("token".into())
}

async fn share_with<T: TokenSource>(
    endpoints: &Endpoints,
    tokens: &T,
    request: ShareFileRequest<'_>,
    cancel: &AtomicBool,
    progress: &(dyn Fn(Progress) + Send + Sync),
) -> Result<DriveShare, DriveError> {
    let http = DriveHttp::new().unwrap();
    share_file(&http, endpoints, tokens, request, progress, cancel).await
}

async fn share(fake: &FakeGoogle, project: &Project) -> Result<DriveShare, DriveError> {
    share_with(
        &fake.endpoints(),
        &token(),
        project.request(),
        &AtomicBool::new(false),
        &|_| {},
    )
    .await
}

fn videos(fake: &FakeGoogle) -> Vec<FakeFile> {
    fake.files()
        .into_iter()
        .filter(|f| f.mime_type == VIDEO_MIME)
        .collect()
}

fn folders(fake: &FakeGoogle) -> Vec<FakeFile> {
    fake.files()
        .into_iter()
        .filter(|f| f.mime_type == FOLDER_MIME)
        .collect()
}

fn the_video(fake: &FakeGoogle) -> FakeFile {
    let videos = videos(fake);
    assert_eq!(videos.len(), 1, "exactly one video file");
    videos.into_iter().next().unwrap()
}

fn chunks(fake: &FakeGoogle) -> Vec<FakeRequest> {
    fake.requests()
        .into_iter()
        .filter(FakeRequest::is_chunk)
        .collect()
}

fn status_queries(fake: &FakeGoogle) -> Vec<FakeRequest> {
    fake.requests()
        .into_iter()
        .filter(FakeRequest::is_status_query)
        .collect()
}

fn range_of(request: &FakeRequest) -> (u64, u64, u64) {
    let range = request.header("content-range").unwrap();
    let rest = range.strip_prefix("bytes ").unwrap();
    let (span, total) = rest.split_once('/').unwrap();
    let (a, b) = span.split_once('-').unwrap();
    (
        a.parse().unwrap(),
        b.parse().unwrap(),
        total.parse().unwrap(),
    )
}

fn chunk_starts(fake: &FakeGoogle) -> Vec<u64> {
    chunks(fake).iter().map(|c| range_of(c).0).collect()
}

fn assert_chunks_are_well_formed(fake: &FakeGoogle, total: u64) {
    let chunks = chunks(fake);
    assert!(!chunks.is_empty());
    for chunk in chunks {
        let (a, b, t) = range_of(&chunk);
        assert_eq!(t, total);
        let declared: u64 = chunk.header("content-length").unwrap().parse().unwrap();
        assert_eq!(declared, b - a + 1);
        if b + 1 < total {
            assert_eq!(declared % CHUNK_ALIGN as u64, 0, "non-final chunk {a}-{b}");
        }
        assert_eq!(chunk.header("authorization"), None);
    }
}

fn the_init(fake: &FakeGoogle) -> FakeRequest {
    let inits: Vec<_> = fake
        .requests()
        .into_iter()
        .filter(|r| r.method == "POST" && r.path() == "/upload/drive/v3/files")
        .collect();
    assert_eq!(inits.len(), 1);
    inits.into_iter().next().unwrap()
}

fn closed_port_endpoints() -> Endpoints {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);
    Endpoints::local(&format!("http://{addr}"))
}

fn earlier_sidecar(project: &Project, folder_id: &str, uri: &str, started_at_ms: i64) -> Sidecar {
    Sidecar {
        version: 1,
        source: SOURCE.into(),
        size: project.bytes.len() as u64,
        modified_ms: ms_since_epoch(project.modified),
        account_email: Some(FAKE_EMAIL.into()),
        folder_id: Some(folder_id.into()),
        session_uri: Some(uri.into()),
        session_started_at_ms: Some(started_at_ms),
        offset: CHUNK as u64,
        ..Sidecar::default()
    }
}

async fn start_earlier_session(fake: &FakeGoogle, project: &Project) -> (String, upload::Session) {
    let http = DriveHttp::new().unwrap();
    let endpoints = fake.endpoints();
    let folder = api::ensure_folder(&http, &endpoints, &token(), "Cap", None)
        .await
        .unwrap();
    let meta = FileMetadata {
        name: "My recording".into(),
        mime_type: VIDEO_MIME.into(),
        parents: vec![folder.clone()],
        description: None,
        app_properties: BTreeMap::from([("capRecording".to_string(), "1".to_string())]),
    };
    let total = project.bytes.len() as u64;
    let session = upload::start_session(&http, &endpoints, "token", &meta, total)
        .await
        .unwrap();
    let cancel = AtomicBool::new(false);
    let progress = |p: Progress| {
        if p.sent > 0 {
            cancel.store(true, Ordering::SeqCst);
        }
    };
    let failure = upload::upload_from(
        &http,
        UploadSource {
            session: &session,
            file: &project.file,
            total,
        },
        0,
        &options(),
        &progress,
        &cancel,
        &|_| {},
    )
    .await
    .unwrap_err();
    assert_eq!(failure, UploadFailure::Fatal(DriveError::Cancelled));
    (folder, session)
}

#[tokio::test]
async fn happy_path_uploads_aligned_chunks_and_makes_the_file_public() {
    let fake = FakeGoogle::start();
    let project = Project::new(TOTAL);
    let mut completed = fake.completed();

    let share = share(&fake, &project).await.unwrap();

    completed.wait_for(|n| *n == 1).await.unwrap();
    let folders = folders(&fake);
    assert_eq!(folders.len(), 1);
    let folder = &folders[0];
    assert_eq!(
        folder.app_properties.get("capFolder").map(String::as_str),
        Some("1")
    );
    assert_eq!(folder.name, "Cap");
    assert!(folder.permissions.is_empty(), "the folder is never shared");

    let init = the_init(&fake);
    assert_eq!(init.query("uploadType").as_deref(), Some("resumable"));
    assert_eq!(init.header("x-upload-content-type"), Some(VIDEO_MIME));
    assert_eq!(
        init.header("x-upload-content-length"),
        Some(TOTAL.to_string().as_str())
    );
    assert_eq!(init.header("authorization"), Some("Bearer token"));
    assert!(
        init.header("content-type")
            .unwrap()
            .starts_with("application/json")
    );
    let meta: Value = serde_json::from_slice(&init.body).unwrap();
    assert_eq!(meta["name"], "My recording");
    assert_eq!(meta["mimeType"], VIDEO_MIME);
    assert_eq!(meta["parents"], json!([folder.id]));
    assert_eq!(meta["description"], "Recorded with Cap");
    assert_eq!(meta["appProperties"], json!({"capRecording": "1"}));

    assert_chunks_are_well_formed(&fake, TOTAL as u64);
    assert_eq!(chunk_starts(&fake), vec![0, CHUNK as u64, 2 * CHUNK as u64]);

    let video = the_video(&fake);
    assert_eq!(video.bytes, project.bytes);
    assert_eq!(video.parents, vec![folder.id.clone()]);
    assert_eq!(video.name, "My recording");
    assert_eq!(
        video.app_properties.get("capRecording").map(String::as_str),
        Some("1")
    );
    assert_eq!(
        video.permissions,
        vec![json!({"role": "reader", "type": "anyone", "allowFileDiscovery": false})]
    );
    let permission = fake
        .requests()
        .into_iter()
        .find(|r| r.path().ends_with("/permissions"))
        .unwrap();
    assert_eq!(permission.body, PERMISSION_BODY.as_bytes());

    assert_eq!(share.file_id, video.id);
    assert_eq!(share.web_view_link, web_view_link(&video.id));
    assert!(share.web_view_link.ends_with("&resourcekey=0-fake"));
    assert_eq!(share.folder_id, folder.id);
    assert_eq!(share.visibility, LinkVisibility::Public);
    assert!(!share.reused);
    assert_eq!(fake.sessions_started(), 1);

    let saved = project.sidecar();
    assert_eq!(saved.source, SOURCE);
    assert_eq!(saved.file_id.as_deref(), Some(video.id.as_str()));
    assert_eq!(
        saved.web_view_link.as_deref(),
        Some(share.web_view_link.as_str())
    );
    assert!(saved.public);
    assert_eq!(saved.session_uri, None);
    assert_eq!(saved.last_error, None);
    project.assert_untouched();
}

#[tokio::test]
async fn progress_reports_the_server_offsets_up_to_the_total() {
    let fake = FakeGoogle::start();
    let project = Project::new(TOTAL);
    let seen = std::sync::Mutex::new(Vec::new());
    let progress = |p: Progress| seen.lock().unwrap().push(p.sent);

    share_with(
        &fake.endpoints(),
        &token(),
        project.request(),
        &AtomicBool::new(false),
        &progress,
    )
    .await
    .unwrap();

    let seen = seen.into_inner().unwrap();
    assert_eq!(seen.last().copied(), Some(TOTAL as u64));
    assert!(seen.windows(2).all(|w| w[0] <= w[1]));
    assert!(seen.contains(&(CHUNK as u64)));
    project.assert_untouched();
}

#[tokio::test]
async fn a_second_recording_reuses_the_marked_folder() {
    let fake = FakeGoogle::start();
    let first = Project::new(TOTAL);
    let second = Project::new(CHUNK / 3);

    let a = share(&fake, &first).await.unwrap();
    let b = share(&fake, &second).await.unwrap();

    assert_eq!(folders(&fake).len(), 1);
    assert_eq!(a.folder_id, b.folder_id);
    assert_ne!(a.file_id, b.file_id);
    assert_eq!(videos(&fake).len(), 2);
    let lookups = fake
        .requests()
        .into_iter()
        .filter(|r| r.method == "GET" && r.path() == "/drive/v3/files")
        .count();
    assert_eq!(lookups, 2);
    first.assert_untouched();
    second.assert_untouched();
}

#[tokio::test]
async fn a_trashed_known_folder_is_replaced() {
    let fake = FakeGoogle::start();
    let first = Project::new(CHUNK);
    let a = share(&fake, &first).await.unwrap();
    fake.trash(&a.folder_id);

    let second = Project::new(CHUNK);
    let b = share_with(
        &fake.endpoints(),
        &token(),
        ShareFileRequest {
            known_folder_id: Some(&a.folder_id),
            ..second.request()
        },
        &AtomicBool::new(false),
        &|_| {},
    )
    .await
    .unwrap();

    assert_ne!(b.folder_id, a.folder_id);
    let live: Vec<_> = folders(&fake).into_iter().filter(|f| !f.trashed).collect();
    assert_eq!(live.len(), 1);
    assert_eq!(live[0].id, b.folder_id);
    first.assert_untouched();
    second.assert_untouched();
}

#[tokio::test]
async fn a_known_folder_is_used_without_a_lookup() {
    let fake = FakeGoogle::start();
    let first = Project::new(CHUNK);
    let a = share(&fake, &first).await.unwrap();
    let before = fake.requests().len();

    let second = Project::new(CHUNK);
    let b = share_with(
        &fake.endpoints(),
        &token(),
        ShareFileRequest {
            known_folder_id: Some(&a.folder_id),
            ..second.request()
        },
        &AtomicBool::new(false),
        &|_| {},
    )
    .await
    .unwrap();

    assert_eq!(b.folder_id, a.folder_id);
    let lookups_after = fake.requests()[before..]
        .iter()
        .filter(|r| r.method == "GET" && r.path() == "/drive/v3/files")
        .count();
    assert_eq!(lookups_after, 0);
    second.assert_untouched();
}

#[tokio::test]
async fn a_dropped_connection_resumes_from_the_reported_range() {
    let fake = FakeGoogle::start();
    let project = Project::new(TOTAL);
    let kept = CHUNK_ALIGN as u64 + 1000;
    fake.push_fault(Fault::DropConnectionAfter { bytes: kept });

    let share = share(&fake, &project).await.unwrap();

    let queries = status_queries(&fake);
    assert_eq!(queries.len(), 1);
    assert_eq!(
        queries[0].header("content-range"),
        Some(format!("bytes */{TOTAL}").as_str())
    );
    assert_eq!(queries[0].header("content-length"), Some("0"));
    assert_eq!(queries[0].header("authorization"), None);
    let starts = chunk_starts(&fake);
    assert_eq!(starts[0], 0);
    assert_eq!(starts[1], kept);
    assert_chunks_are_well_formed(&fake, TOTAL as u64);
    assert_eq!(fake.sessions_started(), 1);
    assert_eq!(the_video(&fake).bytes, project.bytes);
    assert_eq!(share.visibility, LinkVisibility::Public);
    assert_eq!(fake.faults_left(), 0);
    project.assert_untouched();
}

#[tokio::test]
async fn a_partially_accepted_chunk_continues_at_the_reported_offset() {
    let fake = FakeGoogle::start();
    let project = Project::new(TOTAL);
    fake.push_fault(Fault::AcceptOnly { bytes: 100_000 });

    share(&fake, &project).await.unwrap();

    let starts = chunk_starts(&fake);
    assert_eq!(starts[0], 0);
    assert_eq!(starts[1], 100_000);
    assert!(status_queries(&fake).is_empty());
    assert_chunks_are_well_formed(&fake, TOTAL as u64);
    assert_eq!(fake.sessions_started(), 1);
    assert_eq!(the_video(&fake).bytes, project.bytes);
    project.assert_untouched();
}

#[tokio::test]
async fn a_gone_session_starts_again_from_zero() {
    let fake = FakeGoogle::start();
    let project = Project::new(TOTAL);
    fake.push_fault(Fault::DropConnectionAfter {
        bytes: CHUNK_ALIGN as u64,
    });
    fake.push_fault(Fault::StatusQueryGone);

    share(&fake, &project).await.unwrap();

    assert_eq!(fake.sessions_started(), 2);
    assert_eq!(the_video(&fake).bytes, project.bytes);
    let starts = chunk_starts(&fake);
    assert_eq!(starts.iter().filter(|s| **s == 0).count(), 2);
    project.assert_untouched();
}

#[tokio::test]
async fn a_session_saved_by_an_earlier_process_is_resumed() {
    let fake = FakeGoogle::start();
    let project = Project::new(TOTAL);
    let (folder, session) = start_earlier_session(&fake, &project).await;
    sidecar::save(
        &project.dir,
        &earlier_sidecar(&project, &folder, &session.uri, session.started_at_ms),
    )
    .unwrap();
    assert_eq!(fake.sessions_started(), 1);

    let share = share(&fake, &project).await.unwrap();

    assert_eq!(fake.sessions_started(), 1);
    assert_eq!(status_queries(&fake).len(), 1);
    assert_eq!(chunk_starts(&fake), vec![0, CHUNK as u64, 2 * CHUNK as u64]);
    assert_eq!(the_video(&fake).bytes, project.bytes);
    assert_eq!(share.folder_id, folder);
    project.assert_untouched();
}

#[tokio::test]
async fn a_session_older_than_the_max_age_is_not_queried() {
    let fake = FakeGoogle::start();
    let project = Project::new(TOTAL);
    let (folder, session) = start_earlier_session(&fake, &project).await;
    let old = now_ms() - i64::try_from(SESSION_MAX_AGE.as_millis()).unwrap() - 60_000;
    sidecar::save(
        &project.dir,
        &earlier_sidecar(&project, &folder, &session.uri, old),
    )
    .unwrap();

    share(&fake, &project).await.unwrap();

    assert_eq!(fake.sessions_started(), 2);
    assert!(status_queries(&fake).is_empty());
    assert_eq!(the_video(&fake).bytes, project.bytes);
    project.assert_untouched();
}

#[tokio::test]
async fn repeated_server_errors_give_up_and_keep_the_session_for_the_next_call() {
    let fake = FakeGoogle::start();
    let project = Project::new(TOTAL);
    for _ in 0..options().max_attempts {
        fake.push_fault(Fault::ChunkStatus {
            status: 503,
            reason: "backendError",
        });
    }

    let error = share(&fake, &project).await.unwrap_err();

    assert_eq!(
        error,
        DriveError::Server {
            status: 503,
            reason: "backendError".into()
        }
    );
    assert_eq!(fake.faults_left(), 0);
    let saved = project.sidecar();
    assert!(saved.session_uri.is_some());
    assert!(saved.last_error.is_some());
    assert!(videos(&fake).is_empty());

    share(&fake, &project).await.unwrap();

    assert_eq!(fake.sessions_started(), 1);
    assert_eq!(the_video(&fake).bytes, project.bytes);
    assert_eq!(project.sidecar().last_error, None);
    project.assert_untouched();
}

#[tokio::test]
async fn separate_interruptions_with_progress_never_use_up_the_attempts() {
    let fake = FakeGoogle::start();
    let project = Project::new(TOTAL);
    let interruptions = options().max_attempts + 2;
    for _ in 0..interruptions {
        fake.push_fault(Fault::DropConnectionAfter {
            bytes: CHUNK_ALIGN as u64,
        });
    }

    share(&fake, &project).await.unwrap();

    assert_eq!(fake.faults_left(), 0);
    assert_eq!(status_queries(&fake).len(), interruptions as usize);
    assert_eq!(fake.sessions_started(), 1);
    assert_eq!(the_video(&fake).bytes, project.bytes);
    project.assert_untouched();
}

#[tokio::test]
async fn a_status_query_refused_with_a_client_error_starts_a_new_session() {
    let fake = FakeGoogle::start();
    let project = Project::new(TOTAL);
    fake.push_fault(Fault::DropConnectionAfter {
        bytes: CHUNK_ALIGN as u64,
    });
    fake.push_fault(Fault::StatusQueryStatus {
        status: 400,
        reason: "badRequest",
    });

    share(&fake, &project).await.unwrap();

    assert_eq!(fake.faults_left(), 0);
    assert_eq!(fake.sessions_started(), 2);
    assert_eq!(the_video(&fake).bytes, project.bytes);
    assert_eq!(project.sidecar().last_error, None);
    project.assert_untouched();
}

#[tokio::test]
async fn a_rate_limited_status_query_backs_off_and_keeps_the_session() {
    let fake = FakeGoogle::start();
    let project = Project::new(TOTAL);
    fake.push_fault(Fault::DropConnectionAfter {
        bytes: CHUNK_ALIGN as u64,
    });
    fake.push_fault(Fault::StatusQueryStatus {
        status: 429,
        reason: "rateLimitExceeded",
    });

    share(&fake, &project).await.unwrap();

    assert_eq!(fake.sessions_started(), 1);
    assert_eq!(status_queries(&fake).len(), 2);
    assert_eq!(the_video(&fake).bytes, project.bytes);
    project.assert_untouched();
}

#[tokio::test]
async fn a_chunk_refused_with_a_client_error_starts_a_new_session() {
    let fake = FakeGoogle::start();
    let project = Project::new(TOTAL);
    fake.push_fault(Fault::ChunkStatus {
        status: 400,
        reason: "badRequest",
    });

    share(&fake, &project).await.unwrap();

    assert_eq!(fake.sessions_started(), 2);
    assert_eq!(the_video(&fake).bytes, project.bytes);
    project.assert_untouched();
}

#[tokio::test]
async fn chunks_refused_every_time_stop_after_the_restart_limit() {
    let fake = FakeGoogle::start();
    let project = Project::new(TOTAL);
    for _ in 0..10 {
        fake.push_fault(Fault::ChunkStatus {
            status: 400,
            reason: "badRequest",
        });
    }

    let error = share(&fake, &project).await.unwrap_err();

    assert_eq!(
        error,
        DriveError::Server {
            status: 400,
            reason: "badRequest".into()
        }
    );
    assert_eq!(fake.sessions_started(), 3);
    assert_eq!(chunks(&fake).len(), 3);
    assert!(videos(&fake).is_empty());
    project.assert_untouched();
}

#[tokio::test]
async fn a_rate_limited_chunk_backs_off_and_resumes_the_same_session() {
    let fake = FakeGoogle::start();
    let project = Project::new(TOTAL);
    fake.push_fault(Fault::ChunkStatus {
        status: 429,
        reason: "rateLimitExceeded",
    });

    share(&fake, &project).await.unwrap();

    assert_eq!(fake.sessions_started(), 1);
    assert_eq!(status_queries(&fake).len(), 1);
    assert_eq!(
        chunk_starts(&fake),
        vec![0, 0, CHUNK as u64, 2 * CHUNK as u64]
    );
    assert_eq!(the_video(&fake).bytes, project.bytes);
    project.assert_untouched();
}

#[tokio::test]
async fn a_full_drive_during_a_chunk_keeps_the_session_for_the_next_call() {
    let fake = FakeGoogle::start();
    let project = Project::new(TOTAL);
    fake.push_fault(Fault::ChunkStatus {
        status: 403,
        reason: "storageQuotaExceeded",
    });

    assert_eq!(share(&fake, &project).await, Err(DriveError::StorageFull));
    assert!(project.sidecar().session_uri.is_some());
    assert!(videos(&fake).is_empty());

    share(&fake, &project).await.unwrap();

    assert_eq!(fake.sessions_started(), 1);
    assert_eq!(status_queries(&fake).len(), 1);
    assert_eq!(the_video(&fake).bytes, project.bytes);
    project.assert_untouched();
}

#[tokio::test]
async fn an_admin_block_during_a_chunk_keeps_the_session() {
    let fake = FakeGoogle::start();
    let project = Project::new(TOTAL);
    fake.push_fault(Fault::ChunkStatus {
        status: 403,
        reason: "domainPolicy",
    });

    assert_eq!(share(&fake, &project).await, Err(DriveError::AdminBlocked));
    assert!(project.sidecar().session_uri.is_some());
    assert_eq!(fake.sessions_started(), 1);
    project.assert_untouched();
}

#[tokio::test]
async fn a_permission_call_that_fails_briefly_is_retried() {
    let fake = FakeGoogle::start();
    let project = Project::new(CHUNK);
    for _ in 0..options().max_attempts - 1 {
        fake.push_fault(Fault::PermissionStatus {
            status: 503,
            reason: "backendError",
        });
    }

    let share = share(&fake, &project).await.unwrap();

    assert_eq!(share.visibility, LinkVisibility::Public);
    assert_eq!(fake.faults_left(), 0);
    assert_eq!(the_video(&fake).permissions.len(), 1);
    assert!(folders(&fake)[0].permissions.is_empty());
    assert!(project.sidecar().public);
    project.assert_untouched();
}

#[tokio::test]
async fn a_permission_call_that_keeps_failing_still_hands_out_the_private_link() {
    let fake = FakeGoogle::start();
    let project = Project::new(CHUNK);
    for _ in 0..options().max_attempts {
        fake.push_fault(Fault::PermissionStatus {
            status: 503,
            reason: "backendError",
        });
    }

    let first = share(&fake, &project).await.unwrap();

    assert_eq!(fake.faults_left(), 0);
    let video = the_video(&fake);
    assert_eq!(first.file_id, video.id);
    assert_eq!(first.web_view_link, web_view_link(&video.id));
    let reason = DriveError::Server {
        status: 503,
        reason: "backendError".into(),
    }
    .to_string();
    assert_eq!(
        first.visibility,
        LinkVisibility::Private(PrivateReason::Other(reason))
    );
    assert!(video.permissions.is_empty());
    assert!(folders(&fake)[0].permissions.is_empty());
    let saved = project.sidecar();
    assert!(!saved.public);
    assert_eq!(saved.file_id.as_deref(), Some(video.id.as_str()));
    assert_eq!(saved.last_error, None);

    let second = share(&fake, &project).await.unwrap();

    assert!(second.reused);
    assert_eq!(second.visibility, LinkVisibility::Public);
    assert_eq!(fake.sessions_started(), 1);
    assert_eq!(the_video(&fake).permissions.len(), 1);
    project.assert_untouched();
}

#[tokio::test]
async fn a_permission_call_refused_after_the_upload_still_hands_out_the_link() {
    let fake = FakeGoogle::start();
    let project = Project::new(CHUNK);
    fake.push_fault(Fault::PermissionStatus {
        status: 401,
        reason: "authError",
    });

    let share = share(&fake, &project).await.unwrap();

    assert_eq!(share.web_view_link, web_view_link(&share.file_id));
    assert_eq!(
        share.visibility,
        LinkVisibility::Private(PrivateReason::Other(DriveError::SignInAgain.to_string()))
    );
    assert_eq!(videos(&fake).len(), 1);
    project.assert_untouched();
}

#[tokio::test]
async fn a_refused_public_link_stays_private_and_a_later_share_retries() {
    let fake = FakeGoogle::start();
    let project = Project::new(CHUNK);
    fake.push_fault(Fault::PermissionStatus {
        status: 400,
        reason: "invalidSharingRequest",
    });

    let first = share(&fake, &project).await.unwrap();

    assert_eq!(
        first.visibility,
        LinkVisibility::Private(PrivateReason::SharingRestricted)
    );
    assert!(the_video(&fake).permissions.is_empty());
    assert_eq!(first.web_view_link, web_view_link(&first.file_id));
    let saved = project.sidecar();
    assert!(!saved.public);
    assert_eq!(saved.file_id.as_deref(), Some(first.file_id.as_str()));

    let second = share(&fake, &project).await.unwrap();

    assert!(second.reused);
    assert_eq!(second.file_id, first.file_id);
    assert_eq!(second.web_view_link, first.web_view_link);
    assert_eq!(second.visibility, LinkVisibility::Public);
    assert_eq!(the_video(&fake).permissions.len(), 1);
    assert_eq!(fake.sessions_started(), 1);
    assert!(project.sidecar().public);
    project.assert_untouched();
}

#[tokio::test]
async fn a_rate_limited_permission_gives_a_private_link() {
    let fake = FakeGoogle::start();
    let project = Project::new(CHUNK);
    fake.push_fault(Fault::PermissionStatus {
        status: 403,
        reason: "sharingRateLimitExceeded",
    });

    let share = share(&fake, &project).await.unwrap();

    assert_eq!(
        share.visibility,
        LinkVisibility::Private(PrivateReason::RateLimited)
    );
    assert_eq!(videos(&fake).len(), 1);
    assert!(!project.sidecar().public);
    project.assert_untouched();
}

#[tokio::test]
async fn a_full_drive_is_storage_full_and_starts_nothing() {
    let fake = FakeGoogle::start();
    let project = Project::new(CHUNK);
    fake.push_fault(Fault::InitStatus {
        status: 403,
        reason: "storageQuotaExceeded",
    });

    assert_eq!(share(&fake, &project).await, Err(DriveError::StorageFull));
    assert_eq!(fake.sessions_started(), 0);
    assert!(videos(&fake).is_empty());
    project.assert_untouched();
}

#[tokio::test]
async fn an_admin_policy_is_admin_blocked() {
    let fake = FakeGoogle::start();
    let project = Project::new(CHUNK);
    fake.push_fault(Fault::InitStatus {
        status: 403,
        reason: "domainPolicy",
    });

    assert_eq!(share(&fake, &project).await, Err(DriveError::AdminBlocked));
    assert_eq!(fake.sessions_started(), 0);
    project.assert_untouched();
}

#[tokio::test]
async fn too_many_requests_is_rate_limited_after_the_attempts_run_out() {
    let fake = FakeGoogle::start();
    let project = Project::new(CHUNK);
    for _ in 0..options().max_attempts {
        fake.push_fault(Fault::InitStatus {
            status: 429,
            reason: "rateLimitExceeded",
        });
    }

    assert_eq!(share(&fake, &project).await, Err(DriveError::RateLimited));
    assert_eq!(fake.faults_left(), 0);
    assert_eq!(fake.sessions_started(), 0);
    project.assert_untouched();
}

#[tokio::test]
async fn a_rate_limit_that_clears_before_the_attempts_run_out_succeeds() {
    let fake = FakeGoogle::start();
    let project = Project::new(CHUNK);
    fake.push_fault(Fault::InitStatus {
        status: 403,
        reason: "userRateLimitExceeded",
    });

    share(&fake, &project).await.unwrap();

    assert_eq!(fake.sessions_started(), 1);
    assert_eq!(the_video(&fake).bytes, project.bytes);
    project.assert_untouched();
}

#[tokio::test]
async fn a_disabled_drive_api_is_api_disabled_and_starts_no_session() {
    let fake = FakeGoogle::start();
    let project = Project::new(CHUNK);
    fake.push_fault(Fault::ApiStatus {
        status: 403,
        reason: "accessNotConfigured",
    });

    assert_eq!(share(&fake, &project).await, Err(DriveError::ApiDisabled));
    assert_eq!(fake.sessions_started(), 0);
    assert!(fake.files().is_empty());
    project.assert_untouched();
}

#[tokio::test]
async fn an_unauthorized_init_refreshes_the_token_once() {
    let fake = FakeGoogle::start();
    let project = Project::new(CHUNK);
    let tokens = CountingTokens::new();
    fake.push_fault(Fault::Unauthorized);

    share_with(
        &fake.endpoints(),
        &tokens,
        project.request(),
        &AtomicBool::new(false),
        &|_| {},
    )
    .await
    .unwrap();

    assert_eq!(tokens.forced.load(Ordering::SeqCst), 1);
    let inits: Vec<_> = fake
        .requests()
        .into_iter()
        .filter(|r| r.method == "POST" && r.path() == "/upload/drive/v3/files")
        .map(|r| r.header("authorization").unwrap().to_string())
        .collect();
    assert_eq!(inits, vec!["Bearer stale", "Bearer fresh"]);
    assert_eq!(fake.sessions_started(), 1);
    project.assert_untouched();
}

#[tokio::test]
async fn two_unauthorized_inits_ask_to_sign_in_again() {
    let fake = FakeGoogle::start();
    let project = Project::new(CHUNK);
    let tokens = CountingTokens::new();
    fake.push_fault(Fault::Unauthorized);
    fake.push_fault(Fault::Unauthorized);

    let result = share_with(
        &fake.endpoints(),
        &tokens,
        project.request(),
        &AtomicBool::new(false),
        &|_| {},
    )
    .await;

    assert_eq!(result, Err(DriveError::SignInAgain));
    assert_eq!(tokens.forced.load(Ordering::SeqCst), 1);
    assert_eq!(fake.sessions_started(), 0);
    project.assert_untouched();
}

#[tokio::test]
async fn ensure_folder_refreshes_once_on_a_401() {
    let fake = FakeGoogle::start();
    let tokens = CountingTokens::new();
    fake.push_fault(Fault::ApiStatus {
        status: 401,
        reason: "authError",
    });

    let http = DriveHttp::new().unwrap();
    let folder = api::ensure_folder(&http, &fake.endpoints(), &tokens, "Cap", None)
        .await
        .unwrap();

    assert_eq!(tokens.forced.load(Ordering::SeqCst), 1);
    assert_eq!(folders(&fake).len(), 1);
    assert_eq!(folders(&fake)[0].id, folder);
}

#[tokio::test]
async fn a_closed_port_is_offline() {
    let project = Project::new(CHUNK);

    let result = share_with(
        &closed_port_endpoints(),
        &token(),
        project.request(),
        &AtomicBool::new(false),
        &|_| {},
    )
    .await;

    assert_eq!(result, Err(DriveError::Offline));
    project.assert_untouched();
}

#[tokio::test]
async fn cancel_after_the_first_chunk_keeps_the_session_for_the_next_call() {
    let fake = FakeGoogle::start();
    let project = Project::new(TOTAL);
    let cancel = AtomicBool::new(false);
    let progress = |p: Progress| {
        if p.sent > 0 {
            cancel.store(true, Ordering::SeqCst);
        }
    };

    let result = share_with(
        &fake.endpoints(),
        &token(),
        project.request(),
        &cancel,
        &progress,
    )
    .await;

    assert_eq!(result, Err(DriveError::Cancelled));
    assert_eq!(chunks(&fake).len(), 1);
    let saved = project.sidecar();
    assert!(saved.session_uri.is_some());
    assert_eq!(saved.offset, CHUNK as u64);
    assert!(videos(&fake).is_empty());

    share(&fake, &project).await.unwrap();

    assert_eq!(fake.sessions_started(), 1);
    assert_eq!(status_queries(&fake).len(), 1);
    assert_eq!(chunk_starts(&fake), vec![0, CHUNK as u64, 2 * CHUNK as u64]);
    assert_eq!(the_video(&fake).bytes, project.bytes);
    project.assert_untouched();
}

#[tokio::test]
async fn an_unchanged_source_reuses_the_uploaded_file() {
    let fake = FakeGoogle::start();
    let project = Project::new(CHUNK);
    let first = share(&fake, &project).await.unwrap();

    let second = share(&fake, &project).await.unwrap();

    assert!(second.reused);
    assert_eq!(second.file_id, first.file_id);
    assert_eq!(second.web_view_link, first.web_view_link);
    assert_eq!(second.visibility, LinkVisibility::Public);
    assert_eq!(fake.sessions_started(), 1);
    assert_eq!(the_video(&fake).permissions.len(), 1);
    project.assert_untouched();
}

#[tokio::test]
async fn a_trashed_upload_is_uploaded_again() {
    let fake = FakeGoogle::start();
    let project = Project::new(CHUNK);
    let first = share(&fake, &project).await.unwrap();
    fake.trash(&first.file_id);

    let second = share(&fake, &project).await.unwrap();

    assert!(!second.reused);
    assert_ne!(second.file_id, first.file_id);
    assert_eq!(fake.sessions_started(), 2);
    assert_eq!(second.web_view_link, web_view_link(&second.file_id));
    project.assert_untouched();
}

#[tokio::test]
async fn a_changed_source_uploads_a_new_file_and_leaves_the_old_one() {
    let fake = FakeGoogle::start();
    let mut project = Project::new(CHUNK);
    let first = share(&fake, &project).await.unwrap();
    project.rewrite(CHUNK + 17);

    let second = share(&fake, &project).await.unwrap();

    assert!(!second.reused);
    assert_ne!(second.file_id, first.file_id);
    assert_eq!(second.folder_id, first.folder_id);
    assert_eq!(fake.sessions_started(), 2);
    let videos = videos(&fake);
    assert_eq!(videos.len(), 2);
    assert!(videos.iter().all(|v| !v.trashed));
    let newest = videos.iter().find(|v| v.id == second.file_id).unwrap();
    assert_eq!(newest.bytes, project.bytes);
    project.assert_untouched();
}

#[tokio::test]
async fn a_missing_source_is_a_local_file_error_and_calls_nothing() {
    let fake = FakeGoogle::start();
    let project = Project::new(CHUNK);
    let missing = project.dir.join("output/missing.mp4");

    let result = share_with(
        &fake.endpoints(),
        &token(),
        ShareFileRequest {
            file: &missing,
            ..project.request()
        },
        &AtomicBool::new(false),
        &|_| {},
    )
    .await;

    assert!(matches!(result, Err(DriveError::LocalFile(_))));
    assert!(fake.requests().is_empty());
    project.assert_untouched();
}

#[tokio::test]
async fn an_empty_source_completes_with_one_empty_file() {
    let fake = FakeGoogle::start();
    let project = Project::new(0);

    let share = share(&fake, &project).await.unwrap();

    let video = the_video(&fake);
    assert!(video.bytes.is_empty());
    assert_eq!(share.file_id, video.id);
    project.assert_untouched();
}

#[tokio::test]
async fn about_reads_the_account_email() {
    let fake = FakeGoogle::start();
    let http = DriveHttp::new().unwrap();

    let user = api::about(&http, &fake.endpoints(), "token").await.unwrap();

    assert_eq!(user.email.as_deref(), Some(FAKE_EMAIL));
    let request = &fake.requests()[0];
    assert_eq!(
        request.query("fields").as_deref(),
        Some("user(emailAddress,displayName)")
    );
}

#[tokio::test]
async fn get_file_is_none_for_an_unknown_id() {
    let fake = FakeGoogle::start();
    let http = DriveHttp::new().unwrap();

    let found = api::get_file(&http, &fake.endpoints(), "token", "nope")
        .await
        .unwrap();

    assert_eq!(found, None);
}

#[tokio::test]
async fn the_fake_token_endpoint_exchanges_rotates_and_revokes() {
    let fake = FakeGoogle::start();
    fake.issue_code(
        "code-1",
        "refresh-1",
        "https://www.googleapis.com/auth/drive.file",
    );
    let client = reqwest::Client::new();
    let endpoints = fake.endpoints();
    let post = |form: Vec<(&'static str, String)>| {
        let client = client.clone();
        let url = endpoints.token.clone();
        async move {
            let response = client.post(url).form(&form).send().await.unwrap();
            let status = response.status().as_u16();
            let body: Value = response.json().await.unwrap();
            (status, body)
        }
    };
    let exchange = |code: &str| {
        vec![
            ("grant_type", "authorization_code".to_string()),
            ("client_id", "client".to_string()),
            ("code", code.to_string()),
            ("code_verifier", "verifier".to_string()),
            ("redirect_uri", "http://127.0.0.1:1".to_string()),
        ]
    };
    let refresh = |token: &str| {
        vec![
            ("grant_type", "refresh_token".to_string()),
            ("client_id", "client".to_string()),
            ("refresh_token", token.to_string()),
        ]
    };

    let (status, body) = post(exchange("code-1")).await;
    assert_eq!(status, 200);
    assert_eq!(body["refresh_token"], "refresh-1");
    assert_eq!(body["scope"], "https://www.googleapis.com/auth/drive.file");
    assert!(body["access_token"].as_str().is_some_and(|t| !t.is_empty()));
    assert!(body["expires_in"].as_u64().is_some());
    let (status, body) = post(exchange("code-1")).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (400, Some("invalid_grant"))
    );

    let (status, body) = post(refresh("refresh-1")).await;
    assert_eq!(status, 200);
    assert!(body.get("refresh_token").is_none());
    let (status, body) = post(refresh("refresh-1")).await;
    assert_eq!(status, 200);
    let rotated = body["refresh_token"].as_str().unwrap().to_string();
    assert_ne!(rotated, "refresh-1");
    let (status, body) = post(refresh("refresh-1")).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (400, Some("invalid_grant"))
    );

    fake.push_fault(Fault::TokenError {
        error: "admin_policy_enforced",
    });
    let (status, body) = post(refresh(&rotated)).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (400, Some("admin_policy_enforced"))
    );

    let http = DriveHttp::new().unwrap();
    api::revoke(&http, &endpoints, &rotated).await.unwrap();
    assert_eq!(fake.revoked(), vec![rotated.clone()]);
    let (status, body) = post(refresh(&rotated)).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (400, Some("invalid_grant"))
    );
}

#[tokio::test]
async fn the_fake_revoke_accepts_a_form_body() {
    let fake = FakeGoogle::start();
    let response = reqwest::Client::new()
        .post(fake.endpoints().revoke)
        .form(&[("token", "refresh-x")])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(fake.revoked(), vec!["refresh-x".to_string()]);
}

#[test]
fn share_file_future_is_send() {
    fn assert_send<F: Future + Send>(_: F) {}
    let http = DriveHttp::new().unwrap();
    let endpoints = closed_port_endpoints();
    let tokens = token();
    let cancel = AtomicBool::new(false);
    let project = Project::new(1);
    assert_send(share_file(
        &http,
        &endpoints,
        &tokens,
        project.request(),
        &|_| {},
        &cancel,
    ));
}

#[test]
fn the_chunk_time_limit_has_a_floor_and_grows_with_the_chunk() {
    let floor = upload::chunk_timeout(0);
    assert_eq!(floor, Duration::from_secs(120));
    assert_eq!(upload::chunk_timeout(CHUNK_ALIGN), floor);
    let default = upload::chunk_timeout(cap_gdrive::DEFAULT_CHUNK_SIZE);
    assert_eq!(default, Duration::from_secs(1024));
    assert_eq!(
        upload::chunk_timeout(2 * cap_gdrive::DEFAULT_CHUNK_SIZE),
        2 * default
    );
    let mut last = Duration::ZERO;
    for chunks in [1, 8, 64, 128, 256] {
        let limit = upload::chunk_timeout(chunks * CHUNK_ALIGN);
        assert!(limit >= last && limit >= floor);
        last = limit;
    }
}

#[test]
fn debug_output_never_shows_the_upload_session_address() {
    let uri = "https://www.googleapis.com/upload/drive/v3/files?upload_id=SECRET-UPLOAD-ID";
    let saved = Sidecar {
        session_uri: Some(uri.into()),
        ..Sidecar::default()
    };
    let session = upload::Session {
        uri: uri.into(),
        started_at_ms: 1,
    };
    for text in [
        format!("{saved:?}"),
        format!("{saved:#?}"),
        format!("{session:?}"),
    ] {
        assert!(!text.contains("SECRET-UPLOAD-ID"), "{text}");
        assert!(!text.contains("upload_id"), "{text}");
    }
    assert!(format!("{:?}", Sidecar::default()).contains("session_uri: None"));
}

#[cfg(unix)]
#[test]
fn the_sidecar_is_readable_by_its_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = sidecar::path_in(dir.path());
    fs::write(&path, "{}").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

    sidecar::save(dir.path(), &Sidecar::default()).unwrap();

    let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    assert_eq!(sidecar::load(dir.path()), Some(Sidecar::default()));
}

#[test]
fn parse_range_reads_the_last_received_byte() {
    assert_eq!(upload::parse_range(Some("bytes=0-0")), Some(1));
    assert_eq!(upload::parse_range(Some("bytes=0-262143")), Some(262_144));
    assert_eq!(upload::parse_range(Some(" bytes=0-99 ")), Some(100));
    assert_eq!(upload::parse_range(None), None);
    assert_eq!(upload::parse_range(Some("")), None);
    assert_eq!(upload::parse_range(Some("bytes=5-10")), None);
    assert_eq!(upload::parse_range(Some("bytes=0-")), None);
    assert_eq!(upload::parse_range(Some("bytes=0-x")), None);
    assert_eq!(upload::parse_range(Some("items=0-9")), None);
}

#[test]
fn chunk_len_is_aligned_except_for_the_last_chunk() {
    let align = CHUNK_ALIGN as u64;
    assert_eq!(upload::chunk_len(0, 10, CHUNK), 10);
    assert_eq!(upload::chunk_len(0, 3 * align, CHUNK), CHUNK);
    assert_eq!(upload::chunk_len(2 * align, 3 * align, CHUNK), CHUNK_ALIGN);
    assert_eq!(
        upload::chunk_len(0, 10 * align, CHUNK_ALIGN + 1000),
        CHUNK_ALIGN
    );
    assert_eq!(upload::chunk_len(0, 10 * align, 0), CHUNK_ALIGN);
    assert_eq!(upload::chunk_len(5, 10 * align, CHUNK), CHUNK);
    assert_eq!(upload::chunk_len(10, 10, CHUNK), 0);
    assert_eq!(upload::chunk_len(11, 10, CHUNK), 0);
}

fn google_error(status: u16, reason: &str) -> String {
    json!({"error": {"code": status, "message": "m", "errors": [{"domain": "global", "reason": reason}]}})
        .to_string()
}

fn google_detail(status: u16, reason: &str) -> String {
    json!({"error": {"code": status, "status": "PERMISSION_DENIED", "details": [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": reason}]}})
        .to_string()
}

#[test]
fn classify_follows_the_plan_table() {
    use api::classify;
    assert_eq!(
        classify(403, &google_error(403, "accessNotConfigured")),
        DriveError::ApiDisabled
    );
    assert_eq!(
        classify(403, &google_detail(403, "SERVICE_DISABLED")),
        DriveError::ApiDisabled
    );
    assert_eq!(classify(401, ""), DriveError::SignInAgain);
    assert_eq!(
        classify(401, &google_error(401, "authError")),
        DriveError::SignInAgain
    );
    assert_eq!(
        classify(403, &google_error(403, "storageQuotaExceeded")),
        DriveError::StorageFull
    );
    assert_eq!(
        classify(403, &google_error(403, "domainPolicy")),
        DriveError::AdminBlocked
    );
    assert_eq!(
        classify(403, &google_error(403, "appNotAuthorizedToFile")),
        DriveError::AdminBlocked
    );
    assert_eq!(
        classify(403, &google_error(403, "rateLimitExceeded")),
        DriveError::RateLimited
    );
    assert_eq!(
        classify(403, &google_error(403, "userRateLimitExceeded")),
        DriveError::RateLimited
    );
    assert_eq!(
        classify(403, &google_error(403, "sharingRateLimitExceeded")),
        DriveError::RateLimited
    );
    assert_eq!(classify(429, ""), DriveError::RateLimited);
    assert_eq!(
        classify(403, &google_error(403, "insufficientPermissions")),
        DriveError::SignInAgain
    );
    assert_eq!(
        classify(403, &google_detail(403, "ACCESS_TOKEN_SCOPE_INSUFFICIENT")),
        DriveError::SignInAgain
    );
    assert_eq!(
        classify(503, &google_error(503, "backendError")),
        DriveError::Server {
            status: 503,
            reason: "backendError".into()
        }
    );
    assert_eq!(
        classify(502, "<html>bad gateway</html>"),
        DriveError::Server {
            status: 502,
            reason: String::new()
        }
    );
    assert_eq!(
        classify(400, &google_error(400, "badRequest")),
        DriveError::Server {
            status: 400,
            reason: "badRequest".into()
        }
    );
    let both = json!({"error": {"errors": [{"reason": "rateLimitExceeded"}, {"reason": "accessNotConfigured"}]}}).to_string();
    assert_eq!(classify(403, &both), DriveError::ApiDisabled);
}

#[test]
fn sharing_ids_round_trip() {
    assert_eq!(sharing_id("abc"), "gdrive:abc");
    assert_eq!(file_id_from_sharing(&sharing_id("abc")), Some("abc"));
    assert_eq!(file_id_from_sharing("abc"), None);
}

#[test]
fn sidecar_round_trips_and_matches_only_the_same_source() {
    let root = tempfile::tempdir().unwrap();
    assert_eq!(
        sidecar::path_in(root.path()),
        root.path().join("drive-upload.json")
    );
    assert_eq!(sidecar::load(root.path()), None);

    let saved = Sidecar {
        version: 1,
        source: SOURCE.into(),
        size: 42,
        modified_ms: 1_700_000_000_000,
        account_email: Some(FAKE_EMAIL.into()),
        folder_id: Some("folder".into()),
        session_uri: Some("http://127.0.0.1/upload/session/1".into()),
        session_started_at_ms: Some(5),
        offset: 7,
        file_id: Some("file".into()),
        web_view_link: Some(web_view_link("file")),
        public: true,
        last_error: Some("e".into()),
    };
    sidecar::save(root.path(), &saved).unwrap();
    assert_eq!(sidecar::load(root.path()), Some(saved.clone()));
    let names: Vec<_> = fs::read_dir(root.path())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names, vec![std::ffi::OsString::from("drive-upload.json")]);
    let raw: Value =
        serde_json::from_slice(&fs::read(sidecar::path_in(root.path())).unwrap()).unwrap();
    assert_eq!(raw["sessionUri"], "http://127.0.0.1/upload/session/1");
    assert_eq!(raw["webViewLink"], web_view_link("file"));

    assert!(sidecar::matches_source(
        &saved,
        SOURCE,
        42,
        1_700_000_000_000
    ));
    assert!(!sidecar::matches_source(
        &saved,
        "content/output.mp4",
        42,
        1_700_000_000_000
    ));
    assert!(!sidecar::matches_source(
        &saved,
        SOURCE,
        43,
        1_700_000_000_000
    ));
    assert!(!sidecar::matches_source(
        &saved,
        SOURCE,
        42,
        1_700_000_000_001
    ));

    fs::write(sidecar::path_in(root.path()), b"{not json").unwrap();
    assert_eq!(sidecar::load(root.path()), None);
    fs::write(
        sidecar::path_in(root.path()),
        br#"{"source":"output/result.mp4"}"#,
    )
    .unwrap();
    assert_eq!(
        sidecar::load(root.path()).map(|s| s.source),
        Some(SOURCE.to_string())
    );
}

#[test]
fn a_saved_sidecar_does_not_need_the_project_folder_changed() {
    let root = tempfile::tempdir().unwrap();
    let missing = root.path().join("gone");
    assert!(sidecar::save(&missing, &Sidecar::default()).is_err());
    assert!(!Path::new(&missing).exists());
}
