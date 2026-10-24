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
        Foundation::{COLORREF, HMODULE, HWND, LPARAM, LRESULT, RECT, WPARAM},
        Graphics::{
            Direct3D::D3D_DRIVER_TYPE_WARP,
            Direct3D11::{
                D3D11_BOX, D3D11_CREATE_DEVICE_FLAG, D3D11_SDK_VERSION, D3D11CreateDevice,
                ID3D11Device,
            },
            Gdi::{CreateSolidBrush, InvalidateRect},
        },
        UI::{
            HiDpi::{PROCESS_PER_MONITOR_DPI_AWARE, SetProcessDpiAwareness},
            WindowsAndMessaging::{
                CS_HREDRAW, CS_VREDRAW, CreateWindowExW, DefWindowProcW, DispatchMessageW,
                HWND_TOPMOST, MSG, PM_REMOVE, PeekMessageW, RegisterClassW, SPI_GETWORKAREA,
                SWP_NOACTIVATE, SWP_SHOWWINDOW, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, SetWindowPos,
                SystemParametersInfoW, TranslateMessage, WINDOW_EX_STYLE, WNDCLASSW,
                WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_OVERLAPPEDWINDOW, WS_POPUP, WS_VISIBLE,
            },
        },
    },
    core::{PCWSTR, w},
};

/// Where the fixture puts the target window: a fixed fraction of the primary
/// display's work area, so the windows, the crop taken around them and every
/// resize stay on screen from a 1024x768 runner up to a 4K desktop.
#[derive(Clone, Copy, Debug)]
struct Layout {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

impl Layout {
    /// Physical pixels once the process is per-monitor DPI aware, which the
    /// fixture and every test arrange before calling this.
    fn of_primary_work_area() -> Self {
        let mut area = RECT::default();
        unsafe {
            SystemParametersInfoW(
                SPI_GETWORKAREA,
                0,
                Some(&mut area as *mut RECT as *mut _),
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
            )
        }
        .expect("primary display work area");
        let (width, height) = (area.right - area.left, area.bottom - area.top);
        Self {
            x: area.left + width / 8,
            y: area.top + height / 8,
            width: width / 2,
            height: height / 2,
        }
    }

    /// Inside the target's client area, clear of its title bar.
    fn overlay(&self) -> (i32, i32, i32, i32) {
        (
            self.x + self.width / 4,
            self.y + self.height / 4,
            self.width / 3,
            self.height / 3,
        )
    }

    /// Still inside the work area: x + 3w/2 and y + 5h/4 end at 7/8 and 6/8.
    fn grown(&self) -> (i32, i32) {
        (self.width * 3 / 2, self.height * 5 / 4)
    }
}

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
    let layout = Layout::of_primary_work_area();
    let (overlay_x, overlay_y, overlay_w, overlay_h) = layout.overlay();

    // COLORREF is 0x00BBGGRR.
    register_class(w!("Cap2151Target"), 0x00FF_0000);
    register_class(w!("Cap2151Overlay"), 0x0000_00FF);

    let target = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("Cap2151Target"),
            w!("Cap2151 target"),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            layout.x,
            layout.y,
            layout.width,
            layout.height,
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
            overlay_x,
            overlay_y,
            overlay_w,
            overlay_h,
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
            overlay_x,
            overlay_y,
            overlay_w,
            overlay_h,
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
                let (width, height) = layout.grown();
                SetWindowPos(
                    target,
                    None,
                    layout.x,
                    layout.y,
                    width,
                    height,
                    SWP_SHOWWINDOW | SWP_NOACTIVATE,
                )
                .expect("resize target");
            },
            // `size W H` resizes in place; `at X Y W H` also moves the window.
            Ok(line) if line.trim().starts_with("size ") || line.trim().starts_with("at ") => {
                let mut words = line.trim().split(' ');
                let moves = words.next() == Some("at");
                let mut dims = words.map(|v| v.parse::<i32>().expect("fixture command number"));
                let (x, y) = if moves {
                    (dims.next().unwrap(), dims.next().unwrap())
                } else {
                    (layout.x, layout.y)
                };
                let (width, height) = (dims.next().unwrap(), dims.next().unwrap());
                unsafe {
                    SetWindowPos(
                        target,
                        None,
                        x,
                        y,
                        width,
                        height,
                        SWP_SHOWWINDOW | SWP_NOACTIVATE,
                    )
                    .expect("size target");
                }
            }
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
    /// The frame's ContentSize, which on some systems (Server 2022) is
    /// smaller than `item.Size()` because the latter counts the window's
    /// invisible resize borders.
    content: (u32, u32),
    red: usize,
    blue: usize,
}

fn capture_samples(
    item: windows::Graphics::Capture::GraphicsCaptureItem,
    crop: Option<D3D11_BOX>,
    duration: Duration,
    during: impl FnOnce(),
) -> Vec<Sample> {
    capture_samples_with(
        item,
        Settings {
            crop,
            ..Default::default()
        },
        duration,
        during,
    )
}

