use super::*;
use std::collections::HashSet;
use std::sync::atomic::AtomicUsize;

struct TempExport(PathBuf);

impl TempExport {
    fn new(bytes: &[u8]) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "cap-gpui-multipart-{}-{}.mp4",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::AcqRel),
        ));
        std::fs::write(&path, bytes).unwrap();
        Self(path)
    }
}

impl Drop for TempExport {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn export_bytes(len: usize) -> Vec<u8> {
    (0..len).map(|index| (index * 7 % 251) as u8).collect()
}

struct InFlight<'a>(&'a AtomicUsize);

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

const S3_URL: &str = "https://cap-test.s3.us-east-1.amazonaws.com/export.mp4?partNumber=";
const DRIVE_URL: &str =
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=";

#[derive(Default)]
struct FakeParts {
    /// Every part PUT in start order, with the bytes it sent.
    started: Mutex<Vec<(u32, u64, Vec<u8>)>>,
    /// (event, part) in order: "presign", "presigned", "put".
    events: Mutex<Vec<(&'static str, u32)>>,
    /// PUTs in flight when each part's PUT started, itself included.
    put_in_flight: Mutex<Vec<(u32, usize)>>,
    in_flight: AtomicUsize,
    max_in_flight: AtomicUsize,
    fail_once: Mutex<HashSet<u32>>,
    fail_always: HashSet<u32>,
    hang_from: Option<u32>,
    drive_from: Option<u32>,
    presign_delay: Duration,
}

impl FakeParts {
    fn started_parts(&self) -> Vec<u32> {
        self.started
            .lock()
            .unwrap()
            .iter()
            .map(|(part, _, _)| *part)
            .collect()
    }

    fn event_index(&self, event: &str, part: u32) -> usize {
        self.events
            .lock()
            .unwrap()
            .iter()
            .position(|entry| *entry == (event, part))
            .unwrap()
    }
}

impl PartTransport for FakeParts {
    async fn presign(
        &self,
        chunk: &PartChunk,
        _cancel: &AtomicBool,
    ) -> Result<PresignedPart, AuthApiError> {
        self.events
            .lock()
            .unwrap()
            .push(("presign", chunk.part_number));
        if !self.presign_delay.is_zero() {
            tokio::time::sleep(self.presign_delay).await;
        }
        self.events
            .lock()
            .unwrap()
            .push(("presigned", chunk.part_number));
        let base = if self
            .drive_from
            .is_some_and(|from| chunk.part_number >= from)
        {
            DRIVE_URL
        } else {
            S3_URL
        };
        Ok(PresignedPart {
            url: format!("{base}{}", chunk.part_number),
            md5: None,
        })
    }

