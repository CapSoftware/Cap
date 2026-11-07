use std::time::{Duration, Instant};

use anyhow::{Result, ensure};
use gpui::{AppContext as _, AsyncApp, WindowHandle};

use crate::{
    app_windows::{self, AppWindows},
    main_window::MainWindow,
    session::{Phase, RecordingSession},
    store::{self, PostInstantBehaviour},
};

pub fn run() {
    let sandbox = std::env::temp_dir().join(format!(
        "cap-recording-completion-test-{}",
        std::process::id()
    ));
    std::fs::create_dir(&sandbox).expect("create isolated completion test profile");
    unsafe {
        std::env::set_var("CAP_GPUI_APP_DATA_DIR", &sandbox);
        std::env::set_var("CAP_GPUI_TAURI_STORE", sandbox.join("store"));
    }
    if !crate::permissions::necessary_granted() {
        std::fs::remove_dir_all(&sandbox).expect("remove isolated completion test profile");
        eprintln!(
            "completion flow needs existing permissions; it will not open onboarding or request access"
        );
        std::process::exit(1);
    }
    assert!(store::set_has_completed_startup(true));
    assert!(store::set_has_completed_onboarding(true));
    let runtime = crate::app_runtime();
    let app = gpui_platform::application().with_assets(crate::Assets);
    #[cfg(target_os = "macos")]
    crate::recording_window_tests::prevent_test_activation().expect("prevent test activation");
    let runtime_handle = runtime.handle().clone();
    app.run(move |cx| {
        gpui_tokio::init_from_handle(cx, runtime_handle);
        crate::Assets.load_fonts(cx).expect("load test fonts");
        crate::ui::bind_text_input_keys(cx);
        let settings = store::GeneralSettings::load();
        crate::i18n::init(settings.ui_language.as_deref());
        crate::theme::init(settings.theme, cx);
        let session = RecordingSession::init(cx);
        crate::sign_in::SignIn::init(cx);
        crate::feeds::Feeds::init(cx);
        crate::media_access::MediaAccess::init(cx);
        crate::target_overlay::TargetSelect::init(cx);
        let main = cx
            .open_window(window_options(), {
                let session = session.clone();
                move |window, cx| cx.new(|cx| MainWindow::new(session, window, cx))
            })
            .expect("open completion test main window");
        app_windows::init(main, session, cx);
        #[cfg(target_os = "macos")]
        let window = main
            .update(cx, |_, window, _| crate::platform::ns_window(window))
            .expect("read main window")
            .expect("main NSWindow");
        cx.spawn(async move |cx| {
            #[cfg(target_os = "macos")]
            {
                crate::recording_window_tests::prepare_test_window(&window)
                    .expect("prepare invisible test window");
                let native = crate::platform::test_native_window(window);
                crate::platform::lock_borderless_style(&native);
            }
            let result = exercise_completion(main, cx).await;
            std::fs::remove_dir_all(&sandbox).expect("remove isolated completion test profile");
            match result {
                Ok(()) => {
                    println!("native recording completion regression passed");
                    std::process::exit(0);
                }
                Err(error) => {
                    eprintln!("native recording completion regression failed: {error:#}");
                    std::process::exit(1);
                }
            }
        })
        .detach();
    });
}

fn window_options() -> gpui::WindowOptions {
    gpui::WindowOptions {
        window_bounds: Some(gpui::WindowBounds::Windowed(gpui::Bounds::new(
            gpui::point(gpui::px(-10000.), gpui::px(-10000.)),
            gpui::size(gpui::px(330.), gpui::px(436.)),
        ))),
        #[cfg(target_os = "linux")]
        app_id: Some("so.cap.app.recording-completion-test".into()),
        #[cfg(target_os = "windows")]
        titlebar: Some(gpui::TitlebarOptions::default()),
        #[cfg(not(target_os = "windows"))]
        titlebar: None,
        #[cfg(target_os = "macos")]
        kind: gpui::WindowKind::Floating,
        is_resizable: false,
        is_minimizable: cfg!(target_os = "windows"),
        focus: false,
        show: false,
        ..Default::default()
    }
}

