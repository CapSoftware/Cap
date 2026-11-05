use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};

use serde_json::{Map, Value};

#[derive(Clone, Copy)]
pub struct Provider {
    pub id: &'static str,
    pub label: &'static str,
    pub environment: &'static str,
    keychain_setting: &'static str,
    keychain_default: &'static str,
}

pub const PROVIDERS: &[Provider] = &[
    Provider {
        id: "elevenlabs",
        label: "ElevenLabs Scribe",
        environment: "ELEVENLABS_API_KEY",
        keychain_setting: "elevenlabsKeychainItem",
        keychain_default: "ux-walk-elevenlabs",
    },
    Provider {
        id: "assemblyai",
        label: "AssemblyAI",
        environment: "ASSEMBLYAI_API_KEY",
        keychain_setting: "assemblyaiKeychainItem",
        keychain_default: "ux-walk-assemblyai",
    },
    Provider {
        id: "descript",
        label: "Descript",
        environment: "DESCRIPT_API_TOKEN",
        keychain_setting: "descriptKeychainItem",
        keychain_default: "descript-mcp-token",
    },
    Provider {
        id: "none",
        label: "None",
        environment: "",
        keychain_setting: "",
        keychain_default: "",
    },
];

pub const HANDOFFS: &[(&str, &str)] = &[
    ("copy", "Copy agent prompt"),
    ("cmux", "Open Claude in cmux"),
];

pub fn config_path() -> PathBuf {
    std::env::var_os("CAP_UX_WALK_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".config/ux-walk"))
        .join("config.json")
}

fn read_file(path: &Path) -> Result<Map<String, Value>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(_) => {
            return Err(fork_brand::mode_text_static(
                "Could not read %walk% settings. Check the file permissions.",
            )
            .into());
        }
    };
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
        fork_brand::mode_text_static(
            "%walk% settings contain invalid JSON. Repair the file before saving.",
        )
        .to_string()
    })?;
    value.as_object().cloned().ok_or_else(|| {
        fork_brand::mode_text_static(
            "%walk% settings must contain a JSON object. The file was left unchanged.",
        )
        .into()
    })
}

pub fn load() -> Result<Map<String, Value>, String> {
    read_file(&config_path())
}

pub fn text<'a>(settings: &'a Map<String, Value>, key: &str) -> &'a str {
    settings
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(match key {
            "url" => "https://onc4ll.com",
            "outDir" => "~/Movies/ux-walk",
            "transcriber" => "elevenlabs",
            "language" => "en",
            "agent" => "copy",
            _ => "",
        })
}

/// The default for "Notes & action items" on ordinary Studio and Instant recordings.
pub const RECORDING_NOTES: &str = "recordingNotes";

/// Settings that are off until the owner turns them on.
const OFF_BY_DEFAULT: &[&str] = &["brief", RECORDING_NOTES];

pub fn enabled(settings: &Map<String, Value>, key: &str) -> bool {
    settings
        .get(key)
        .and_then(Value::as_bool)
        .unwrap_or(!OFF_BY_DEFAULT.contains(&key))
}

pub fn provider(settings: &Map<String, Value>) -> Option<Provider> {
    PROVIDERS
        .iter()
        .copied()
        .find(|provider| provider.id == text(settings, "transcriber"))
}

