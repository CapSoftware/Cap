use super::*;
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
};
use x11rb::{
    protocol::xproto::{CreateGCAux, Rectangle},
    wrapper::ConnectionExt as _,
};

const WIDTH: u16 = 320;
const HEIGHT: u16 = 240;
const RED: u32 = 0xff0000;
const GREEN: u32 = 0x00ff00;

struct Xvfb {
    child: Child,
    display: String,
}

impl Xvfb {
    fn start() -> Option<Self> {
        let (reader, writer) = std::io::pipe().ok()?;
        let mut child = Command::new("Xvfb")
            .args(["-displayfd", "1", "-screen", "0"])
            .arg(format!("{WIDTH}x{HEIGHT}x24"))
            .args(["-nolisten", "tcp"])
            .stdin(Stdio::null())
            .stdout(writer)
            .stderr(Stdio::null())
            .spawn()
            .inspect_err(|error| eprintln!("skipping X11 delivery test: no Xvfb: {error}"))
            .ok()?;
        let mut line = String::new();
        let read = BufReader::new(reader).read_line(&mut line);
        let Some(number) = read.ok().and_then(|_| line.trim().parse::<u32>().ok()) else {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        };
        Some(Self {
            child,
            display: format!(":{number}"),
        })
    }
}

impl Drop for Xvfb {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Screen {
    conn: RustConnection,
    root: u32,
}

impl Screen {
    fn connect(server: &Xvfb) -> Self {
        let (conn, screen) = x11rb::connect(Some(&server.display)).unwrap();
        let root = conn.setup().roots[screen].root;
        Self { conn, root }
    }

    fn fill(&self, color: u32) {
        let gc = self.conn.generate_id().unwrap();
        self.conn
            .create_gc(gc, self.root, &CreateGCAux::new().foreground(color))
            .unwrap();
        self.conn
            .poly_fill_rectangle(
                self.root,
                gc,
                &[Rectangle {
                    x: 0,
                    y: 0,
                    width: WIDTH,
                    height: HEIGHT,
                }],
            )
            .unwrap();
        self.conn.free_gc(gc).unwrap();
        self.conn.sync().unwrap();
    }
}

struct Capture {
    frames: mpsc::Receiver<FFmpegVideoFrame>,
    refresh_requests: Arc<AtomicU64>,
    stop: CancellationToken,
    thread: Option<std::thread::JoinHandle<anyhow::Result<()>>>,
    _health: tokio::sync::mpsc::Receiver<output_pipeline::PipelineHealthEvent>,
}

impl Capture {
    fn start(server: &Xvfb, channel_buffer: usize, refresh_interval: Option<Duration>) -> Self {
        let input = X11InputConfig {
            display_name: server.display.clone(),
            window_id: None,
            x: 0,
            y: 0,
            width: u32::from(WIDTH),
            height: u32::from(HEIGHT),
            fps: 60,
            show_cursor: false,
        };
        let info = VideoInfo::from_raw_ffmpeg(
            ffmpeg::format::Pixel::BGRZ,
            u32::from(WIDTH),
            u32::from(HEIGHT),
            60,
        );
        let refresh_requests = Arc::new(AtomicU64::new(0));
        let delivery = X11Delivery {
            every_frame: false,
            refresh_interval,
            refresh_requests: refresh_requests.clone(),
        };
        let (tx, frames) = mpsc::channel(channel_buffer);
        let (health_tx, health) = tokio::sync::mpsc::channel(64);
        let stop = CancellationToken::new();
        let thread_stop = stop.clone();
        let thread = std::thread::spawn(move || {
            capture_x11(info, input, delivery, tx, thread_stop, health_tx)
        });
        Self {
            frames,
            refresh_requests,
            stop,
            thread: Some(thread),
            _health: health,
        }
    }

    async fn next_color(&mut self) -> Option<u32> {
        let frame = tokio::time::timeout(Duration::from_secs(2), self.frames.next())
            .await
            .ok()??
            .inner;
        let center = usize::from(HEIGHT / 2) * frame.stride(0) + usize::from(WIDTH / 2) * 4;
        let pixel = &frame.data(0)[center..center + 3];
        Some(u32::from(pixel[2]) << 16 | u32::from(pixel[1]) << 8 | u32::from(pixel[0]))
    }

    async fn count_for(&mut self, window: Duration) -> usize {
        let deadline = tokio::time::Instant::now() + window;
        let mut count = 0;
        while let Ok(Some(_)) = tokio::time::timeout_at(deadline, self.frames.next()).await {
            count += 1;
        }
        count
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.cancel();
        self.frames.close();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[tokio::test]
async fn a_change_discarded_downstream_is_delivered_again_on_request() {
    let Some(server) = Xvfb::start() else {
        return;
    };
    let screen = Screen::connect(&server);
    screen.fill(RED);
    let mut capture = Capture::start(&server, 4, None);
    assert_eq!(capture.next_color().await, Some(RED));

    screen.fill(GREEN);
    capture.count_for(Duration::from_millis(300)).await;
    assert_eq!(capture.count_for(Duration::from_millis(200)).await, 0);

    capture.refresh_requests.fetch_add(1, Ordering::Release);
    assert_eq!(capture.next_color().await, Some(GREEN));
    assert_eq!(capture.count_for(Duration::from_millis(200)).await, 0);
}

#[tokio::test]
async fn a_request_right_after_a_delivery_still_sends_the_frame_again() {
    let Some(server) = Xvfb::start() else {
        return;
    };
    let screen = Screen::connect(&server);
    screen.fill(RED);
    let mut capture = Capture::start(&server, 4, None);
    assert_eq!(capture.next_color().await, Some(RED));

    screen.fill(GREEN);
    assert_eq!(capture.next_color().await, Some(GREEN));
    capture.refresh_requests.fetch_add(1, Ordering::Release);
    assert_eq!(capture.next_color().await, Some(GREEN));
    assert_eq!(capture.count_for(Duration::from_millis(200)).await, 0);
}

#[tokio::test]
async fn a_change_dropped_under_backpressure_is_delivered_once_the_channel_drains() {
    let Some(server) = Xvfb::start() else {
        return;
    };
    let screen = Screen::connect(&server);
    screen.fill(RED);
    let mut capture = Capture::start(&server, 0, None);
    tokio::time::sleep(Duration::from_millis(300)).await;

    screen.fill(GREEN);
    tokio::time::sleep(Duration::from_millis(output_pipeline::STALL_BUDGET_MS * 6)).await;

    assert_eq!(capture.next_color().await, Some(RED));
    assert_eq!(capture.next_color().await, Some(GREEN));
    assert_eq!(capture.count_for(Duration::from_millis(200)).await, 0);
}

#[tokio::test]
async fn a_static_screen_is_resent_at_the_refresh_interval() {
    let Some(server) = Xvfb::start() else {
        return;
    };
    let screen = Screen::connect(&server);
    screen.fill(RED);

    let mut unrefreshed = Capture::start(&server, 4, None);
    assert_eq!(unrefreshed.next_color().await, Some(RED));
    assert_eq!(unrefreshed.count_for(Duration::from_millis(600)).await, 0);
    drop(unrefreshed);

    let mut refreshed = Capture::start(&server, 4, Some(Duration::from_millis(200)));
    assert_eq!(refreshed.next_color().await, Some(RED));
    let resent = refreshed.count_for(Duration::from_millis(1100)).await;
    assert!((4..=6).contains(&resent), "resent {resent} frames");
}
