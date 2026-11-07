use std::{
    path::Path,
    time::{Duration, Instant},
};

use anyhow::{Context as _, Result, ensure};
use gpui::AppContext as _;
use objc2::{
    class, msg_send,
    rc::{Allocated, Retained, autoreleasepool},
    runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel},
};
use objc2_app_kit::{NSBackingStoreType, NSWindow, NSWindowStyleMask};
use objc2_foundation::{MainThreadMarker, NSDate, NSPoint, NSRect, NSRunLoop, NSSize};

use crate::{app_windows, platform, store};

static ACTIVATION_REQUESTS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static WINDOWS_VISIBILITY: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub fn run() {
    let sandbox =
        std::env::temp_dir().join(format!("cap-recording-window-test-{}", std::process::id()));
    std::fs::create_dir(&sandbox).expect("create isolated window test profile");
    if std::env::var("CAP_GPUI_TEST_RECORDING_WINDOW_START").as_deref() == Ok("dock") {
        unsafe {
            std::env::set_var("CAP_GPUI_APP_DATA_DIR", &sandbox);
            std::env::set_var("CAP_GPUI_TAURI_STORE", sandbox.join("store"));
        }
        run_dock_flow(sandbox);
        return;
    }
    let result = autoreleasepool(|_| run_flow(&sandbox));
    std::fs::remove_dir_all(&sandbox).expect("remove isolated window test profile");
    if let Err(error) = result {
        eprintln!("recording window regression failed: {error:#}");
        std::process::exit(1);
    }
    println!("recording window regression passed");
}

fn run_flow(sandbox: &Path) -> Result<()> {
    unsafe {
        std::env::set_var("CAP_GPUI_APP_DATA_DIR", sandbox);
        std::env::set_var("CAP_GPUI_TAURI_STORE", sandbox.join("store"));
    }
    let _main_thread =
        MainThreadMarker::new().context("native test must run on the main thread")?;
    let frontmost = frontmost_pid();
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let _: bool = msg_send![app, setActivationPolicy: 1isize];
        let _: () = msg_send![app, finishLaunching];
    }
    let window = test_panel()?;
    let native = platform::test_native_window(window.clone());
    platform::lock_borderless_style(&native);
    let result = exercise_recording_window(&window, &native);
    platform::hide_native(&native);
    window.close();
    result?;
    ensure!(
        frontmost_pid() == frontmost,
        "native test changed the active app"
    );
    Ok(())
}

fn test_panel() -> Result<Retained<NSWindow>> {
    unsafe extern "C-unwind" fn cannot_become_key(_: *mut AnyObject, _: Sel) -> Bool {
        Bool::NO
    }

    unsafe extern "C-unwind" fn occlusion_changed(_: *mut AnyObject, _: Sel, _: *mut AnyObject) {}

    let superclass = AnyClass::get(c"NSPanel").context("NSPanel is unavailable")?;
    let mut builder = ClassBuilder::new(c"CapRecordingWindowTestPanel", superclass)
        .context("test panel class")?;
    unsafe {
        builder.add_method(
            objc2::sel!(canBecomeKeyWindow),
            cannot_become_key as unsafe extern "C-unwind" fn(*mut AnyObject, Sel) -> Bool,
        );
        builder.add_method(
            objc2::sel!(windowDidChangeOcclusionState:),
            occlusion_changed as unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
        );
    }
    let class = builder.register();
    let allocated: Allocated<NSWindow> = unsafe { msg_send![class, alloc] };
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            allocated,
            NSRect::new(NSPoint::new(-10000., -10000.), NSSize::new(330., 436.)),
            NSWindowStyleMask::Titled | NSWindowStyleMask::FullSizeContentView,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    unsafe {
        window.setReleasedWhenClosed(false);
    }
    window.setAlphaValue(0.);
    window.setAnimationBehavior(objc2_app_kit::NSWindowAnimationBehavior::None);
    window.setLevel(platform::MAIN_WINDOW_LEVEL);
    Ok(window)
}