/// The WARP software rasterizer, which Cap falls back to without a usable GPU.
/// It removes its device over copies a hardware driver lets pass, so it is
/// what catches an out-of-bounds copy on a machine that has a GPU.
fn warp_device() -> ID3D11Device {
    let mut device = None;
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_WARP,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_FLAG::default(),
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )
    }
    .expect("create WARP device");
    device.expect("WARP device")
}

/// `CAP_SCAP_TEST_WARP=1` runs every capture here on WARP; otherwise the
/// capturer picks its device the way the recorder does.
fn device_from_env() -> Option<ID3D11Device> {
    std::env::var_os("CAP_SCAP_TEST_WARP").map(|_| warp_device())
}

fn capture_samples_with(
    item: windows::Graphics::Capture::GraphicsCaptureItem,
    settings: Settings,
    duration: Duration,
    during: impl FnOnce(),
) -> Vec<Sample> {
    capture_samples_on(
        item,
        settings,
        device_from_env(),
        Duration::ZERO,
        duration,
        during,
    )
}

/// `frame_delay` holds each frame in the callback, standing in for a consumer
/// slower than the capture, so frames queue up in the pool behind it.
fn capture_samples_on(
    item: windows::Graphics::Capture::GraphicsCaptureItem,
    settings: Settings,
    device: Option<ID3D11Device>,
    frame_delay: Duration,
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
            fps: Some(30),
            ..settings
        },
        move |frame| {
            if !frame_delay.is_zero() {
                std::thread::sleep(frame_delay);
            }
            let content = frame.inner().ContentSize()?;
            let content = (content.Width.max(0) as u32, content.Height.max(0) as u32);
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
                content,
                red,
                blue,
            });
            Ok(())
        },
        || Ok(()),
        device,
    )
    .expect("create capturer");

    capturer.start().expect("start capture");
    during();
    std::thread::sleep(duration);
    capturer.stop().expect("stop capture");
    // A removed device stops the frames without failing anything else, and
    // on WARP it is how an invalid copy shows up.
    unsafe { capturer.d3d_device().GetDeviceRemovedReason() }
        .expect("the capture device must not be removed during the capture");
    let samples = samples.lock().unwrap();
    samples.clone()
}

