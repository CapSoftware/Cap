#![cfg(target_os = "linux")]

use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::{Mutex, MutexGuard},
};

use cap_recording::screen_capture::{X11Grabber, X11InputConfig};
use x11rb::{
    connection::Connection,
    protocol::{
        xfixes::ConnectionExt as _,
        xproto::{
            ConfigureWindowAux, ConnectionExt, CreateGCAux, CreateWindowAux, ImageFormat, Window,
            WindowClass,
        },
    },
    rust_connection::RustConnection,
    wrapper::ConnectionExt as _,
};

const DISABLE_SHM_ENV: &str = "CAP_X11_DISABLE_SHM";

static SERIAL: Mutex<()> = Mutex::new(());

fn serial() -> MutexGuard<'static, ()> {
    SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Xvfb {
    child: Child,
    number: u32,
}

impl Xvfb {
    fn start(width: u32, height: u32, extra_args: &[&str]) -> Option<Self> {
        let (reader, writer) = std::io::pipe().ok()?;
        let child = Command::new("Xvfb")
            .args(["-displayfd", "1", "-screen", "0"])
            .arg(format!("{width}x{height}x24"))
            .args(extra_args)
            .stdin(Stdio::null())
            .stdout(writer)
            .stderr(Stdio::null())
            .spawn();
        let mut child = match child {
            Ok(child) => child,
            Err(error) => {
                eprintln!("skipping X11 SHM test: cannot start Xvfb: {error}");
                return None;
            }
        };
        let mut line = String::new();
        let read = BufReader::new(reader).read_line(&mut line);
        let Some(number) = read.ok().and_then(|_| line.trim().parse().ok()) else {
            let _ = child.kill();
            let _ = child.wait();
            eprintln!("skipping X11 SHM test: Xvfb did not report a display");
            return None;
        };
        Some(Self { child, number })
    }

    fn display(&self) -> String {
        format!(":{}", self.number)
    }
}

