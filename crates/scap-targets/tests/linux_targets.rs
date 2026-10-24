#![cfg(target_os = "linux")]

use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
};

use scap_targets::{Display, Window, WindowId};
use x11rb::{
    COPY_DEPTH_FROM_PARENT,
    connection::Connection,
    protocol::xproto::{
        AtomEnum, ConfigureWindowAux, ConnectionExt as _, CreateWindowAux, PropMode, WindowClass,
    },
    wrapper::ConnectionExt as _,
};

struct Xvfb(Child);

impl Xvfb {
    fn start() -> Option<(Self, String)> {
        let (reader, writer) = std::io::pipe().ok()?;
        let child = Command::new("Xvfb")
            .args([
                "-displayfd",
                "1",
                "-screen",
                "0",
                "1280x720x24",
                "-nolisten",
                "tcp",
            ])
            .stdin(Stdio::null())
            .stdout(writer)
            .stderr(Stdio::null())
            .spawn();
        let child = match child {
            Ok(child) => child,
            Err(error) => {
                eprintln!("skipping X11 targets test: cannot start Xvfb: {error}");
                return None;
            }
        };
        let server = Self(child);
        let mut line = String::new();
        BufReader::new(reader)
            .read_line(&mut line)
            .expect("Xvfb display number");
        let number: u32 = line.trim().parse().expect("Xvfb display number");
        Some((server, format!(":{number}")))
    }
}

impl Drop for Xvfb {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn partially_offscreen_window_remains_a_recording_target() {
    let Some((_server, display)) = Xvfb::start() else {
        return;
    };
    // SAFETY: this binary has one test, which sets the variables before calling scap_targets.
    unsafe {
        std::env::set_var("DISPLAY", &display);
        std::env::set_var("XDG_SESSION_TYPE", "x11");
    }
    let (conn, screen_num) = x11rb::connect(Some(&display)).unwrap();
    let screen = &conn.setup().roots[screen_num];
    let id = conn.generate_id().unwrap();
    conn.create_window(
        COPY_DEPTH_FROM_PARENT,
        id,
        screen.root,
        100,
        100,
        320,
        240,
        0,
        WindowClass::INPUT_OUTPUT,
        0,
        &CreateWindowAux::new(),
    )
    .unwrap()
    .check()
    .unwrap();
    conn.change_property8(
        PropMode::REPLACE,
        id,
        AtomEnum::WM_NAME,
        AtomEnum::STRING,
        b"Cap offscreen target regression",
    )
    .unwrap()
    .check()
    .unwrap();
    conn.change_property8(
        PropMode::REPLACE,
        id,
        AtomEnum::WM_CLASS,
        AtomEnum::STRING,
        b"cap-target-fixture\0CapTargetFixture\0",
    )
    .unwrap()
    .check()
    .unwrap();
    conn.map_window(id).unwrap().check().unwrap();

    let target_id: WindowId = id.to_string().parse().unwrap();
    let display_id = Display::primary().id();
    let width = i32::from(screen.width_in_pixels);
    let height = i32::from(screen.height_in_pixels);
    for (x, y) in [
        (100, 100),
        (-250, 100),
        (width - 70, 100),
        (100, -200),
        (100, height - 40),
        (-250, -200),
    ] {
        conn.configure_window(id, &ConfigureWindowAux::new().x(x).y(y))
            .unwrap()
            .check()
            .unwrap();
        let target = Window::from_id(&target_id)
            .unwrap_or_else(|| panic!("visible window at ({x}, {y}) must remain selectable"));
        assert_eq!(target.owner_name().as_deref(), Some("cap-target-fixture"));
        assert_eq!(target.display().unwrap().id(), display_id);
        let bounds = target.display_relative_logical_bounds().unwrap();
        assert_eq!(bounds.position().x(), f64::from(x));
        assert_eq!(bounds.position().y(), f64::from(y));
        assert_eq!(bounds.size().width(), 320.0);
        assert_eq!(bounds.size().height(), 240.0);
        conn.warp_pointer(
            x11rb::NONE,
            screen.root,
            0,
            0,
            0,
            0,
            i16::try_from(x.max(0) + 10).unwrap(),
            i16::try_from(y.max(0) + 10).unwrap(),
        )
        .unwrap()
        .check()
        .unwrap();
        assert_eq!(Window::get_topmost_at_cursor().unwrap().id(), target_id);
    }

    conn.configure_window(id, &ConfigureWindowAux::new().x(-320).y(100))
        .unwrap()
        .check()
        .unwrap();
    assert!(Window::from_id(&target_id).is_none());

    conn.configure_window(id, &ConfigureWindowAux::new().x(100).y(100))
        .unwrap()
        .check()
        .unwrap();
    assert!(Window::from_id(&target_id).is_some());
    conn.destroy_window(id).unwrap().check().unwrap();
    assert!(Window::from_id(&target_id).is_none());
}