fn exercise_recording_window(window: &NSWindow, native: &platform::NativeWindow) -> Result<()> {
    ensure!(
        store::GeneralSettings::load().main_window_recording_start_behaviour
            == store::MainWindowStartBehaviour::Close,
        "fresh settings must default to Close"
    );
    for picker_hidden in [false, true] {
        reopen(window, native)?;
        if picker_hidden {
            platform::hide_native(native);
        }
        app_windows::apply_main_window_recording_start_behaviour(native);
        assert_state(window, false, false)?;
        assert_custom_chrome(window)?;
        println!("default Close, picker_hidden={picker_hidden}: passed");
    }

    for (setting, minimised) in [("minimise", true), ("close", false), ("minimise", true)] {
        ensure!(
            store::set_store_setting(
                store::GENERAL_SETTINGS,
                "mainWindowRecordingStartBehaviour",
                setting.into()
            ),
            "setting was not saved"
        );
        for picker_hidden in [false, true] {
            reopen(window, native)?;
            if picker_hidden {
                platform::hide_native(native);
            }
            app_windows::apply_main_window_recording_start_behaviour(native);
            assert_state(window, false, minimised)
                .with_context(|| format!("{setting}, picker_hidden={picker_hidden}"))?;
            assert_custom_chrome(window)?;
            platform::restore_borderless_style(native);
            assert_state(window, false, minimised)?;
            window.setStyleMask(window.styleMask() | NSWindowStyleMask::Resizable);
            assert_custom_chrome(window)?;
            reopen(window, native)?;
            assert_custom_chrome(window)?;
            println!("{setting}, picker_hidden={picker_hidden}, reopen: passed");
        }
    }
    Ok(())
}

fn reopen(window: &NSWindow, native: &platform::NativeWindow) -> Result<()> {
    platform::show_native(native);
    assert_state(window, true, false)
}

fn assert_state(window: &NSWindow, visible: bool, minimised: bool) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut stable = 0;
    loop {
        if window.isVisible() == visible && window.isMiniaturized() == minimised {
            stable += 1;
            if stable == 2 {
                return Ok(());
            }
        } else {
            stable = 0;
        }
        ensure!(
            Instant::now() < deadline,
            "expected visible={visible}, minimised={minimised}; actual visible={}, minimised={}",
            window.isVisible(),
            window.isMiniaturized()
        );
        NSRunLoop::mainRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.01));
    }
}

fn assert_custom_chrome(window: &NSWindow) -> Result<()> {
    ensure!(
        window.styleMask() == NSWindowStyleMask::Titled | NSWindowStyleMask::FullSizeContentView,
        "main window style changed: {:?}",
        window.styleMask()
    );
    for button in [0usize, 1, 2] {
        let button: *mut AnyObject = unsafe { msg_send![window, standardWindowButton: button] };
        ensure!(button.is_null(), "native titlebar button appeared");
    }
    Ok(())
}

fn frontmost_pid() -> i32 {
    unsafe {
        let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        let app: *mut AnyObject = msg_send![workspace, frontmostApplication];
        msg_send![app, processIdentifier]
    }
}