    async fn put(
        &self,
        _presigned: &PresignedPart,
        chunk: &PartChunk,
        _total_size: u64,
        _cancel: &AtomicBool,
    ) -> Result<UploadedPart, AuthApiError> {
        self.events.lock().unwrap().push(("put", chunk.part_number));
        self.started
            .lock()
            .unwrap()
            .push((chunk.part_number, chunk.offset, chunk.bytes.to_vec()));
        let now = self.in_flight.fetch_add(1, Ordering::AcqRel) + 1;
        let _guard = InFlight(&self.in_flight);
        self.max_in_flight.fetch_max(now, Ordering::AcqRel);
        self.put_in_flight
            .lock()
            .unwrap()
            .push((chunk.part_number, now));
        if self.hang_from.is_some_and(|from| chunk.part_number >= from) {
            std::future::pending::<()>().await;
        }
        // Later parts in each window finish first, so completions arrive out of order.
        tokio::time::sleep(Duration::from_millis(u64::from(4 - chunk.part_number % 4))).await;
        if self.fail_always.contains(&chunk.part_number)
            || self.fail_once.lock().unwrap().remove(&chunk.part_number)
        {
            return Err(AuthApiError::Other(format!(
                "uploader/part/{}/status/500",
                chunk.part_number
            )));
        }
        Ok(UploadedPart {
            part_number: chunk.part_number,
            etag: format!("etag-{}", chunk.part_number),
            size: chunk.bytes.len(),
            object_identity: None,
        })
    }
}

fn s3() -> PartConcurrency {
    PartConcurrency::new(false, MAX_CONCURRENT_PARTS)
}

async fn run(
    transport: &impl PartTransport,
    export: &TempExport,
    chunk_size: u64,
    concurrency: PartConcurrency,
    cancel: &AtomicBool,
    source: Option<&mut ReplacementUploadSource>,
) -> (Result<Vec<UploadedPart>, AuthApiError>, Vec<f64>) {
    let progress = Mutex::new(Vec::new());
    let size = std::fs::metadata(&export.0).unwrap().len();
    let result = upload_file_parts(
        transport,
        &export.0,
        size,
        chunk_size,
        concurrency,
        &|value| progress.lock().unwrap().push(value),
        cancel,
        source,
    )
    .await;
    (result, progress.into_inner().unwrap())
}

/// Compares the exact JSON `multipart_complete` sends for these parts.
fn assert_parts(parts: &[UploadedPart], sizes: &[usize]) {
    let expected = sizes
        .iter()
        .enumerate()
        .map(|(index, size)| {
            json!({ "partNumber": index + 1, "etag": format!("etag-{}", index + 1), "size": size })
        })
        .collect::<Vec<_>>();
    assert_eq!(serde_json::to_value(parts).unwrap(), Value::Array(expected));
}

#[test]
fn part_concurrency_follows_the_initiate_response_and_every_presigned_url() {
    const { assert!(MAX_CONCURRENT_PARTS > 1) };
    let s3_url = format!("{S3_URL}1");
    let drive_url = format!("{DRIVE_URL}1");

    let drive = PartConcurrency::new(true, MAX_CONCURRENT_PARTS);
    assert_eq!(drive.limit(), 1);
    drive.observe_url(&s3_url);
    assert_eq!(drive.limit(), 1);

    let unknown = s3();
    assert_eq!(unknown.limit(), 1);
    unknown.observe_url(&s3_url);
    assert_eq!(unknown.limit(), MAX_CONCURRENT_PARTS);
    unknown.observe_url(&drive_url);
    assert_eq!(unknown.limit(), 1);
    unknown.observe_url(&s3_url);
    assert_eq!(unknown.limit(), 1);

    let drive_url_first = s3();
    drive_url_first.observe_url(&drive_url);
    assert_eq!(drive_url_first.limit(), 1);
    drive_url_first.observe_url(&s3_url);
    assert_eq!(drive_url_first.limit(), 1);
}

#[tokio::test]
async fn parts_stay_one_at_a_time_until_the_first_presigned_url_is_known() {
    let export = TempExport::new(&export_bytes(40));
    let transport = FakeParts {
        presign_delay: Duration::from_millis(5),
        ..FakeParts::default()
    };
    let (result, _) = run(&transport, &export, 4, s3(), &AtomicBool::new(false), None).await;
    assert_parts(&result.unwrap(), &[4; 10]);
    // Part 1 alone until its URL is known, then the other three slots fill at once.
    assert_eq!(
        transport.events.lock().unwrap()[..6],
        [
            ("presign", 1),
            ("presigned", 1),
            ("put", 1),
            ("presign", 2),
            ("presign", 3),
            ("presign", 4),
        ]
    );
}

#[tokio::test]
async fn drive_urls_without_a_drive_initiate_upload_sequentially_with_serial_progress() {
    let export = TempExport::new(&export_bytes(18));
    let transport = FakeParts {
        drive_from: Some(1),
        ..FakeParts::default()
    };
    let (result, progress) = run(&transport, &export, 4, s3(), &AtomicBool::new(false), None).await;
    assert_parts(&result.unwrap(), &[4, 4, 4, 4, 2]);
    assert_eq!(transport.max_in_flight.load(Ordering::Acquire), 1);
    assert_eq!(
        *transport.events.lock().unwrap(),
        (1..=5)
            .flat_map(|part| [("presign", part), ("presigned", part), ("put", part)])
            .collect::<Vec<_>>()
    );
    assert_eq!(
        progress,
        [4.0 / 18.0, 8.0 / 18.0, 12.0 / 18.0, 16.0 / 18.0, 0.99]
    );
}

#[tokio::test]
async fn late_drive_url_drains_in_flight_parts_then_continues_one_at_a_time() {
    let export = TempExport::new(&export_bytes(48));
    let transport = FakeParts {
        drive_from: Some(6),
        ..FakeParts::default()
    };
    let (result, _) = run(&transport, &export, 4, s3(), &AtomicBool::new(false), None).await;
    assert_parts(&result.unwrap(), &[4; 12]);
    assert_eq!(transport.max_in_flight.load(Ordering::Acquire), 4);
    // At most MAX_CONCURRENT_PARTS parts (6 and up to three after it) can be in
    // flight when part 6's Drive URL arrives; every part after those is read
    // only once the in-flight parts have drained, and then runs alone.
    let first_after_switch = 6 + MAX_CONCURRENT_PARTS as u32;
    let switched = transport.event_index("presigned", 6);
    let put_in_flight = transport.put_in_flight.lock().unwrap();
    for part in first_after_switch..=12 {
        assert!(transport.event_index("presign", part) > switched);
        assert!(
            put_in_flight.contains(&(part, 1)),
            "part {part} overlapped: {put_in_flight:?}"
        );
    }
    assert_eq!(transport.started_parts(), (1..=12).collect::<Vec<_>>());
}

#[tokio::test]
async fn concurrent_parts_complete_sorted_with_bounded_in_flight() {
    let bytes = export_bytes(42);
    let export = TempExport::new(&bytes);
    let transport = FakeParts::default();
    let (result, _) = run(&transport, &export, 4, s3(), &AtomicBool::new(false), None).await;
    let parts = result.unwrap();
    let mut sizes = vec![4; 10];
    sizes.push(2);
    assert_parts(&parts, &sizes);
    assert_eq!(transport.max_in_flight.load(Ordering::Acquire), 4);
    assert_eq!(transport.in_flight.load(Ordering::Acquire), 0);
    assert_eq!(transport.started_parts(), (1..=11).collect::<Vec<_>>());
    for (part, offset, chunk) in transport.started.lock().unwrap().iter() {
        assert_eq!(*offset, u64::from(part - 1) * 4);
        let start = *offset as usize;
        assert_eq!(
            chunk.as_slice(),
            &bytes[start..(start + 4).min(bytes.len())]
        );
    }
}

#[tokio::test]
async fn drive_parts_upload_sequentially_in_order_with_serial_progress() {
    let export = TempExport::new(&export_bytes(18));
    let transport = FakeParts::default();
    let (result, progress) = run(
        &transport,
        &export,
        4,
        PartConcurrency::new(true, MAX_CONCURRENT_PARTS),
        &AtomicBool::new(false),
        None,
    )
    .await;
    assert_parts(&result.unwrap(), &[4, 4, 4, 4, 2]);
    assert_eq!(transport.max_in_flight.load(Ordering::Acquire), 1);
    assert_eq!(transport.started_parts(), [1, 2, 3, 4, 5]);
    assert_eq!(
        progress,
        [4.0 / 18.0, 8.0 / 18.0, 12.0 / 18.0, 16.0 / 18.0, 0.99]
    );
}

#[tokio::test]
async fn concurrent_progress_is_monotonic_and_reaches_the_serial_final_value() {
    let export = TempExport::new(&export_bytes(64));
    let transport = FakeParts::default();
    let (result, progress) = run(&transport, &export, 4, s3(), &AtomicBool::new(false), None).await;
    assert_eq!(result.unwrap().len(), 16);
    assert_eq!(progress.len(), 16);
    assert!(progress.windows(2).all(|pair| pair[0] <= pair[1]));
    assert_eq!(progress.last().copied(), Some(0.99));
}

#[tokio::test]
async fn failed_part_is_retried_after_the_rest_and_upload_completes() {
    let export = TempExport::new(&export_bytes(40));
    let transport = FakeParts {
        fail_once: Mutex::new(HashSet::from([3, 6])),
        ..FakeParts::default()
    };
    let (result, progress) = run(&transport, &export, 4, s3(), &AtomicBool::new(false), None).await;
    assert_parts(&result.unwrap(), &[4; 10]);
    let started = transport.started_parts();
    assert_eq!(started.len(), 12);
    assert_eq!(&started[10..], [3, 6]);
    assert_eq!(progress.last().copied(), Some(0.99));
    let retried = transport.started.lock().unwrap();
    assert_eq!(retried[10].2, retried[2].2);
}

#[tokio::test]
async fn part_failing_its_retry_returns_the_first_error() {
    let export = TempExport::new(&export_bytes(20));
    let transport = FakeParts {
        fail_always: HashSet::from([2]),
        ..FakeParts::default()
    };
    let (result, _) = run(&transport, &export, 4, s3(), &AtomicBool::new(false), None).await;
    assert_eq!(
        result.unwrap_err().to_string(),
        "uploader/part/2/status/500"
    );
    assert_eq!(transport.started_parts(), [1, 2, 3, 4, 5, 2]);
}

#[tokio::test]
async fn cancel_mid_upload_drops_in_flight_parts_and_starts_no_more() {
    let export = TempExport::new(&export_bytes(40));
    let transport = FakeParts {
        hang_from: Some(3),
        ..FakeParts::default()
    };
    let cancel = AtomicBool::new(false);
    let started = Instant::now();
    let (result, progress) =
        tokio::join!(run(&transport, &export, 4, s3(), &cancel, None), async {
            while transport.started_parts().len() < 6 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            cancel.store(true, Ordering::Release);
        })
        .0;
    assert!(result.unwrap_err().to_string().contains("Export cancelled"));
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(transport.started_parts(), [1, 2, 3, 4, 5, 6]);
    assert_eq!(transport.in_flight.load(Ordering::Acquire), 0);
    assert!(progress.windows(2).all(|pair| pair[0] <= pair[1]));
}

#[tokio::test]
async fn cancelled_before_start_reads_no_parts() {
    let export = TempExport::new(&export_bytes(40));
    let transport = FakeParts::default();
    let (result, progress) = run(&transport, &export, 4, s3(), &AtomicBool::new(true), None).await;
    assert!(result.unwrap_err().to_string().contains("Export cancelled"));
    assert!(transport.started_parts().is_empty());
    assert!(progress.is_empty());
}

#[tokio::test]
async fn concurrent_replacement_upload_checks_reads_in_order_and_seals() {
    let export = TempExport::new(&export_bytes(22));
    let mut source = ReplacementUploadSource::new(&export.0).unwrap();
    let transport = FakeParts::default();
    let (result, _) = run(
        &transport,
        &export,
        4,
        s3(),
        &AtomicBool::new(false),
        Some(&mut source),
    )
    .await;
    let parts = result.unwrap();
    assert_eq!(
        source
            .chunks
            .iter()
            .map(|chunk| (chunk.offset, chunk.size))
            .collect::<Vec<_>>(),
        [(0, 4), (4, 4), (8, 4), (12, 4), (16, 4), (20, 2)]
    );
    source.seal_parts(&parts).unwrap();

    let restarted = FakeParts::default();
    let (result, _) = run(
        &restarted,
        &export,
        4,
        s3(),
        &AtomicBool::new(false),
        Some(&mut source),
    )
    .await;
    assert_eq!(
        serde_json::to_value(result.unwrap()).unwrap(),
        serde_json::to_value(&parts).unwrap()
    );
    assert_eq!(restarted.max_in_flight.load(Ordering::Acquire), 4);

    std::fs::write(&export.0, &export_bytes(23)[1..]).unwrap();
    let changed = FakeParts::default();
    let (result, _) = run(
        &changed,
        &export,
        4,
        s3(),
        &AtomicBool::new(false),
        Some(&mut source),
    )
    .await;
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("Rendered video changed")
    );
    assert!(changed.started_parts().is_empty());
}

