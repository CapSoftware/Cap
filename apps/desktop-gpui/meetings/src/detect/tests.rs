use super::*;
use crate::test_rng::Rng;

struct Sim {
    detector: Detector,
    now: u64,
    log: Vec<(u64, DetectEvent)>,
}

impl Sim {
    fn new() -> Self {
        Self::with(Platform::MacOS, DetectConfig::default())
    }

    fn with(platform: Platform, config: DetectConfig) -> Self {
        Self {
            detector: Detector::new(platform, config),
            now: 0,
            log: Vec::new(),
        }
    }

    fn record(&mut self, events: Vec<DetectEvent>) {
        let now = self.now;
        self.log.extend(events.into_iter().map(|e| (now, e)));
    }

    fn run_until(&mut self, t: u64) {
        while let Some(due) = self.detector.next_deadline() {
            if due.0 > t {
                break;
            }
            assert!(
                due.0 >= self.now,
                "deadline {due:?} behind now {}",
                self.now
            );
            self.now = due.0;
            let events = self.detector.tick(due);
            self.record(events);
        }
        self.now = self.now.max(t);
    }

    fn at(&mut self, t: u64) -> &mut Self {
        self.run_until(t);
        self
    }

    fn mic(&mut self, ids: &[&str]) -> &mut Self {
        let clients: Vec<MicClient> = ids
            .iter()
            .enumerate()
            .map(|(i, id)| MicClient::new(*id, 100 + i as u32))
            .collect();
        self.clients(&clients)
    }

    fn clients(&mut self, clients: &[MicClient]) -> &mut Self {
        let events = self.detector.on_mic_clients(Millis(self.now), clients);
        self.record(events);
        self
    }

    fn verdict(&mut self, app: &str, verdict: BrowserVerdict) -> &mut Self {
        let events = self
            .detector
            .on_browser_verdict(Millis(self.now), app, verdict);
        self.record(events);
        self
    }

    fn take(&mut self) -> Vec<(u64, String)> {
        std::mem::take(&mut self.log)
            .into_iter()
            .map(|(t, e)| (t, describe(&e)))
            .collect()
    }

    fn expect(&mut self, expected: &[(u64, &str)]) -> &mut Self {
        let got = self.take();
        let expected: Vec<(u64, String)> =
            expected.iter().map(|(t, s)| (*t, s.to_string())).collect();
        assert_eq!(got, expected);
        self
    }

    fn quiet(&mut self) -> &mut Self {
        self.expect(&[])
    }
}

fn describe(event: &DetectEvent) -> String {
    match event {
        DetectEvent::CallStarted(c) => format!("start {}@{}", c.app_id, c.started_at.0),
        DetectEvent::CallUpdated(c) => format!(
            "update {} {:?}",
            c.app_id,
            c.web.as_ref().and_then(|w| w.title.clone())
        ),
        DetectEvent::CallEnded {
            app_id,
            ended_at,
            held_for_ms,
        } => format!("end {app_id}@{} held {held_for_ms}", ended_at.0),
        DetectEvent::NeedBrowserEvidence { app_id } => format!("evidence {app_id}"),
    }
}

fn meet(title: &str) -> BrowserVerdict {
    BrowserVerdict::Meeting {
        provider: WebProvider::GoogleMeet,
        meeting_id: Some("abc-defg-hij".into()),
        title: Some(title.into()),
    }
}

#[test]
fn holds_mic_reads_one_look_the_way_a_call_is_read() {
    let detector = Detector::new(
        Platform::MacOS,
        DetectConfig {
            own_pids: vec![7],
            ..DetectConfig::default()
        },
    );
    let zoom = MicClient::new("us.zoom.xos", 1).on_device("BuiltInMic-uid");
    assert!(detector.holds_mic("zoom", std::slice::from_ref(&zoom)));
    assert!(!detector.holds_mic("teams", std::slice::from_ref(&zoom)));
    assert!(!detector.holds_mic("zoom", &[]));
    assert!(!detector.holds_mic(
        "zoom",
        &[MicClient::new("us.zoom.xos", 1).on_device("BlackHole2ch_UID")]
    ));
    assert!(!detector.holds_mic("zoom", &[MicClient::new("us.zoom.xos", 7)]));
    let linux = Detector::new(Platform::Linux, DetectConfig::default());
    assert!(linux.holds_mic("zoom", &[MicClient::new("zoom", 40)]));
}

