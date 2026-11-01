use serde_json::{Value, json};
use std::{
    fs,
    io::Write as _,
    path::Path,
    process::{Command, Stdio},
};

fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        fs::File::open(path)
            .and_then(|file| file.sync_all())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// The session clears its clock in `finish`, before the monitor writes the terminal heartbeat,
/// so the session's elapsed time reads zero exactly when the worker needs the final clock.
pub fn heartbeat_clock(previous: u64, elapsed: u64, journal_duration: Option<u64>) -> u64 {
    previous
        .max(elapsed)
        .max(journal_duration.unwrap_or_default())
}

pub fn heartbeat(
    journal: &crate::ux_walk_journal::Journal,
    generation: u64,
    elapsed: u64,
    paused: bool,
    draft: &str,
    microphone: bool,
    system_audio: bool,
    capture_ended: bool,
) -> Result<(), String> {
    let directory = &journal.request.directory;
    let file = directory.join("checkpoint-heartbeat.json");
    let temporary = directory.join(format!(".checkpoint-heartbeat-{}.tmp", std::process::id()));
    let wall = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis() as u64;
    let value = json!({ "schemaVersion": 1, "parentPid": std::process::id(), "generation": generation, "wallMs": wall, "activeElapsedMs": elapsed, "paused": paused, "captureEnded": capture_ended, "noteDraft": draft, "expectedAudio": { "microphone": microphone, "systemAudio": system_audio } });
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut target = options
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    target
        .write_all(&serde_json::to_vec(&value).map_err(|error| error.to_string())?)
        .and_then(|()| target.sync_all())
        .map_err(|error| error.to_string())?;
    fs::rename(temporary, file).map_err(|error| error.to_string())?;
    sync_directory(directory)
}

pub fn start(journal: &crate::ux_walk_journal::Journal) -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let contents = executable
        .parent()
        .and_then(Path::parent)
        .ok_or("App bundle is unavailable.")?;
    let engine = contents.join("Resources/ux-walk");
    let mut log = fs::OpenOptions::new();
    log.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        log.mode(0o600);
    }
    let log = log
        .open(journal.request.directory.join("checkpoint-worker.log"))
        .map_err(|error| error.to_string())?;
    let mut child = Command::new(engine.join("bin/node"))
        .arg(engine.join("checkpoint-worker.mjs"))
        .arg(journal.file())
        .env("UXW_CAP_BINARY", contents.join("MacOS/cap-cli"))
        .env("CAP_UX_SHARING_CONFIG", cap_cloud_sharing::config_path()?)
        .env(
            "CAP_UX_WALK_CONFIG_DIR",
            crate::ux_walk::config_path()
                .parent()
                .ok_or("Walk settings folder is unavailable.")?,
        )
        .env(
            "PATH",
            format!(
                "/opt/homebrew/bin:/usr/local/bin:{}",
                std::env::var("PATH").unwrap_or_default()
            ),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log))
        .spawn()
        .map_err(|error| format!("Could not start evidence checkpoints: {error}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

pub fn recovery_notice(directory: &Path) -> Option<String> {
    let status: Value =
        serde_json::from_slice(&fs::read(directory.join("checkpoint-status.json")).ok()?).ok()?;
    (status["phase"] == "resume-needed")
        .then(|| status["error"].as_str().map(str::to_string))
        .flatten()
}

pub fn notice(directory: &Path) -> String {
    let file = directory.join("checkpoint-status.json");
    let Some(status) = fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    else {
        return "Evidence checkpoints are starting. Video recording continues normally.".into();
    };
    let clock = |value: u64| format!("{}:{:02}", value / 60000, value / 1000 % 60);
    let local = status["localClockThroughMs"].as_u64().unwrap_or(0);
    let remote = status["remoteClockThroughMs"]
        .as_u64()
        .filter(|value| *value > 0);
    let sources = status["sources"]
        .as_object()
        .map_or(0, |sources| sources.len());
    let backup = if status["backupEnabled"] == true {
        match remote {
            Some(remote) => format!("Notes backed up through {}.", clock(remote)),
            None => "Notes backup is awaiting confirmation.".into(),
        }
    } else {
        "Private backup is off.".into()
    };
    let warning = status["error"]
        .as_str()
        .filter(|text| !text.is_empty())
        .map(|text| format!(" {text}"))
        .unwrap_or_default();
    let unsupported = status["sourceErrors"]
        .as_object()
        .is_some_and(|errors| !errors.is_empty());
    format!(
        "Notes checkpointed through {}. Audio: {} source{} saved locally{}. {} Transcript: {}.{}",
        clock(local),
        sources,
        if sources == 1 { "" } else { "s" },
        if unsupported {
            "; some live sources are unavailable"
        } else {
            "; source timing is provisional until stop"
        },
        backup,
        status["transcription"].as_str().unwrap_or("waiting"),
        warning
    )
}

#[cfg(test)]
mod tests {
    use super::heartbeat_clock;

    #[test]
    fn terminal_heartbeat_never_regresses_when_the_session_clock_is_cleared() {
        assert_eq!(heartbeat_clock(0, 1_000, None), 1_000);
        assert_eq!(heartbeat_clock(2_231_000, 2_231_625, None), 2_231_625);
        assert_eq!(
            heartbeat_clock(2_231_625, 0, Some(2_231_625)),
            2_231_625,
            "a completed stop keeps the journal duration"
        );
        assert_eq!(
            heartbeat_clock(2_231_000, 0, Some(2_231_625)),
            2_231_625,
            "the journal wins when the last heartbeat predates the stop"
        );
        assert_eq!(heartbeat_clock(9_000, 0, None), 9_000, "an aborted walk");
    }
}
