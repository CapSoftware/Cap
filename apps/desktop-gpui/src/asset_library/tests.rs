//! Real downloads against a local HTTP server: every way a transfer can go
//! wrong must leave the destination untouched and the state honest.

use std::collections::HashMap;
use std::io::{BufRead as _, BufReader, Write as _};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sha2::Digest as _;

use super::catalog::{Catalog, FileRef, Item};
use super::{Begin, FetchError, ItemStatus, Kind, Library, Restore};

#[derive(Clone)]
struct Response {
    status: u16,
    body: Vec<u8>,
    /// Sent as Content-Length instead of the body's real length.
    declared: Option<usize>,
    /// Close the connection after this many body bytes.
    cut_after: Option<usize>,
    delay: Duration,
}

impl Response {
    fn ok(body: &[u8]) -> Self {
        Self {
            status: 200,
            body: body.to_vec(),
            declared: None,
            cut_after: None,
            delay: Duration::ZERO,
        }
    }

    fn status(status: u16) -> Self {
        Self {
            status,
            ..Self::ok(b"")
        }
    }
}

/// Serves each path's responses in order, repeating the last.
struct Server {
    port: u16,
    routes: Arc<Mutex<HashMap<String, Vec<Response>>>>,
    hits: Arc<Mutex<HashMap<String, usize>>>,
    stop: Arc<AtomicBool>,
}

impl Server {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let routes: Arc<Mutex<HashMap<String, Vec<Response>>>> = Arc::default();
        let hits: Arc<Mutex<HashMap<String, usize>>> = Arc::default();
        let stop = Arc::new(AtomicBool::new(false));
        let (thread_routes, thread_hits, thread_stop) =
            (routes.clone(), hits.clone(), stop.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if thread_stop.load(Ordering::Acquire) {
                    break;
                }
                let Ok(stream) = stream else { continue };
                let (routes, hits) = (thread_routes.clone(), thread_hits.clone());
                std::thread::spawn(move || serve(stream, &routes, &hits));
            }
        });
        Self {
            port,
            routes,
            hits,
            stop,
        }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}/{path}", self.port)
    }

    fn route(&self, path: &str, responses: Vec<Response>) {
        self.routes
            .lock()
            .unwrap()
            .insert(format!("/{path}"), responses);
    }

    fn hits(&self, path: &str) -> usize {
        self.hits
            .lock()
            .unwrap()
            .get(&format!("/{path}"))
            .copied()
            .unwrap_or(0)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
    }
}

fn serve(
    mut stream: TcpStream,
    routes: &Mutex<HashMap<String, Vec<Response>>>,
    hits: &Mutex<HashMap<String, usize>>,
) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
            break;
        }
    }
    let path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("/")
        .to_string();
    let hit = {
        let mut hits = hits.lock().unwrap();
        let count = hits.entry(path.clone()).or_default();
        *count += 1;
        *count
    };
    let response = routes
        .lock()
        .unwrap()
        .get(&path)
        .map(|responses| responses[(hit - 1).min(responses.len() - 1)].clone())
        .unwrap_or_else(|| Response::status(404));
    std::thread::sleep(response.delay);
    let length = response.declared.unwrap_or(response.body.len());
    let head = format!(
        "HTTP/1.1 {} X\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n",
        response.status
    );
    if stream.write_all(head.as_bytes()).is_err() {
        return;
    }
    let body = match response.cut_after {
        Some(cut) => &response.body[..cut.min(response.body.len())],
        None => &response.body[..],
    };
    for chunk in body.chunks(4096) {
        if stream.write_all(chunk).is_err() {
            return;
        }
        if !response.delay.is_zero() {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    let _ = stream.flush();
}

fn leak(value: &str) -> &'static str {
    Box::leak(value.to_owned().into_boxed_str())
}

fn file_ref(url: String, body: &[u8]) -> FileRef {
    FileRef {
        url,
        size: body.len() as u64,
        sha256: sha2::Sha256::digest(body).into(),
    }
}

fn track(server: &Server, id: &str, body: &[u8]) -> Item {
    Item {
        kind: Kind::Music,
        id: leak(id),
        file: file_ref(server.url(id), body),
        thumbnail: None,
        theme: "",
        name: leak(id),
        builtin: true,
    }
}