#[test]
fn join_and_leave() {
    let mut s = Sim::new();
    s.at(1_000).mic(&["us.zoom.xos"]).quiet();
    s.at(2_999).quiet();
    s.at(3_000).expect(&[(3_000, "start zoom@1000")]);
    assert_eq!(s.detector.active_calls().len(), 1);
    s.at(60_000).mic(&[]).quiet();
    assert_eq!(s.detector.active_calls().len(), 1);
    s.at(61_999).quiet();
    s.at(62_000)
        .expect(&[(62_000, "end zoom@60000 held 59000")]);
    assert!(s.detector.active_calls().is_empty());
    assert_eq!(s.detector.next_deadline(), None);
}

#[test]
fn blip_shorter_than_hold_emits_nothing() {
    let mut s = Sim::new();
    s.at(0).mic(&["us.zoom.xos"]);
    s.at(1_500).mic(&[]);
    s.at(10_000).quiet();
    assert_eq!(s.detector.next_deadline(), None);
}

#[test]
fn reacquire_within_grace_is_same_call() {
    let mut s = Sim::new();
    s.at(0).mic(&["com.microsoft.teams2"]);
    s.at(2_000).expect(&[(2_000, "start teams@0")]);
    s.at(10_000).mic(&[]);
    s.at(11_500).mic(&["com.microsoft.teams2"]).quiet();
    s.at(30_000).quiet();
    s.at(40_000).mic(&[]);
    s.at(50_000)
        .expect(&[(42_000, "end teams@40000 held 40000")]);
}

#[test]
fn headset_switch_gap_inside_long_grace() {
    let mut s = Sim::new();
    let airpods = MicClient::new("us.zoom.xos", 1).on_device("AirPods-uid");
    let builtin = MicClient::new("us.zoom.xos", 1).on_device("BuiltInMic-uid");
    s.at(0).clients(std::slice::from_ref(&builtin));
    s.at(2_000).expect(&[(2_000, "start zoom@0")]);
    s.at(20_000).clients(&[]);
    let events = s.detector.on_devices_changed(Millis(20_100));
    assert!(events.is_empty());
    s.at(24_500).clients(&[airpods]).quiet();
    s.at(60_000).quiet();
    assert_eq!(s.detector.active_calls().len(), 1);
}

#[test]
fn device_change_just_before_release_uses_long_grace() {
    let mut s = Sim::new();
    s.at(0).mic(&["us.zoom.xos"]);
    s.at(5_000).take();
    s.detector.on_devices_changed(Millis(9_000));
    s.at(10_000).mic(&[]);
    s.at(14_000).quiet();
    s.at(16_000)
        .expect(&[(16_000, "end zoom@10000 held 10000")]);
}

#[test]
fn device_change_inferred_from_client_devices() {
    let mut s = Sim::new();
    let a = MicClient::new("us.zoom.xos", 1).on_device("mic-a");
    let b = MicClient::new("us.zoom.xos", 1).on_device("mic-b");
    s.at(0).clients(std::slice::from_ref(&a));
    s.at(3_000).take();
    s.at(10_000).clients(std::slice::from_ref(&b));
    s.at(11_000).clients(&[]);
    s.at(15_000).quiet();
    s.at(17_000)
        .expect(&[(17_000, "end zoom@11000 held 11000")]);
}