/// A loopback HTTP/1.1 server that serves presign and part PUT requests over
/// real sockets while modelling a WAN link: handshake round trips on every new
/// connection, per-connection slow start capped by a send window, one round
/// trip per request, and a link bandwidth shared by all connections.
mod mock_network {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::{TcpListener, TcpStream};

    const INITIAL_WINDOW: usize = 10 * 1460;

    #[derive(Clone, Copy)]
    pub(super) struct Profile {
        pub rtt: Duration,
        pub link_bytes_per_sec: f64,
        pub max_window: usize,
        pub handshake_rtts: u32,
        pub presign_server_time: Duration,
    }

    struct Link {
        profile: Profile,
        next_free: Mutex<std::time::Instant>,
    }

    impl Link {
        fn transmit(&self, bytes: usize) {
            let done = {
                let mut next_free = self.next_free.lock().unwrap();
                let start = (*next_free).max(std::time::Instant::now());
                *next_free =
                    start + Duration::from_secs_f64(bytes as f64 / self.profile.link_bytes_per_sec);
                *next_free
            };
            let now = std::time::Instant::now();
            if done > now {
                std::thread::sleep(done - now);
            }
        }
    }

    #[derive(Default)]
    pub(super) struct Recorded {
        pub received: Mutex<HashMap<u32, usize>>,
        /// Every part PUT in arrival order with its Content-Range header.
        pub puts: Mutex<Vec<(u32, Option<String>)>>,
        active_puts: AtomicUsize,
        pub max_active_puts: AtomicUsize,
    }

