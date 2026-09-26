#![cfg(target_os = "windows")]

//! Window capture regressions for CapSoftware/Cap#2151.
//!
//! The fixture process owns the windows because `Window::list()` skips the
//! calling process, the same arrangement `scap-targets`' window discovery test
//! uses.

use scap_direct3d::{Capturer, PixelFormat, Settings};
use scap_targets::{Window, WindowId};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, Once, mpsc},
    time::{Duration, Instant},
};
use windows::{
    Win32::{
        Foundation::{COLORREF, HWND, LPARAM, LRESULT, WPARAM},
        Graphics::{
            Direct3D11::D3D11_BOX,
            Gdi::{CreateSolidBrush, InvalidateRect},
        },
        UI::{
            HiDpi::{PROCESS_PER_MONITOR_DPI_AWARE, SetProcessDpiAwareness},
            WindowsAndMessaging::{
                CS_HREDRAW, CS_VREDRAW, CreateWindowExW, DefWindowProcW, DispatchMessageW,
                HWND_TOPMOST, MSG, PM_REMOVE, PeekMessageW, RegisterClassW, SWP_NOACTIVATE,
                SWP_SHOWWINDOW, SetWindowPos, TranslateMessage, WINDOW_EX_STYLE, WNDCLASSW,
                WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_OVERLAPPEDWINDOW, WS_POPUP, WS_VISIBLE,
            },
        },
    },
    core::{PCWSTR, w},
};

const TARGET_X: i32 = 200;
const TARGET_Y: i32 = 200;
const TARGET_W: i32 = 800;
const TARGET_H: i32 = 600;
const OVERLAY_W: i32 = 300;
const OVERLAY_H: i32 = 200;
const RESIZED_W: i32 = 1100;
const RESIZED_H: i32 = 700;

struct FixtureProcess(Child);

impl Drop for FixtureProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Process-wide and only settable once, so both tests here share one call.
fn match_cli_dpi_awareness() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        unsafe { SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE) }
            .expect("match CLI per-monitor DPI awareness");
    });
}

unsafe extern "system" fn window_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    unsafe { DefWindowProcW(window, message, wparam, lparam) }
}

fn register_class(class: PCWSTR, colour: u32) {
    let class = WNDCLASSW {
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(window_proc),
        hbrBackground: unsafe { CreateSolidBrush(COLORREF(colour)) },
        lpszClassName: class,
        ..Default::default()
    };
    assert!(unsafe { RegisterClassW(&class) } != 0, "register class");
}

/// Runs in the fixture process: a blue window with a red always-on-top window
/// covering part of it, resized once `resize` is read on stdin.
#[test]
fn window_capture_fixture_process() {
    if std::env::var_os("CAP_WINDOW_CAPTURE_FIXTURE").is_none() {
        return;
    }

    match_cli_dpi_awareness();

    // COLORREF is 0x00BBGGRR.
    register_class(w!("Cap2151Target"), 0x00FF_0000);
    register_class(w!("Cap2151Overlay"), 0x0000_00FF);

    let target = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("Cap2151Target"),
            w!("Cap2151 target"),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            TARGET_X,
            TARGET_Y,
            TARGET_W,
            TARGET_H,
            None,
            None,
            None,
            None,
        )
    }
    .expect("create target window");
    let overlay = unsafe {
        CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
            w!("Cap2151Overlay"),
            w!("Cap2151 overlay"),
            WS_POPUP | WS_VISIBLE,
            TARGET_X + 200,
            TARGET_Y + 150,
            OVERLAY_W,
            OVERLAY_H,
            None,
            None,
            None,
            None,
        )
    }
    .expect("create overlay window");
    unsafe {
        SetWindowPos(
            overlay,
            Some(HWND_TOPMOST),
            TARGET_X + 200,
            TARGET_Y + 150,
            OVERLAY_W,
            OVERLAY_H,
            SWP_SHOWWINDOW | SWP_NOACTIVATE,
        )
    }
    .expect("raise overlay");

    println!("WINDOW_CAPTURE_FIXTURE {}", target.0 as u64);
    std::io::stdout().flush().unwrap();

    let (command_tx, command_rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(std::io::stdin()).lines() {
            let Ok(line) = line else { break };
            if command_tx.send(line).is_err() {
                break;
            }
        }
    });

    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(60) {
        match command_rx.try_recv() {
            Ok(line) if line.trim() == "resize" => unsafe {
                SetWindowPos(
                    target,
                    None,
                    TARGET_X,
                    TARGET_Y,
                    RESIZED_W,
                    RESIZED_H,
                    SWP_SHOWWINDOW | SWP_NOACTIVATE,
                )
                .expect("resize target");
            },
            Ok(line) if line.trim() == "stop" => return,
            Ok(_) | Err(mpsc::TryRecvError::Empty) => {}
            Err(mpsc::TryRecvError::Disconnected) => return,
        }

        // WGC only delivers a frame when the content changes, so keep the
        // window repainting for the duration of the capture.
        let _ = unsafe { InvalidateRect(Some(target), None, true) };
        let mut message = MSG::default();
        while unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE) }.as_bool() {
            let _ = unsafe { TranslateMessage(&message) };
            unsafe { DispatchMessageW(&message) };
        }
        std::thread::sleep(Duration::from_millis(16));
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Sample {
    width: u32,
    height: u32,
    red: usize,
    blue: usize,
}