#[test]
fn several_pids_of_one_app_are_one_call() {
    let mut s = Sim::new();
    s.at(0).clients(&[
        MicClient::new("com.google.Chrome.helper", 10),
        MicClient::new("com.google.Chrome.helper.Renderer", 11),
        MicClient::new("com.google.Chrome", 12),
    ]);
    s.at(3_000)
        .expect(&[(0, "evidence chrome"), (2_000, "start chrome@0")]);
    assert_eq!(s.detector.active_calls()[0].pids, vec![10, 11, 12]);
    s.at(4_000)
        .clients(&[MicClient::new("com.google.Chrome.helper", 10)])
        .quiet();
    assert_eq!(s.detector.active_calls()[0].pids, vec![10]);
}

#[test]
fn two_overlapping_calls_are_ordered_by_start() {
    let mut s = Sim::new();
    s.at(0).mic(&["com.tinyspeck.slackmacgap"]);
    s.at(1_000)
        .mic(&["com.tinyspeck.slackmacgap", "us.zoom.xos"]);
    s.at(3_000)
        .expect(&[(2_000, "start slack@0"), (3_000, "start zoom@1000")]);
    let ids: Vec<&str> = s
        .detector
        .active_calls()
        .iter()
        .map(|c| c.app_id.as_str())
        .collect();
    assert_eq!(ids, vec!["slack", "zoom"]);
    s.at(20_000).mic(&["us.zoom.xos"]);
    s.at(30_000)
        .expect(&[(22_000, "end slack@20000 held 20000")]);
    assert_eq!(s.detector.active_calls().len(), 1);
}

// The process object of an app recording from an aggregate input lists every sub-device, in the
// aggregate's order, and never the aggregate (measured on macOS with private aggregates of
// BlackHole 2ch and 16ch, both orders). These are the UID shapes CoreAudio reports.
const USB_MIC: &str = "AppleUSBAudioEngine:Blue Microphones:Yeti Stereo Microphone:REV8_2041SG00:1";
const BUILT_IN_MIC: &str = "BuiltInMicrophoneDevice";

#[test]
fn a_real_microphone_in_an_aggregate_is_real_whichever_sub_device_comes_first() {
    let detector = Detector::new(Platform::MacOS, DetectConfig::default());
    for subs in [
        [USB_MIC, "BlackHole2ch_UID"],
        ["BlackHole2ch_UID", USB_MIC],
        [BUILT_IN_MIC, "BlackHole16ch_UID"],
        ["BlackHole16ch_UID", BUILT_IN_MIC],
    ] {
        let zoom = MicClient::new("us.zoom.xos", 1).on_devices(&subs);
        assert!(detector.holds_mic("zoom", &[zoom]), "{subs:?}");
    }
    for subs in [
        ["BlackHole2ch_UID", "BlackHole16ch_UID"],
        ["BlackHole16ch_UID", "BlackHole2ch_UID"],
    ] {
        let zoom = MicClient::new("us.zoom.xos", 1).on_devices(&subs);
        assert!(!detector.holds_mic("zoom", &[zoom]), "{subs:?}");
    }
}

#[test]
fn a_call_on_an_aggregate_that_lists_a_loopback_first_starts() {
    let mut s = Sim::new();
    s.at(0)
        .clients(&[MicClient::new("us.zoom.xos", 1).on_devices(&["BlackHole2ch_UID", USB_MIC])]);
    s.at(2_000).expect(&[(2_000, "start zoom@0")]);
}

#[test]
fn ignored_devices_own_ids_and_unknown_apps() {
    let config = DetectConfig {
        own_pids: vec![42],
        ..DetectConfig::default()
    };
    let mut s = Sim::with(Platform::MacOS, config);
    s.at(0).clients(&[
        MicClient::new("us.zoom.xos", 1).on_device("BlackHole2ch_UID"),
        MicClient::new("so.cap.desktop", 2),
        MicClient::new("com.tinyspeck.slackmacgap", 42),
        MicClient::new("com.apple.VoiceMemos", 3),
        MicClient::new("com.example.unknown", 4),
    ]);
    s.at(30_000).quiet();
    assert!(s.detector.active_calls().is_empty());
}