    pub(super) struct Server {
        pub addr: std::net::SocketAddr,
        pub connections: Arc<AtomicUsize>,
        pub recorded: Arc<Recorded>,
    }

    pub(super) fn start(profile: Profile) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let link = Arc::new(Link {
            profile,
            next_free: Mutex::new(std::time::Instant::now()),
        });
        let connections = Arc::new(AtomicUsize::new(0));
        let recorded = Arc::new(Recorded::default());
        let server = Server {
            addr,
            connections: connections.clone(),
            recorded: recorded.clone(),
        };
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { return };
                connections.fetch_add(1, Ordering::AcqRel);
                let link = link.clone();
                let recorded = recorded.clone();
                std::thread::spawn(move || serve(stream, addr, &link, &recorded));
            }
        });
        server
    }

    fn serve(stream: TcpStream, addr: std::net::SocketAddr, link: &Link, recorded: &Recorded) {
        let profile = link.profile;
        let mut writer = stream.try_clone().unwrap();
        let mut reader = BufReader::with_capacity(64 * 1024, stream);
        let mut window = INITIAL_WINDOW;
        let mut handshake = true;
        loop {
            let mut request_line = String::new();
            if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
                return;
            }
            let mut content_length = 0usize;
            let mut content_range = None;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    return;
                }
                let line = line.trim_end();
                if line.is_empty() {
                    break;
                }
                if let Some((name, value)) = line.split_once(':')
                    && name.eq_ignore_ascii_case("content-length")
                {
                    content_length = value.trim().parse().unwrap();
                }
                if let Some((name, value)) = line.split_once(':')
                    && name.eq_ignore_ascii_case("content-range")
                {
                    content_range = Some(value.trim().to_string());
                }
            }
            let path = request_line.split(' ').nth(1).unwrap_or("/").to_string();
            let part = path
                .rsplit_once("/part/")
                .map(|(_, part)| part.split('?').next().unwrap().parse::<u32>().unwrap());
            if let Some(part) = part {
                recorded.puts.lock().unwrap().push((part, content_range));
                let active = recorded.active_puts.fetch_add(1, Ordering::AcqRel) + 1;
                recorded.max_active_puts.fetch_max(active, Ordering::AcqRel);
            }
            if std::mem::take(&mut handshake) {
                std::thread::sleep(profile.rtt * profile.handshake_rtts);
            }
            let mut remaining = content_length;
            let mut buffer = vec![0u8; 64 * 1024];
            while remaining > 0 {
                let round = std::time::Instant::now();
                let mut budget = window.min(remaining);
                while budget > 0 {
                    let read = reader.read(&mut buffer[..budget.min(64 * 1024)]).unwrap();
                    assert!(read > 0);
                    link.transmit(read);
                    budget -= read;
                    remaining -= read;
                }
                window = (window * 2).min(profile.max_window);
                if remaining > 0 && round.elapsed() < profile.rtt {
                    std::thread::sleep(profile.rtt - round.elapsed());
                }
            }
            std::thread::sleep(profile.rtt);
            let response = if let Some(part) = path.strip_prefix("/presign/") {
                std::thread::sleep(profile.presign_server_time);
                let body = format!(r#"{{"presignedUrl":"http://{addr}/part/{part}"}}"#);
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                )
            } else {
                let part = part.unwrap();
                recorded
                    .received
                    .lock()
                    .unwrap()
                    .insert(part, content_length);
                format!("HTTP/1.1 200 OK\r\nETag: \"etag-{part}\"\r\nContent-Length: 0\r\n\r\n")
            };
            let written = writer.write_all(response.as_bytes());
            if part.is_some() {
                recorded.active_puts.fetch_sub(1, Ordering::AcqRel);
            }
            if written.is_err() {
                return;
            }
        }
    }
}

