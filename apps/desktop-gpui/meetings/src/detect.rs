use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::Millis;
use crate::apps::{self, AppInfo, AppKind, CallNoun, Platform};
use crate::browser::{BrowserVerdict, WebProvider};

#[cfg(test)]
mod tests;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MicClient {
    pub platform_id: String,
    pub pid: u32,
    pub device_uid: Option<String>,
}

impl MicClient {
    pub fn new(platform_id: impl Into<String>, pid: u32) -> Self {
        Self {
            platform_id: platform_id.into(),
            pid,
            device_uid: None,
        }
    }

    pub fn on_device(mut self, device_uid: impl Into<String>) -> Self {
        self.device_uid = Some(device_uid.into());
        self
    }
}

// A browser that already holds the microphone for another page only becomes a meeting when the
// user joins one in some tab, which can be minutes later, so evidence keeps being requested.
const BROWSER_SLOW_RETRY_MS: u64 = 30_000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BrowserPolicy {
    #[default]
    Any,
    RecognisedOnly,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DetectConfig {
    pub start_hold_ms: u64,
    pub release_grace_ms: u64,
    pub device_change_grace_ms: u64,
    pub device_change_window_ms: u64,
    pub browser_policy: BrowserPolicy,
    pub browser_retry_ms: u64,
    pub browser_max_retries: u32,
    pub ignored_device_substrings: Vec<String>,
    pub own_pids: Vec<u32>,
}

impl Default for DetectConfig {
    fn default() -> Self {
        Self {
            start_hold_ms: 2_000,
            release_grace_ms: 2_000,
            device_change_grace_ms: 6_000,
            device_change_window_ms: 3_000,
            browser_policy: BrowserPolicy::Any,
            browser_retry_ms: 3_000,
            browser_max_retries: 10,
            ignored_device_substrings: [
                "blackhole",
                "loopback",
                "soundflower",
                "vb-audio",
                "cable output",
                "zoomaudiodevice",
                "ms teams audio",
                "monitor of",
                "virtual",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect(),
            own_pids: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebMeeting {
    pub provider: WebProvider,
    pub meeting_id: Option<String>,
    pub title: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveCall {
    pub app_id: String,
    pub app_name: String,
    pub kind: AppKind,
    pub call_noun: CallNoun,
    pub started_at: Millis,
    pub pids: Vec<u32>,
    pub web: Option<WebMeeting>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DetectEvent {
    CallStarted(ActiveCall),
    CallUpdated(ActiveCall),
    CallEnded {
        app_id: String,
        ended_at: Millis,
        held_for_ms: u64,
    },
    NeedBrowserEvidence {
        app_id: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Pending,
    Active,
    Releasing { released_at: Millis, until: Millis },
}

#[derive(Debug)]
struct Track {
    app: &'static AppInfo,
    since: Millis,
    pids: Vec<u32>,
    phase: Phase,
    verdict: Option<BrowserVerdict>,
    requests: u32,
    next_request: Option<Millis>,
}

impl Track {
    fn is_browser(&self) -> bool {
        self.app.kind == AppKind::Browser
    }

    fn web(&self) -> Option<WebMeeting> {
        match &self.verdict {
            Some(BrowserVerdict::Meeting {
                provider,
                meeting_id,
                title,
            }) => Some(WebMeeting {
                provider: *provider,
                meeting_id: meeting_id.clone(),
                title: title.clone(),
            }),
            _ => None,
        }
    }

    fn call(&self) -> ActiveCall {
        ActiveCall {
            app_id: self.app.id.to_string(),
            app_name: self.app.name.to_string(),
            kind: self.app.kind,
            call_noun: self.app.call_noun,
            started_at: self.since,
            pids: self.pids.clone(),
            web: self.web(),
        }
    }
}

#[derive(Debug)]
pub struct Detector {
    platform: Platform,
    config: DetectConfig,
    now: Millis,
    tracks: Vec<Track>,
    calls: Vec<ActiveCall>,
    devices: Option<BTreeSet<String>>,
    last_device_change: Option<Millis>,
}

impl Detector {
    pub fn new(platform: Platform, config: DetectConfig) -> Self {
        Self {
            platform,
            config,
            now: Millis::ZERO,
            tracks: Vec::new(),
            calls: Vec::new(),
            devices: None,
            last_device_change: None,
        }
    }

    pub fn config(&self) -> &DetectConfig {
        &self.config
    }

    pub fn set_config(&mut self, config: DetectConfig) {
        self.config = config;
    }

    pub fn active_calls(&self) -> &[ActiveCall] {
        &self.calls
    }

    /// Whether `app_id` is among these microphone clients, read the way a
    /// call is (Cap's own processes and ignored devices do not count).
    pub fn holds_mic(&self, app_id: &str, clients: &[MicClient]) -> bool {
        clients.iter().any(|client| {
            !self.ignored(client)
                && apps::classify(self.platform, &client.platform_id)
                    .is_some_and(|a| a.id == app_id)
        })
    }

    pub fn on_mic_clients(&mut self, now: Millis, clients: &[MicClient]) -> Vec<DetectEvent> {
        let now = self.clamp(now);
        let mut events = self.advance(now);

        let devices: BTreeSet<String> = clients
            .iter()
            .filter_map(|c| c.device_uid.clone())
            .collect();
        if !devices.is_empty() {
            if self
                .devices
                .as_ref()
                .is_some_and(|previous| *previous != devices)
            {
                self.device_changed(now);
            }
            self.devices = Some(devices);
        }

        let mut present: Vec<(&'static AppInfo, Vec<u32>)> = Vec::new();
        for client in clients {
            if self.ignored(client) {
                continue;
            }
            let Some(app) = apps::classify(self.platform, &client.platform_id) else {
                continue;
            };
            match present.iter_mut().find(|(a, _)| a.id == app.id) {
                Some((_, pids)) => {
                    if !pids.contains(&client.pid) {
                        pids.push(client.pid);
                    }
                }
                None => present.push((app, vec![client.pid])),
            }
        }
        for (_, pids) in &mut present {
            pids.sort_unstable();
        }

        let grace = self.release_grace(now);
        let mut removed = Vec::new();
        for (index, track) in self.tracks.iter_mut().enumerate() {
            match present.iter().find(|(a, _)| a.id == track.app.id) {
                Some((_, pids)) => {
                    track.pids.clone_from(pids);
                    if let Phase::Releasing { .. } = track.phase {
                        track.phase = Phase::Active;
                    }
                }
                None => match track.phase {
                    Phase::Pending => removed.push(index),
                    Phase::Active => {
                        track.phase = Phase::Releasing {
                            released_at: now,
                            until: now.plus(grace),
                        };
                    }
                    Phase::Releasing { .. } => {}
                },
            }
        }
        for index in removed.into_iter().rev() {
            self.tracks.remove(index);
        }

        for (app, pids) in present {
            if self.tracks.iter().any(|t| t.app.id == app.id) {
                continue;
            }
            let mut track = Track {
                app,
                since: now,
                pids,
                phase: Phase::Pending,
                verdict: None,
                requests: 0,
                next_request: None,
            };
            if track.is_browser() {
                track.requests = 1;
                track.next_request = Some(self.retry_after(now, 1));
                events.push(DetectEvent::NeedBrowserEvidence {
                    app_id: app.id.to_string(),
                });
            }
            self.tracks.push(track);
        }
        self.sync_pids();
        events.extend(self.advance(now));
        events
    }

    pub fn on_devices_changed(&mut self, now: Millis) -> Vec<DetectEvent> {
        let now = self.clamp(now);
        let mut events = self.advance(now);
        self.device_changed(now);
        events.extend(self.advance(now));
        events
    }

    pub fn on_browser_verdict(
        &mut self,
        now: Millis,
        app_id: &str,
        verdict: BrowserVerdict,
    ) -> Vec<DetectEvent> {
        let now = self.clamp(now);
        let mut events = self.advance(now);
        let Some(track) = self.tracks.iter_mut().find(|t| t.app.id == app_id) else {
            return events;
        };
        if !track.is_browser() {
            return events;
        }
        match verdict {
            BrowserVerdict::Unknown => {}
            BrowserVerdict::NotMeeting => {
                if track.phase == Phase::Pending {
                    track.verdict = Some(BrowserVerdict::NotMeeting);
                }
            }
            meeting @ BrowserVerdict::Meeting { .. } => {
                let changed = track.verdict.as_ref() != Some(&meeting);
                track.verdict = Some(meeting);
                track.next_request = None;
                if changed && track.phase != Phase::Pending {
                    let call = track.call();
                    if let Some(slot) = self.calls.iter_mut().find(|c| c.app_id == call.app_id) {
                        *slot = call.clone();
                    }
                    events.push(DetectEvent::CallUpdated(call));
                }
            }
        }
        events.extend(self.advance(now));
        events
    }

    pub fn tick(&mut self, now: Millis) -> Vec<DetectEvent> {
        let now = self.clamp(now);
        self.advance(now)
    }

    pub fn next_deadline(&self) -> Option<Millis> {
        self.tracks
            .iter()
            .flat_map(|track| {
                let hold = match track.phase {
                    Phase::Pending => {
                        let due = track.since.plus(self.config.start_hold_ms);
                        (due > self.now).then_some(due)
                    }
                    Phase::Releasing { until, .. } => Some(until),
                    Phase::Active => None,
                };
                [hold, track.next_request]
            })
            .flatten()
            .min()
    }

    fn clamp(&mut self, now: Millis) -> Millis {
        self.now = self.now.max(now);
        self.now
    }

    fn ignored(&self, client: &MicClient) -> bool {
        if self.config.own_pids.contains(&client.pid) || apps::is_own_process(&client.platform_id) {
            return true;
        }
        let Some(device) = &client.device_uid else {
            return false;
        };
        let device = device.to_lowercase();
        self.config
            .ignored_device_substrings
            .iter()
            .filter(|s| !s.is_empty())
            .any(|s| device.contains(&s.to_lowercase()))
    }

    fn device_changed(&mut self, now: Millis) {
        self.last_device_change = Some(now);
        let long = self.config.device_change_grace_ms;
        for track in &mut self.tracks {
            if let Phase::Releasing { released_at, until } = &mut track.phase {
                *until = (*until).max(released_at.plus(long));
            }
        }
    }

    fn release_grace(&self, now: Millis) -> u64 {
        let recent = self
            .last_device_change
            .is_some_and(|t| now.since(t) <= self.config.device_change_window_ms);
        if recent {
            self.config
                .device_change_grace_ms
                .max(self.config.release_grace_ms)
        } else {
            self.config.release_grace_ms
        }
    }

    fn retry_after(&self, now: Millis, requests: u32) -> Millis {
        let wait = if requests <= self.config.browser_max_retries {
            self.config.browser_retry_ms.max(1)
        } else {
            BROWSER_SLOW_RETRY_MS.max(self.config.browser_retry_ms)
        };
        now.plus(wait)
    }

    fn can_start(&self, track: &Track) -> bool {
        if !track.is_browser() {
            return true;
        }
        match self.config.browser_policy {
            BrowserPolicy::RecognisedOnly => {
                matches!(track.verdict, Some(BrowserVerdict::Meeting { .. }))
            }
            BrowserPolicy::Any => !matches!(track.verdict, Some(BrowserVerdict::NotMeeting)),
        }
    }

    fn sync_pids(&mut self) {
        for call in &mut self.calls {
            if let Some(track) = self.tracks.iter().find(|t| t.app.id == call.app_id) {
                call.pids.clone_from(&track.pids);
            }
        }
    }

    fn advance(&mut self, now: Millis) -> Vec<DetectEvent> {
        let mut due: Vec<(Millis, usize, DetectEvent)> = Vec::new();
        let mut ended = Vec::new();
        let hold = self.config.start_hold_ms;
        for index in 0..self.tracks.len() {
            let can_start = self.can_start(&self.tracks[index]);
            let next_retry = self.retry_after(now, self.tracks[index].requests.saturating_add(1));
            let track = &mut self.tracks[index];
            match track.phase {
                Phase::Pending => {
                    if let Some(at) = track.next_request
                        && at <= now
                    {
                        track.requests = track.requests.saturating_add(1);
                        track.next_request = Some(next_retry);
                        due.push((
                            at,
                            due.len(),
                            DetectEvent::NeedBrowserEvidence {
                                app_id: track.app.id.to_string(),
                            },
                        ));
                    }
                    let start_at = track.since.plus(hold);
                    if can_start && start_at <= now {
                        track.phase = Phase::Active;
                        track.next_request = None;
                        let call = track.call();
                        self.calls.push(call.clone());
                        due.push((start_at, due.len(), DetectEvent::CallStarted(call)));
                    }
                }
                Phase::Releasing { released_at, until } if until <= now => {
                    ended.push(index);
                    due.push((
                        until,
                        due.len(),
                        DetectEvent::CallEnded {
                            app_id: track.app.id.to_string(),
                            ended_at: released_at,
                            held_for_ms: released_at.since(track.since),
                        },
                    ));
                }
                _ => {}
            }
        }
        for index in ended.into_iter().rev() {
            let id = self.tracks[index].app.id;
            self.tracks.remove(index);
            self.calls.retain(|c| c.app_id != id);
        }
        self.calls.sort_by_key(|c| c.started_at);
        due.sort_by_key(|(at, seq, _)| (*at, *seq));
        due.into_iter().map(|(_, _, e)| e).collect()
    }
}