fn wallpaper(server: &Server, id: &str, body: &[u8]) -> Item {
    Item {
        kind: Kind::Wallpaper,
        id: leak(id),
        file: file_ref(server.url(id), body),
        thumbnail: None,
        theme: leak(id.split('/').next().unwrap()),
        name: "",
        builtin: true,
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    library: Arc<Library>,
    runtime: tokio::runtime::Runtime,
}

impl Fixture {
    fn new(server: &Server, items: Vec<Item>) -> Self {
        Self::with_local(server, items, HashMap::new(), false)
    }

    fn with_local(
        server: &Server,
        items: Vec<Item>,
        local_dirs: HashMap<Kind, Vec<PathBuf>>,
        local_files: bool,
    ) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("assets");
        let mut catalog = Catalog::default();
        for item in items {
            catalog.insert(item);
        }
        let library = Arc::new(Library::new(
            root.clone(),
            local_dirs,
            local_files,
            server.url("manifest.json"),
            Some(format!("http://127.0.0.1:{}", server.port)),
            catalog,
        ));
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let _ = library.runtime.set(runtime.handle().clone());
        Self {
            _dir: dir,
            root,
            library,
            runtime,
        }
    }

    fn ensure(&self, kind: Kind, id: &str) -> Result<PathBuf, FetchError> {
        let library = self.library.clone();
        let id = id.to_string();
        self.runtime
            .block_on(async move { library.ensure(kind, &id).await })
    }

    /// Returns once `condition` holds, checking it after each change the
    /// library signals.
    fn wait_until(&self, condition: impl Fn(&Library) -> bool) {
        let mut changes = self.library.subscribe();
        let library = self.library.clone();
        let met = self.runtime.block_on(async move {
            tokio::time::timeout(Duration::from_secs(4), async {
                loop {
                    if condition(&library) {
                        return;
                    }
                    if changes.changed().await.is_err() {
                        return;
                    }
                }
            })
            .await
        });
        assert!(met.is_ok(), "condition not met in time");
    }
}

/// Every file under `dir`, recursively.
fn files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                out.extend(files(&path));
            } else {
                out.push(path);
            }
        }
    }
    out
}

fn staging_files(dir: &Path) -> Vec<PathBuf> {
    files(dir)
        .into_iter()
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(super::fetch::is_staging_name)
        })
        .collect()
}

fn body(len: usize, seed: u8) -> Vec<u8> {
    (0..len)
        .map(|index| (index as u8).wrapping_mul(31) ^ seed)
        .collect()
}

#[test]
fn a_download_lands_verified_and_in_place() {
    let server = Server::start();
    let data = body(200_000, 1);
    server.route("song", vec![Response::ok(&data)]);
    let fixture = Fixture::new(&server, vec![track(&server, "song", &data)]);

    assert_eq!(
        fixture.library.status(Kind::Music, "song"),
        ItemStatus::Missing
    );
    let path = fixture.ensure(Kind::Music, "song").unwrap();

    assert_eq!(path, fixture.root.join("music/song.mp3"));
    assert_eq!(std::fs::read(&path).unwrap(), data);
    assert_eq!(
        fixture.library.status(Kind::Music, "song"),
        ItemStatus::Ready
    );
    assert!(staging_files(&fixture.root).is_empty());
    // Already here: no second request.
    assert_eq!(fixture.ensure(Kind::Music, "song").unwrap(), path);
    assert_eq!(server.hits("song"), 1);
}

#[test]
fn concurrent_requests_share_one_download() {
    let server = Server::start();
    let data = body(300_000, 2);
    server.route(
        "song",
        vec![Response {
            delay: Duration::from_millis(100),
            ..Response::ok(&data)
        }],
    );
    let fixture = Fixture::new(&server, vec![track(&server, "song", &data)]);

    let receivers: Vec<_> = (0..5)
        .map(|_| match fixture.library.begin(Kind::Music, "song") {
            Begin::Waiting(rx) => rx,
            _ => panic!("expected a download"),
        })
        .collect();
    assert!(matches!(
        fixture.library.status(Kind::Music, "song"),
        ItemStatus::Downloading(_)
    ));
    for rx in receivers {
        let result = fixture.runtime.block_on(rx).unwrap();
        assert_eq!(std::fs::read(result.unwrap()).unwrap(), data);
    }
    assert_eq!(server.hits("song"), 1);
}