fn local_client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

/// Presigns over a fresh client per part, like `auth::authed_request`, then
/// runs the real part PUT on either a fresh client per part (the previous
/// behaviour) or one shared client. With `drive_urls`, presigning returns
/// Google Drive resumable URLs that the shared client resolves to the server.
struct MockPartTransport {
    addr: std::net::SocketAddr,
    shared: Option<reqwest::Client>,
    drive_urls: bool,
}

impl PartTransport for MockPartTransport {
    async fn presign(
        &self,
        chunk: &PartChunk,
        _cancel: &AtomicBool,
    ) -> Result<PresignedPart, AuthApiError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Presigned {
            presigned_url: String,
        }
        if self.drive_urls {
            return Ok(PresignedPart {
                url: format!(
                    "http://www.googleapis.com:{}/upload/drive/v3/files/part/{}?upload_id=cap-test",
                    self.addr.port(),
                    chunk.part_number
                ),
                md5: None,
            });
        }
        let url = local_client()
            .post(format!(
                "http://{}/presign/{}",
                self.addr, chunk.part_number
            ))
            .json(&json!({ "partNumber": chunk.part_number }))
            .send()
            .await
            .map_err(|error| AuthApiError::Other(error.to_string()))?
            .json::<Presigned>()
            .await
            .map_err(|error| AuthApiError::Other(error.to_string()))?
            .presigned_url;
        Ok(PresignedPart { url, md5: None })
    }

    async fn put(
        &self,
        presigned: &PresignedPart,
        chunk: &PartChunk,
        total_size: u64,
        cancel: &AtomicBool,
    ) -> Result<UploadedPart, AuthApiError> {
        let fresh;
        let client = match &self.shared {
            Some(client) => client,
            None => {
                fresh = local_client();
                &fresh
            }
        };
        put_presigned_part(
            client,
            &presigned.url,
            chunk,
            total_size,
            false,
            None,
            cancel,
        )
        .await
    }
}