#[test]
fn windows_and_linux_platforms() {
    let mut s = Sim::with(Platform::Windows, DetectConfig::default());
    s.at(0)
        .mic(&["C:\\Users\\me\\AppData\\Roaming\\Zoom\\bin\\Zoom.exe"]);
    s.at(2_000).expect(&[(2_000, "start zoom@0")]);
    let mut s = Sim::with(Platform::Linux, DetectConfig::default());
    s.at(0).mic(&["teams-for-linux"]);
    s.at(2_000).expect(&[(2_000, "start teams@0")]);
}

#[test]
fn browser_any_policy_starts_without_verdict() {
    let mut s = Sim::new();
    s.at(0)
        .mic(&["com.google.Chrome"])
        .expect(&[(0, "evidence chrome")]);
    s.at(2_000).expect(&[(2_000, "start chrome@0")]);
    s.at(2_500).verdict("chrome", meet("Standup"));
    s.expect(&[(2_500, "update chrome Some(\"Standup\")")]);
    s.at(3_000).verdict("chrome", meet("Standup")).quiet();
    s.at(60_000).quiet();
}

#[test]
fn browser_any_policy_not_meeting_blocks_until_meeting() {
    let mut s = Sim::new();
    s.at(0).mic(&["com.google.Chrome"]).take();
    s.at(1_000).verdict("chrome", BrowserVerdict::NotMeeting);
    s.at(2_000).quiet();
    s.at(3_000).expect(&[(3_000, "evidence chrome")]);
    s.at(3_500)
        .verdict("chrome", BrowserVerdict::Unknown)
        .quiet();
    s.at(4_000).verdict("chrome", meet("Sync"));
    s.expect(&[(4_000, "start chrome@0")]);
    assert_eq!(
        s.detector.active_calls()[0]
            .web
            .as_ref()
            .and_then(|w| w.title.as_deref()),
        Some("Sync")
    );
}

#[test]
fn browser_any_policy_unknown_verdict_starts() {
    let mut s = Sim::new();
    s.at(0).mic(&["org.mozilla.firefox"]).take();
    s.at(500).verdict("firefox", BrowserVerdict::Unknown);
    s.at(2_000).expect(&[(2_000, "start firefox@0")]);
}

#[test]
fn browser_recognised_only_waits_and_retries() {
    let config = DetectConfig {
        browser_policy: BrowserPolicy::RecognisedOnly,
        ..DetectConfig::default()
    };
    let mut s = Sim::with(Platform::MacOS, config);
    s.at(0)
        .mic(&["com.google.Chrome"])
        .expect(&[(0, "evidence chrome")]);
    s.at(2_000).quiet();
    s.at(3_000).expect(&[(3_000, "evidence chrome")]);
    s.at(3_100).verdict("chrome", BrowserVerdict::Unknown);
    s.at(3_200)
        .verdict("chrome", BrowserVerdict::NotMeeting)
        .quiet();
    s.at(100_000);
    let requests: Vec<u64> = s
        .take()
        .into_iter()
        .filter(|(_, e)| e == "evidence chrome")
        .map(|(t, _)| t)
        .collect();
    assert_eq!(requests.iter().filter(|t| **t <= 30_000).count(), 9);
    let slow: Vec<u64> = requests.into_iter().filter(|t| *t > 30_000).collect();
    assert_eq!(slow, vec![60_000, 90_000]);
    assert_eq!(s.detector.next_deadline(), Some(Millis(120_000)));
    assert!(s.detector.active_calls().is_empty());
    s.at(100_000).verdict("chrome", meet("Late"));
    s.expect(&[(100_000, "start chrome@0")]);
    assert_eq!(s.detector.next_deadline(), None);
}