#[test]
fn a_corrupt_file_never_lands_and_a_later_try_starts_fresh() {
    let server = Server::start();
    let data = body(50_000, 3);
    let mut wrong = data.clone();
    wrong[123] ^= 0xff;
    server.route(
        "song",
        vec![
            Response::ok(&wrong),
            Response::ok(&wrong),
            Response::ok(&wrong),
            Response::ok(&data),
        ],
    );
    let fixture = Fixture::new(&server, vec![track(&server, "song", &data)]);

    assert_eq!(
        fixture.ensure(Kind::Music, "song"),
        Err(FetchError::Corrupt)
    );
    assert_eq!(
        server.hits("song"),
        3,
        "corrupt transfers are retried twice"
    );
    assert!(!fixture.root.join("music/song.mp3").exists());
    assert!(staging_files(&fixture.root).is_empty());
    assert_eq!(
        fixture.library.status(Kind::Music, "song"),
        ItemStatus::Failed
    );

    assert_eq!(
        std::fs::read(fixture.ensure(Kind::Music, "song").unwrap()).unwrap(),
        data
    );
    assert_eq!(
        fixture.library.status(Kind::Music, "song"),
        ItemStatus::Ready
    );
}

#[test]
fn a_cut_off_transfer_never_lands() {
    let server = Server::start();
    let data = body(80_000, 4);
    server.route(
        "song",
        vec![Response {
            cut_after: Some(30_000),
            ..Response::ok(&data)
        }],
    );
    let fixture = Fixture::new(&server, vec![track(&server, "song", &data)]);

    assert!(fixture.ensure(Kind::Music, "song").is_err());
    assert_eq!(server.hits("song"), 3);
    assert!(
        files(&fixture.root).is_empty(),
        "{:?}",
        files(&fixture.root)
    );
}

#[test]
fn a_body_longer_than_the_manifest_says_is_refused() {
    let server = Server::start();
    let data = body(10_000, 5);
    let mut longer = data.clone();
    longer.extend_from_slice(&body(5_000, 6));
    server.route(
        "declared",
        vec![Response {
            declared: Some(data.len()),
            ..Response::ok(&longer)
        }],
    );
    server.route("honest", vec![Response::ok(&longer)]);
    let fixture = Fixture::new(
        &server,
        vec![
            track(&server, "declared", &data),
            track(&server, "honest", &data),
        ],
    );

    // A lying Content-Length gets the right bytes and is fine; a body that
    // says it is longer is refused before it is read.
    assert!(fixture.ensure(Kind::Music, "declared").is_ok());
    assert_eq!(
        fixture.ensure(Kind::Music, "honest"),
        Err(FetchError::Corrupt)
    );
    assert!(!fixture.root.join("music/honest.mp3").exists());
    assert!(staging_files(&fixture.root).is_empty());
}

#[test]
fn not_found_is_not_retried_but_server_errors_are() {
    let server = Server::start();
    let data = body(1_000, 7);
    server.route("gone", vec![Response::status(404)]);
    server.route(
        "flaky",
        vec![
            Response::status(503),
            Response::status(502),
            Response::ok(&data),
        ],
    );
    let fixture = Fixture::new(
        &server,
        vec![
            track(&server, "gone", &data),
            track(&server, "flaky", &data),
        ],
    );

    assert_eq!(
        fixture.ensure(Kind::Music, "gone"),
        Err(FetchError::Http(404))
    );
    assert_eq!(server.hits("gone"), 1);
    assert!(fixture.ensure(Kind::Music, "flaky").is_ok());
    assert_eq!(server.hits("flaky"), 3);
}

#[test]
fn no_server_reads_as_offline() {
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let server = Server::start();
    let data = body(100, 8);
    let mut item = track(&server, "song", &data);
    item.file.url = format!("http://127.0.0.1:{port}/song");
    let fixture = Fixture::new(&server, vec![item]);

    assert_eq!(
        fixture.ensure(Kind::Music, "song"),
        Err(FetchError::Offline)
    );
    assert!(files(&fixture.root).is_empty());
    assert_eq!(
        super::error_message(&FetchError::Offline),
        crate::i18n::tr::assets::error::offline()
    );
}