fn run_dock_flow(sandbox: std::path::PathBuf) {
    let frontmost = frontmost_pid();
    let runtime = crate::app_runtime();
    let app = gpui_platform::application().with_assets(crate::Assets);
    prevent_test_activation().expect("keep the Dock test from activating the app");
    let runtime_handle = runtime.handle().clone();
    app.run(move |cx| {
        gpui_tokio::init_from_handle(cx, runtime_handle);
        crate::Assets.load_fonts(cx).expect("load test fonts");
        crate::ui::bind_text_input_keys(cx);
        let settings = store::GeneralSettings::load();
        crate::i18n::init(settings.ui_language.as_deref());
        crate::theme::init(settings.theme, cx);
        let session = crate::session::RecordingSession::init(cx);
        crate::sign_in::SignIn::init(cx);
        crate::feeds::Feeds::init(cx);
        crate::media_access::MediaAccess::init(cx);
        crate::target_overlay::TargetSelect::init(cx);
        let main = cx
            .open_window(test_window_options(), {
                let session = session.clone();
                move |window, cx| {
                    cx.new(|cx| crate::main_window::MainWindow::new(session, window, cx))
                }
            })
            .expect("open isolated GPUI main window");
        app_windows::init(main, session.clone(), cx);
        let controls = cx
            .open_window(test_window_options(), move |window, cx| {
                cx.new(|cx| {
                    crate::controls_window::ControlsWindow::new(session, false, window, cx)
                })
            })
            .expect("open isolated GPUI recording controls");
        let window = main
            .update(cx, |_, window, _| platform::ns_window(window))
            .expect("read main window")
            .expect("main NSWindow");
        let controls_window = controls
            .update(cx, |_, window, _| platform::ns_window(window))
            .expect("read recording controls")
            .expect("controls NSWindow");
        cx.spawn(async move |cx| {
            let result = async {
                prepare_test_window(&window)?;
                prepare_test_window(&controls_window)?;
                let native = platform::test_native_window(window.clone());
                let controls_native = platform::test_native_window(controls_window);
                platform::lock_borderless_style(&native);
                for controls_present in [false, true] {
                    cx.update(|cx| {
                        cx.global_mut::<app_windows::AppWindows>().controls =
                            controls_present.then_some(controls);
                    });
                    if controls_present {
                        platform::show_native(&controls_native);
                    } else {
                        platform::hide_native(&controls_native);
                    }
                    for hide_dock_icon in [false, true] {
                        ensure!(
                            store::set_store_setting(
                                store::GENERAL_SETTINGS,
                                "hideDockIcon",
                                hide_dock_icon.into()
                            ),
                            "Dock preference was not saved"
                        );
                        for (setting, minimised) in
                            [("close", false), ("minimise", true), ("minimise", true)]
                        {
                            ensure!(
                                store::set_store_setting(
                                    store::GENERAL_SETTINGS,
                                    "mainWindowRecordingStartBehaviour",
                                    setting.into()
                                ),
                                "recording-start preference was not saved"
                            );
                            for picker_hidden in [false, true] {
                                platform::show_native(&native);
                                if picker_hidden {
                                    platform::hide_native(&native);
                                }
                                let initial_policy =
                                    isize::from(hide_dock_icon && controls_present && picker_hidden);
                                unsafe {
                                    let app: *mut AnyObject =
                                        msg_send![class!(NSApplication), sharedApplication];
                                    let _: bool =
                                        msg_send![app, setActivationPolicy: initial_policy];
                                    ensure!(
                                        platform::activation_policy() == initial_policy,
                                        "set initial activation policy={initial_policy}, actual={}",
                                        platform::activation_policy()
                                    );
                                }
                                let before = crate::menus::test_dock_sync_state().0;
                                let activations =
                                    ACTIVATION_REQUESTS.load(std::sync::atomic::Ordering::Acquire);
                                cx.update(app_windows::put_main_window_away_for_recording);
                                await_dock_sync(cx, before).await?;
                                let context = format!(
                                    "{setting}, hide_dock_icon={hide_dock_icon}, controls={controls_present}, picker_hidden={picker_hidden}"
                                );
                                ensure!(
                                    !window.isVisible() && window.isMiniaturized() == minimised,
                                    "{context}: visible={}, minimised={}",
                                    window.isVisible(),
                                    window.isMiniaturized()
                                );
                                let expected_policy = if minimised || !hide_dock_icon {
                                    0
                                } else if controls_present {
                                    initial_policy
                                } else {
                                    1
                                };
                                ensure!(
                                    platform::activation_policy() == expected_policy,
                                    "{context}: expected Dock policy={expected_policy}, actual={}",
                                    platform::activation_policy()
                                );
                                if minimised {
                                    ensure!(
                                        ACTIVATION_REQUESTS
                                            .load(std::sync::atomic::Ordering::Acquire)
                                            == activations,
                                        "{context}: minimising requested app activation"
                                    );
                                }
                                assert_custom_chrome(&window)?;
                                platform::show_native(&native);
                                ensure!(
                                    window.isVisible() && !window.isMiniaturized(),
                                    "{context}: window did not reopen"
                                );
                                println!("{context}, scheduled Dock update and reopen: passed");
                            }
                        }
                    }
                }
                cx.update(|cx| cx.global_mut::<app_windows::AppWindows>().controls = None);
                platform::hide_native(&controls_native);
                exercise_instant_completion(cx, &window, &native).await?;
                platform::hide_native(&native);
                platform::hide_native(&controls_native);
                ensure!(frontmost_pid() == frontmost, "Dock test changed the active app");
                Ok::<_, anyhow::Error>(())
            }
            .await;
            std::fs::remove_dir_all(&sandbox).expect("remove isolated Dock test profile");
            match result {
                Ok(()) => {
                    println!("recording Dock regression passed");
                    std::process::exit(0);
                }
                Err(error) => {
                    eprintln!("recording Dock regression failed: {error:#}");
                    std::process::exit(1);
                }
            }
        })
        .detach();
    });
}