fn validate(key: &str, value: &Value) -> Result<(), String> {
    let valid = match key {
        "transcriber" => value
            .as_str()
            .is_some_and(|id| PROVIDERS.iter().any(|provider| provider.id == id)),
        "agent" => value
            .as_str()
            .is_some_and(|id| HANDOFFS.iter().any(|(value, _)| *value == id)),
        "askSpeakers" | "brief" | "screenNames" | "trace" | "liveTranscription"
        | RECORDING_NOTES => value.is_boolean(),
        "me" | "url" | "outDir" | "sourceRoot" | "speakers" | "glossary" | "language" => {
            value.as_str().is_some_and(|text| !text.contains('\0'))
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(fork_brand::mode_text_static("That %walk% setting or value is not supported.").into())
    }
}

static NEXT_WRITE: AtomicU64 = AtomicU64::new(0);

fn update_file(path: &Path, key: &str, value: Value) -> Result<Map<String, Value>, String> {
    validate(key, &value)?;
    let mut settings = read_file(path)?;
    settings.insert(key.into(), value);
    let parent = path.parent().ok_or(fork_brand::mode_text_static(
        "%walk% settings have no parent folder.",
    ))?;
    fs::create_dir_all(parent).map_err(|_| {
        fork_brand::mode_text_static("Could not create the %walk% settings folder.")
    })?;
    let temporary = parent.join(format!(
        ".config-{}-{}.tmp",
        std::process::id(),
        NEXT_WRITE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| -> Result<(), String> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| fork_brand::mode_text_static("Could not stage %walk% settings."))?;
        let mut bytes = serde_json::to_vec_pretty(&settings)
            .map_err(|_| fork_brand::mode_text_static("Could not encode %walk% settings."))?;
        bytes.push(b'\n');
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| fork_brand::mode_text_static("Could not save %walk% settings."))?;
        fs::rename(&temporary, path)
            .map_err(|_| fork_brand::mode_text_static("Could not replace %walk% settings."))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    Ok(settings)
}

pub fn save(key: &str, value: Value) -> Result<Map<String, Value>, String> {
    update_file(&config_path(), key, value)
}

fn keychain_item(settings: &Map<String, Value>, provider: Provider) -> String {
    settings
        .get(provider.keychain_setting)
        .and_then(Value::as_str)
        .unwrap_or(provider.keychain_default)
        .to_string()
}

fn account() -> String {
    std::env::var("USER").unwrap_or_default()
}

const NO_SAVED_KEY: &str = "No saved key";

/// Runs `key_status`, which starts a process, so call it off the main thread.
pub fn missing_key_warning(settings: &Map<String, Value>) -> Option<String> {
    let provider = provider(settings)?;
    key_warning(provider, key_status(settings, provider))
}

fn key_warning(provider: Provider, status: &str) -> Option<String> {
    (provider.id != "none" && status == NO_SAVED_KEY).then(|| {
        format!(
            "No {} key is saved, so this walk will have no transcript. Add the key in Settings > Transcription. You can record now and run saved audio later with Resume evidence sync.",
            provider.label
        )
    })
}

pub fn key_status(settings: &Map<String, Value>, provider: Provider) -> &'static str {
    if provider.id == "none" {
        return "Transcription is off";
    }
    if std::env::var(provider.environment).is_ok_and(|value| !value.is_empty()) {
        return "Using environment key";
    }
    if cfg!(target_os = "macos")
        && Command::new("/usr/bin/security")
            .args([
                "find-generic-password",
                "-a",
                &account(),
                "-s",
                &keychain_item(settings, provider),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    {
        "Saved in Keychain"
    } else {
        NO_SAVED_KEY
    }
}

fn security_argument(value: &str) -> Result<String, String> {
    if value.chars().any(char::is_control) {
        return Err("Keychain names must fit on one line.".into());
    }
    Ok(format!(
        "\"{}\"",
        value.replace('\\', "\\\\").replace('\"', "\\\"")
    ))
}

pub fn save_key(
    settings: &Map<String, Value>,
    provider: Provider,
    secret: &str,
) -> Result<(), String> {
    if !cfg!(target_os = "macos") || provider.id == "none" || secret.trim().is_empty() {
        return Err("Enter an API key to save in the macOS Keychain.".into());
    }
    let account = security_argument(&account())?;
    let item = security_argument(&keychain_item(settings, provider))?;
    let encoded = secret
        .trim()
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let mut process = Command::new("/usr/bin/security")
        .arg("-i")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Could not open the macOS Keychain.")?;
    let mut input = process
        .stdin
        .take()
        .ok_or("Could not send the key to Keychain.")?;
    let write = writeln!(
        input,
        "add-generic-password -U -a {account} -s {item} -X {encoded}"
    );
    drop(input);
    let status = process
        .wait()
        .map_err(|_| "Could not confirm that Keychain saved the key.")?;
    if write.is_ok() && status.success() {
        Ok(())
    } else {
        Err("Keychain did not save the key. Unlock your login Keychain and try again.".into())
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    use super::*;
    use serde_json::json;

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "ux-walk-preferences-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path.join("config.json"))
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(self.0.parent().unwrap()).unwrap();
        }
    }

    #[test]
    fn only_a_provider_without_a_key_warns() {
        let provider = |id: &str| *PROVIDERS.iter().find(|item| item.id == id).unwrap();
        let warning = key_warning(provider("assemblyai"), NO_SAVED_KEY).unwrap();
        assert!(warning.contains(provider("assemblyai").label));
        assert!(warning.contains("Settings"));
        assert_eq!(
            key_warning(provider("assemblyai"), "Saved in Keychain"),
            None
        );
        assert_eq!(
            key_warning(provider("descript"), "Using environment key"),
            None
        );
        assert_eq!(key_warning(provider("none"), NO_SAVED_KEY), None);
    }

    #[test]
    fn native_provider_choice_preserves_companion_preferences() {
        let fixture = Fixture::new();
        fs::write(&fixture.0, r##"{"transcriber":"elevenlabs","sourceRoot":"/work/app","contextSelectors":{"org":"#org"},"assemblyaiKeychainItem":"custom-item"}"##).unwrap();
        update_file(&fixture.0, "transcriber", json!("assemblyai")).unwrap();
        let saved: Value = serde_json::from_slice(&fs::read(&fixture.0).unwrap()).unwrap();
        assert_eq!(saved["transcriber"], "assemblyai");
        assert_eq!(saved["sourceRoot"], "/work/app");
        assert_eq!(saved["contextSelectors"], json!({"org":"#org"}));
        assert_eq!(saved["assemblyaiKeychainItem"], "custom-item");
    }

    #[test]
    fn malformed_existing_preferences_are_never_overwritten() {
        let fixture = Fixture::new();
        for original in ["{broken", "[]", "null"] {
            fs::write(&fixture.0, original).unwrap();
            assert!(update_file(&fixture.0, "me", json!("Alex")).is_err());
            assert_eq!(fs::read_to_string(&fixture.0).unwrap(), original);
        }
    }

    #[test]
    fn credentials_and_invalid_choices_are_refused_by_json_writer() {
        let fixture = Fixture::new();
        for (key, value) in [
            ("apiKey", json!("example-secret")),
            ("transcriber", json!("unknown")),
            ("askSpeakers", json!("yes")),
            ("agent", json!("shell-command")),
        ] {
            assert!(update_file(&fixture.0, key, value).is_err());
            assert!(!fixture.0.exists());
        }
    }

    #[test]
    fn recording_notes_default_off_and_save_as_a_switch() {
        let fixture = Fixture::new();
        assert!(!enabled(&Map::new(), RECORDING_NOTES));
        assert!(enabled(&Map::new(), "askSpeakers"));
        assert!(update_file(&fixture.0, RECORDING_NOTES, json!("yes")).is_err());
        let saved = update_file(&fixture.0, RECORDING_NOTES, json!(true)).unwrap();
        assert!(enabled(&saved, RECORDING_NOTES));
        assert!(enabled(&read_file(&fixture.0).unwrap(), RECORDING_NOTES));
    }
}
