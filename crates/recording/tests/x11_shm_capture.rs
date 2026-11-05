#![cfg(target_os = "linux")]

use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::{Mutex, MutexGuard},
};

use cap_recording::screen_capture::{X11_SHM_PUBLISH_SLOTS, X11Grabber, X11InputConfig};
use x11rb::{
    connection::Connection,
    protocol::xproto::{
        ConfigureWindowAux, ConnectionExt, CreateGCAux, CreateWindowAux, ImageFormat, Rectangle,
        Window, WindowClass,
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

fn page_aligned(ptr: *const u8) -> bool {
    (ptr as usize).is_multiple_of(4096)
}

fn fill_rect(conn: &RustConnection, drawable: u32, width: u16, height: u16, pixel: u32) {
    let gc = conn.generate_id().unwrap();
    conn.create_gc(gc, drawable, &CreateGCAux::new().foreground(pixel))
        .unwrap()
        .check()
        .unwrap();
    conn.poly_fill_rectangle(
        drawable,
        gc,
        &[Rectangle {
            x: 0,
            y: 0,
            width,
            height,
        }],
    )
    .unwrap()
    .check()
    .unwrap();
    conn.free_gc(gc).unwrap().check().unwrap();
    conn.sync().unwrap();
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
    assert!(page_aligned(shm_frame_ptr(&mut shm)));
}

fn shm_frame_ptr(grabber: &mut X11Grabber) -> *const u8 {
    grabber.grab().unwrap().data(0).as_ptr()
}

#[test]
fn shm_publish_keeps_pixels_until_the_frame_is_dropped() {
    let _guard = serial();
    let Some(server) = Xvfb::start(640, 480, &["-nolisten", "tcp"]) else {
        return;
    };
    let (conn, root) = connect(&server.display());
    draw_pattern(&conn, root, 640, 480);
    let baseline = shm_segments_owned_by_this_process();

    let mut shm = grabber(&config(&server.display(), 0, 0, 640, 480), true);
    assert!(shm.uses_shm());
    let first = shm.grab().unwrap();
    let first_ptr = first.data(0).as_ptr();
    let first_pixels = bgr_rows(&first);
    assert!(page_aligned(first_ptr));
    assert_eq!(first_pixels, expected_bgr(0, 0, 640, 480));
    assert!(
        shm.publish_idle_shm_frame().is_err(),
        "the published frame still owns the mapping"
    );

    fill_rect(&conn, root, 640, 480, 0x0000_ff00);
    let second = shm.grab().unwrap();
    assert_ne!(second.data(0).as_ptr(), first_ptr);
    assert!(page_aligned(second.data(0).as_ptr()));
    assert_eq!(bgr_rows(&first), first_pixels);
    assert_ne!(bgr_rows(&second), first_pixels);

    let second_ptr = second.data(0).as_ptr();
    let second_pixels = bgr_rows(&second);
    drop(second);
    let republished = shm.publish_idle_shm_frame().unwrap();
    assert_eq!(republished.data(0).as_ptr(), second_ptr);
    assert_eq!(bgr_rows(&republished), second_pixels);
    drop(republished);

    drop(first);
    let reused = shm.grab().unwrap();
    assert_eq!(reused.data(0).as_ptr(), first_ptr);
    drop(reused);
    drop(shm);
    assert_eq!(shm_segments_owned_by_this_process(), baseline);
}

#[test]
fn shm_frame_outlives_the_grabber() {
    let _guard = serial();
    let Some(server) = Xvfb::start(320, 240, &["-nolisten", "tcp"]) else {
        return;
    };
    let (conn, root) = connect(&server.display());
    draw_pattern(&conn, root, 320, 240);
    let baseline = shm_segments_owned_by_this_process();

    let frame = {
        let mut shm = grabber(&config(&server.display(), 0, 0, 320, 240), true);
        let frame = shm.grab().unwrap();
        assert_eq!(shm_segments_owned_by_this_process(), baseline + 1);
        frame
    };
    assert_eq!(shm_segments_owned_by_this_process(), baseline + 1);
    assert_eq!(bgr_rows(&frame), expected_bgr(0, 0, 320, 240));
    assert!(page_aligned(frame.data(0).as_ptr()));
    drop(frame);
    assert_eq!(shm_segments_owned_by_this_process(), baseline);
}

#[test]
fn busy_shm_slots_fall_back_to_a_private_copy() {
    let _guard = serial();
    let Some(server) = Xvfb::start(160, 120, &["-nolisten", "tcp"]) else {
        return;
    };
    let (conn, root) = connect(&server.display());
    let baseline = shm_segments_owned_by_this_process();
    let config = config(&server.display(), 0, 0, 160, 120);
    let mut shm = grabber(&config, true);
    let mut frames = Vec::new();
    let mut pixels = Vec::new();
    for index in 0..X11_SHM_PUBLISH_SLOTS {
        let pixel = 0x0010_1000 * (index as u32 + 1);
        fill_rect(&conn, root, 160, 120, pixel);
        let frame = shm.grab().unwrap();
        assert!(page_aligned(frame.data(0).as_ptr()));
        pixels.push(bgr_rows(&frame));
        frames.push(frame);
    }
    assert_eq!(
        shm_segments_owned_by_this_process(),
        baseline + X11_SHM_PUBLISH_SLOTS
    );

    fill_rect(&conn, root, 160, 120, 0x00aa_00bb);
    let copied = shm.grab().unwrap();
    assert_eq!(
        shm_segments_owned_by_this_process(),
        baseline + X11_SHM_PUBLISH_SLOTS + 1
    );
    for (frame, expected) in frames.iter().zip(&pixels) {
        assert_eq!(&bgr_rows(frame), expected);
    }
    let mut copied_grabber = grabber(&config, true);
    copied_grabber.force_shm_row_copy(true);
    assert_eq!(bgr_rows(&copied), bgr_rows(&copied_grabber.grab().unwrap()));
}

#[test]
fn scaled_shm_publish_matches_the_row_copy() {
    let _guard = serial();
    let Some(server) = Xvfb::start(320, 240, &["-nolisten", "tcp"]) else {
        return;
    };
    let (conn, root) = connect(&server.display());
    draw_pattern(&conn, root, 320, 240);
    let config = config(&server.display(), 0, 0, 320, 240);
    let mut published = grabber(&config, true);
    let mut copied = grabber(&config, true);
    copied.force_shm_row_copy(true);
    published.set_output_size(160, 120);
    copied.set_output_size(160, 120);

    let published_frame = published.grab().unwrap();
    let copied_frame = copied.grab().unwrap();
    assert_eq!(
        (published_frame.width(), published_frame.height()),
        (160, 120)
    );
    assert_eq!(bgr_rows(&published_frame), bgr_rows(&copied_frame));
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
