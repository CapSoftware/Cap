//! Deterministic fault-injection tests for the share and Instant upload paths.
//!
//! The real upload code runs against `MockCap`, an in-process HTTP/1.1 mock of
//! the Cap upload API and its object store, on a paused tokio clock. Retry
//! backoff, outages and request timeouts therefore cost virtual time only.
//! The clock advances in 1 ms steps, and freezes while the mock is serving a
//! request, and for a few real milliseconds after the mock or any other task
//! last did work. Bytes still crossing the loopback socket therefore never
//! see virtual time move, and a far timer (a 5 minute request timeout, say)
//! never fires early.
//!
//! Every case checks the stored objects against the local files byte for byte
//! and holds request counts and re-uploaded bytes to budgets taken from the
//! behaviour of main when the case was written. Lower is allowed; higher fails.

use super::*;
use cap_recording::upload_verification::UploadVerification;
use sha2::{Digest as _, Sha256};
use std::collections::BTreeMap;
use std::sync::atomic::AtomicBool;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};

pub(super) const API_KEY: &str = "verify-api-key";
pub(super) const OWNER: &str = "verify-owner";
pub(super) const SAMPLE_MP4: &[u8] =
    include_bytes!("../../../media-server/src/__tests__/fixtures/test-with-audio.mp4");

const MIB: usize = 1024 * 1024;
const PART: u64 = 5 * MIB as u64;
const STUDIO_SIZE: usize = 5 * 5 * MIB + MIB + 12_345;
const STUDIO_LAST_PART: u64 = STUDIO_SIZE as u64 - 5 * PART;
const VIDEO_SEGMENT: usize = 256 * 1024;
const AUDIO_SEGMENT: usize = 32 * 1024;
const INSTANT_PAIRS: u32 = 8;
const INSTANT_VIDEO_ID: &str = "instantverify01";
const RETRY_WINDOW: Duration = Duration::from_secs(5 * 60);

const SETTLE: Duration = Duration::from_millis(50);
const WORKED: Duration = Duration::from_micros(200);

#[derive(Default)]
struct Activity {
    in_flight: std::sync::atomic::AtomicUsize,
    last: Mutex<Option<std::time::Instant>>,
}

impl Activity {
    fn touch(&self) {
        *self.last.lock().unwrap_or_else(|error| error.into_inner()) =
            Some(std::time::Instant::now());
    }

    fn busy(&self) -> bool {
        self.in_flight.load(Ordering::Acquire) > 0
            || self
                .last
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_some_and(|at| at.elapsed() < SETTLE)
    }
}

struct InFlight(Arc<Activity>);

impl InFlight {
    fn new(activity: &Arc<Activity>) -> Self {
        activity.in_flight.fetch_add(1, Ordering::AcqRel);
        activity.touch();
        Self(activity.clone())
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.in_flight.fetch_sub(1, Ordering::AcqRel);
        self.0.touch();
    }
}

thread_local! {
    static ACTIVITY: std::cell::RefCell<Option<Arc<Activity>>> = const {
        std::cell::RefCell::new(None)
    };
}

pub(super) fn virtual_time<F: Future>(future: F) -> F::Output {
    let activity = Arc::new(Activity::default());
    ACTIVITY.with(|current| *current.borrow_mut() = Some(activity.clone()));
    let output = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .start_paused(true)
        .build()
        .unwrap()
        .block_on(async {
            let ticker = tokio::spawn(async move {
                loop {
                    if activity.busy() {
                        std::thread::sleep(Duration::from_micros(50));
                        tokio::task::yield_now().await;
                    } else {
                        let step = std::time::Instant::now();
                        tokio::time::sleep(Duration::from_millis(1)).await;
                        if step.elapsed() > WORKED {
                            activity.touch();
                        }
                    }
                }
            });
            let output = future.await;
            ticker.abort();
            output
        });
    ACTIVITY.with(|current| *current.borrow_mut() = None);
    output
}

