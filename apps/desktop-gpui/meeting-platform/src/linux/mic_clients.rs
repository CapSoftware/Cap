use std::{
    collections::HashSet,
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread::JoinHandle,
    time::Duration,
};

use crate::{MicClient, MicSnapshot, WatchError};

const COALESCE: Duration = Duration::from_millis(60);

fn pactl(args: &[&str]) -> Option<String> {
    let output = Command::new("pactl")
        .args(args)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

fn monitor_sources() -> HashSet<String> {
    pactl(&["list", "short", "sources"])
        .unwrap_or_default()
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let index = fields.next()?;
            let name = fields.next()?;
            name.ends_with(".monitor").then(|| index.to_owned())
        })
        .collect()
}

fn property(line: &str, key: &str) -> Option<String> {
    let rest = line.trim().strip_prefix(key)?.trim_start();
    let value = rest.strip_prefix('=')?.trim();
    Some(value.trim_matches('"').to_owned())
}

pub(crate) fn parse_source_outputs(
    listing: &str,
    monitors: &HashSet<String>,
    own_pid: u32,
) -> Vec<MicClient> {
    #[derive(Default)]
    struct Entry {
        source: Option<String>,
        corked: bool,
        binary: Option<String>,
        name: Option<String>,
        pid: Option<u32>,
    }

    let mut entries = Vec::new();
    let mut current: Option<Entry> = None;
    for line in listing.lines() {
        if line.starts_with("Source Output #") {
            entries.extend(current.replace(Entry::default()));
            continue;
        }
        let Some(entry) = current.as_mut() else {
            continue;
        };
        let trimmed = line.trim();
        if let Some(source) = trimmed.strip_prefix("Source:") {
            entry.source = Some(source.trim().to_owned());
        } else if let Some(corked) = trimmed.strip_prefix("Corked:") {
            entry.corked = corked.trim() == "yes";
        } else if let Some(value) = property(line, "application.process.binary") {
            entry.binary = Some(value);
        } else if let Some(value) = property(line, "application.name") {
            entry.name = Some(value);
        } else if let Some(value) = property(line, "application.process.id") {
            entry.pid = value.parse().ok();
        }
    }
    entries.extend(current);

    let mut clients: Vec<_> = entries
        .into_iter()
        .filter(|entry| !entry.corked)
        .filter(|entry| {
            entry
                .source
                .as_ref()
                .is_none_or(|source| !monitors.contains(source))
        })
        .filter(|entry| entry.pid != Some(own_pid))
        .filter_map(|entry| {
            let id = entry.binary.clone().or_else(|| entry.name.clone())?;
            Some(MicClient {
                id: id.to_lowercase(),
                raw_id: entry.name.or(entry.binary).unwrap_or_default(),
                pid: entry.pid.unwrap_or(0),
                device_uid: entry.source,
            })
        })
        .collect();
    clients.sort();
    clients.dedup();
    clients
}

pub fn snapshot_now() -> MicSnapshot {
    let Some(listing) = pactl(&["list", "source-outputs"]) else {
        return MicSnapshot::default();
    };
    let clients = parse_source_outputs(&listing, &monitor_sources(), std::process::id());
    MicSnapshot {
        mic_in_use: !clients.is_empty(),
        attributed: true,
        clients,
        ..MicSnapshot::default()
    }
}

pub struct Watcher {
    child: Arc<Mutex<Option<Child>>>,
    thread: Option<JoinHandle<()>>,
}

impl Watcher {
    pub fn spawn(updates: flume::Sender<MicSnapshot>) -> Result<Self, WatchError> {
        let mut subscription = Command::new("pactl")
            .arg("subscribe")
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| WatchError::Unsupported(format!("pactl is not available: {error}")))?;
        let stdout = subscription
            .stdout
            .take()
            .ok_or_else(|| WatchError::Start("pactl produced no output stream".into()))?;
        let child = Arc::new(Mutex::new(Some(subscription)));

        let thread = std::thread::Builder::new()
            .name("cap-mic-activity".into())
            .spawn(move || {
                let mut last = None;
                let publish = |last: &mut Option<MicSnapshot>| {
                    let snapshot = snapshot_now();
                    if last.as_ref() != Some(&snapshot) {
                        *last = Some(snapshot.clone());
                        return updates.send(snapshot).is_ok();
                    }
                    true
                };
                if !publish(&mut last) {
                    return;
                }
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    if !line.contains("source-output") && !line.contains("on source #") {
                        continue;
                    }
                    std::thread::sleep(COALESCE);
                    if !publish(&mut last) {
                        break;
                    }
                }
            })
            .map_err(|error| WatchError::Start(error.to_string()))?;

        Ok(Self {
            child,
            thread: Some(thread),
        })
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock()
            && let Some(mut child) = child.take()
        {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LISTING: &str = r#"Source Output #41
	Driver: PipeWire
	Owner Module: n/a
	Client: 88
	Source: 54
	Sample Specification: float32le 1ch 48000Hz
	Corked: no
	Properties:
		application.name = "ZOOM VoiceEngine"
		application.process.id = "4242"
		application.process.binary = "zoom"

Source Output #42
	Client: 90
	Source: 55
	Corked: no
	Properties:
		application.name = "Screen recorder"
		application.process.id = "777"
		application.process.binary = "recorder"

Source Output #43
	Client: 91
	Source: 54
	Corked: yes
	Properties:
		application.name = "Firefox"
		application.process.id = "900"
		application.process.binary = "firefox"

Source Output #44
	Client: 92
	Source: 54
	Corked: no
	Properties:
		application.name = "Own"
		application.process.id = "1"
		application.process.binary = "cap-gpui"
"#;

    #[test]
    fn keeps_live_microphone_streams_only() {
        let monitors = HashSet::from(["55".to_owned()]);
        let clients = parse_source_outputs(LISTING, &monitors, 1);
        assert_eq!(clients.len(), 1);
        assert_eq!(clients[0].id, "zoom");
        assert_eq!(clients[0].pid, 4242);
        assert_eq!(clients[0].raw_id, "ZOOM VoiceEngine");
    }

    #[test]
    fn tolerates_empty_and_malformed_listings() {
        assert!(parse_source_outputs("", &HashSet::new(), 0).is_empty());
        assert!(parse_source_outputs("Source Output #1\n\tgarbage", &HashSet::new(), 0).is_empty());
    }
}
