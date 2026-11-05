use std::process::{Command, Stdio};

pub use crate::ux_walk_preferences::*;

#[path = "ux_walk/assets.rs"]
pub(crate) mod assets;

pub fn start(cx: &mut gpui::App) {
    let main = cx.global::<crate::app_windows::AppWindows>().main;
    main.update(cx, |view, _, cx| view.set_ux_walk(cx)).ok();
    crate::app_windows::show_main_window(cx);
}

/// Record Diatribe: an Instant screen and microphone recording that starts at once and is
/// processed like a walk into notes and action items. The recorder's mode is left as it was.
pub fn start_diatribe(cx: &mut gpui::App) {
    let main = cx.global::<crate::app_windows::AppWindows>().main;
    main.update(cx, |view, _, cx| view.start_diatribe(cx)).ok();
}

pub const DIATRIBE_TOPIC: &str = "Diatribe";

/// A walk request for a diatribe: the walk output folder and speakers, no browser page.
pub fn diatribe_request() -> Result<crate::ux_walk_journal::Request, String> {
    let mut request = request(DIATRIBE_TOPIC)?;
    request.kind = crate::ux_walk_journal::Kind::Diatribe;
    request.url.clear();
    Ok(request)
}

pub fn request(topic: &str) -> Result<crate::ux_walk_journal::Request, String> {
    let settings = load()?;
    let output = text(&settings, "outDir");
    let output = if output == "~" {
        dirs::home_dir().ok_or("Home folder is unavailable.")?
    } else if let Some(relative) = output.strip_prefix("~/") {
        dirs::home_dir()
            .ok_or("Home folder is unavailable.")?
            .join(relative)
    } else {
        std::path::PathBuf::from(output)
    };
    if !output.is_absolute() {
        return Err("Choose an absolute walk recordings folder in Settings.".into());
    }
    std::fs::create_dir_all(&output).map_err(|_| "Could not create the walk recordings folder.")?;
    let speakers = text(&settings, "speakers");
    let speakers = if speakers.is_empty() {
        text(&settings, "me")
    } else {
        speakers
    };
    Ok(crate::ux_walk_journal::Request {
        directory: output.join(format!(
            "{}-{}-{}",
            chrono::Local::now().format("%Y-%m-%d_%H-%M"),
            topic
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == ' ' || *c == '-')
                .take(48)
                .collect::<String>()
                .trim()
                .replace(' ', "-"),
            crate::store::new_uuid_v4()
        )),
        topic: if topic.trim().is_empty() {
            fork_brand::WALK_MODE_NAME.into()
        } else {
            topic.trim().to_string()
        },
        url: text(&settings, "url").to_string(),
        speakers: speakers
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
        kind: crate::ux_walk_journal::Kind::Walk,
    })
}

pub fn run_engine(command: &str, file: &std::path::Path) -> Result<String, String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let contents = executable
        .parent()
        .and_then(|p| p.parent())
        .ok_or("The app bundle is unavailable.")?;
    let engine = contents.join("Resources/ux-walk");
    let cli = contents.join("MacOS/cap-cli");
    let output = Command::new(engine.join("bin/node"))
        .arg(engine.join("native-walk.mjs"))
        .arg(command)
        .arg(file)
        .env("UXW_CAP_BINARY", cli)
        .env(
            "CAP_UX_WALK_CONFIG_DIR",
            config_path().parent().ok_or("Invalid settings folder.")?,
        )
        .env(
            "PATH",
            format!(
                "/opt/homebrew/bin:/usr/local/bin:{}",
                std::env::var("PATH").unwrap_or_default()
            ),
        )
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Could not start walk processing: {e}"))?;
    if output.status.success() {
        String::from_utf8(output.stdout)
            .map_err(|_| "Walk processing returned invalid text.".into())
    } else {
        Err(String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(1000)
            .collect())
    }
}

pub fn prompt_key(label: &str) -> Option<String> {
    prompt_secret(
        &format!("{label} API key"),
        fork_brand::mode_text_static(
            "Saved in your login Keychain for %walk%. Your audio is sent to this provider when transcription runs.",
        ),
    )
}

#[cfg(target_os = "macos")]
pub fn prompt_secret(title: &str, detail: &str) -> Option<String> {
    use objc2::{
        class, msg_send, msg_send_id,
        rc::{Allocated, Id},
        runtime::AnyObject,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
    unsafe {
        let alert: Id<AnyObject> = msg_send_id![class!(NSAlert), new];
        let field: Allocated<AnyObject> = msg_send_id![class!(NSSecureTextField), alloc];
        let field: Id<AnyObject> = msg_send_id![field, initWithFrame: NSRect::new(NSPoint::new(0., 0.), NSSize::new(320., 24.))];
        let _: () = msg_send![&*alert, setMessageText: &*NSString::from_str(title)];
        let _: () = msg_send![&*alert, setInformativeText: &*NSString::from_str(detail)];
        let _: () = msg_send![&*alert, setAccessoryView: &*field];
        let _: *mut AnyObject =
            msg_send![&*alert, addButtonWithTitle: &*NSString::from_str("Save")];
        let _: *mut AnyObject =
            msg_send![&*alert, addButtonWithTitle: &*NSString::from_str("Cancel")];
        let window: *mut AnyObject = msg_send![&*alert, window];
        let _: objc2::runtime::Bool = msg_send![window, makeFirstResponder: &*field];
        let response: isize = msg_send![&*alert, runModal];
        if response != 1000 {
            return None;
        }
        let value: Id<NSString> = msg_send_id![&*field, stringValue];
        Some(value.to_string())
    }
}

#[cfg(not(target_os = "macos"))]
pub fn prompt_secret(_title: &str, _detail: &str) -> Option<String> {
    None
}