fn capture_samples(
    item: windows::Graphics::Capture::GraphicsCaptureItem,
    crop: Option<D3D11_BOX>,
    duration: Duration,
    during: impl FnOnce(),
) -> Vec<Sample> {
    let samples: Arc<Mutex<Vec<Sample>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = samples.clone();
    let mut capturer = Capturer::new(
        item,
        Settings {
            is_border_required: Some(false),
            is_cursor_capture_enabled: Some(false),
            pixel_format: PixelFormat::R8G8B8A8Unorm,
            crop,
            fps: Some(30),
            ..Default::default()
        },
        move |frame| {
            let buffer = frame.as_buffer()?;
            let (width, height, stride) = (
                buffer.width() as usize,
                buffer.height() as usize,
                buffer.stride() as usize,
            );
            let data = buffer.data();
            let (mut red, mut blue) = (0usize, 0usize);
            for y in 0..height {
                for x in 0..width {
                    let pixel = &data[y * stride + x * 4..y * stride + x * 4 + 4];
                    let (r, g, b) = (pixel[0], pixel[1], pixel[2]);
                    if r > 200 && g < 60 && b < 60 {
                        red += 1;
                    } else if b > 200 && r < 60 && g < 60 {
                        blue += 1;
                    }
                }
            }
            sink.lock().unwrap().push(Sample {
                width: width as u32,
                height: height as u32,
                red,
                blue,
            });
            Ok(())
        },
        || Ok(()),
        None,
    )
    .expect("create capturer");

    capturer.start().expect("start capture");
    during();
    std::thread::sleep(duration);
    capturer.stop().expect("stop capture");
    let samples = samples.lock().unwrap();
    samples.clone()
}

struct Fixture {
    process: FixtureProcess,
    target: WindowId,
}

impl Fixture {
    fn start() -> Self {
        let mut process = FixtureProcess(
            Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "window_capture_fixture_process", "--nocapture"])
                .env("CAP_WINDOW_CAPTURE_FIXTURE", "1")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .expect("start window capture fixture"),
        );
        let stdout = process.0.stdout.take().unwrap();
        let (ready_tx, ready_rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Some((_, id)) = line.split_once("WINDOW_CAPTURE_FIXTURE ") {
                    let _ = ready_tx.send(id.to_string());
                }
            }
        });
        let target: WindowId = ready_rx
            .recv_timeout(Duration::from_secs(15))
            .expect("fixture must become ready")
            .trim()
            .parse()
            .expect("parse fixture window id");
        // Give the windows a moment to paint before capturing them.
        std::thread::sleep(Duration::from_millis(800));
        Self { process, target }
    }

    fn window(&self) -> Window {
        Window::from_id(&self.target).expect("fixture window must be discoverable")
    }

    fn send(&mut self, command: &str) {
        let stdin = self.process.0.stdin.as_mut().expect("fixture stdin");
        stdin.write_all(command.as_bytes()).unwrap();
        stdin.write_all(b"\n").unwrap();
        stdin.flush().unwrap();
    }
}

/// Capturing a window through the display's capture item sees whatever is
/// stacked on top of it; capturing the window's own item does not.
#[test]
fn window_item_excludes_windows_stacked_on_top() {
    match_cli_dpi_awareness();

    let fixture = Fixture::start();
    let window = fixture.window();
    let display = window.display().expect("window display");
    let window_bounds = window
        .raw_handle()
        .physical_bounds()
        .expect("window bounds");
    let display_position = display
        .raw_handle()
        .physical_position()
        .expect("display position");

    let crop = D3D11_BOX {
        left: (window_bounds.position().x() - display_position.x()).max(0.0) as u32,
        top: (window_bounds.position().y() - display_position.y()).max(0.0) as u32,
        right: (window_bounds.position().x() - display_position.x() + window_bounds.size().width())
            .max(0.0) as u32,
        bottom: (window_bounds.position().y() - display_position.y()
            + window_bounds.size().height())
        .max(0.0) as u32,
        front: 0,
        back: 1,
    };

    let cropped = capture_samples(
        display
            .raw_handle()
            .try_as_capture_item()
            .expect("display capture item"),
        Some(crop),
        Duration::from_secs(2),
        || {},
    );
    let cropped = cropped.last().copied().expect("cropped display frames");
    assert!(
        cropped.red > 0,
        "a display capture cropped to the window must show the window stacked on top of it, \
         which is the bug being fixed: {cropped:?}"
    );

    let window_item = capture_samples(
        window
            .raw_handle()
            .try_as_capture_item()
            .expect("window capture item"),
        None,
        Duration::from_secs(2),
        || {},
    );
    let window_item = window_item.last().copied().expect("window frames");
    assert_eq!(
        window_item.red, 0,
        "the window's own capture item must not contain the window stacked on top of it: \
         {window_item:?}"
    );
    assert!(
        window_item.blue > 0,
        "the window's own capture item must contain the window: {window_item:?}"
    );
}

/// The frame pool is created at the item's size; when the item resizes, frames
/// keep arriving with the new ContentSize but the pool's surfaces are still the
/// old size, so every frame reads back empty until the pool is recreated.
#[test]
fn frames_survive_the_capture_item_resizing() {
    match_cli_dpi_awareness();

    let mut fixture = Fixture::start();
    let window = fixture.window();
    let before = window.physical_size().expect("window size");

    let samples = capture_samples(
        window
            .raw_handle()
            .try_as_capture_item()
            .expect("window capture item"),
        None,
        Duration::from_secs(4),
        || {
            std::thread::sleep(Duration::from_millis(500));
            fixture.send("resize");
        },
    );

    let grown: Vec<_> = samples
        .iter()
        .filter(|sample| sample.width > before.width() as u32)
        .collect();
    assert!(
        !grown.is_empty(),
        "the capture must follow the window's new size, saw {:?}",
        samples
            .iter()
            .map(|s| (s.width, s.height))
            .collect::<Vec<_>>()
    );
    let last = grown.last().expect("a frame after the resize");
    assert!(
        last.blue > 0,
        "frames after a resize must still carry the window's contents: {last:?}"
    );
}