#[test]
fn unknown_ids_are_refused_without_a_request() {
    let server = Server::start();
    let fixture = Fixture::new(&server, vec![]);
    assert!(matches!(
        fixture.library.begin(Kind::Music, "../../etc/passwd"),
        Begin::Unknown
    ));
    assert!(matches!(
        fixture.library.begin(Kind::Wallpaper, "nope/nope"),
        Begin::Unknown
    ));
}

#[test]
fn download_all_fetches_every_missing_item_and_reports_progress() {
    let server = Server::start();
    let items: Vec<(String, Vec<u8>)> = (0..5)
        .map(|index| {
            (
                format!("t{index}"),
                body(40_000 + index * 1000, index as u8),
            )
        })
        .collect();
    for (id, data) in &items {
        server.route(id, vec![Response::ok(data)]);
    }
    let fixture = Fixture::new(
        &server,
        items
            .iter()
            .map(|(id, data)| track(&server, id, data))
            .collect(),
    );
    let total: u64 = items.iter().map(|(_, data)| data.len() as u64).sum();

    let summary = fixture.library.summary(Kind::Music);
    assert_eq!((summary.missing, summary.missing_bytes), (5, total));
    {
        let _enter = fixture.runtime.enter();
        fixture.library.download_all(Kind::Music);
    }
    let bulk = fixture.library.summary(Kind::Music).bulk.unwrap();
    assert!(bulk.running);
    assert_eq!(bulk.total, total);

    fixture.wait_until(|library| library.summary(Kind::Music).bulk.is_none());
    let summary = fixture.library.summary(Kind::Music);
    assert_eq!(summary.missing, 0);
    for (id, data) in &items {
        assert_eq!(
            std::fs::read(fixture.root.join(format!("music/{id}.mp3"))).unwrap(),
            *data
        );
        assert_eq!(server.hits(id), 1);
    }
}

#[test]
fn a_failed_bulk_says_how_many_and_retries_only_those() {
    let server = Server::start();
    let good = body(5_000, 9);
    server.route("good", vec![Response::ok(&good)]);
    server.route("bad", vec![Response::status(404), Response::ok(&good)]);
    let fixture = Fixture::new(
        &server,
        vec![track(&server, "good", &good), track(&server, "bad", &good)],
    );
    {
        let _enter = fixture.runtime.enter();
        fixture.library.download_all(Kind::Music);
    }
    fixture.wait_until(|library| {
        library
            .summary(Kind::Music)
            .bulk
            .is_some_and(|bulk| !bulk.running)
    });
    let bulk = fixture.library.summary(Kind::Music).bulk.unwrap();
    assert_eq!(bulk.failed, 1);
    assert_eq!(
        fixture.library.status(Kind::Music, "bad"),
        ItemStatus::Failed
    );

    fixture.library.dismiss_failures(Kind::Music);
    {
        let _enter = fixture.runtime.enter();
        fixture.library.download_all(Kind::Music);
    }
    fixture.wait_until(|library| library.summary(Kind::Music).bulk.is_none());
    assert_eq!(fixture.library.summary(Kind::Music).missing, 0);
    assert_eq!(server.hits("good"), 1);
}

#[test]
fn cancel_stops_a_bulk_and_leaves_nothing_half_written() {
    let server = Server::start();
    let items: Vec<(String, Vec<u8>)> = (0..6)
        .map(|index| (format!("slow{index}"), body(400_000, index as u8)))
        .collect();
    for (id, data) in &items {
        server.route(
            id,
            vec![Response {
                delay: Duration::from_millis(30),
                ..Response::ok(data)
            }],
        );
    }
    let fixture = Fixture::new(
        &server,
        items
            .iter()
            .map(|(id, data)| track(&server, id, data))
            .collect(),
    );
    {
        let _enter = fixture.runtime.enter();
        fixture.library.download_all(Kind::Music);
    }
    fixture.wait_until(|library| {
        (0..6).any(|index| {
            matches!(
                library.status(Kind::Music, &format!("slow{index}")),
                ItemStatus::Downloading(fraction) if fraction > 0.
            )
        })
    });
    fixture.library.cancel_all(Kind::Music);
    assert!(fixture.library.summary(Kind::Music).bulk.is_none());
    fixture.wait_until(|library| {
        (0..6).all(|index| {
            !matches!(
                library.status(Kind::Music, &format!("slow{index}")),
                ItemStatus::Downloading(_)
            )
        })
    });
    assert!(staging_files(&fixture.root).is_empty());
    assert!(
        fixture.library.summary(Kind::Music).missing > 0,
        "cancel stopped the queue"
    );
    // A cancelled item is not a failure.
    for index in 0..6 {
        assert_ne!(
            fixture.library.status(Kind::Music, &format!("slow{index}")),
            ItemStatus::Failed
        );
    }
    let started: usize = (0..6)
        .map(|index| server.hits(&format!("slow{index}")))
        .sum();
    assert!(started < 6, "queued items never started ({started})");
}