struct Fixture {
    process: FixtureProcess,
    target: WindowId,
    layout: Layout,
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
        Self {
            process,
            target,
            layout: Layout::of_primary_work_area(),
        }
    }

    fn window(&self) -> Window {
        Window::from_id(&self.target).expect("fixture window must be discoverable")
    }

    /// Resizes the target in place to its starting size plus `pixels`.
    fn grow_by(&mut self, pixels: i32) {
        let (width, height) = (self.layout.width + pixels, self.layout.height + pixels);
        self.send(&format!("size {width} {height}"));
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

    let samples = capture_samples_with(
        window
            .raw_handle()
            .try_as_capture_item()
            .expect("window capture item"),
        Settings {
            follow_item_size: true,
            ..Default::default()
        },
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

/// A window's capture item is often odd-sized (the window's own dimensions, or
/// the invisible resize borders taken off them), while the recording encodes
/// at even dimensions. With `even_dimensions` the odd row or column is trimmed
/// on the GPU, so every frame arrives at exactly the even size the recording
/// sizes its output from, and none fall through to the CPU scaler. Two sizes
/// one pixel apart guarantee each axis is odd for one of them.
#[test]
fn window_frames_are_trimmed_to_even_dimensions_on_the_gpu() {
    match_cli_dpi_awareness();

    let mut fixture = Fixture::start();
    let item = fixture
        .window()
        .raw_handle()
        .try_as_capture_item()
        .expect("window capture item");
    let samples = capture_samples_with(
        item,
        Settings {
            even_dimensions: true,
            follow_item_size: true,
            ..Default::default()
        },
        Duration::from_secs(2),
        || {
            std::thread::sleep(Duration::from_millis(700));
            fixture.grow_by(1);
            std::thread::sleep(Duration::from_millis(700));
            fixture.grow_by(2);
        },
    );

    let sizes: Vec<_> = samples.iter().map(|s| (s.width, s.height)).collect();
    let first = samples.first().expect("frames");
    assert_eq!(
        (first.width, first.height),
        (first.content.0 & !1, first.content.1 & !1),
        "the first frame must be its ContentSize floored to even: {samples:?}"
    );
    assert!(
        sizes.iter().all(|(w, h)| w % 2 == 0 && h % 2 == 0),
        "every frame must have even dimensions: {sizes:?}"
    );
    let mut distinct = sizes.clone();
    distinct.dedup();
    assert!(
        distinct.len() >= 2,
        "the capture must follow both resizes, saw {distinct:?}"
    );
    let last = samples.last().expect("frames");
    assert!(
        last.blue > 0,
        "trimmed frames must still carry the window's contents: {last:?}"
    );
}

/// A consumer slower than the capture leaves frames queued in the pool when it
/// is recreated for a new size. Those frames report the new ContentSize on a
/// surface still at the old size, so trimming them to their ContentSize reads
/// past the surface's edge. WARP removes the device over that copy and
/// Windows.Graphics.Capture then fails fast on its next use of it, taking the
/// whole process down with 0xc0000409. Runs on WARP whatever the machine has.
/// Which frames are queued is up to the capture's timing, so before the fix
/// this crashed on most runs rather than every one.
#[test]
fn frames_queued_before_the_pool_is_recreated_are_not_copied() {
    match_cli_dpi_awareness();

    let mut fixture = Fixture::start();
    let item = fixture
        .window()
        .raw_handle()
        .try_as_capture_item()
        .expect("window capture item");

    let samples = capture_samples_on(
        item,
        Settings {
            even_dimensions: true,
            follow_item_size: true,
            ..Default::default()
        },
        Some(warp_device()),
        Duration::from_millis(150),
        Duration::from_secs(2),
        || {
            std::thread::sleep(Duration::from_millis(700));
            fixture.grow_by(1);
            std::thread::sleep(Duration::from_millis(700));
            fixture.grow_by(2);
        },
    );

    let sizes: Vec<_> = samples.iter().map(|s| (s.width, s.height)).collect();
    assert!(
        sizes.iter().all(|(w, h)| w % 2 == 0 && h % 2 == 0),
        "every frame must have even dimensions: {sizes:?}"
    );
    let mut distinct = sizes.clone();
    distinct.dedup();
    assert!(
        distinct.len() >= 2,
        "the capture must follow the resizes, saw {distinct:?}"
    );
}

/// Without `follow_item_size` the pool keeps its creation size while the item
/// grows past it, so the trim has to stay inside the surface rather than
/// follow ContentSize off its edge. Runs on WARP, where that copy removes the
/// device and the capture stops delivering frames.
#[test]
fn even_dimension_trim_stays_inside_the_surface() {
    match_cli_dpi_awareness();

    let mut fixture = Fixture::start();
    let item = fixture
        .window()
        .raw_handle()
        .try_as_capture_item()
        .expect("window capture item");
    // Without `follow_item_size` the pool keeps the surface size it was created
    // with, which is the item's size at the start.
    let start = item.Size().expect("item size");
    let pool = (start.Width.max(0) as u32, start.Height.max(0) as u32);

    let samples = capture_samples_on(
        item,
        Settings {
            even_dimensions: true,
            ..Default::default()
        },
        Some(warp_device()),
        Duration::ZERO,
        Duration::from_secs(2),
        || {
            // WARP can be slow to deliver its first frame while the other
            // tests capture alongside it.
            std::thread::sleep(Duration::from_millis(1000));
            fixture.grow_by(1);
            std::thread::sleep(Duration::from_millis(700));
            fixture.grow_by(2);
        },
    );

    let sizes: Vec<_> = samples.iter().map(|s| (s.width, s.height)).collect();
    assert!(!sizes.is_empty(), "the capture must deliver frames");
    assert!(
        samples
            .iter()
            .all(|s| (s.width, s.height)
                == (s.content.0.min(pool.0) & !1, s.content.1.min(pool.1) & !1)),
        "every frame must be its ContentSize, bounded by the pool's surface, floored to even: {samples:?}"
    );
}

/// With no crop, trim or pool recreation, a frame whose ContentSize is smaller
/// than its surface must still read back. Handing the whole surface over under
/// the smaller size made `as_buffer`'s `CopyResource` a copy between different
/// sizes, which D3D11 drops, so the frame read back blank. Shrinking the window
/// under a fixed pool reaches this anywhere; on Server 2022 every window item
/// does, because its surface includes the invisible resize borders.
#[test]
fn frames_smaller_than_their_surface_still_read_back() {
    match_cli_dpi_awareness();

    let mut fixture = Fixture::start();
    let item = fixture
        .window()
        .raw_handle()
        .try_as_capture_item()
        .expect("window capture item");
    let start = item.Size().expect("item size");
    let pool = (start.Width.max(0) as u32, start.Height.max(0) as u32);

    let samples = capture_samples(item, None, Duration::from_secs(1), || {
        std::thread::sleep(Duration::from_millis(700));
        fixture.grow_by(-41);
    });

    let shrunk: Vec<_> = samples
        .iter()
        .filter(|s| s.content.0 < pool.0 && s.content.1 < pool.1)
        .collect();
    assert!(
        !shrunk.is_empty(),
        "the capture must deliver frames after the shrink: {samples:?}"
    );
    assert!(
        shrunk
            .iter()
            .all(|s| (s.width, s.height) == s.content && s.blue > 0),
        "a frame smaller than its surface must be its ContentSize and carry the window: {shrunk:?}"
    );
}
