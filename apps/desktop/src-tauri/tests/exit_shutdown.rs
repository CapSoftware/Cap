#[path = "../src/exit_shutdown.rs"]
mod exit_shutdown;

use exit_shutdown::{
    AppExitAction, ExitBlocked, ExitRequestDecision, UpdateInstallState, abort_join_handles,
    app_exit_action, collect_device_inventory, handle_exit_requested, prepare_then_begin_exit,
    read_target_under_cursor, recording_start_allowed, run_while_active, with_idle_recording_state,
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
fn exit_refusals_do_not_start_shutdown_or_disable_active_watchers() {
    for reason in [
        ExitBlocked::StateUnavailable,
        ExitBlocked::RecordingActive,
        ExitBlocked::FinalizationActive,
        ExitBlocked::ExportActive,
        ExitBlocked::UpdateInstalling,
    ] {
        let state = tokio::sync::RwLock::new(());
        let exiting = AtomicBool::new(false);
        let result = with_idle_recording_state(
            &state,
            |_| Err(reason),
            || {
                exiting.store(true, Ordering::Release);
                true
            },
        );
        assert_eq!(result, Err(reason));
        assert!(!exiting.load(Ordering::Acquire));
        assert_eq!(
            run_while_active(|| exiting.load(Ordering::Acquire), || 1),
            Some(1)
        );
        assert!(!reason.message().is_empty());
    }
    assert!(recording_start_allowed(true, false).is_err());
    assert!(!ExitBlocked::AlreadyExiting.message().is_empty());
}

#[test]
fn failed_handoff_preparation_leaves_recording_available_and_success_commits_before_unlock() {
    for succeeds in [false, true] {
        let state = tokio::sync::RwLock::new(());
        let exiting = AtomicBool::new(false);
        let prepared = AtomicBool::new(false);
        let result = with_idle_recording_state(
            &state,
            |_| Ok(()),
            || {
                prepare_then_begin_exit(
                    || {
                        assert!(state.try_write().is_err());
                        assert!(!exiting.load(Ordering::Acquire));
                        prepared.store(true, Ordering::Release);
                        if succeeds {
                            Ok(())
                        } else {
                            Err("Child launch failed".into())
                        }
                    },
                    || {
                        assert!(state.try_write().is_err());
                        assert!(prepared.load(Ordering::Acquire));
                        !exiting.swap(true, Ordering::AcqRel)
                    },
                )
            },
        )
        .unwrap();
        assert_eq!(result.is_ok(), succeeds);
        assert_eq!(exiting.load(Ordering::Acquire), succeeds);
        assert!(state.try_write().is_ok());
        assert_eq!(
            recording_start_allowed(exiting.load(Ordering::Acquire), false).is_ok(),
            !succeeds
        );
    }
}

#[test]
fn recording_and_finalization_refusals_never_dispatch_an_installer() {
    for reason in [
        ExitBlocked::RecordingActive,
        ExitBlocked::FinalizationActive,
    ] {
        let state = tokio::sync::RwLock::new(());
        let install = UpdateInstallState::default();
        let dispatched = AtomicBool::new(false);
        let result = with_idle_recording_state(
            &state,
            |_| Err(reason),
            || {
                let _admission = install.begin().unwrap();
                dispatched.store(true, Ordering::Release);
            },
        );
        assert_eq!(result, Err(reason));
        assert!(!dispatched.load(Ordering::Acquire));
        assert!(!install.blocks_recording());
    }
}

#[test]
fn installer_failure_releases_only_its_start_block_without_beginning_shutdown() {
    let state = tokio::sync::RwLock::new(false);
    let install = UpdateInstallState::default();
    let exiting = AtomicBool::new(false);
    let run_install = || -> Result<(), &'static str> {
        let _admission = with_idle_recording_state(
            &state,
            |_| Ok(()),
            || {
                assert!(state.try_write().is_err());
                install.begin().unwrap()
            },
        )
        .unwrap();
        assert!(install.is_installing());
        assert!(install.begin().is_none());
        let mut recording = state.try_write().unwrap();
        let admitted =
            recording_start_allowed(exiting.load(Ordering::Acquire), install.blocks_recording());
        if admitted.is_ok() {
            *recording = true;
        }
        assert!(admitted.is_err());
        assert!(!*recording);
        Err("Installer failed before dispatch")
    };
    assert!(run_install().is_err());
    assert!(!install.blocks_recording());
    assert!(!exiting.load(Ordering::Acquire));
    assert!(recording_start_allowed(false, install.blocks_recording()).is_ok());
    assert!(run_install().is_err());
    assert!(!install.blocks_recording());
}

#[test]
fn successful_installer_keeps_start_block_only_when_it_may_exit_later() {
    for can_exit_later in [false, true] {
        let install = UpdateInstallState::default();
        let admission = install.begin().unwrap();
        assert!(install.is_installing());
        admission.complete(can_exit_later);
        assert!(!install.is_installing());
        assert_eq!(install.blocks_recording(), can_exit_later);
        assert_eq!(
            recording_start_allowed(false, install.blocks_recording()).is_err(),
            can_exit_later
        );
        assert_eq!(install.begin().is_none(), can_exit_later);
    }
}