#[test]
fn a_bulk_cancel_does_not_stop_a_download_someone_clicked() {
    let server = Server::start();
    let data = body(400_000, 10);
    server.route(
        "clicked",
        vec![Response {
            delay: Duration::from_millis(40),
            ..Response::ok(&data)
        }],
    );
    let fixture = Fixture::new(&server, vec![track(&server, "clicked", &data)]);
    {
        let _enter = fixture.runtime.enter();
        fixture.library.download_all(Kind::Music);
    }
    let rx = match fixture.library.begin(Kind::Music, "clicked") {
        Begin::Waiting(rx) => rx,
        _ => panic!("expected to join the bulk download"),
    };
    fixture.library.cancel_all(Kind::Music);
    let path = fixture.runtime.block_on(rx).unwrap().unwrap();
    assert_eq!(std::fs::read(path).unwrap(), data);
    assert_eq!(server.hits("clicked"), 1);
}

#[test]
fn built_in_files_already_on_disk_count_only_when_allowed_and_whole() {
    let server = Server::start();
    let data = body(2_000, 11);
    let local = tempfile::tempdir().unwrap();
    let dirs = HashMap::from([(Kind::Music, vec![local.path().to_path_buf()])]);
    std::fs::write(local.path().join("song.mp3"), &data).unwrap();
    std::fs::write(local.path().join("short.mp3"), &data[..100]).unwrap();
    let items = || {
        vec![
            track(&server, "song", &data),
            track(&server, "short", &data),
        ]
    };

    let fixture = Fixture::with_local(&server, items(), dirs.clone(), true);
    assert_eq!(
        fixture.library.status(Kind::Music, "song"),
        ItemStatus::Ready
    );
    assert_eq!(
        fixture.ensure(Kind::Music, "song").unwrap(),
        local.path().join("song.mp3")
    );
    assert_eq!(
        fixture.library.status(Kind::Music, "short"),
        ItemStatus::Missing
    );
    assert_eq!(server.hits("song"), 0);

    let fixture = Fixture::with_local(&server, items(), dirs, false);
    assert_eq!(
        fixture.library.status(Kind::Music, "song"),
        ItemStatus::Missing
    );
}

#[test]
fn a_deleted_download_is_noticed_and_fetched_again() {
    let server = Server::start();
    let data = body(3_000, 12);
    server.route("song", vec![Response::ok(&data)]);
    let fixture = Fixture::new(&server, vec![track(&server, "song", &data)]);
    let path = fixture.ensure(Kind::Music, "song").unwrap();
    std::fs::remove_file(&path).unwrap();

    assert_eq!(fixture.ensure(Kind::Music, "song").unwrap(), path);
    assert_eq!(server.hits("song"), 2);
}

#[test]
fn stale_staging_files_are_swept_and_real_files_kept() {
    let server = Server::start();
    let fixture = Fixture::new(&server, vec![]);
    let theme = fixture.root.join("backgrounds/blue");
    std::fs::create_dir_all(&theme).unwrap();
    std::fs::create_dir_all(fixture.root.join("music")).unwrap();
    let stale = [
        theme.join(".1.jpg.123-0.part"),
        fixture.root.join("music/.a.mp3.9-1.part"),
        fixture.root.join(".state.json.5-2.part"),
    ];
    for path in &stale {
        std::fs::write(path, b"partial").unwrap();
    }
    std::fs::write(theme.join("1.jpg"), b"real").unwrap();

    fixture
        .library
        .remove_stale_staging_files(Duration::from_secs(3600));
    assert!(stale.iter().all(|path| path.exists()), "fresh ones stay");
    fixture.library.remove_stale_staging_files(Duration::ZERO);
    assert!(stale.iter().all(|path| !path.exists()));
    assert!(theme.join("1.jpg").exists());
}

