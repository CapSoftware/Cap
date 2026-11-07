use std::{
    path::Path,
    time::{Duration, Instant},
};

use anyhow::{Context as _, Result, ensure};
use objc2::{
    class, msg_send,
    rc::{Allocated, Retained, autoreleasepool},
    runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel},
};
use objc2_app_kit::{NSBackingStoreType, NSWindow, NSWindowStyleMask};
use objc2_foundation::{MainThreadMarker, NSDate, NSPoint, NSRect, NSRunLoop, NSSize};

use crate::{app_windows, platform, store};

pub fn run() {
    let sandbox =
        std::env::temp_dir().join(format!("cap-recording-window-test-{}", std::process::id()));
    std::fs::create_dir(&sandbox).expect("create isolated window test profile");
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

#[cfg(test)]
#[test]
#[ignore = "requires a built debug app and a macOS WindowServer session"]
fn recording_start_window_flow() {
    let binary = std::env::var_os("CAP_GPUI_REAL_APP_BIN")
        .expect("set CAP_GPUI_REAL_APP_BIN to the built debug cap-gpui binary");
    let output = std::process::Command::new(binary)
        .env("CAP_GPUI_TEST_RECORDING_WINDOW_START", "1")
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
    assert!(String::from_utf8_lossy(&output.stdout).contains("recording window regression passed"));
}