#[test]
fn browser_holding_the_mic_for_another_page_detects_a_later_meeting() {
    for policy in [BrowserPolicy::Any, BrowserPolicy::RecognisedOnly] {
        let mut s = Sim::with(
            Platform::MacOS,
            DetectConfig {
                browser_policy: policy,
                ..DetectConfig::default()
            },
        );
        s.at(0)
            .mic(&["com.google.Chrome"])
            .expect(&[(0, "evidence chrome")]);
        s.at(500).verdict("chrome", BrowserVerdict::NotMeeting);
        s.at(10 * 60_000);
        let log = s.take();
        assert!(
            log.iter().all(|(_, e)| e == "evidence chrome"),
            "{policy:?}: {log:?}"
        );
        let late: Vec<u64> = log
            .iter()
            .map(|(t, _)| *t)
            .filter(|t| *t > 5 * 60_000)
            .collect();
        assert_eq!(late.len(), 10, "{policy:?}: {late:?}");
        assert!(late.windows(2).all(|w| w[1] - w[0] == 30_000), "{late:?}");
        let due = s.detector.next_deadline().expect("still asking");
        assert!(due.0 > s.now && due.0 <= s.now + 30_000);

        s.at(due.0).expect(&[(due.0, "evidence chrome")]);
        s.at(due.0 + 200)
            .verdict("chrome", BrowserVerdict::NotMeeting)
            .quiet();
        s.at(due.0 + 30_400).take();
        s.verdict("chrome", meet("Standup"));
        s.expect(&[(due.0 + 30_400, "start chrome@0")]);
        assert_eq!(
            s.detector.active_calls()[0]
                .web
                .as_ref()
                .and_then(|w| w.title.as_deref()),
            Some("Standup")
        );
        assert_eq!(s.detector.next_deadline(), None);
    }

    let mut s = Sim::new();
    s.at(0).mic(&["com.google.Chrome"]).take();
    s.at(500).verdict("chrome", BrowserVerdict::NotMeeting);
    s.at(5 * 60_000).take();
    assert!(s.detector.next_deadline().is_some());
    s.mic(&[]);
    assert_eq!(s.detector.next_deadline(), None);
    s.at(20 * 60_000).quiet();
}

#[test]
fn browser_recognised_only_meeting_before_hold_waits_for_hold() {
    let config = DetectConfig {
        browser_policy: BrowserPolicy::RecognisedOnly,
        ..DetectConfig::default()
    };
    let mut s = Sim::with(Platform::MacOS, config);
    s.at(0).mic(&["com.google.Chrome"]).take();
    s.at(500).verdict("chrome", meet("Early")).quiet();
    s.at(2_000).expect(&[(2_000, "start chrome@0")]);
}

#[test]
fn browser_verdict_for_unknown_or_non_browser_app_is_ignored() {
    let mut s = Sim::new();
    s.at(0).mic(&["us.zoom.xos"]);
    s.at(1_000).verdict("zoom", BrowserVerdict::NotMeeting);
    s.at(1_000).verdict("nonexistent", meet("x"));
    s.at(2_000).expect(&[(2_000, "start zoom@0")]);
}

#[test]
fn browser_released_while_pending_drops_cleanly() {
    let mut s = Sim::new();
    s.at(0).mic(&["com.google.Chrome"]).take();
    s.at(1_000).mic(&[]);
    s.at(1_500).verdict("chrome", meet("Gone")).quiet();
    assert_eq!(s.detector.next_deadline(), None);
}

#[test]
fn out_of_order_and_duplicate_inputs() {
    let mut s = Sim::new();
    s.at(5_000).mic(&["us.zoom.xos"]);
    s.mic(&["us.zoom.xos"]);
    let events = s
        .detector
        .on_mic_clients(Millis(1_000), &[MicClient::new("us.zoom.xos", 1)]);
    assert!(events.is_empty());
    s.at(7_000).expect(&[(7_000, "start zoom@5000")]);
    let events = s.detector.tick(Millis(3_000));
    assert!(events.is_empty());
}