fn fast_local_profile() -> mock_network::Profile {
    mock_network::Profile {
        rtt: Duration::from_millis(10),
        link_bytes_per_sec: 1e9,
        max_window: 1 << 20,
        handshake_rtts: 0,
        presign_server_time: Duration::ZERO,
    }
}

#[tokio::test]
async fn drive_urls_without_a_drive_initiate_are_put_in_order_with_content_range() {
    let export = TempExport::new(&export_bytes(4500));
    let server = mock_network::start(fast_local_profile());
    let transport = MockPartTransport {
        addr: server.addr,
        shared: Some(
            reqwest::Client::builder()
                .no_proxy()
                .resolve("www.googleapis.com", server.addr)
                .build()
                .unwrap(),
        ),
        drive_urls: true,
    };
    let (result, progress) = run(
        &transport,
        &export,
        1000,
        s3(),
        &AtomicBool::new(false),
        None,
    )
    .await;
    let parts = result.unwrap();
    assert_eq!(
        parts
            .iter()
            .map(|part| (part.part_number, part.size))
            .collect::<Vec<_>>(),
        [(1, 1000), (2, 1000), (3, 1000), (4, 1000), (5, 500)]
    );
    assert_eq!(
        *server.recorded.puts.lock().unwrap(),
        [
            (1, Some("bytes 0-999/4500".to_string())),
            (2, Some("bytes 1000-1999/4500".to_string())),
            (3, Some("bytes 2000-2999/4500".to_string())),
            (4, Some("bytes 3000-3999/4500".to_string())),
            (5, Some("bytes 4000-4499/4500".to_string())),
        ]
    );
    assert_eq!(server.recorded.max_active_puts.load(Ordering::Acquire), 1);
    assert_eq!(
        progress,
        [
            1000.0 / 4500.0,
            2000.0 / 4500.0,
            3000.0 / 4500.0,
            4000.0 / 4500.0,
            0.99
        ]
    );
}