fn test_window_options() -> gpui::WindowOptions {
    gpui::WindowOptions {
        window_bounds: Some(gpui::WindowBounds::Windowed(gpui::Bounds::new(
            gpui::point(gpui::px(-10000.), gpui::px(-10000.)),
            gpui::size(gpui::px(330.), gpui::px(436.)),
        ))),
        titlebar: None,
        kind: gpui::WindowKind::Floating,
        is_resizable: false,
        is_minimizable: false,
        focus: false,
        show: false,
        ..Default::default()
    }
}

pub(crate) fn prevent_test_activation() -> Result<()> {
    unsafe extern "C-unwind" fn do_not_activate(_: *mut AnyObject, _: Sel, _: Bool) {
        ACTIVATION_REQUESTS.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    }

    let superclass = AnyClass::get(c"GPUIApplication").context("GPUIApplication is unavailable")?;
    let mut builder = ClassBuilder::new(c"CapRecordingDockTestApp", superclass)
        .context("test application class")?;
    unsafe {
        builder.add_method(
            objc2::sel!(activateIgnoringOtherApps:),
            do_not_activate as unsafe extern "C-unwind" fn(*mut AnyObject, Sel, Bool),
        );
        let app: Retained<AnyObject> = msg_send![superclass, sharedApplication];
        AnyObject::set_class(&app, builder.register());
    }
    Ok(())
}

pub(crate) fn prepare_test_window(window: &NSWindow) -> Result<()> {
    unsafe extern "C-unwind" fn cannot_become_key(_: *mut AnyObject, _: Sel) -> Bool {
        Bool::NO
    }

    unsafe extern "C-unwind" fn windows_visibility(this: *mut AnyObject, _: Sel) -> Bool {
        unsafe {
            let visible: Bool = msg_send![super(&*this, class!(NSWindow)), isVisible];
            let minimised: Bool = msg_send![this, isMiniaturized];
            Bool::new(
                visible.as_bool()
                    || (WINDOWS_VISIBILITY.load(std::sync::atomic::Ordering::Acquire)
                        && minimised.as_bool()),
            )
        }
    }

    // Only test-owned objects are subclassed, so real Dock policy runs without stealing focus.
    let class = if let Some(class) = AnyClass::get(c"CapRecordingDockTestPanel") {
        class
    } else {
        let object: &AnyObject = window;
        let mut builder = ClassBuilder::new(c"CapRecordingDockTestPanel", object.class())
            .context("GPUI test panel class")?;
        unsafe {
            builder.add_method(
                objc2::sel!(canBecomeKeyWindow),
                cannot_become_key as unsafe extern "C-unwind" fn(*mut AnyObject, Sel) -> Bool,
            );
            builder.add_method(
                objc2::sel!(isVisible),
                windows_visibility as unsafe extern "C-unwind" fn(*mut AnyObject, Sel) -> Bool,
            );
        }
        builder.register()
    };
    unsafe {
        AnyObject::set_class(window, class);
    }
    window.setAlphaValue(0.);
    window.setAnimationBehavior(objc2_app_kit::NSWindowAnimationBehavior::None);
    window.setFrameOrigin(NSPoint::new(-10000., -10000.));
    Ok(())
}