impl Drop for Xvfb {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn pattern_pixel(x: u32, y: u32) -> [u8; 3] {
    [
        (x.wrapping_mul(7) ^ y) as u8,
        (y.wrapping_mul(3).wrapping_add(x >> 2)) as u8,
        (x.wrapping_add(y.wrapping_mul(5)) >> 1) as u8,
    ]
}

fn draw_pattern(conn: &RustConnection, drawable: u32, width: u16, height: u16) {
    let gc = conn.generate_id().unwrap();
    conn.create_gc(gc, drawable, &CreateGCAux::new()).unwrap();
    let rows_per_request = 32u16;
    let mut top = 0u16;
    while top < height {
        let rows = rows_per_request.min(height - top);
        let mut data = Vec::with_capacity(usize::from(width) * usize::from(rows) * 4);
        for y in top..top + rows {
            for x in 0..width {
                let [b, g, r] = pattern_pixel(u32::from(x), u32::from(y));
                data.extend_from_slice(&[b, g, r, 0]);
            }
        }
        conn.put_image(
            ImageFormat::Z_PIXMAP,
            drawable,
            gc,
            width,
            rows,
            0,
            top as i16,
            0,
            24,
            &data,
        )
        .unwrap()
        .check()
        .unwrap();
        top += rows;
    }
    conn.free_gc(gc).unwrap().check().unwrap();
}

fn connect(display: &str) -> (RustConnection, Window) {
    let (conn, screen) = x11rb::connect(Some(display)).unwrap();
    let root = conn.setup().roots[screen].root;
    (conn, root)
}

fn config(display: &str, x: i32, y: i32, width: u32, height: u32) -> X11InputConfig {
    X11InputConfig {
        display_name: display.to_string(),
        window_id: None,
        x,
        y,
        width,
        height,
        fps: 30,
        show_cursor: false,
    }
}

fn grabber(config: &X11InputConfig, shm: bool) -> X11Grabber {
    // SAFETY: every test holds `SERIAL` and the grabber reads the variable only
    // during construction, so no other thread observes the change.
    unsafe {
        if shm {
            std::env::remove_var(DISABLE_SHM_ENV);
        } else {
            std::env::set_var(DISABLE_SHM_ENV, "1");
        }
    }
    let grabber = X11Grabber::new(config).unwrap();
    unsafe { std::env::remove_var(DISABLE_SHM_ENV) };
    grabber
}

fn bgr_rows(frame: &ffmpeg::frame::Video) -> Vec<u8> {
    let stride = frame.stride(0);
    let data = frame.data(0);
    let mut out = Vec::new();
    for row in 0..frame.height() as usize {
        for pixel in data[row * stride..][..frame.width() as usize * 4].chunks_exact(4) {
            out.extend_from_slice(&pixel[..3]);
        }
    }
    out
}

fn expected_bgr(x: u32, y: u32, width: u32, height: u32) -> Vec<u8> {
    let mut out = Vec::new();
    for row in y..y + height {
        for column in x..x + width {
            out.extend_from_slice(&pattern_pixel(column, row));
        }
    }
    out
}

fn shm_segments_owned_by_this_process() -> usize {
    let pid = std::process::id().to_string();
    std::fs::read_to_string("/proc/sysvipc/shm")
        .unwrap()
        .lines()
        .skip(1)
        .filter(|line| line.split_whitespace().nth(4) == Some(pid.as_str()))
        .count()
}

#[test]
fn shm_and_get_image_capture_identical_pixels() {
    let _guard = serial();
    let Some(server) = Xvfb::start(1280, 720, &["-nolisten", "tcp"]) else {
        return;
    };
    let (conn, root) = connect(&server.display());
    draw_pattern(&conn, root, 1280, 720);

    let config = config(&server.display(), 0, 0, 1280, 720);
    let mut shm = grabber(&config, true);
    let mut get_image = grabber(&config, false);
    assert!(shm.uses_shm());
    assert!(!get_image.uses_shm());

    let shm_frame = bgr_rows(&shm.grab().unwrap());
    let get_image_frame = bgr_rows(&get_image.grab().unwrap());
    assert_eq!(shm_frame, expected_bgr(0, 0, 1280, 720));
    assert_eq!(shm_frame, get_image_frame);
    assert!(shm.uses_shm());
}

#[test]
fn shm_captures_unaligned_regions() {
    let _guard = serial();
    let Some(server) = Xvfb::start(800, 600, &["-nolisten", "tcp"]) else {
        return;
    };
    let (conn, root) = connect(&server.display());
    draw_pattern(&conn, root, 800, 600);

    for (x, y, width, height) in [(101, 53, 333, 211), (0, 599, 799, 1), (797, 0, 3, 600)] {
        let config = config(&server.display(), x, y, width, height);
        let mut shm = grabber(&config, true);
        assert!(shm.uses_shm());
        let frame = bgr_rows(&shm.grab().unwrap());
        assert_eq!(
            frame,
            expected_bgr(x as u32, y as u32, width, height),
            "region {x},{y} {width}x{height}"
        );
    }
}

#[test]
fn env_opt_out_forces_get_image() {
    let _guard = serial();
    let Some(server) = Xvfb::start(320, 240, &["-nolisten", "tcp"]) else {
        return;
    };
    let (conn, root) = connect(&server.display());
    draw_pattern(&conn, root, 320, 240);

    let mut grabber = grabber(&config(&server.display(), 0, 0, 320, 240), false);
    assert!(!grabber.uses_shm());
    assert_eq!(
        bgr_rows(&grabber.grab().unwrap()),
        expected_bgr(0, 0, 320, 240)
    );
}

#[test]
fn missing_mit_shm_extension_falls_back_to_get_image() {
    let _guard = serial();
    let Some(server) = Xvfb::start(320, 240, &["-nolisten", "tcp", "-extension", "MIT-SHM"]) else {
        return;
    };
    let (conn, root) = connect(&server.display());
    draw_pattern(&conn, root, 320, 240);

    let mut grabber = grabber(&config(&server.display(), 0, 0, 320, 240), true);
    assert!(!grabber.uses_shm());
    assert_eq!(
        bgr_rows(&grabber.grab().unwrap()),
        expected_bgr(0, 0, 320, 240)
    );
}

#[test]
fn tcp_display_falls_back_when_server_cannot_attach_segment() {
    let _guard = serial();
    let Some(server) = Xvfb::start(320, 240, &["-listen", "tcp", "-ac"]) else {
        return;
    };
    let display = format!("localhost:{}", server.number);
    let Ok((conn, root)) = x11rb::connect(Some(&display)).map(|(conn, screen)| {
        let root = conn.setup().roots[screen].root;
        (conn, root)
    }) else {
        eprintln!("skipping TCP X11 SHM test: cannot reach {display}");
        return;
    };
    draw_pattern(&conn, root, 320, 240);
    let baseline = shm_segments_owned_by_this_process();

    let mut grabber = grabber(&config(&display, 0, 0, 320, 240), true);
    assert!(!grabber.uses_shm());
    assert_eq!(shm_segments_owned_by_this_process(), baseline);
    assert_eq!(
        bgr_rows(&grabber.grab().unwrap()),
        expected_bgr(0, 0, 320, 240)
    );
}

#[test]
fn window_capture_uses_shm_and_survives_resize() {
    let _guard = serial();
    let Some(server) = Xvfb::start(640, 480, &["-nolisten", "tcp"]) else {
        return;
    };
    let (conn, root) = connect(&server.display());
    let window = conn.generate_id().unwrap();
    conn.create_window(
        24,
        window,
        root,
        40,
        30,
        200,
        150,
        0,
        WindowClass::INPUT_OUTPUT,
        0,
        &CreateWindowAux::new().background_pixel(0),
    )
    .unwrap()
    .check()
    .unwrap();
    conn.map_window(window).unwrap().check().unwrap();

    let mut config = config(&server.display(), 40, 30, 200, 150);
    config.window_id = Some(window);
    let mut shm = grabber(&config, true);
    let mut get_image = grabber(&config, false);
    assert!(shm.uses_shm());

    draw_pattern(&conn, window, 200, 150);
    conn.sync().unwrap();
    let frame = bgr_rows(&shm.grab().unwrap());
    assert_eq!(frame, expected_bgr(0, 0, 200, 150));
    assert_eq!(frame, bgr_rows(&get_image.grab().unwrap()));

    for (width, height) in [(320u16, 240u16), (90, 70)] {
        conn.configure_window(
            window,
            &ConfigureWindowAux::new()
                .width(u32::from(width))
                .height(u32::from(height)),
        )
        .unwrap()
        .check()
        .unwrap();
        draw_pattern(&conn, window, width, height);
        conn.sync().unwrap();

        let shm_frame = shm.grab().unwrap();
        assert!(shm.uses_shm(), "SHM survives a resize to {width}x{height}");
        assert_eq!((shm_frame.width(), shm_frame.height()), (200, 150));
        assert_eq!(
            bgr_rows(&shm_frame),
            bgr_rows(&get_image.grab().unwrap()),
            "resized to {width}x{height}"
        );
    }

    let mut resized = grabber(
        &X11InputConfig {
            width: 90,
            height: 70,
            ..config
        },
        true,
    );
    assert_eq!(
        bgr_rows(&resized.grab().unwrap()),
        expected_bgr(0, 0, 90, 70)
    );
}

fn create_window(
    conn: &RustConnection,
    parent: Window,
    x: i16,
    y: i16,
    width: u16,
    height: u16,
    background: u32,
) -> Window {
    let window = conn.generate_id().unwrap();
    conn.create_window(
        24,
        window,
        parent,
        x,
        y,
        width,
        height,
        0,
        WindowClass::INPUT_OUTPUT,
        0,
        &CreateWindowAux::new().background_pixel(background),
    )
    .unwrap()
    .check()
    .unwrap();
    window
}

fn move_window(conn: &RustConnection, window: Window, x: i32, y: i32) {
    conn.configure_window(window, &ConfigureWindowAux::new().x(x).y(y))
        .unwrap()
        .check()
        .unwrap();
}

fn cursor_top_left(with: &mut X11Grabber, without: &mut X11Grabber) -> Option<(i32, i32)> {
    let with = with.grab().unwrap();
    let without = without.grab().unwrap();
    let width = with.width() as usize;
    bgr_rows(&with)
        .chunks_exact(3)
        .zip(bgr_rows(&without).chunks_exact(3))
        .enumerate()
        .filter(|(_, (cursor, plain))| cursor != plain)
        .map(|(index, _)| ((index % width) as i32, (index / width) as i32))
        .reduce(|(min_x, min_y), (x, y)| (min_x.min(x), min_y.min(y)))
}

#[test]
fn window_capture_follows_moved_and_reparented_ancestors() {
    let _guard = serial();
    let Some(server) = Xvfb::start(640, 480, &["-nolisten", "tcp"]) else {
        return;
    };
    let (conn, root) = connect(&server.display());
    conn.xfixes_query_version(5, 0).unwrap().reply().unwrap();

    let (child_x, child_y, width, height) = (5, 20, 240u16, 170u16);
    let frame = create_window(&conn, root, 100, 80, width + 10, height + 25, 0x333333);
    let window = create_window(&conn, frame, child_x, child_y, width, height, 0x00ff00);
    conn.map_window(window).unwrap().check().unwrap();
    conn.map_window(frame).unwrap().check().unwrap();
    conn.sync().unwrap();

    let config = |show_cursor| X11InputConfig {
        window_id: Some(window),
        show_cursor,
        ..config(&server.display(), 0, 0, u32::from(width), u32::from(height))
    };
    let mut with = grabber(&config(true), true);
    let mut without = grabber(&config(false), true);
    for _ in 0..3 {
        with.grab().unwrap();
        without.grab().unwrap();
    }

    let cursor = conn.xfixes_get_cursor_image().unwrap().reply().unwrap();
    let (cursor_width, cursor_height) = (cursor.width as usize, cursor.height as usize);
    let opaque = |x: usize, y: usize| cursor.cursor_image[y * cursor_width + x] >> 24 != 0;
    let opaque_x = (0..cursor_width)
        .find(|&x| (0..cursor_height).any(|y| opaque(x, y)))
        .unwrap() as i32;
    let opaque_y = (0..cursor_height)
        .find(|&y| (0..cursor_width).any(|x| opaque(x, y)))
        .unwrap() as i32;
    let offset = (
        opaque_x - i32::from(cursor.xhot),
        opaque_y - i32::from(cursor.yhot),
    );

    let mut assert_cursor = |origin: (i32, i32), local: (i32, i32), stage: &str| {
        let pointer = (origin.0 + local.0, origin.1 + local.1);
        conn.warp_pointer(
            x11rb::NONE,
            root,
            0,
            0,
            0,
            0,
            pointer.0 as i16,
            pointer.1 as i16,
        )
        .unwrap()
        .check()
        .unwrap();
        conn.sync().unwrap();
        assert_eq!(
            cursor_top_left(&mut with, &mut without),
            Some((local.0 + offset.0, local.1 + offset.1)),
            "{stage}"
        );
    };

    let child = (i32::from(child_x), i32::from(child_y));
    assert_cursor((100 + child.0, 80 + child.1), (95, 50), "initial frame");

    move_window(&conn, frame, 300, 250);
    assert_cursor((300 + child.0, 250 + child.1), (55, 50), "frame moved");

    let outer = create_window(&conn, root, 20, 30, 400, 300, 0x666666);
    conn.map_window(outer).unwrap().check().unwrap();
    conn.reparent_window(frame, outer, 40, 10)
        .unwrap()
        .check()
        .unwrap();
    conn.sync().unwrap();
    assert_cursor(
        (20 + 40 + child.0, 30 + 10 + child.1),
        (30, 40),
        "frame reparented into a new outer frame",
    );

    move_window(&conn, outer, 150, 100);
    assert_cursor(
        (150 + 40 + child.0, 100 + 10 + child.1),
        (70, 60),
        "new outer frame moved",
    );

    let mut fresh = grabber(&config(false), true);
    fresh.grab().unwrap();

    conn.unmap_window(outer).unwrap().check().unwrap();
    conn.sync().unwrap();
    for (name, grabber) in [
        ("show_cursor", &mut with),
        ("no cursor", &mut without),
        ("fresh no cursor", &mut fresh),
    ] {
        let Err(error) = grabber.grab() else {
            panic!("{name}: grab succeeded after the outer frame was unmapped");
        };
        assert!(
            format!("{error:#}").contains("no longer viewable"),
            "{name}: {error:#}"
        );
    }
}

fn soak(frames: usize) {
    let _guard = serial();
    let Some(server) = Xvfb::start(256, 256, &["-nolisten", "tcp"]) else {
        return;
    };
    let (conn, root) = connect(&server.display());
    draw_pattern(&conn, root, 256, 256);
    let baseline = shm_segments_owned_by_this_process();

    for cycle in 0..40 {
        let size = 32 + cycle * 5;
        let mut grabber = grabber(&config(&server.display(), 0, 0, size, size), true);
        assert!(grabber.uses_shm());
        for _ in 0..10 {
            grabber.grab().unwrap();
        }
        assert_eq!(shm_segments_owned_by_this_process(), baseline + 1);
    }
    assert_eq!(shm_segments_owned_by_this_process(), baseline);

    let mut grabber = grabber(&config(&server.display(), 0, 0, 64, 64), true);
    for _ in 0..frames {
        grabber.grab().unwrap();
    }
    assert!(grabber.uses_shm());
    assert_eq!(
        bgr_rows(&grabber.grab().unwrap()),
        expected_bgr(0, 0, 64, 64)
    );
    drop(grabber);
    assert_eq!(shm_segments_owned_by_this_process(), baseline);
}

#[test]
fn repeated_grabbers_do_not_leak_shared_memory() {
    soak(2_000);
}

#[test]
#[ignore = "100k-frame soak; run explicitly"]
fn soak_100k_frames_does_not_leak_shared_memory() {
    soak(100_000);
}