#[test]
fn existing_users_are_restored_and_new_users_are_not() {
    let server = Server::start();
    let existing = Fixture::new(&server, vec![]);
    existing.library.decide_restore(true);
    assert_eq!(
        existing.library.load_state().unwrap().restore,
        Restore::Pending
    );
    assert!(existing.library.restore_pending());
    // Decided once: a later launch, after onboarding, does not change it.
    existing
        .library
        .update_state(|state| state.restore = Restore::Done);
    existing.library.decide_restore(true);
    assert!(!existing.library.restore_pending());

    let new = Fixture::new(&server, vec![]);
    new.library.decide_restore(false);
    assert!(!new.library.restore_pending());
    new.library.decide_restore(true);
    assert!(
        !new.library.restore_pending(),
        "decided on first launch only"
    );
}

#[test]
fn a_remote_manifest_adds_items_with_their_thumbnails() {
    let server = Server::start();
    let picture = body(20_000, 13);
    let thumbnail = body(900, 14);
    let song = body(9_000, 15);
    let hex = |data: &[u8]| -> String {
        sha2::Sha256::digest(data)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    };
    let manifest = serde_json::json!({
        "version": 1,
        "themes": [{ "id": "space", "label": "Space" }],
        "wallpapers": [{
            "id": "space/nebula", "url": server.url("nebula.jpg"), "size": picture.len(),
            "sha256": hex(&picture),
            "thumbnail": { "url": server.url("nebula-thumb.jpg"), "size": thumbnail.len(), "sha256": hex(&thumbnail) }
        }],
        "music": [{ "id": "fresh", "name": "Fresh", "url": server.url("fresh.mp3"), "size": song.len(), "sha256": hex(&song) }]
    });
    server.route(
        "manifest.json",
        vec![Response::ok(manifest.to_string().as_bytes())],
    );
    server.route("nebula-thumb.jpg", vec![Response::ok(&thumbnail)]);
    server.route("nebula.jpg", vec![Response::ok(&picture)]);
    server.route("fresh.mp3", vec![Response::ok(&song)]);
    let fixture = Fixture::new(&server, vec![]);

    let library = fixture.library.clone();
    fixture.runtime.block_on(library.refresh_remote(false));

    let catalog = fixture.library.catalog();
    assert_eq!(catalog.extra_themes(), [("space", "Space")]);
    assert_eq!(fixture.library.summary(Kind::Wallpaper).new, 1);
    assert_eq!(
        std::fs::read(fixture.library.thumbnail_path("space/nebula").unwrap()).unwrap(),
        thumbnail
    );
    assert_eq!(fixture.library.summary(Kind::Music).new, 1);
    assert_eq!(
        std::fs::read(fixture.ensure(Kind::Wallpaper, "space/nebula").unwrap()).unwrap(),
        picture
    );

    // Checked within six hours: no second request, and the cached copy
    // brings the extras back on the next launch.
    let library = fixture.library.clone();
    fixture.runtime.block_on(library.refresh_remote(false));
    assert_eq!(server.hits("manifest.json"), 1);
    let relaunched = Arc::new(Library::new(
        fixture.root.clone(),
        HashMap::new(),
        false,
        server.url("manifest.json"),
        Some(format!("http://127.0.0.1:{}", server.port)),
        Catalog::default(),
    ));
    relaunched.load_cached_remote();
    assert!(relaunched.catalog().item(Kind::Music, "fresh").is_some());
}

#[test]
fn a_missing_or_broken_remote_manifest_changes_nothing() {
    let server = Server::start();
    let fixture = Fixture::new(&server, vec![]);
    let library = fixture.library.clone();
    fixture.runtime.block_on(library.refresh_remote(true));
    assert!(fixture.library.catalog().extra_themes().is_empty());

    server.route("manifest.json", vec![Response::ok(b"{ not json")]);
    let library = fixture.library.clone();
    fixture.runtime.block_on(library.refresh_remote(true));
    assert_eq!(fixture.library.catalog().items(Kind::Music).count(), 0);
    assert!(!fixture.root.join("remote-manifest.json").exists());
}