#[test]
fn quit_during_stop_does_not_wait_for_or_interrupt_the_recording_writer() {
    let state = tokio::sync::RwLock::new(true);
    let mut stopping = state.try_write().unwrap();
    let result = with_idle_recording_state(
        &state,
        |_| panic!("Busy recording state must not be inspected"),
        || -> bool { panic!("Shutdown must not begin while Stop holds the state") },
    );
    assert_eq!(result, Err(ExitBlocked::StateUnavailable));
    *stopping = false;
    drop(stopping);
    let exiting = AtomicBool::new(false);
    assert_eq!(
        with_idle_recording_state(
            &state,
            |recording| {
                if *recording {
                    Err(ExitBlocked::RecordingActive)
                } else {
                    Ok(())
                }
            },
            || !exiting.swap(true, Ordering::AcqRel),
        ),
        Ok(true)
    );
}

#[test]
fn recording_start_and_exit_admission_cannot_both_succeed() {
    let state = Arc::new(tokio::sync::RwLock::new(false));
    let exiting = Arc::new(AtomicBool::new(false));
    let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
    let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
    let exit = {
        let state = state.clone();
        let exiting = exiting.clone();
        std::thread::spawn(move || {
            with_idle_recording_state(
                &state,
                |recording| {
                    if *recording {
                        Err(ExitBlocked::RecordingActive)
                    } else {
                        Ok(())
                    }
                },
                || {
                    entered_tx.send(()).unwrap();
                    release_rx
                        .recv_timeout(std::time::Duration::from_secs(2))
                        .unwrap();
                    !exiting.swap(true, Ordering::AcqRel)
                },
            )
        })
    };
    entered_rx
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    let start_was_locked = state.try_write().is_err();
    release_tx.send(()).unwrap();
    assert_eq!(exit.join().unwrap(), Ok(true));
    assert!(start_was_locked);
    let mut starting = state.try_write().unwrap();
    let start = recording_start_allowed(exiting.load(Ordering::Acquire), false);
    if start.is_ok() {
        *starting = true;
    }
    assert!(start.is_err());
    assert!(!*starting);
    drop(starting);

    let started_first = tokio::sync::RwLock::new(false);
    let mut starting = started_first.try_write().unwrap();
    recording_start_allowed(false, false).unwrap();
    *starting = true;
    drop(starting);
    assert_eq!(
        with_idle_recording_state(
            &started_first,
            |recording| {
                if *recording {
                    Err(ExitBlocked::RecordingActive)
                } else {
                    Ok(())
                }
            },
            || -> bool { panic!("An admitted recording must prevent shutdown") },
        ),
        Err(ExitBlocked::RecordingActive)
    );
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

#[test]
fn exit_requested_prevents_user_exit_when_already_exiting() {
    let prevented = Arc::new(AtomicBool::new(false));
    let prevented_flag = prevented.clone();

    let decision = handle_exit_requested(true, false, false, false, move || {
        prevented_flag.store(true, Ordering::Release);
    });

    assert_eq!(decision, ExitRequestDecision::AlreadyExiting);
    assert!(prevented.load(Ordering::Acquire));
}

#[test]
fn exit_requested_allows_runtime_exit_when_already_exiting() {
    let prevented = Arc::new(AtomicBool::new(false));
    let prevented_flag = prevented.clone();

    let decision = handle_exit_requested(true, false, true, false, move || {
        prevented_flag.store(true, Ordering::Release);
    });

    assert_eq!(decision, ExitRequestDecision::AllowRuntimeExit);
    assert!(!prevented.load(Ordering::Acquire));
}

#[test]
fn exit_requested_allows_runtime_exit_when_export_cancel_is_draining() {
    let prevented = Arc::new(AtomicBool::new(false));
    let prevented_flag = prevented.clone();

    let decision = handle_exit_requested(true, true, true, false, move || {
        prevented_flag.store(true, Ordering::Release);
    });

    assert_eq!(decision, ExitRequestDecision::AllowRuntimeExit);
    assert!(!prevented.load(Ordering::Acquire));
}

#[test]
fn exit_requested_prevents_runtime_exit_during_export() {
    let prevented = Arc::new(AtomicBool::new(false));
    let prevented_flag = prevented.clone();

    let decision = handle_exit_requested(false, true, true, false, move || {
        prevented_flag.store(true, Ordering::Release);
    });

    assert_eq!(decision, ExitRequestDecision::ExportActive);
    assert!(prevented.load(Ordering::Acquire));
}

#[test]
fn exit_requested_allows_runtime_restart_without_starting_cleanup() {
    let prevented = Arc::new(AtomicBool::new(false));
    let prevented_flag = prevented.clone();

    let decision = handle_exit_requested(false, false, true, true, move || {
        prevented_flag.store(true, Ordering::Release);
    });

    assert_eq!(decision, ExitRequestDecision::AllowRuntimeRestart);
    assert!(!prevented.load(Ordering::Acquire));
}

#[test]
fn exit_requested_allows_unpreventable_runtime_restart_during_export() {
    let prevented = Arc::new(AtomicBool::new(false));
    let prevented_flag = prevented.clone();

    let decision = handle_exit_requested(false, true, true, true, move || {
        prevented_flag.store(true, Ordering::Release);
    });

    assert_eq!(decision, ExitRequestDecision::AllowRuntimeRestart);
    assert!(!prevented.load(Ordering::Acquire));
}