#[test]
fn missed_ticks_still_produce_ordered_events() {
    let mut d = Detector::new(Platform::MacOS, DetectConfig::default());
    d.on_mic_clients(Millis(0), &[MicClient::new("us.zoom.xos", 1)]);
    let events = d.on_mic_clients(Millis(10_000), &[]);
    assert!(matches!(&events[..], [DetectEvent::CallStarted(c)] if c.started_at == Millis(0)));
    let events = d.on_mic_clients(Millis(50_000), &[MicClient::new("us.zoom.xos", 1)]);
    assert!(matches!(
        &events[..],
        [DetectEvent::CallEnded {
            ended_at: Millis(10_000),
            ..
        }]
    ));
    assert_eq!(d.next_deadline(), Some(Millis(52_000)));
}

#[test]
fn randomised_invariants() {
    let ids = [
        "us.zoom.xos",
        "com.google.Chrome",
        "com.google.Chrome.helper",
        "com.tinyspeck.slackmacgap",
        "com.microsoft.teams2",
        "so.cap.desktop",
        "com.example.other",
    ];
    let devices = ["mic-a", "mic-b", "BlackHole 2ch"];
    for seed in 0..40 {
        let mut rng = Rng::new(seed);
        let policy = if seed % 2 == 0 {
            BrowserPolicy::Any
        } else {
            BrowserPolicy::RecognisedOnly
        };
        let mut d = Detector::new(
            Platform::MacOS,
            DetectConfig {
                browser_policy: policy,
                ..DetectConfig::default()
            },
        );
        let mut now = 0u64;
        let mut live: Vec<String> = Vec::new();
        for _ in 0..400 {
            if rng.chance(5) {
                now = now.saturating_sub(rng.below(3_000));
            } else {
                now += rng.below(4_000);
            }
            let events = match rng.below(6) {
                0 | 1 => {
                    let clients: Vec<MicClient> = (0..rng.below(4))
                        .map(|i| {
                            let mut c = MicClient::new(*rng.pick(&ids), i as u32);
                            if rng.chance(40) {
                                c = c.on_device(*rng.pick(&devices));
                            }
                            c
                        })
                        .collect();
                    d.on_mic_clients(Millis(now), &clients)
                }
                2 => {
                    let verdict = match rng.below(3) {
                        0 => meet("t"),
                        1 => BrowserVerdict::NotMeeting,
                        _ => BrowserVerdict::Unknown,
                    };
                    d.on_browser_verdict(Millis(now), "chrome", verdict)
                }
                3 => d.on_devices_changed(Millis(now)),
                _ => match d.next_deadline() {
                    Some(due) if rng.chance(80) => d.tick(due),
                    _ => d.tick(Millis(now)),
                },
            };
            for event in &events {
                match event {
                    DetectEvent::CallStarted(c) => {
                        assert!(!live.contains(&c.app_id), "double start {}", c.app_id);
                        live.push(c.app_id.clone());
                    }
                    DetectEvent::CallEnded { app_id, .. } => {
                        let pos = live.iter().position(|a| a == app_id);
                        assert!(pos.is_some(), "end without start {app_id}");
                        live.retain(|a| a != app_id);
                    }
                    DetectEvent::CallUpdated(c) => assert!(live.contains(&c.app_id)),
                    DetectEvent::NeedBrowserEvidence { app_id } => assert_eq!(app_id, "chrome"),
                }
            }
            let mut active: Vec<String> =
                d.active_calls().iter().map(|c| c.app_id.clone()).collect();
            let mut expected = live.clone();
            active.sort();
            expected.sort();
            assert_eq!(active, expected);
            assert!(
                d.active_calls()
                    .windows(2)
                    .all(|w| w[0].started_at <= w[1].started_at)
            );
            if let Some(due) = d.next_deadline() {
                assert!(
                    due > d.now,
                    "seed {seed}: deadline {due:?} not after {:?}",
                    d.now
                );
            }
        }
    }
}