#[test]
fn a_legacy_project_path_resolves_to_its_catalogue_wallpaper() {
    let server = Server::start();
    let data = body(1_000, 16);
    let fixture = Fixture::new(&server, vec![wallpaper(&server, "zztest/one", &data)]);
    let mut project = cap_project::ProjectConfiguration::default();
    project.background.source = cap_project::BackgroundSource::Wallpaper {
        path: Some(
            "/Applications/Cap.app/Contents/Resources/assets/backgrounds/zztest/one.jpg".into(),
        ),
    };
    assert_eq!(
        fixture.library.missing_project_wallpapers(&project),
        vec![Ok("zztest/one")]
    );

    project.background.source = cap_project::BackgroundSource::Wallpaper {
        path: Some("/Users/a/Pictures/mine.jpg".into()),
    };
    assert!(
        fixture
            .library
            .missing_project_wallpapers(&project)
            .is_empty()
    );
    project.background.source = cap_project::BackgroundSource::Image {
        path: Some(
            "/Applications/Cap.app/Contents/Resources/assets/backgrounds/zztest/one.jpg".into(),
        ),
    };
    assert!(
        fixture
            .library
            .missing_project_wallpapers(&project)
            .is_empty()
    );

    // A style section's wallpaper counts too, and a catalogue-shaped path
    // this catalogue does not list is reported apart.
    let mut style_background = project.background.clone();
    style_background.source = cap_project::BackgroundSource::Wallpaper {
        path: Some("/gone/assets/backgrounds/zztest/one.jpg".into()),
    };
    let mut unknown_background = project.background.clone();
    unknown_background.source = cap_project::BackgroundSource::Wallpaper {
        path: Some("/gone/assets/backgrounds/later/added.jpg".into()),
    };
    // A disabled section is never drawn, so it needs nothing.
    let mut disabled_background = project.background.clone();
    disabled_background.source = cap_project::BackgroundSource::Wallpaper {
        path: Some("/gone/assets/backgrounds/zztest/two.jpg".into()),
    };
    let timeline = project.timeline.get_or_insert_with(|| {
        serde_json::from_value(serde_json::json!({ "segments": [], "zoomSegments": [] })).unwrap()
    });
    for background in [style_background, unknown_background] {
        let mut segment = cap_project::StyleSegment::default();
        segment.overrides.background = Some(background);
        timeline.style_segments.push(segment);
    }
    let mut disabled = cap_project::StyleSegment::default();
    disabled.enabled = false;
    disabled.overrides.background = Some(disabled_background);
    timeline.style_segments.push(disabled);
    assert_eq!(
        fixture.library.missing_project_wallpapers(&project),
        vec![Ok("zztest/one"), Err("later/added.jpg".to_string())]
    );
}

#[test]
fn progress_notifications_fire_and_are_throttled() {
    let server = Server::start();
    let data = body(600_000, 17);
    server.route(
        "big",
        vec![Response {
            delay: Duration::from_millis(1),
            ..Response::ok(&data)
        }],
    );
    let fixture = Fixture::new(&server, vec![track(&server, "big", &data)]);
    let before = *fixture.library.subscribe().borrow();
    let started = std::time::Instant::now();
    fixture.ensure(Kind::Music, "big").unwrap();
    let elapsed = started.elapsed();
    // Read straight after: the last notification may land later, which
    // only makes the count smaller.
    let notified = fixture.library.subscribe().borrow().wrapping_sub(before) as usize;
    assert!(notified >= 2, "start and finish at least ({notified})");
    let ceiling = (elapsed.as_millis() / 50) as usize + 4;
    assert!(
        notified <= ceiling,
        "{notified} notifications in {elapsed:?}"
    );
}

