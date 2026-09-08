#![cfg(target_os = "windows")]

use scap_targets::{Window, WindowId};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::Duration,
};
use windows::{
    Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, DispatchMessageW, MSG, PM_REMOVE, PeekMessageW,
            SW_MINIMIZE, ShowWindow, TranslateMessage, WINDOW_EX_STYLE, WINDOW_STYLE, WS_CHILD,
            WS_EX_TOOLWINDOW, WS_OVERLAPPEDWINDOW, WS_POPUP, WS_VISIBLE,
        },
    },
    core::w,
};

struct TestWindow(HWND);

impl TestWindow {
    fn new(style: WINDOW_STYLE, extended: WINDOW_EX_STYLE, parent: Option<HWND>) -> Self {
        Self(unsafe {
            CreateWindowExW(
                extended,
                w!("STATIC"),
                w!("Cap window discovery regression"),
                style,
                100,
                100,
                320,
                240,
                parent,
                None,
                None,
                None,
            )
            .expect("create native test window")
        })
    }

    fn id(&self) -> WindowId {
        (self.0.0 as u64).to_string().parse().unwrap()
    }
}

impl Drop for TestWindow {
    fn drop(&mut self) {
        let _ = unsafe { DestroyWindow(self.0) };
    }
}

struct FixtureProcess(Child);

impl Drop for FixtureProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn window_fixture_process() {
    if std::env::var_os("CAP_WINDOW_DISCOVERY_FIXTURE").is_none() {
        return;
    }

    let normal = TestWindow::new(WS_OVERLAPPEDWINDOW | WS_VISIBLE, WINDOW_EX_STYLE(0), None);
    let popup = TestWindow::new(WS_POPUP | WS_VISIBLE, WINDOW_EX_STYLE(0), Some(normal.0));
    let hidden = TestWindow::new(WS_OVERLAPPEDWINDOW, WINDOW_EX_STYLE(0), None);
    let child = TestWindow::new(WS_CHILD | WS_VISIBLE, WINDOW_EX_STYLE(0), Some(normal.0));
    let tool = TestWindow::new(WS_OVERLAPPEDWINDOW | WS_VISIBLE, WS_EX_TOOLWINDOW, None);
    let minimized = TestWindow::new(WS_OVERLAPPEDWINDOW | WS_VISIBLE, WINDOW_EX_STYLE(0), None);
    let _ = unsafe { ShowWindow(minimized.0, SW_MINIMIZE) };
    println!(
        "WINDOW_FIXTURE {} {} {} {} {} {}",
        normal.id(),
        popup.id(),
        hidden.id(),
        child.id(),
        tool.id(),
        minimized.id()
    );
    std::io::stdout().flush().unwrap();

    let (stop_tx, stop_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = std::io::stdin().read_line(&mut line);
        let _ = stop_tx.send(());
    });
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_secs(30) && stop_rx.try_recv().is_err() {
        let mut message = MSG::default();
        while unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE) }.as_bool() {
            let _ = unsafe { TranslateMessage(&message) };
            unsafe { DispatchMessageW(&message) };
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn discovers_foreign_top_level_windows_and_preserves_target_filters() {
    let mut fixture = FixtureProcess(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "window_fixture_process", "--nocapture"])
            .env("CAP_WINDOW_DISCOVERY_FIXTURE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("start native window fixture"),
    );
    let output = fixture.0.stdout.take().unwrap();
    let (ready_tx, ready_rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            let Ok(line) = line else { break };
            if let Some((_, ids)) = line.split_once("WINDOW_FIXTURE ") {
                let _ = ready_tx.send(ids.to_string());
            }
        }
    });
    let ids: Vec<WindowId> = ready_rx
        .recv_timeout(Duration::from_secs(15))
        .expect("native window fixture must become ready")
        .split_whitespace()
        .map(|id| id.parse().unwrap())
        .collect();
    assert_eq!(ids.len(), 6);
    let own = TestWindow::new(WS_OVERLAPPEDWINDOW | WS_VISIBLE, WINDOW_EX_STYLE(0), None);
    let windows = Window::list();
    assert!(!windows.iter().any(|window| window.id() == own.id()));

    for id in &ids[..2] {
        let window = windows
            .iter()
            .find(|window| &window.id() == id)
            .expect("visible top-level and owned popup windows must be discoverable");
        assert!(window.raw_handle().is_valid());
        assert!(window.raw_handle().is_on_screen());
        assert!(window.name().is_some_and(|name| !name.is_empty()));
        assert!(window.owner_name().is_some());
        assert!(window.display().is_some());
        assert!(window.display_relative_logical_bounds().is_some());
        assert_eq!(
            window.raw_handle().inner().0 as u64,
            id.to_string().parse::<u64>().unwrap()
        );
        let parsed: WindowId = id.to_string().parse().unwrap();
        assert_eq!(
            Window::from_id(&parsed)
                .expect("resolve listed window ID")
                .id(),
            *id
        );
    }

    let eligible: Vec<_> = windows
        .iter()
        .filter(|window| window.raw_handle().is_valid() && window.raw_handle().is_on_screen())
        .map(Window::id)
        .collect();
    for id in &ids[2..] {
        assert!(
            !eligible.contains(id),
            "ineligible window {id} must stay excluded"
        );
    }
    fixture
        .0
        .stdin
        .take()
        .unwrap()
        .write_all(b"stop\n")
        .unwrap();
    assert!(fixture.0.wait().unwrap().success());
}