async fn exercise_instant_completion(
    cx: &mut gpui::AsyncApp,
    window: &NSWindow,
    native: &platform::NativeWindow,
) -> Result<()> {
    for windows_visibility in [true, false] {
        WINDOWS_VISIBILITY.store(windows_visibility, std::sync::atomic::Ordering::Release);
        for behaviour in [
            store::PostInstantBehaviour::OpenLink,
            store::PostInstantBehaviour::CopyLink,
        ] {
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
                "save Instant completion choice"
            );
            for setting in ["minimise", "close", "minimise"] {
                ensure!(
                    store::set_store_setting(
                        store::GENERAL_SETTINGS,
                        "mainWindowRecordingStartBehaviour",
                        setting.into()
                    ),
                    "save recording-start choice"
                );
                platform::show_native(native);
                cx.update(|cx| {
                    crate::session::RecordingSession::global(cx).update(cx, |session, cx| {
                        session.phase = crate::session::Phase::Starting;
                        cx.notify();
                    });
                });
                let before = crate::menus::test_dock_sync_state().0;
                cx.update(app_windows::put_main_window_away_for_recording);
                await_dock_sync(cx, before).await?;
                let minimised = setting == "minimise";
                ensure!(
                    window.isMiniaturized() == minimised,
                    "Instant setup did not apply {setting}"
                );
                if windows_visibility && minimised {
                    ensure!(
                        window.isVisible(),
                        "Windows visibility contract was not exercised"
                    );
                }
                let before = crate::menus::test_dock_sync_state().0;
                cx.update(|cx| {
                    crate::session::RecordingSession::global(cx).update(cx, |session, cx| {
                        session.finished_instant = true;
                        session.phase = crate::session::Phase::Idle;
                        cx.notify();
                    });
                });
                await_dock_sync(cx, before).await?;
                ensure!(
                    cx.update(|cx| {
                        let windows = cx.global::<app_windows::AppWindows>();
                        windows.main_hidden_by_app && windows.onboarding.is_none()
                    }),
                    "{behaviour:?}, {setting}, windows_visibility={windows_visibility}: completion attempted to reopen Cap"
                );
                ensure!(
                    window.isMiniaturized() == minimised,
                    "{behaviour:?}: completion restored the minimised window"
                );
                println!(
                    "Instant {behaviour:?}, {setting}, windows_visibility={windows_visibility}: completion kept Cap away"
                );
            }
        }
    }
    WINDOWS_VISIBILITY.store(false, std::sync::atomic::Ordering::Release);
    Ok(())
}

async fn await_dock_sync(cx: &mut gpui::AsyncApp, before: u64) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let (scheduled, completed) = crate::menus::test_dock_sync_state();
        if scheduled > before && scheduled == completed {
            return Ok(());
        }
        ensure!(
            Instant::now() < deadline,
            "recording start did not finish its scheduled Dock update: before={before}, scheduled={scheduled}, completed={completed}"
        );
        cx.background_executor()
            .timer(Duration::from_millis(10))
            .await;
    }
}

#[cfg(test)]
#[test]
#[ignore = "requires a built debug app and a macOS WindowServer session"]
fn recording_start_window_flow() {
    run_regression("1", "recording window regression passed");
}

#[cfg(test)]
#[test]
#[ignore = "requires a built debug app and a macOS WindowServer session"]
fn recording_start_dock_flow() {
    run_regression("dock", "recording Dock regression passed");
}

#[cfg(test)]
fn run_regression(mode: &str, expected_output: &str) {
    let binary = std::env::var_os("CAP_GPUI_REAL_APP_BIN")
        .expect("set CAP_GPUI_REAL_APP_BIN to the built debug cap-gpui binary");
    let output = std::process::Command::new(binary)
        .env("CAP_GPUI_TEST_RECORDING_WINDOW_START", mode)
        .env(
            "DYLD_FALLBACK_LIBRARY_PATH",
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/native-deps/Spacedrive.framework/Libraries"),
        )
        .output()
        .expect("run native recording window regression");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains(expected_output));
}