#[test]
fn restore_brings_back_every_built_in_file_and_marks_itself_done() {
    let server = Server::start();
    let items: Vec<(String, Vec<u8>)> = (0..4)
        .map(|index| (format!("r{index}"), body(7_000, 40 + index as u8)))
        .collect();
    for (id, data) in &items {
        server.route(id, vec![Response::ok(data)]);
    }
    let mut catalog_items: Vec<Item> = items
        .iter()
        .map(|(id, data)| track(&server, id, data))
        .collect();
    let mut extra = track(&server, "remote-only", b"x");
    extra.builtin = false;
    catalog_items.push(extra);
    let fixture = Fixture::new(&server, catalog_items);
    fixture.library.decide_restore(true);
    fixture.library.hub().restoring = true;
    assert!(!fixture.library.offers_downloads());

    let checks = AtomicUsize::new(0);
    let library = fixture.library.clone();
    fixture.runtime.block_on(super::restore(
        &library,
        // Recording for the first two checks: it waits.
        || checks.fetch_add(1, Ordering::AcqRel) < 2,
        |_| async {},
    ));

    assert!(checks.load(Ordering::Acquire) >= 3);
    for (id, data) in &items {
        assert_eq!(
            std::fs::read(fixture.root.join(format!("music/{id}.mp3"))).unwrap(),
            *data
        );
    }
    assert_eq!(
        server.hits("remote-only"),
        0,
        "restore is for built-ins only"
    );
    assert!(!fixture.library.restore_pending());
    assert!(fixture.library.offers_downloads());
}

#[test]
fn restore_without_a_connection_stops_early_and_tries_again_next_launch() {
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let server = Server::start();
    let items: Vec<Item> = (0..10)
        .map(|index| {
            let mut item = track(&server, &format!("o{index}"), b"data");
            item.file.url = format!("http://127.0.0.1:{port}/o{index}");
            item
        })
        .collect();
    let fixture = Fixture::new(&server, items);
    fixture.library.decide_restore(true);

    let library = fixture.library.clone();
    fixture
        .runtime
        .block_on(super::restore(&library, || false, |_| async {}));

    assert!(fixture.library.restore_pending(), "retried next launch");
    assert!(
        fixture.library.offers_downloads(),
        "the sections offer downloads again"
    );
    let failed = (0..10)
        .filter(|index| {
            fixture.library.status(Kind::Music, &format!("o{index}")) == ItemStatus::Failed
        })
        .count();
    assert_eq!(failed, 3, "stopped after three offline files");
}

#[test]
fn download_all_right_after_cancel_still_fetches_everything() {
    let server = Server::start();
    let items: Vec<(String, Vec<u8>)> = (0..4)
        .map(|index| (format!("again{index}"), body(300_000, 60 + index as u8)))
        .collect();
    for (id, data) in &items {
        server.route(
            id,
            vec![Response {
                delay: Duration::from_millis(20),
                ..Response::ok(data)
            }],
        );
    }
    let fixture = Fixture::new(
        &server,
        items
            .iter()
            .map(|(id, data)| track(&server, id, data))
            .collect(),
    );
    fixture.library.download_all(Kind::Music);
    fixture.wait_until(|library| {
        (0..4).any(|index| {
            matches!(
                library.status(Kind::Music, &format!("again{index}")),
                ItemStatus::Downloading(fraction) if fraction > 0.
            )
        })
    });
    fixture.library.cancel_all(Kind::Music);
    fixture.library.download_all(Kind::Music);
    fixture.wait_until(|library| library.summary(Kind::Music).bulk.is_none());

    assert_eq!(fixture.library.summary(Kind::Music).missing, 0);
    for (id, data) in &items {
        assert_eq!(
            std::fs::read(fixture.root.join(format!("music/{id}.mp3"))).unwrap(),
            *data
        );
    }
    assert!(staging_files(&fixture.root).is_empty());
}

#[test]
fn a_cancelled_export_stops_waiting_for_its_wallpaper() {
    let server = Server::start();
    let data = body(2_000_000, 70);
    server.route(
        "stalls",
        vec![Response {
            delay: Duration::from_millis(50),
            ..Response::ok(&data)
        }],
    );
    let fixture = Fixture::new(&server, vec![track(&server, "stalls", &data)]);
    let rx = match fixture.library.begin(Kind::Music, "stalls") {
        Begin::Waiting(rx) => rx,
        _ => panic!("expected a download"),
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = cancel.clone();
    let result = fixture.runtime.block_on(async move {
        let waiting = super::wait_unless_cancelled(rx, Some(&flag));
        flag.store(true, Ordering::Release);
        tokio::time::timeout(Duration::from_secs(5), waiting).await
    });
    assert_eq!(result, Ok(Err(FetchError::Cancelled)));
    // The shared download is not stopped by one caller giving up.
    assert!(matches!(
        fixture.library.status(Kind::Music, "stalls"),
        ItemStatus::Downloading(_)
    ));
    let _ = cancel;
}