#[tokio::test]
async fn s3_urls_are_put_concurrently_over_http_without_content_range() {
    let export = TempExport::new(&export_bytes(8000));
    let server = mock_network::start(fast_local_profile());
    let transport = MockPartTransport {
        addr: server.addr,
        shared: Some(local_client()),
        drive_urls: false,
    };
    let (result, _) = run(
        &transport,
        &export,
        1000,
        s3(),
        &AtomicBool::new(false),
        None,
    )
    .await;
    assert_parts(&result.unwrap(), &[1000; 8]);
    let puts = server.recorded.puts.lock().unwrap();
    assert_eq!(puts.len(), 8);
    assert!(puts.iter().all(|(_, range)| range.is_none()));
    let max_active = server.recorded.max_active_puts.load(Ordering::Acquire);
    assert!(
        (2..=MAX_CONCURRENT_PARTS).contains(&max_active),
        "{max_active}"
    );
}

/// `cargo test --bin cap-gpui multipart_mock_network_benchmark -- --ignored --nocapture`
/// `CAP_UPLOAD_BENCH_MB` overrides the export size (default 300).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "benchmark: moves hundreds of MB through a throttled loopback server"]
async fn multipart_mock_network_benchmark() {
    let megabytes = std::env::var("CAP_UPLOAD_BENCH_MB")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(300);
    let file_size = megabytes * 1_000_000;
    let export = TempExport(std::env::temp_dir().join(format!(
        "cap-gpui-multipart-bench-{}.mp4",
        std::process::id()
    )));
    {
        let file = std::fs::File::create(&export.0).unwrap();
        let block = export_bytes(1 << 20);
        let mut writer = std::io::BufWriter::new(file);
        let mut written = 0u64;
        while written < file_size {
            let take = (file_size - written).min(block.len() as u64) as usize;
            std::io::Write::write_all(&mut writer, &block[..take]).unwrap();
            written += take as u64;
        }
    }
    let chunk_size = chunk_size_for(file_size);
    let part_count = file_size.div_ceil(chunk_size);
    println!(
        "{megabytes} MB export, {part_count} parts of {} MB; window 2 MiB, TCP+TLS handshake 2 RTT, presign server 20 ms",
        chunk_size / 1_000_000
    );
    println!(
        "| RTT | link | serial, fresh client (before) | serial, shared client | 4 parts, shared client (after) | speedup |"
    );
    println!("|---|---|---|---|---|---|");
    for (rtt_ms, mbps) in [(50u64, 100.0f64), (150, 100.0), (50, 500.0), (150, 20.0)] {
        let profile = mock_network::Profile {
            rtt: Duration::from_millis(rtt_ms),
            link_bytes_per_sec: mbps * 1_000_000.0 / 8.0,
            max_window: 2 << 20,
            handshake_rtts: 2,
            presign_server_time: Duration::from_millis(20),
        };
        let mut times = Vec::new();
        for (concurrency, shared) in [(1, false), (1, true), (MAX_CONCURRENT_PARTS, true)] {
            let server = mock_network::start(profile);
            let transport = MockPartTransport {
                addr: server.addr,
                shared: shared.then(local_client),
                drive_urls: false,
            };
            let progress = Mutex::new(Vec::new());
            let started = Instant::now();
            let parts = upload_file_parts(
                &transport,
                &export.0,
                file_size,
                chunk_size,
                PartConcurrency::new(false, concurrency),
                &|value| progress.lock().unwrap().push(value),
                &AtomicBool::new(false),
                None,
            )
            .await
            .unwrap();
            let elapsed = started.elapsed();
            assert_eq!(parts.len() as u64, part_count);
            assert!(
                parts
                    .iter()
                    .enumerate()
                    .all(|(index, part)| part.part_number == index as u32 + 1
                        && part.etag == format!("etag-{}", index + 1))
            );
            assert_eq!(
                server
                    .recorded
                    .received
                    .lock()
                    .unwrap()
                    .values()
                    .sum::<usize>() as u64,
                file_size
            );
            let progress = progress.into_inner().unwrap();
            assert!(progress.windows(2).all(|pair| pair[0] <= pair[1]));
            assert_eq!(progress.last().copied(), Some(0.99));
            eprintln!(
                "rtt {rtt_ms} ms, {mbps} Mbps, concurrency {concurrency}, shared {shared}: {elapsed:.1?}, {} connections",
                server.connections.load(Ordering::Acquire)
            );
            times.push(elapsed.as_secs_f64());
        }
        println!(
            "| {rtt_ms} ms | {mbps} Mbps | {:.1} s | {:.1} s | {:.1} s | {:.1}x |",
            times[0],
            times[1],
            times[2],
            times[0] / times[2]
        );
    }
}