#[derive(Clone, Copy, Debug)]
pub(super) enum Route {
    Part(u32),
    Object(&'static str),
    Api(&'static str),
}

impl Route {
    fn matches(self, method: &str, path: &str) -> bool {
        match self {
            Route::Part(number) => {
                method == "PUT"
                    && path.starts_with("/s3mp/")
                    && path.rsplit('/').next() == Some(number.to_string().as_str())
            }
            Route::Object(fragment) => {
                method == "PUT" && path.starts_with("/s3/") && path.contains(fragment)
            }
            Route::Api(fragment) => path.starts_with("/api/") && path.contains(fragment),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(super) enum Fault {
    /// Read the whole body, then answer with this status.
    Status(u16),
    /// Read this fraction of the body, then reset the connection.
    Reset(f64),
    /// Read this fraction of the body, then take the network down: every open
    /// connection is reset and new ones are reset on accept until it ends.
    Outage(f64, Duration),
    /// Read the body, wait, then answer normally.
    Delay(Duration),
    /// Read the body and never answer.
    Hang,
    /// Read this fraction of the body, raise the test's cancel flag (or quit
    /// signal), then finish the request normally.
    Trip(f64),
}

pub(super) struct Rule {
    route: Route,
    fault: Fault,
    skip: u32,
    count: u32,
    seen: u32,
    fired: u32,
}

pub(super) fn rule(route: Route, fault: Fault) -> Rule {
    Rule {
        route,
        fault,
        skip: 0,
        count: 1,
        seen: 0,
        fired: 0,
    }
}

impl Rule {
    pub(super) fn times(mut self, count: u32) -> Self {
        self.count = count;
        self
    }
}

#[derive(Default)]
struct Multipart {
    video_id: String,
    parts: BTreeMap<u32, (String, Vec<u8>)>,
    completed: bool,
    aborted: bool,
}

#[derive(Default)]
struct MockState {
    rules: Vec<Rule>,
    requests: Vec<(String, String, u16, Duration)>,
    epoch: Option<tokio::time::Instant>,
    media_put_bytes: u64,
    useful_offset: u64,
    objects: BTreeMap<String, Vec<u8>>,
    uploads: BTreeMap<String, Multipart>,
    outage_until: Option<tokio::time::Instant>,
    reset_on_accept: u32,
    accepted: usize,
    connections: Vec<tokio::task::AbortHandle>,
    next_id: u32,
    confirmations: Vec<Value>,
    deletes: u32,
    created: Vec<String>,
    deleted: Vec<String>,
    problems: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Stats {
    /// HTTP requests that reached the mock (API calls and object PUTs).
    pub(super) requests: usize,
    /// PUTs of media objects and multipart parts (recording metadata excluded).
    pub(super) media_puts: usize,
    /// PUTs of `segments/manifest.json`.
    pub(super) manifest_puts: usize,
    /// Media body bytes the server received, whole or cut off.
    pub(super) media_bytes: u64,
    /// Media body bytes the server received beyond what it finally kept:
    /// failed or reset bodies, rewritten objects and parts of multipart
    /// uploads that were never completed.
    pub(super) reupload_bytes: u64,
    /// Multipart uploads initiated and never completed or aborted.
    pub(super) orphans: usize,
    /// Connections the mock accepted and served.
    pub(super) connections: usize,
    /// Connections reset on accept during an outage.
    pub(super) reset_on_accept: u32,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct Budget {
    pub(super) requests: usize,
    pub(super) media_puts: usize,
    pub(super) manifest_puts: usize,
    pub(super) reupload_bytes: u64,
    pub(super) orphans: usize,
    pub(super) connections: usize,
}

/// Every budget, in one table: main's measured behaviour at 83237e994 (#2522
/// merged: multipart parts go one at a time over per-upload clients). A
/// change that should move a number, like a retry fix, updates it here and
/// says why; anything that goes over fails.
///
/// Studio: a 26 MiB export in six parts (five of 5 MiB, one of 1 MiB + 12345
/// bytes), each part a presign and a PUT. Instant: 2 init segments and 8
/// audio/video pairs on URLs from one batch presign, progress manifests (a
/// presign and a PUT each) and the completion signal.
pub(super) mod budget {
    use super::{Budget, PART, STUDIO_LAST_PART, STUDIO_SIZE, VIDEO_SEGMENT};

    const fn budget(
        requests: usize,
        media_puts: usize,
        manifest_puts: usize,
        reupload_bytes: u64,
        orphans: usize,
        connections: usize,
    ) -> Budget {
        Budget {
            requests,
            media_puts,
            manifest_puts,
            reupload_bytes,
            orphans,
            connections,
        }
    }

    // budget(requests, media_puts, manifest_puts, reupload_bytes, orphans, connections)
    const SEGMENT_3: u64 = VIDEO_SEGMENT as u64 + 21;
    /// Instant segments share one pooled client, and whether a finished
    /// request's connection is back in the pool when the next one starts is
    /// a race: under heavy load main was seen opening up to 2 more
    /// connections than its usual count. Studio connection counts are exact.
    const POOL_RACE: usize = 3;
    const SEGMENT_4: u64 = VIDEO_SEGMENT as u64 + 28;

    pub(in crate::upload) const STUDIO_SHARE_CLEAN: Budget = budget(18, 7, 0, 0, 0, 8);
    pub(in crate::upload) const STUDIO_SHARE_PART_503: Budget = budget(20, 8, 0, PART, 0, 8);
    pub(in crate::upload) const STUDIO_SHARE_RESET_MID_PART: Budget =
        budget(19, 8, 0, PART / 2, 0, 9);
    pub(in crate::upload) const STUDIO_SHARE_OUTAGE_MID_PART: Budget =
        budget(19, 8, 0, PART / 2, 0, 10);
    pub(in crate::upload) const STUDIO_SHARE_PRESIGN_500: Budget = budget(19, 7, 0, 0, 0, 8);
    pub(in crate::upload) const STUDIO_SHARE_HUNG_PART: Budget = budget(19, 8, 0, PART, 0, 10);
    pub(in crate::upload) const STUDIO_SHARE_SLOW_PART: Budget = budget(18, 7, 0, 0, 0, 8);
    pub(in crate::upload) const STUDIO_SHARE_PERMANENT_403: Budget =
        budget(17, 7, 0, 6 * PART + STUDIO_LAST_PART, 1, 5);
    pub(in crate::upload) const STUDIO_SHARE_COMPLETE_500: Budget =
        budget(16, 6, 0, STUDIO_SIZE as u64, 1, 6);
    pub(in crate::upload) const STUDIO_SHARE_CANCEL_THEN_RESUME: Budget =
        budget(26, 10, 0, 3 * PART, 1, 12);

    pub(in crate::upload) const INSTANT_LIVE_CLEAN: Budget =
        budget(38, 18, 9, 0, 0, 13 + POOL_RACE);
    pub(in crate::upload) const INSTANT_LIVE_SEGMENT_503: Budget =
        budget(42, 19, 10, SEGMENT_3, 0, 15 + POOL_RACE);
    pub(in crate::upload) const INSTANT_LIVE_SEGMENT_503X3: Budget =
        budget(44, 21, 9, 3 * SEGMENT_3, 0, 16 + POOL_RACE);
    pub(in crate::upload) const INSTANT_LIVE_SEGMENT_RESET: Budget =
        budget(44, 21, 9, 3 * (SEGMENT_4 / 2), 0, 18 + POOL_RACE);
    pub(in crate::upload) const INSTANT_LIVE_OUTAGE: Budget =
        budget(41, 19, 7, SEGMENT_3 / 2, 0, 22 + POOL_RACE);
    pub(in crate::upload) const INSTANT_LIVE_SLOW_SEGMENT: Budget =
        budget(38, 18, 9, 0, 0, 13 + POOL_RACE);
    pub(in crate::upload) const INSTANT_LIVE_OUTAGE_PAST_WINDOW: Budget =
        budget(15, 8, 3, SEGMENT_3 / 2, 0, 6 + POOL_RACE);
    pub(in crate::upload) const INSTANT_LIVE_PERMANENT_403: Budget =
        budget(22, 11, 4, 3 * SEGMENT_3, 0, 9 + POOL_RACE);
    pub(in crate::upload) const INSTANT_LIVE_CANCEL: Budget =
        budget(19, 10, 4, 0, 0, 7 + POOL_RACE);
    pub(in crate::upload) const INSTANT_LIVE_COMPLETION_500: Budget =
        budget(40, 18, 9, 0, 0, 15 + POOL_RACE);

    /// The relaunch session only: every segment and the thumbnail once.
    pub(in crate::upload) const QUEUE_RESUME_AFTER_QUIT_MID_TRANSFER: Budget =
        budget(24, 15, 2, 1_795_340, 0, 12 + POOL_RACE);
    pub(in crate::upload) const QUEUE_RESUME_AFTER_QUIT_DURING_VERIFICATION: Budget =
        budget(1, 0, 0, 0, 0, 1);
}

pub(super) fn check_budget(case: &str, mock: &MockCap, budget: Budget) {
    let stats = mock.stats();
    eprintln!("upload-verify {case}: {stats:?}");
    let over = [
        ("requests", stats.requests as u64, budget.requests as u64),
        (
            "media_puts",
            stats.media_puts as u64,
            budget.media_puts as u64,
        ),
        (
            "manifest_puts",
            stats.manifest_puts as u64,
            budget.manifest_puts as u64,
        ),
        (
            "reupload_bytes",
            stats.reupload_bytes,
            budget.reupload_bytes,
        ),
        ("orphans", stats.orphans as u64, budget.orphans as u64),
        (
            "connections",
            stats.connections as u64,
            budget.connections as u64,
        ),
    ]
    .into_iter()
    .filter(|(_, actual, limit)| actual > limit)
    .map(|(name, actual, limit)| format!("{name} {actual} > budget {limit}"))
    .collect::<Vec<_>>();
    assert!(
        over.is_empty(),
        "{case} is over budget: {over:?} ({stats:?})\nrequests (virtual time):\n{}",
        mock.timeline()
    );
}

pub(super) struct MockCap {
    pub(super) url: String,
    activity: Arc<Activity>,
    state: Arc<Mutex<MockState>>,
    cancel: Arc<AtomicBool>,
    tripped: Arc<tokio::sync::Notify>,
    accept: tokio::task::JoinHandle<()>,
}

impl Drop for MockCap {
    fn drop(&mut self) {
        self.accept.abort();
        for connection in self.lock().connections.drain(..) {
            connection.abort();
        }
    }
}

impl MockCap {
    pub(super) async fn start(rules: Vec<Rule>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(MockState {
            rules,
            epoch: Some(tokio::time::Instant::now()),
            ..Default::default()
        }));
        let cancel = Arc::new(AtomicBool::new(false));
        let tripped = Arc::new(tokio::sync::Notify::new());
        let activity: Arc<Activity> = ACTIVITY
            .with(|current| current.borrow().clone())
            .unwrap_or_default();
        let server = Server {
            activity: activity.clone(),
            url: url.clone(),
            state: state.clone(),
            cancel: cancel.clone(),
            tripped: tripped.clone(),
        };
        let accept = tokio::spawn(server.accept(listener));
        Self {
            url,
            activity,
            state,
            cancel,
            tripped,
            accept,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, MockState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub(super) fn cancel_flag(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    pub(super) async fn tripped(&self) {
        self.tripped.notified().await;
    }

    pub(super) fn object(&self, key: &str) -> Option<Vec<u8>> {
        self.lock().objects.get(key).cloned()
    }

    pub(super) fn confirmations(&self) -> Vec<Value> {
        self.lock().confirmations.clone()
    }

    pub(super) fn created(&self) -> Vec<String> {
        self.lock().created.clone()
    }

    pub(super) fn deleted(&self) -> Vec<String> {
        self.lock().deleted.clone()
    }

    pub(super) fn deletes(&self) -> u32 {
        self.lock().deletes
    }

    pub(super) fn count(&self, method: &str, fragment: &str) -> usize {
        self.lock()
            .requests
            .iter()
            .filter(|(m, path, ..)| m == method && path.contains(fragment))
            .count()
    }

    pub(super) fn timeline(&self) -> String {
        self.lock()
            .requests
            .iter()
            .map(|(method, path, status, at)| {
                format!("{:>10.3}s {status:>3} {method} {path}\n", at.as_secs_f64())
            })
            .collect()
    }

    pub(super) fn assert_clean(&self) {
        let problems = self.lock().problems.clone();
        assert!(
            problems.is_empty(),
            "upload protocol problems: {problems:?}"
        );
    }

    /// Waits until the mock has been idle for the settle window, so requests
    /// a quit app already handed to the kernel are served before the next
    /// session starts counting.
    pub(super) async fn drain(&self) {
        while self.activity.busy() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    }

    /// Forget every request so far and drop every open connection, as a quit
    /// does. Stored objects survive, so a relaunch can be measured on its own.
    pub(super) fn new_session(&self) {
        let mut state = self.lock();
        for connection in state.connections.drain(..) {
            connection.abort();
        }
        state.requests.clear();
        state.media_put_bytes = 0;
        state.reset_on_accept = 0;
        state.accepted = 0;
        state.useful_offset = state.useful_bytes();
    }

    pub(super) fn stats(&self) -> Stats {
        let state = self.lock();
        let is_media = |path: &str| {
            path.starts_with("/s3mp/") || (path.starts_with("/s3/") && !is_metadata_object(path))
        };
        Stats {
            requests: state.requests.len(),
            media_puts: state
                .requests
                .iter()
                .filter(|(method, path, ..)| method == "PUT" && is_media(path))
                .count(),
            manifest_puts: state
                .requests
                .iter()
                .filter(|(method, path, ..)| method == "PUT" && path.ends_with("/manifest.json"))
                .count(),
            media_bytes: state.media_put_bytes,
            reupload_bytes: state
                .media_put_bytes
                .saturating_sub(state.useful_bytes().saturating_sub(state.useful_offset)),
            orphans: state
                .uploads
                .values()
                .filter(|upload| !upload.completed && !upload.aborted)
                .count(),
            connections: state.accepted,
            reset_on_accept: state.reset_on_accept,
        }
    }
}

#[derive(Clone)]
struct Server {
    activity: Arc<Activity>,
    url: String,
    state: Arc<Mutex<MockState>>,
    cancel: Arc<AtomicBool>,
    tripped: Arc<tokio::sync::Notify>,
}

struct Head {
    method: String,
    path: String,
    query: String,
    headers: HashMap<String, String>,
}

impl Server {
    fn lock(&self) -> std::sync::MutexGuard<'_, MockState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    async fn accept(self, listener: TcpListener) {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            self.activity.touch();
            let _ = stream.set_zero_linger();
            let _ = stream.set_nodelay(true);
            let mut state = self.lock();
            if state
                .outage_until
                .is_some_and(|until| tokio::time::Instant::now() < until)
            {
                state.reset_on_accept += 1;
                continue;
            }
            state.accepted += 1;
            let connection = tokio::spawn(self.clone().connection(stream));
            state
                .connections
                .retain(|connection| !connection.is_finished());
            state.connections.push(connection.abort_handle());
        }
    }

    fn take_fault(&self, method: &str, path: &str) -> Option<Fault> {
        let mut state = self.lock();
        for rule in &mut state.rules {
            if rule.route.matches(method, path) {
                rule.seen += 1;
                if rule.seen > rule.skip && rule.fired < rule.count {
                    rule.fired += 1;
                    return Some(rule.fault);
                }
            }
        }
        None
    }

    fn record(&self, head: &Head, status: u16) {
        let mut state = self.lock();
        let at = state.epoch.map_or(Duration::ZERO, |epoch| epoch.elapsed());
        state
            .requests
            .push((head.method.clone(), head.path.clone(), status, at));
    }

    fn outage(&self, lasts: Duration) {
        let mut state = self.lock();
        state.outage_until = Some(tokio::time::Instant::now() + lasts);
        for connection in state.connections.drain(..) {
            connection.abort();
        }
    }

    async fn connection(self, mut stream: TcpStream) {
        let mut pending = Vec::new();
        while let Some(head) = read_head(&mut stream, &mut pending).await {
            let mut in_flight = Some(InFlight::new(&self.activity));
            let length = head
                .headers
                .get("content-length")
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            let media = head.method == "PUT"
                && (head.path.starts_with("/s3mp/")
                    || (head.path.starts_with("/s3/") && !is_metadata_object(&head.path)));
            let fault = self.take_fault(&head.method, &head.path);
            let cut = match fault {
                Some(Fault::Reset(at) | Fault::Outage(at, _) | Fault::Trip(at)) => {
                    ((length as f64) * at) as usize
                }
                _ => length,
            };
            let mut body = Vec::with_capacity(length);
            if !self
                .read_body(&mut stream, &mut pending, &mut body, cut, media)
                .await
            {
                self.record(&head, 0);
                return;
            }
            match fault {
                Some(Fault::Reset(_)) => {
                    self.record(&head, 0);
                    return;
                }
                Some(Fault::Outage(_, lasts)) => {
                    self.record(&head, 0);
                    self.outage(lasts);
                    return;
                }
                Some(Fault::Trip(_)) => {
                    self.cancel.store(true, Ordering::Release);
                    self.tripped.notify_one();
                    if !self
                        .read_body(&mut stream, &mut pending, &mut body, length, media)
                        .await
                    {
                        self.record(&head, 0);
                        return;
                    }
                }
                Some(Fault::Delay(delay)) => {
                    drop(in_flight.take());
                    tokio::time::sleep(delay).await;
                    in_flight = Some(InFlight::new(&self.activity));
                }
                Some(Fault::Hang) => {
                    self.record(&head, 0);
                    drop(in_flight.take());
                    std::future::pending::<()>().await;
                }
                Some(Fault::Status(status)) => {
                    self.record(&head, status);
                    if respond(&mut stream, status, &[], br#"{"error":"injected"}"#)
                        .await
                        .is_err()
                    {
                        return;
                    }
                    continue;
                }
                None => {}
            }
            let (status, headers, payload) = self.handle(&head, body);
            self.record(&head, status);
            if respond(&mut stream, status, &headers, &payload)
                .await
                .is_err()
            {
                return;
            }
            drop(in_flight);
        }
    }

    async fn read_body(
        &self,
        stream: &mut TcpStream,
        pending: &mut Vec<u8>,
        body: &mut Vec<u8>,
        until: usize,
        media: bool,
    ) -> bool {
        let mut buffer = vec![0u8; 64 * 1024];
        while body.len() < until {
            let wanted = until - body.len();
            let read = if pending.is_empty() {
                match stream.read(&mut buffer[..wanted.min(64 * 1024)]).await {
                    Ok(0) | Err(_) => return false,
                    Ok(read) => {
                        body.extend_from_slice(&buffer[..read]);
                        read
                    }
                }
            } else {
                let read = wanted.min(pending.len());
                body.extend(pending.drain(..read));
                read
            };
            self.activity.touch();
            if media {
                self.lock().media_put_bytes += read as u64;
            }
        }
        true
    }

    fn handle(&self, head: &Head, body: Vec<u8>) -> (u16, Vec<(String, String)>, Vec<u8>) {
        let mut guard = self.lock();
        let state = &mut *guard;
        let path = head.path.as_str();
        if head.method == "PUT" && path.starts_with("/s3mp/") {
            let mut parts = path["/s3mp/".len()..].splitn(2, '/');
            let upload_id = parts.next().unwrap_or_default().to_string();
            let number = parts
                .next()
                .and_then(|n| n.parse::<u32>().ok())
                .unwrap_or(0);
            let etag = to_hex(&cap_gpui_kernels::codec::md5(&body));
            if let Some(md5) = head.headers.get("content-md5") {
                let actual = base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    cap_gpui_kernels::codec::md5(&body),
                );
                if md5 != &actual {
                    state
                        .problems
                        .push(format!("Content-MD5 mismatch on {path}"));
                    return (400, Vec::new(), b"{}".to_vec());
                }
            }
            let Some(upload) = state.uploads.get_mut(&upload_id) else {
                state
                    .problems
                    .push(format!("part for unknown upload {path}"));
                return (404, Vec::new(), b"{}".to_vec());
            };
            if upload.completed || upload.aborted {
                state.problems.push(format!("part after completion {path}"));
                return (404, Vec::new(), b"{}".to_vec());
            }
            upload.parts.insert(number, (etag.clone(), body));
            return (
                200,
                vec![("ETag".into(), format!("\"{etag}\""))],
                Vec::new(),
            );
        }
        if head.method == "PUT" && path.starts_with("/s3/") {
            state.objects.insert(path["/s3/".len()..].to_string(), body);
            return (200, Vec::new(), Vec::new());
        }

        if head.headers.get("authorization").map(String::as_str)
            != Some(format!("Bearer {API_KEY}").as_str())
        {
            state
                .problems
                .push(format!("unauthenticated {} {path}", head.method));
            return (401, Vec::new(), b"{}".to_vec());
        }
        let request: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        let query = head
            .query
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect::<HashMap<_, _>>();
        let text = |value: &Value, key: &str| {
            value
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        let reply =
            |status: u16, value: Value| (status, Vec::new(), value.to_string().into_bytes());
        match (head.method.as_str(), path) {
            ("GET", "/api/desktop/video/new-id") => {
                state.next_id += 1;
                reply(
                    200,
                    json!({ "id": format!("verifyvideo{:04}", state.next_id) }),
                )
            }
            ("GET", "/api/desktop/video/create") => {
                let id = query.get("videoId").cloned().unwrap_or_else(|| {
                    state.next_id += 1;
                    format!("verifyvideo{:04}", state.next_id)
                });
                state.created.push(id.clone());
                reply(200, json!({ "id": id }))
            }
            ("POST", "/api/upload/multipart/initiate") => {
                state.next_id += 1;
                let upload_id = format!("upload{:04}", state.next_id);
                state.uploads.insert(
                    upload_id.clone(),
                    Multipart {
                        video_id: text(&request, "videoId"),
                        ..Default::default()
                    },
                );
                reply(200, json!({ "uploadId": upload_id }))
            }
            ("POST", "/api/upload/multipart/presign-part") => {
                let upload_id = text(&request, "uploadId");
                let number = request.get("partNumber").and_then(Value::as_u64);
                if !state.uploads.contains_key(&upload_id) || number.is_none() {
                    state.problems.push(format!("bad presign {request}"));
                    return reply(404, json!({}));
                }
                reply(
                    200,
                    json!({ "presignedUrl": format!("{}/s3mp/{upload_id}/{}", self.url, number.unwrap()) }),
                )
            }
            ("POST", "/api/upload/multipart/complete") => {
                let upload_id = text(&request, "uploadId");
                let listed = request
                    .get("parts")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let Some(upload) = state.uploads.get(&upload_id) else {
                    state
                        .problems
                        .push(format!("complete for unknown upload {upload_id}"));
                    return reply(404, json!({}));
                };
                let mut problems = Vec::new();
                let mut object = Vec::new();
                for (position, part) in listed.iter().enumerate() {
                    let number = part.get("partNumber").and_then(Value::as_u64).unwrap_or(0);
                    if number != position as u64 + 1 {
                        problems.push(format!("part {number} listed at {position}"));
                    }
                    match upload.parts.get(&(number as u32)) {
                        Some((etag, bytes))
                            if Some(etag.as_str()) == part.get("etag").and_then(Value::as_str) =>
                        {
                            if part.get("size").and_then(Value::as_u64) != Some(bytes.len() as u64)
                            {
                                problems.push(format!("part {number} size mismatch"));
                            }
                            object.extend_from_slice(bytes);
                        }
                        Some(_) => problems.push(format!("part {number} etag mismatch")),
                        None => problems.push(format!("part {number} missing")),
                    }
                }
                if upload.parts.len() != listed.len() {
                    problems.push(format!(
                        "{} parts stored, {} listed",
                        upload.parts.len(),
                        listed.len()
                    ));
                }
                if !problems.is_empty() {
                    state.problems.extend(problems);
                    return reply(400, json!({ "error": "invalid parts" }));
                }
                state
                    .objects
                    .insert(format!("{}/result.mp4", upload.video_id), object);
                state.uploads.get_mut(&upload_id).unwrap().completed = true;
                reply(200, json!({ "success": true }))
            }
            ("POST", "/api/upload/multipart/abort") => {
                if let Some(upload) = state.uploads.get_mut(&text(&request, "uploadId")) {
                    upload.aborted = true;
                }
                reply(200, json!({ "success": true }))
            }
            ("POST", "/api/upload/signed") => {
                let url = format!(
                    "{}/s3/{}/{}",
                    self.url,
                    text(&request, "videoId"),
                    text(&request, "subpath")
                );
                reply(
                    200,
                    json!({ "presignedPutData": { "url": url, "headers": {} } }),
                )
            }
            ("POST", "/api/upload/signed/batch") => {
                let video_id = text(&request, "videoId");
                let urls = request
                    .get("subpaths")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(|subpath| {
                        (
                            subpath.to_string(),
                            Value::String(format!("{}/s3/{video_id}/{subpath}", self.url)),
                        )
                    })
                    .collect::<serde_json::Map<_, _>>();
                reply(200, json!({ "urls": urls }))
            }
            ("POST", "/api/recording/prepare") => reply(404, json!({ "error": "not found" })),
            ("POST", "/api/upload/recording-complete") => {
                state.confirmations.push(request.clone());
                let video_id = text(&request, "videoId");
                let Some(verification) = request.get("verification") else {
                    return reply(200, json!({ "success": true }));
                };
                match state.verify_segments(&video_id, verification) {
                    Ok(receipt) => reply(
                        200,
                        json!({ "success": true, "status": "verified", "verification": receipt }),
                    ),
                    Err(problem) => {
                        state.problems.push(problem);
                        reply(409, json!({ "status": "reupload-required" }))
                    }
                }
            }
            ("DELETE", "/api/desktop/video/delete") => {
                state.deletes += 1;
                if let Some(id) = query.get("videoId") {
                    state.deleted.push(id.clone());
                }
                reply(200, json!({ "success": true }))
            }
            _ => {
                state
                    .problems
                    .push(format!("unknown route {} {path}", head.method));
                reply(404, json!({}))
            }
        }
    }
}

fn is_metadata_object(path: &str) -> bool {
    path.ends_with("/manifest.json") || path.ends_with("/recording.json")
}

impl MockState {
    fn useful_bytes(&self) -> u64 {
        self.objects
            .iter()
            .filter(|(key, _)| !is_metadata_object(key))
            .map(|(_, object)| object.len() as u64)
            .sum()
    }

    fn verify_segments(&self, video_id: &str, verification: &Value) -> Result<Value, String> {
        let claimed: UploadVerification = serde_json::from_value(verification.clone())
            .map_err(|error| format!("unreadable verification: {error}"))?;
        let stored = self
            .objects
            .get(&format!("{video_id}/segments/manifest.json"))
            .ok_or("verification without a stored manifest")?;
        if UploadVerification::segments(stored, claimed.required_audio) != claimed {
            return Err("verification does not match the stored manifest".into());
        }
        let manifest: SegmentUploadManifest =
            serde_json::from_slice(stored).map_err(|error| error.to_string())?;
        if !manifest.is_complete || !manifest.video_init_uploaded {
            return Err("stored manifest is not complete".into());
        }
        let mut keys = vec!["segments/video/init.mp4".to_string()];
        if manifest.audio_init_uploaded {
            keys.push("segments/audio/init.mp4".into());
        }
        keys.extend(
            manifest
                .video_segments
                .iter()
                .map(|s| format!("segments/video/segment_{:03}.m4s", s.index)),
        );
        keys.extend(
            manifest
                .audio_segments
                .iter()
                .map(|s| format!("segments/audio/segment_{:03}.m4s", s.index)),
        );
        let mut size = 0;
        for key in keys {
            size += self
                .objects
                .get(&format!("{video_id}/{key}"))
                .ok_or_else(|| format!("manifest lists missing object {key}"))?
                .len() as u64;
        }
        Ok(json!({
            "version": 1,
            "videoId": video_id,
            "artifact": claimed.artifact,
            "fileSize": size,
            "duration": manifest.video_segments.iter().map(|s| s.duration).sum::<f64>(),
            "hasAudio": !manifest.audio_segments.is_empty(),
            "fullDecode": true,
            "requiredAudioVerified": claimed.required_audio && !manifest.audio_segments.is_empty(),
        }))
    }
}

async fn read_head(stream: &mut TcpStream, pending: &mut Vec<u8>) -> Option<Head> {
    let mut buffer = [0u8; 16 * 1024];
    let end = loop {
        if let Some(end) = pending.windows(4).position(|window| window == b"\r\n\r\n") {
            break end;
        }
        match stream.read(&mut buffer).await {
            Ok(0) | Err(_) => return None,
            Ok(read) => pending.extend_from_slice(&buffer[..read]),
        }
    };
    let text = String::from_utf8_lossy(&pending[..end]).into_owned();
    pending.drain(..end + 4);
    let mut lines = text.split("\r\n");
    let mut request = lines.next()?.split(' ');
    let method = request.next()?.to_string();
    let target = request.next()?;
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect();
    Some(Head {
        method,
        path: path.to_string(),
        query: query.to_string(),
        headers,
    })
}

async fn respond(
    stream: &mut TcpStream,
    status: u16,
    headers: &[(String, String)],
    body: &[u8],
) -> std::io::Result<()> {
    let mut response = format!(
        "HTTP/1.1 {status} Mock\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (name, value) in headers {
        response.push_str(&format!("{name}: {value}\r\n"));
    }
    response.push_str("\r\n");
    let mut bytes = response.into_bytes();
    bytes.extend_from_slice(body);
    stream.write_all(&bytes).await
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(super) fn noise(seed: u64, len: usize) -> Vec<u8> {
    let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    let mut bytes = Vec::with_capacity(len + 8);
    while bytes.len() < len {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        bytes.extend_from_slice(&state.to_le_bytes());
    }
    bytes.truncate(len);
    bytes
}

pub(super) struct Scratch(pub(super) PathBuf);

impl Scratch {
    pub(super) fn new(tag: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "cap-upload-verify-{tag}-{}",
            crate::store::new_uuid_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        Self(root)
    }

    /// Signs the test thread in to `server` through the thread-local store.
    pub(super) fn sign_in(&self, server: &str) {
        let path = self.0.join("store");
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({
                "general_settings": {
                    "serverUrl": server,
                    "enableNotifications": false,
                    "hasCompletedOnboarding": true,
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
        crate::store::set_test_tauri_store_path(Some(path));
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        crate::store::set_test_tauri_store_path(None);
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(super) fn write_thumbnail(path: &Path) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    image::RgbImage::from_fn(64, 36, |x, y| {
        image::Rgb([(x * 4) as u8, (y * 7) as u8, 90])
    })
    .save(path)
    .unwrap();
}

fn studio_project(root: &Path) -> PathBuf {
    let project = root.join("share.cap");
    std::fs::create_dir_all(project.join("output")).unwrap();
    std::fs::write(
        project.join("recording-meta.json"),
        r#"{"pretty_name":"Upload verify","sharing":null,"segments":[{"display":{"path":"content/segments/segment-0/display.mp4","fps":30}}]}"#,
    )
    .unwrap();
    let mut file = SAMPLE_MP4.to_vec();
    let pad = STUDIO_SIZE - file.len();
    file.extend_from_slice(&(pad as u32).to_be_bytes());
    file.extend_from_slice(b"free");
    file.extend(noise(0x5743_4150, pad - 8));
    std::fs::write(project.join("output/result.mp4"), file).unwrap();
    write_thumbnail(&project.join("screenshots/display.jpg"));
    project
}

/// A fragmented-MP4-shaped segment: a `moof` box then an `mdat` box, sized
/// and filled deterministically.
fn fragment(seed: u64, size: usize) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(size);
    bytes.extend_from_slice(&32u32.to_be_bytes());
    bytes.extend_from_slice(b"moof");
    bytes.extend(noise(seed, 24));
    bytes.extend_from_slice(&((size - 32) as u32).to_be_bytes());
    bytes.extend_from_slice(b"mdat");
    bytes.extend(noise(seed ^ 0xA5A5, size - 40));
    bytes
}

/// Writes `content/display` and `content/audio` the way the Instant recorder
/// leaves them and returns their segment events, init first.
pub(super) fn instant_tracks(
    project: &Path,
    pairs: u32,
) -> (Vec<SegmentCompletedEvent>, Vec<SegmentCompletedEvent>) {
    let track = |name: &str, media: SegmentMediaType, size: usize, version: u32, kind: &str| {
        let dir = project.join("content").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let init = dir.join("init.mp4");
        std::fs::write(&init, SAMPLE_MP4).unwrap();
        let mut events = vec![SegmentCompletedEvent {
            path: init,
            index: 0,
            duration: 0.0,
            file_size: SAMPLE_MP4.len() as u64,
            is_init: true,
            media_type: media,
        }];
        let mut listed = Vec::new();
        for index in 1..=pairs {
            let bytes = fragment(
                u64::from(index) * 2 + (media == SegmentMediaType::Audio) as u64,
                size + index as usize * 7,
            );
            let path = dir.join(format!("segment_{index:03}.m4s"));
            std::fs::write(&path, &bytes).unwrap();
            listed.push(json!({
                "path": format!("segment_{index:03}.m4s"),
                "index": index,
                "duration": 2.0,
                "is_complete": true,
                "file_size": bytes.len(),
            }));
            events.push(SegmentCompletedEvent {
                path,
                index,
                duration: 2.0,
                file_size: bytes.len() as u64,
                is_init: false,
                media_type: media,
            });
        }
        std::fs::write(
            dir.join("manifest.json"),
            serde_json::to_vec(&json!({
                "version": version,
                "type": kind,
                "init_segment": "init.mp4",
                "segments": listed,
                "is_complete": true,
            }))
            .unwrap(),
        )
        .unwrap();
        events
    };
    (
        track(
            "display",
            SegmentMediaType::Video,
            VIDEO_SEGMENT,
            5,
            "m4s_segments",
        ),
        track(
            "audio",
            SegmentMediaType::Audio,
            AUDIO_SEGMENT,
            2,
            "m4s_audio_segments",
        ),
    )
}

pub(super) fn expected_manifest(
    video: &[SegmentCompletedEvent],
    audio: &[SegmentCompletedEvent],
) -> SegmentUploadManifest {
    let mut manifest = SegmentUploadManifest::default();
    for event in video.iter().chain(audio) {
        manifest.record(event);
    }
    manifest.is_complete = true;
    manifest
}

/// Every local segment is stored byte for byte and the final manifest lists
/// exactly the local recording.
pub(super) fn assert_segments_stored(
    mock: &MockCap,
    video_id: &str,
    video: &[SegmentCompletedEvent],
    audio: &[SegmentCompletedEvent],
) {
    for event in video.iter().chain(audio) {
        let key = format!("{video_id}/{}", segment_subpath(event));
        let stored = mock.object(&key);
        assert!(
            stored.as_deref() == Some(std::fs::read(&event.path).unwrap().as_slice()),
            "{key} is missing or differs from the local file"
        );
    }
    let manifest: SegmentUploadManifest = serde_json::from_slice(
        &mock
            .object(&format!("{video_id}/segments/manifest.json"))
            .expect("no manifest uploaded"),
    )
    .unwrap();
    assert_eq!(manifest, expected_manifest(video, audio));
}

struct StudioRun {
    result: Result<UploadResult, String>,
    progress: Vec<f64>,
}

async fn share(project: &Path, cancel: Arc<AtomicBool>) -> StudioRun {
    let progress = Arc::new(Mutex::new(Vec::new()));
    let sink = progress.clone();
    let result = upload_exported_video(
        project.to_path_buf(),
        None,
        move |value| sink.lock().unwrap().push(value),
        cancel,
    )
    .await;
    let progress = progress.lock().unwrap().clone();
    assert!(
        progress.first() == Some(&0.0)
            && progress.windows(2).all(|pair| pair[1] >= pair[0])
            && progress.iter().all(|value| (0.0..=1.0).contains(value)),
        "progress is not monotonic within 0..=1: {progress:?}"
    );
    // 100% means shared: only the final report after completion may be 1.0.
    assert!(
        progress
            .split_last()
            .is_none_or(|(_, earlier)| earlier.iter().all(|value| *value < 1.0))
            && (result.is_ok() || progress.iter().all(|value| *value < 1.0)),
        "progress reached 100% before the upload completed: {progress:?}"
    );
    StudioRun { result, progress }
}

fn assert_shared(mock: &MockCap, project: &Path, run: &StudioRun) {
    let meta = RecordingMeta::load_for_project(project).unwrap();
    let sharing = meta.sharing.as_ref().expect("no sharing state persisted");
    assert_eq!(
        run.result,
        Ok(UploadResult::Success(format!(
            "{}/s/{}",
            mock.url, sharing.id
        )))
    );
    assert_eq!(run.progress.last(), Some(&1.0));
    assert!(matches!(meta.upload, Some(UploadMeta::Complete)));
    let local = std::fs::read(project.join("output/result.mp4")).unwrap();
    let stored = mock
        .object(&format!("{}/result.mp4", sharing.id))
        .expect("no object stored");
    assert!(
        stored == local,
        "stored object ({} bytes, sha256 {}) differs from the local file ({} bytes, sha256 {})",
        stored.len(),
        to_hex(&Sha256::digest(&stored)),
        local.len(),
        to_hex(&Sha256::digest(&local)),
    );
    assert!(
        mock.object(&format!("{}/screenshot/screen-capture.jpg", sharing.id))
            .is_some_and(|thumbnail| thumbnail.starts_with(&[0xFF, 0xD8])),
        "no JPEG thumbnail stored"
    );
    mock.assert_clean();
}

fn assert_share_failed(project: &Path, run: &StudioRun, error: &str) {
    let failure = run
        .result
        .as_ref()
        .expect_err("share unexpectedly succeeded");
    assert!(failure.contains(error), "unexpected error: {failure}");
    let meta = RecordingMeta::load_for_project(project).unwrap();
    assert!(
        matches!(meta.upload, Some(UploadMeta::SinglePartUpload { .. })),
        "the reserved video id must stay persisted for a retry: {:?}",
        meta.upload
    );
    assert!(meta.sharing.is_none());
}

fn studio_case(
    case: &str,
    rules: Vec<Rule>,
    budget: Budget,
    check: impl FnOnce(&MockCap, &Path, StudioRun),
) {
    ffmpeg::init().unwrap();
    let scratch = Scratch::new(case);
    virtual_time(async {
        let mock = MockCap::start(rules).await;
        scratch.sign_in(&mock.url);
        let project = studio_project(&scratch.0);
        let started = tokio::time::Instant::now();
        let run = share(&project, Arc::new(AtomicBool::new(false))).await;
        eprintln!("upload-verify {case}: virtual {:?}", started.elapsed());
        check(&mock, &project, run);
        check_budget(case, &mock, budget);
    });
}

#[test]
fn studio_share_clean() {
    studio_case(
        "studio_share_clean",
        Vec::new(),
        budget::STUDIO_SHARE_CLEAN,
        |mock, project, run| {
            assert_shared(mock, project, &run);
            assert_eq!(mock.count("PUT", "/s3mp/"), 6);
        },
    );
}

#[test]
fn studio_share_part_503_retries_the_part_at_the_end() {
    studio_case(
        "studio_share_part_503",
        vec![rule(Route::Part(3), Fault::Status(503))],
        budget::STUDIO_SHARE_PART_503,
        |mock, project, run| assert_shared(mock, project, &run),
    );
}

#[test]
fn studio_share_reset_mid_part_retries_in_place() {
    studio_case(
        "studio_share_reset_mid_part",
        vec![rule(Route::Part(4), Fault::Reset(0.5))],
        budget::STUDIO_SHARE_RESET_MID_PART,
        |mock, project, run| assert_shared(mock, project, &run),
    );
}

/// The network drops while part 2 is half sent and stays down for 5 s. Main
/// has only that part in flight, so it loses half a part and retries it after
/// the outage (2 s, then 4 s backoff).
#[test]
fn studio_share_outage_mid_part() {
    studio_case(
        "studio_share_outage_mid_part",
        vec![rule(
            Route::Part(2),
            Fault::Outage(0.5, Duration::from_secs(5)),
        )],
        budget::STUDIO_SHARE_OUTAGE_MID_PART,
        |mock, project, run| {
            assert_shared(mock, project, &run);
            assert!(mock.stats().reset_on_accept >= 1);
        },
    );
}

#[test]
fn studio_share_presign_500_retries_the_part_at_the_end() {
    studio_case(
        "studio_share_presign_500",
        vec![Rule {
            skip: 3,
            ..rule(Route::Api("multipart/presign-part"), Fault::Status(500))
        }],
        budget::STUDIO_SHARE_PRESIGN_500,
        |mock, project, run| assert_shared(mock, project, &run),
    );
}

/// A part whose response never arrives hits the 5 minute request timeout
/// (virtual) and is retried in place.
#[test]
fn studio_share_hung_part_times_out_and_retries() {
    studio_case(
        "studio_share_hung_part",
        vec![rule(Route::Part(5), Fault::Hang)],
        budget::STUDIO_SHARE_HUNG_PART,
        |mock, project, run| assert_shared(mock, project, &run),
    );
}

#[test]
fn studio_share_slow_part_costs_nothing_extra() {
    studio_case(
        "studio_share_slow_part",
        vec![rule(Route::Part(3), Fault::Delay(Duration::from_secs(40)))],
        budget::STUDIO_SHARE_SLOW_PART,
        |mock, project, run| assert_shared(mock, project, &run),
    );
}

#[test]
fn studio_share_permanent_403_fails_with_the_part_error() {
    studio_case(
        "studio_share_permanent_403",
        vec![rule(Route::Part(2), Fault::Status(403)).times(u32::MAX)],
        budget::STUDIO_SHARE_PERMANENT_403,
        |mock, project, run| {
            assert_share_failed(project, &run, "uploader/part/2/status/403");
            assert_eq!(mock.count("POST", "multipart/complete"), 0);
            mock.assert_clean();
        },
    );
}

#[test]
fn studio_share_complete_500_fails_and_keeps_the_video_id() {
    studio_case(
        "studio_share_complete_500",
        vec![rule(Route::Api("multipart/complete"), Fault::Status(500))],
        budget::STUDIO_SHARE_COMPLETE_500,
        |mock, project, run| {
            assert_share_failed(project, &run, "upload_multipart_complete/500");
            mock.assert_clean();
        },
    );
}

/// Cancel (or quit) while part 3 is half sent, then share again. The second
/// attempt reuses the persisted video id and starts a new multipart upload.
#[test]
fn studio_share_cancel_then_resume_reuses_the_persisted_video() {
    ffmpeg::init().unwrap();
    let case = "studio_share_cancel_then_resume";
    let scratch = Scratch::new(case);
    virtual_time(async {
        let mock = MockCap::start(vec![rule(Route::Part(3), Fault::Trip(0.5))]).await;
        scratch.sign_in(&mock.url);
        let project = studio_project(&scratch.0);
        let first = share(&project, mock.cancel_flag()).await;
        assert_share_failed(&project, &first, "Export cancelled");
        let reserved = match RecordingMeta::load_for_project(&project).unwrap().upload {
            Some(UploadMeta::SinglePartUpload { video_id, .. }) => video_id,
            other => panic!("unexpected upload state {other:?}"),
        };
        let second = share(&project, Arc::new(AtomicBool::new(false))).await;
        assert_shared(&mock, &project, &second);
        assert_eq!(
            RecordingMeta::load_for_project(&project)
                .unwrap()
                .sharing
                .unwrap()
                .id,
            reserved
        );
        assert_eq!(mock.count("GET", "video/new-id"), 1);
        check_budget(case, &mock, budget::STUDIO_SHARE_CANCEL_THEN_RESUME);
    });
}

/// Feeds the recorder's segment events on a fixed virtual schedule: both init
/// segments at 0 s, then audio segment k at 2k s and video segment k at
/// 2k + 0.6 s, so no two segments are in flight at the same moment unless a
/// retry puts them there.
async fn feed(
    video: Vec<SegmentCompletedEvent>,
    audio: Vec<SegmentCompletedEvent>,
    events: flume::Sender<SegmentCompletedEvent>,
) {
    let start = tokio::time::Instant::now();
    let _ = events.send(video[0].clone());
    let _ = events.send(audio[0].clone());
    for k in 1..video.len() {
        let at = start + Duration::from_secs(2 * k as u64);
        tokio::time::sleep_until(at).await;
        let _ = events.send(audio[k].clone());
        tokio::time::sleep_until(at + Duration::from_millis(600)).await;
        let _ = events.send(video[k].clone());
    }
}

struct InstantRun {
    result: Result<(), String>,
    elapsed: Duration,
    video: Vec<SegmentCompletedEvent>,
    audio: Vec<SegmentCompletedEvent>,
}

fn instant_case(
    case: &str,
    rules: Vec<Rule>,
    budget: Budget,
    check: impl FnOnce(&MockCap, InstantRun),
) {
    let scratch = Scratch::new(case);
    virtual_time(async {
        let mock = MockCap::start(rules).await;
        scratch.sign_in(&mock.url);
        let (video, audio) = instant_tracks(&scratch.0, INSTANT_PAIRS);
        let (sender, events) = flume::unbounded();
        let feeder = tokio::spawn(feed(video.clone(), audio.clone(), sender));
        let started = tokio::time::Instant::now();
        let result = upload_segments(
            &LiveSegmentTransport,
            INSTANT_VIDEO_ID,
            events,
            mock.cancel_flag(),
            None,
        )
        .await;
        let elapsed = started.elapsed();
        eprintln!("upload-verify {case}: virtual {elapsed:?}");
        feeder.abort();
        check(
            &mock,
            InstantRun {
                result,
                elapsed,
                video,
                audio,
            },
        );
        check_budget(case, &mock, budget);
    });
}

fn assert_instant_complete(mock: &MockCap, run: &InstantRun) {
    assert_eq!(run.result, Ok(()));
    assert_segments_stored(mock, INSTANT_VIDEO_ID, &run.video, &run.audio);
    let confirmations = mock.confirmations();
    assert_eq!(confirmations.len(), 1, "{confirmations:?}");
    assert_eq!(confirmations[0], json!({ "videoId": INSTANT_VIDEO_ID }));
    mock.assert_clean();
}

#[test]
fn instant_live_clean() {
    instant_case(
        "instant_live_clean",
        Vec::new(),
        budget::INSTANT_LIVE_CLEAN,
        |mock, run| {
            assert_instant_complete(mock, &run);
        },
    );
}

#[test]
fn instant_live_segment_503_retries_in_call() {
    instant_case(
        "instant_live_segment_503",
        vec![rule(
            Route::Object("segments/video/segment_003"),
            Fault::Status(503),
        )],
        budget::INSTANT_LIVE_SEGMENT_503,
        |mock, run| assert_instant_complete(mock, &run),
    );
}

/// Three 503s exhaust the in-call attempts; the segment is deferred and
/// retried in place instead of failing the live upload.
#[test]
fn instant_live_segment_503_three_times_is_deferred_not_fatal() {
    instant_case(
        "instant_live_segment_503x3",
        vec![
            rule(
                Route::Object("segments/video/segment_003"),
                Fault::Status(503),
            )
            .times(3),
        ],
        budget::INSTANT_LIVE_SEGMENT_503X3,
        |mock, run| assert_instant_complete(mock, &run),
    );
}

#[test]
fn instant_live_segment_reset_mid_body() {
    instant_case(
        "instant_live_segment_reset",
        vec![
            rule(
                Route::Object("segments/video/segment_004"),
                Fault::Reset(0.5),
            )
            .times(3),
        ],
        budget::INSTANT_LIVE_SEGMENT_RESET,
        |mock, run| assert_instant_complete(mock, &run),
    );
}

#[test]
fn instant_live_deferred_retries_back_off_after_recording_ends() {
    let scratch = Scratch::new("instant_live_deferred_retries_back_off");
    virtual_time(async {
        let mock = MockCap::start(vec![
            rule(
                Route::Object("segments/video/segment_008"),
                Fault::Status(503),
            )
            .times(12),
        ])
        .await;
        scratch.sign_in(&mock.url);
        let (video, audio) = instant_tracks(&scratch.0, INSTANT_PAIRS);
        let (sender, events) = flume::unbounded();
        let feeder = tokio::spawn(feed(video.clone(), audio.clone(), sender));
        let result = upload_segments(
            &LiveSegmentTransport,
            INSTANT_VIDEO_ID,
            events,
            mock.cancel_flag(),
            None,
        )
        .await;
        feeder.await.unwrap();
        assert_eq!(result, Ok(()));
        assert_segments_stored(&mock, INSTANT_VIDEO_ID, &video, &audio);
        assert_eq!(mock.confirmations().len(), 1);
        let attempts = mock
            .lock()
            .requests
            .iter()
            .filter(|(method, path, ..)| {
                method == "PUT" && path.ends_with("segments/video/segment_008.m4s")
            })
            .map(|(_, _, status, at)| (*status, *at))
            .collect::<Vec<_>>();
        assert_eq!(attempts.len(), 13, "{}", mock.timeline());
        assert!(attempts[..12].iter().all(|(status, _)| *status == 503));
        assert_eq!(attempts[12].0, 200);
        for (round, seconds) in [2, 4, 8, 16].into_iter().enumerate() {
            let last_failure = attempts[round * 3 + 2].1;
            let next_attempt = attempts[round * 3 + 3].1;
            assert!(
                next_attempt.saturating_sub(last_failure) >= Duration::from_secs(seconds),
                "deferred retry round {round} did not wait {seconds}s:\n{}",
                mock.timeline()
            );
        }
        mock.assert_clean();
    });
}

/// The network drops while video segment 3 is half sent and stays down for
/// 5.7 s, past the in-call attempts. The live upload survives it.
#[test]
fn instant_live_outage_mid_segment() {
    instant_case(
        "instant_live_outage",
        vec![rule(
            Route::Object("segments/video/segment_003"),
            Fault::Outage(0.5, Duration::from_millis(5_700)),
        )],
        budget::INSTANT_LIVE_OUTAGE,
        |mock, run| {
            assert_instant_complete(mock, &run);
            assert!(mock.stats().reset_on_accept >= 1);
        },
    );
}

#[test]
fn instant_live_slow_segment() {
    instant_case(
        "instant_live_slow_segment",
        vec![rule(
            Route::Object("segments/video/segment_002"),
            Fault::Delay(Duration::from_millis(9_300)),
        )],
        budget::INSTANT_LIVE_SLOW_SEGMENT,
        |mock, run| assert_instant_complete(mock, &run),
    );
}

/// An outage that outlasts the 5 minute retry window fails the live upload
/// with the first failure once the window has passed, leaving the rest to the
/// queue.
#[test]
fn instant_live_outage_past_the_retry_window_fails() {
    instant_case(
        "instant_live_outage_past_window",
        vec![rule(
            Route::Object("segments/video/segment_003"),
            Fault::Outage(0.5, Duration::from_secs(6 * 60)),
        )],
        budget::INSTANT_LIVE_OUTAGE_PAST_WINDOW,
        |mock, run| {
            let error = run.result.expect_err("upload outlived its retry window");
            assert!(
                error.contains("segments/video/segment_003.m4s"),
                "unexpected error: {error}"
            );
            assert!(
                (RETRY_WINDOW..RETRY_WINDOW + Duration::from_secs(30)).contains(&run.elapsed),
                "gave up after {:?}, not once the retry window had passed",
                run.elapsed
            );
            assert!(mock.confirmations().is_empty());
            mock.assert_clean();
        },
    );
}

#[test]
fn instant_live_permanent_403_is_fatal() {
    instant_case(
        "instant_live_permanent_403",
        vec![
            rule(
                Route::Object("segments/video/segment_003"),
                Fault::Status(403),
            )
            .times(u32::MAX),
        ],
        budget::INSTANT_LIVE_PERMANENT_403,
        |mock, run| {
            let error = run.result.expect_err("a 403 must not be retried forever");
            assert!(
                error.contains("segment_003.m4s") && error.contains("403"),
                "unexpected error: {error}"
            );
            assert!(mock.confirmations().is_empty());
            mock.assert_clean();
        },
    );
}

#[test]
fn instant_live_cancel_stops_without_completing() {
    instant_case(
        "instant_live_cancel",
        vec![rule(
            Route::Object("segments/video/segment_004"),
            Fault::Trip(0.5),
        )],
        budget::INSTANT_LIVE_CANCEL,
        |mock, run| {
            assert_eq!(
                run.result,
                Err("Instant recording upload cancelled".to_string())
            );
            assert!(mock.confirmations().is_empty());
            assert_eq!(mock.count("PUT", "segments/video/segment_005"), 0);
            mock.assert_clean();
        },
    );
}

#[test]
fn instant_live_completion_signal_retries() {
    instant_case(
        "instant_live_completion_500",
        vec![rule(Route::Api("recording-complete"), Fault::Status(500)).times(2)],
        budget::INSTANT_LIVE_COMPLETION_500,
        |mock, run| {
            assert_eq!(run.result, Ok(()));
            assert_segments_stored(mock, INSTANT_VIDEO_ID, &run.video, &run.audio);
            assert_eq!(mock.count("POST", "recording-complete"), 3);
            mock.assert_clean();
        },
    );
}