async fn exercise_completion(main: WindowHandle<MainWindow>, cx: &mut AsyncApp) -> Result<()> {
    #[cfg(target_os = "linux")]
    ensure!(
        cx.update(|cx| main.update(cx, |_, window, _| window.retained_visibility()))?
            .is_some(),
        "run the native Linux regression under a Wayland compositor"
    );
    let behaviours = if cfg!(target_os = "linux") {
        &[PostInstantBehaviour::ShowCap][..]
    } else {
        &[
            PostInstantBehaviour::OpenLink,
            PostInstantBehaviour::CopyLink,
            PostInstantBehaviour::ShowCap,
        ][..]
    };
    for &behaviour in behaviours {
        let (disable_links, show_cap) = behaviour.store_values();
        ensure!(
            store::set_store_setting(
                store::GENERAL_SETTINGS,
                "disableAutoOpenLinks",
                disable_links.into()
            ) && store::set_store_setting(
                store::GENERAL_SETTINGS,
                store::SHOW_MAIN_WINDOW_AFTER_INSTANT_KEY,
                show_cap.into()
            ),
            "save completion preference"
        );
        let cases = if cfg!(target_os = "linux") {
            &[
                ("minimise", false, false),
                ("close", true, false),
                ("minimise", false, false),
            ][..]
        } else {
            &[
                ("minimise", false, false),
                ("minimise", true, false),
                ("close", false, false),
                ("minimise", false, true),
            ][..]
        };
        for &(setting, picker_hidden, reopened) in cases {
            ensure!(
                store::set_store_setting(
                    store::GENERAL_SETTINGS,
                    "mainWindowRecordingStartBehaviour",
                    setting.into()
                ),
                "save recording-start preference"
            );
            cx.update(app_windows::show_main_window);
            await_window(main, cx, true, false).await?;
            #[cfg(target_os = "linux")]
            eprintln!(
                "CAP_RECORDING_CASE_BEGIN setting={setting} picker_hidden={picker_hidden} reopened={reopened}"
            );
            cx.update(|cx| {
                RecordingSession::global(cx).update(cx, |session, cx| {
                    session.phase = Phase::Starting;
                    cx.notify();
                });
                if picker_hidden {
                    app_windows::hide_main_window(cx);
                }
                app_windows::put_main_window_away_for_recording(cx);
            });
            await_window(main, cx, false, setting == "minimise").await?;
            if reopened {
                cx.update(app_windows::show_main_window);
                await_window(main, cx, true, false).await?;
                cx.update(|cx| main.update(cx, |_, window, _| window.minimize_window()))?;
                await_window(main, cx, false, true).await?;
            }
            cx.update(|cx| {
                RecordingSession::global(cx).update(cx, |session, cx| {
                    session.finished_instant = true;
                    session.phase = Phase::Idle;
                    cx.notify();
                });
            });
            let should_show = behaviour == PostInstantBehaviour::ShowCap || reopened;
            await_window(main, cx, should_show, !should_show && setting == "minimise").await?;
            ensure!(
                cx.update(|cx| cx.global::<AppWindows>().main_hidden_by_app) != should_show,
                "{behaviour:?}: unexpected app-hidden state"
            );
            #[cfg(target_os = "linux")]
            eprintln!("CAP_RECORDING_CASE_END");
            println!(
                "{behaviour:?}, {setting}, picker_hidden={picker_hidden}, reopened={reopened}: passed"
            );
        }
    }
    Ok(())
}

async fn await_window(
    main: WindowHandle<MainWindow>,
    cx: &mut AsyncApp,
    shown: bool,
    minimized: bool,
) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut stable = 0;
    loop {
        let matches = cx.update(|cx| {
            main.update(cx, |_, window, _| {
                #[cfg(target_os = "linux")]
                {
                    window.retained_visibility() == Some(shown || minimized)
                }
                #[cfg(not(target_os = "linux"))]
                {
                    let native_minimized = crate::platform::window_is_minimized(window);
                    let visible = crate::platform::window_is_visible(window) && !native_minimized;
                    visible == shown && native_minimized == minimized
                }
            })
        })?;
        stable = if matches { stable + 1 } else { 0 };
        if stable == 3 {
            return Ok(());
        }
        ensure!(
            Instant::now() < deadline,
            "expected shown={shown}, minimized={minimized} after recording-window action"
        );
        cx.background_executor()
            .timer(Duration::from_millis(20))
            .await;
    }
}

#[cfg(test)]
#[test]
#[ignore = "requires a built debug app and a native window session; use an isolated Wayland compositor on Linux"]
fn native_recording_completion_flow() {
    let binary = std::env::var_os("CAP_GPUI_REAL_APP_BIN")
        .expect("set CAP_GPUI_REAL_APP_BIN to the debug app");
    let mut command = std::process::Command::new(binary);
    command.env("CAP_GPUI_TEST_RECORDING_COMPLETION", "1");
    #[cfg(target_os = "linux")]
    command.env("WAYLAND_DEBUG", "client");
    #[cfg(target_os = "macos")]
    command.env(
        "DYLD_FALLBACK_LIBRARY_PATH",
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/native-deps/Spacedrive.framework/Libraries"),
    );
    let output = command.output().expect("run native completion regression");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout)
            .contains("native recording completion regression passed")
    );
    #[cfg(target_os = "linux")]
    {
        let protocol = String::from_utf8_lossy(&output.stderr);
        let mut checked = 0;
        for case in protocol.split("CAP_RECORDING_CASE_BEGIN ").skip(1) {
            let (header, body) = case.split_once('\n').expect("Wayland case header");
            if !header.starts_with("setting=minimise") || !header.ends_with("reopened=false") {
                continue;
            }
            let (body, _) = body
                .split_once("CAP_RECORDING_CASE_END")
                .expect("Wayland case finished");
            let minimized = body
                .find(".set_minimized(")
                .expect("Wayland minimize request");
            let after_minimize = &body[minimized..];
            let unmap = after_minimize
                .find(".attach(nil")
                .expect("unmap after minimize");
            let remap = &after_minimize[unmap..];
            let configure = remap
                .find(".ack_configure(")
                .expect("fresh restore configure");
            assert!(
                remap[configure..].contains(".attach(wl_buffer"),
                "restore must present a new buffer after its configure"
            );
            checked += 1;
        }
        assert_eq!(checked, 2, "check repeated minimised-window restores");
    }
}
