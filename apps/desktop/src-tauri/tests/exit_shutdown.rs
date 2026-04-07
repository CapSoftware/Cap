#[path = "../src/exit_shutdown.rs"]
mod exit_shutdown;

use exit_shutdown::{
    AppExitAction, abort_join_handles, app_exit_action, collect_device_inventory,
    read_target_under_cursor, run_while_active,
};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

struct DropFlag(Arc<AtomicBool>);

impl Drop for DropFlag {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

#[test]
fn run_while_active_skips_operation_once_exit_begins() {
    let called = Arc::new(AtomicBool::new(false));
    let flag = called.clone();

    let result = run_while_active(
        || true,
        move || {
            flag.store(true, Ordering::Release);
            1usize
        },
    );

    assert_eq!(result, None);
    assert!(!called.load(Ordering::Acquire));
}

#[test]
fn collect_device_inventory_skips_hardware_queries_once_exit_begins() {
    let cameras_called = Arc::new(AtomicBool::new(false));
    let microphones_called = Arc::new(AtomicBool::new(false));
    let camera_flag = cameras_called.clone();
    let microphone_flag = microphones_called.clone();

    let result = collect_device_inventory(
        || true,
        true,
        true,
        move || {
            camera_flag.store(true, Ordering::Release);
            vec![1usize]
        },
        move || {
            microphone_flag.store(true, Ordering::Release);
            vec![2usize]
        },
    );

    assert_eq!(result, None);
    assert!(!cameras_called.load(Ordering::Acquire));
    assert!(!microphones_called.load(Ordering::Acquire));
}

#[test]
fn collect_device_inventory_respects_permissions_before_probings() {
    let cameras_called = Arc::new(AtomicBool::new(false));
    let microphones_called = Arc::new(AtomicBool::new(false));
    let camera_flag = cameras_called.clone();
    let microphone_flag = microphones_called.clone();

    let result = collect_device_inventory(
        || false,
        false,
        true,
        move || {
            camera_flag.store(true, Ordering::Release);
            vec![1usize]
        },
        move || {
            microphone_flag.store(true, Ordering::Release);
            vec![2usize]
        },
    );

    assert_eq!(result, Some((Vec::<usize>::new(), vec![2usize])));
    assert!(!cameras_called.load(Ordering::Acquire));
    assert!(microphones_called.load(Ordering::Acquire));
}

#[test]
fn collect_device_inventory_stops_before_second_probe_when_exit_begins_midway() {
    let exiting = Arc::new(AtomicBool::new(false));
    let cameras_called = Arc::new(AtomicBool::new(false));
    let microphones_called = Arc::new(AtomicBool::new(false));
    let exit_flag = exiting.clone();
    let camera_flag = cameras_called.clone();
    let microphone_flag = microphones_called.clone();

    let result = collect_device_inventory(
        move || exit_flag.load(Ordering::Acquire),
        true,
        true,
        move || {
            camera_flag.store(true, Ordering::Release);
            exiting.store(true, Ordering::Release);
            vec![1usize]
        },
        move || {
            microphone_flag.store(true, Ordering::Release);
            vec![2usize]
        },
    );

    assert_eq!(result, None);
    assert!(cameras_called.load(Ordering::Acquire));
    assert!(!microphones_called.load(Ordering::Acquire));
}

#[test]
fn read_target_under_cursor_skips_queries_once_exit_begins() {
    let display_called = Arc::new(AtomicBool::new(false));
    let window_called = Arc::new(AtomicBool::new(false));
    let display_flag = display_called.clone();
    let window_flag = window_called.clone();

    let result = read_target_under_cursor(
        || true,
        move || {
            display_flag.store(true, Ordering::Release);
            Some(1usize)
        },
        move || {
            window_flag.store(true, Ordering::Release);
            Some(2usize)
        },
    );

    assert_eq!(result, None);
    assert!(!display_called.load(Ordering::Acquire));
    assert!(!window_called.load(Ordering::Acquire));
}

#[test]
fn read_target_under_cursor_stops_before_window_query_when_exit_begins_midway() {
    let exiting = Arc::new(AtomicBool::new(false));
    let display_called = Arc::new(AtomicBool::new(false));
    let window_called = Arc::new(AtomicBool::new(false));
    let exit_flag = exiting.clone();
    let display_flag = display_called.clone();
    let window_flag = window_called.clone();

    let result = read_target_under_cursor(
        move || exit_flag.load(Ordering::Acquire),
        move || {
            display_flag.store(true, Ordering::Release);
            exiting.store(true, Ordering::Release);
            Some(1usize)
        },
        move || {
            window_flag.store(true, Ordering::Release);
            Some(2usize)
        },
    );

    assert_eq!(result, None);
    assert!(display_called.load(Ordering::Acquire));
    assert!(!window_called.load(Ordering::Acquire));
}

#[tokio::test]
async fn abort_all_tasks_cancels_background_tracking() {
    let task_flag = Arc::new(AtomicBool::new(false));
    let tasks_flag = Arc::new(AtomicBool::new(false));

    let task = {
        let task_flag = task_flag.clone();
        tokio::spawn(async move {
            let _flag = DropFlag(task_flag);
            std::future::pending::<()>().await;
        })
    };

    let tasks = vec![{
        let tasks_flag = tasks_flag.clone();
        tokio::spawn(async move {
            let _flag = DropFlag(tasks_flag);
            std::future::pending::<()>().await;
        })
    }];

    tokio::task::yield_now().await;
    abort_join_handles(tasks, Some(task));
    tokio::task::yield_now().await;

    assert!(task_flag.load(Ordering::Acquire));
    assert!(tasks_flag.load(Ordering::Acquire));
}

#[test]
fn app_exit_action_matches_current_platform() {
    #[cfg(target_os = "macos")]
    assert_eq!(app_exit_action(7), AppExitAction::Process(7));

    #[cfg(not(target_os = "macos"))]
    assert_eq!(app_exit_action(7), AppExitAction::Runtime(7));
}
