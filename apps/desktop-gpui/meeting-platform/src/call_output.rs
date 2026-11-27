//! Windows: which output a meeting's computer audio is read from. A call app
//! can play to an output that is not the default (Teams, Zoom and browser
//! calls play to the default communications device, often a headset, while
//! the speakers stay the default), and the default output's loopback then
//! hears nothing of the call. The call app is the program that records the
//! microphone; when everything it plays goes to one output other than the
//! default, that output is followed. Otherwise the default output is kept,
//! exactly as before. The rule is Linux's (`capture/sink.rs`): music playing
//! elsewhere is never taken for the call.
//!
//! A browser keeps silent streams open (a page's audio context plays to the
//! default output even when the call itself goes to a headset), so once the
//! call app is heard, only the outputs it is heard on count. While it is
//! silent everywhere the last such choice stands.

use std::collections::HashMap;

/// An audio session as the audio system lists it on one endpoint.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Session {
    /// The endpoint (device) id.
    pub endpoint: String,
    pub pid: u32,
    /// A stream of the session is running (not only opened before).
    pub active: bool,
    /// Sound came out of the session in one of the last few looks.
    pub heard: bool,
}

/// A running process: its parent and lowercase executable file name.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Proc {
    pub parent: u32,
    pub exe: String,
}

/// How far up the process tree a call app's helpers are looked for (an app,
/// its embedded browser, that browser's audio service).
const DEPTH: usize = 6;

fn chain(pid: u32, procs: &HashMap<u32, Proc>) -> Vec<u32> {
    let mut out = vec![pid];
    let mut at = pid;
    while out.len() <= DEPTH {
        let Some(parent) = procs.get(&at).map(|p| p.parent) else {
            break;
        };
        if parent == 0 || out.contains(&parent) {
            break;
        }
        out.push(parent);
        at = parent;
    }
    out
}

/// Programs that start other programs for a person (the shell, terminals,
/// the system's service hosts): two apps they both started stay two apps.
const LAUNCHERS: &[&str] = &[
    "explorer.exe",
    "svchost.exe",
    "services.exe",
    "wininit.exe",
    "winlogon.exe",
    "userinit.exe",
    "sihost.exe",
    "runtimebroker.exe",
    "taskhostw.exe",
    "cmd.exe",
    "powershell.exe",
    "pwsh.exe",
    "windowsterminal.exe",
    "openconsole.exe",
    "conhost.exe",
];

/// Whether two processes are one app: the same process, or the nearest
/// process that is or started both (one of them, when one started the other)
/// is an app itself (an app and its helpers, such as its embedded browser's
/// audio service). A launcher (the shell, a terminal) never joins two apps,
/// not even the apps it started itself.
fn same_app(a: u32, b: u32, procs: &HashMap<u32, Proc>) -> bool {
    if a == b {
        return true;
    }
    let (up_a, up_b) = (chain(a, procs), chain(b, procs));
    // The nearest process that is or started both: one of the two when one
    // started the other. A launcher there joins nothing (everything a person
    // opens from the taskbar is started by the shell).
    let Some(common) = up_a.iter().find(|pid| up_b.contains(pid)) else {
        return false;
    };
    procs
        .get(common)
        .map(|p| p.exe.as_str())
        .is_some_and(|exe| !exe.is_empty() && !LAUNCHERS.contains(&exe))
}

/// The sessions the calling apps (the programs recording the microphone)
/// play. `ours` is Cap's own process, whose sessions (its sounds, its own
/// recording) never count; process 0 is the system sounds. `None` when no
/// one is recording the microphone.
fn call_sessions<'a>(
    playing: &'a [Session],
    recording: &[Session],
    procs: &HashMap<u32, Proc>,
    ours: u32,
) -> Option<Vec<&'a Session>> {
    let foreign = |s: &&Session| s.active && s.pid != 0 && s.pid != ours;
    let callers: Vec<u32> = recording.iter().filter(foreign).map(|s| s.pid).collect();
    if callers.is_empty() {
        return None;
    }
    Some(
        playing
            .iter()
            .filter(foreign)
            .filter(|s| callers.iter().any(|c| same_app(s.pid, *c, procs)))
            .collect(),
    )
}

/// One process can play several things: a browser plays every tab from one
/// audio service, so a music tab on the speakers and a call on a headset
/// share it. Only when all of them go to one output other than the default
/// is that output followed.
fn only_output(sessions: &[&Session], default: Option<&str>) -> Option<String> {
    let mut outputs: Vec<&str> = sessions.iter().map(|s| s.endpoint.as_str()).collect();
    outputs.sort_unstable();
    outputs.dedup();
    match outputs.as_slice() {
        [only] if Some(*only) != default => Some((*only).to_string()),
        _ => None,
    }
}

/// The output a call is followed to, as one look saw it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Followed {
    pub endpoint: String,
    /// The process whose tree plays everything the call app plays there.
    pub call: Option<u32>,
    /// Every process with a session on that output.
    pub on_output: Vec<u32>,
    /// Processes playing on other outputs right now (not Cap, not the
    /// system sounds).
    pub elsewhere: Vec<u32>,
}

/// [`Followed`] for `endpoint`, from the same look the choice came from.
pub fn followed(
    endpoint: &str,
    playing: &[Session],
    recording: &[Session],
    procs: &HashMap<u32, Proc>,
    ours: u32,
) -> Followed {
    let call = call_sessions(playing, recording, procs, ours)
        .and_then(|sessions| call_root(&pids_on(endpoint, sessions.into_iter()), procs));
    let mut elsewhere: Vec<u32> = playing
        .iter()
        .filter(|s| s.endpoint != endpoint && s.active && s.pid != 0 && s.pid != ours)
        .map(|s| s.pid)
        .collect();
    elsewhere.sort_unstable();
    elsewhere.dedup();
    Followed {
        endpoint: endpoint.to_string(),
        call,
        on_output: pids_on(endpoint, playing.iter()),
        elsewhere,
    }
}

fn pids_on<'a>(endpoint: &str, sessions: impl Iterator<Item = &'a Session>) -> Vec<u32> {
    let mut pids: Vec<u32> = sessions
        .filter(|s| s.endpoint == endpoint)
        .map(|s| s.pid)
        .collect();
    pids.sort_unstable();
    pids.dedup();
    pids
}

/// One process whose tree holds all of `pids`: the only one, or the nearest
/// process that started them all when that is an app (never a launcher).
fn call_root(pids: &[u32], procs: &HashMap<u32, Proc>) -> Option<u32> {
    match pids {
        [] => None,
        [only] => Some(*only),
        [first, rest @ ..] => {
            let others: Vec<Vec<u32>> = rest.iter().map(|pid| chain(*pid, procs)).collect();
            let root = chain(*first, procs)
                .into_iter()
                .find(|pid| others.iter().all(|up| up.contains(pid)))?;
            procs
                .get(&root)
                .map(|p| p.exe.as_str())
                .is_some_and(|exe| !exe.is_empty() && !LAUNCHERS.contains(&exe))
                .then_some(root)
        }
    }
}

/// The output to loop back from one look, or `None` for the default output,
/// remembering what the call app was last heard on.
#[derive(Debug, Default)]
pub struct Chooser {
    /// The choice made the last time the call app was heard, while the same
    /// call goes on.
    heard: Option<Option<String>>,
}

impl Chooser {
    pub fn choose(
        &mut self,
        default: Option<&str>,
        playing: &[Session],
        recording: &[Session],
        procs: &HashMap<u32, Proc>,
        ours: u32,
    ) -> Option<String> {
        let Some(sessions) = call_sessions(playing, recording, procs, ours) else {
            self.heard = None;
            return None;
        };
        let heard: Vec<&Session> = sessions.iter().copied().filter(|s| s.heard).collect();
        if !heard.is_empty() {
            let choice = only_output(&heard, default);
            self.heard = Some(choice.clone());
            return choice;
        }
        // Silent everywhere: the last heard choice, while the call app still
        // plays to that output.
        match &self.heard {
            Some(None) => None,
            Some(Some(id)) if sessions.iter().any(|s| &s.endpoint == id) => Some(id.clone()),
            _ => only_output(&sessions, default),
        }
    }

    /// Nothing plays anywhere but the default output: a new call starts afresh.
    pub fn reset(&mut self) {
        self.heard = None;
    }
}

/// [`Chooser::choose`] with nothing heard before.
#[cfg(test)]
pub fn choose(
    default: Option<&str>,
    playing: &[Session],
    recording: &[Session],
    procs: &HashMap<u32, Proc>,
    ours: u32,
) -> Option<String> {
    Chooser::default().choose(default, playing, recording, procs, ours)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPEAKERS: &str = "{0.0.0.00000000}.{speakers}";
    const HEADSET: &str = "{0.0.0.00000000}.{headset}";
    const HEADSET_MIC: &str = "{0.0.1.00000000}.{headset-mic}";
    const OURS: u32 = 900;

    fn session(endpoint: &str, pid: u32) -> Session {
        Session {
            endpoint: endpoint.into(),
            pid,
            active: true,
            heard: false,
        }
    }

    fn heard(endpoint: &str, pid: u32) -> Session {
        Session {
            heard: true,
            ..session(endpoint, pid)
        }
    }

    fn procs(list: &[(u32, u32, &str)]) -> HashMap<u32, Proc> {
        list.iter()
            .map(|(pid, parent, exe)| {
                (
                    *pid,
                    Proc {
                        parent: *parent,
                        exe: exe.to_string(),
                    },
                )
            })
            .collect()
    }

    #[test]
    fn a_call_on_the_communications_device_is_followed() {
        // A browser call: the audio service both records and plays.
        let playing = [session(HEADSET, 4100)];
        let recording = [session(HEADSET_MIC, 4100)];
        assert_eq!(
            choose(Some(SPEAKERS), &playing, &recording, &HashMap::new(), OURS),
            Some(HEADSET.into())
        );
    }

    #[test]
    fn the_followed_output_names_the_call_and_everyone_playing_there() {
        // A call in the browser's audio service (4100, under chrome 4000) on
        // the headset, a reader (700) speaking there too, music (800) on
        // the speakers.
        let playing = [
            session(HEADSET, 4100),
            session(HEADSET, 700),
            session(SPEAKERS, 800),
        ];
        let recording = [session(HEADSET_MIC, 4000)];
        let tree = procs(&[
            (4000, 1, "chrome.exe"),
            (4100, 4000, "chrome.exe"),
            (700, 1, "nvda.exe"),
            (800, 1, "music.exe"),
        ]);
        assert_eq!(
            followed(HEADSET, &playing, &recording, &tree, OURS),
            Followed {
                endpoint: HEADSET.into(),
                call: Some(4100),
                on_output: vec![700, 4100],
                elsewhere: vec![800],
            }
        );
        // The call on the default output with music on the headset: the
        // music is elsewhere.
        let playing = [
            session(SPEAKERS, 4100),
            session(SPEAKERS, 700),
            session(HEADSET, 800),
        ];
        let there = followed(SPEAKERS, &playing, &recording, &tree, OURS);
        assert_eq!((there.call, there.elsewhere), (Some(4100), vec![800]));
        // Two processes of the call app there: the app that started both.
        let playing = [session(HEADSET, 4100), session(HEADSET, 4200)];
        let tree = procs(&[
            (4000, 1, "teams.exe"),
            (4100, 4000, "webview.exe"),
            (4200, 4000, "webview.exe"),
        ]);
        let recording = [session(HEADSET_MIC, 4000)];
        assert_eq!(
            followed(HEADSET, &playing, &recording, &tree, OURS).call,
            Some(4000)
        );
        // Started only by the shell: no one process holds the call.
        let tree = procs(&[
            (1, 0, "explorer.exe"),
            (4100, 1, "a.exe"),
            (4200, 1, "b.exe"),
        ]);
        let recording = [session(HEADSET_MIC, 4100), session(HEADSET_MIC, 4200)];
        assert_eq!(
            followed(HEADSET, &playing, &recording, &tree, OURS).call,
            None
        );
        // No one records the microphone: no call.
        assert_eq!(followed(HEADSET, &playing, &[], &tree, OURS).call, None);
    }

    #[test]
    fn a_call_on_the_default_output_keeps_the_default() {
        let playing = [session(SPEAKERS, 4100)];
        let recording = [session(HEADSET_MIC, 4100)];
        assert_eq!(
            choose(Some(SPEAKERS), &playing, &recording, &HashMap::new(), OURS),
            None
        );
    }

    #[test]
    fn a_call_playing_to_both_outputs_keeps_the_default() {
        let playing = [session(SPEAKERS, 4100), session(HEADSET, 4100)];
        let recording = [session(HEADSET_MIC, 4100)];
        assert_eq!(
            choose(Some(SPEAKERS), &playing, &recording, &HashMap::new(), OURS),
            None
        );
    }

    #[test]
    fn music_elsewhere_is_never_taken_for_the_call() {
        // The music player does not record: the call's output is followed.
        let playing = [session(SPEAKERS, 5200), session(HEADSET, 4100)];
        let recording = [session(HEADSET_MIC, 4100)];
        assert_eq!(
            choose(Some(SPEAKERS), &playing, &recording, &HashMap::new(), OURS),
            Some(HEADSET.into())
        );
        // Nothing records: no call, the default as always.
        assert_eq!(
            choose(Some(SPEAKERS), &playing, &[], &HashMap::new(), OURS),
            None
        );
    }

    #[test]
    fn two_call_apps_on_different_outputs_keep_the_default() {
        let playing = [session(SPEAKERS, 4100), session(HEADSET, 6100)];
        let recording = [session(HEADSET_MIC, 4100), session(HEADSET_MIC, 6100)];
        assert_eq!(
            choose(Some(SPEAKERS), &playing, &recording, &HashMap::new(), OURS),
            None
        );
    }

    #[test]
    fn caps_own_sessions_and_system_sounds_never_count() {
        // Cap records the microphone and plays a sound to the headset.
        let playing = [session(HEADSET, OURS), session(HEADSET, 0)];
        let recording = [session(HEADSET_MIC, OURS)];
        assert_eq!(
            choose(Some(SPEAKERS), &playing, &recording, &HashMap::new(), OURS),
            None
        );
        // A call on the speakers while Cap plays to the headset: the default.
        let playing = [session(SPEAKERS, 4100), session(HEADSET, OURS)];
        let recording = [session(HEADSET_MIC, 4100), session(HEADSET_MIC, OURS)];
        assert_eq!(
            choose(Some(SPEAKERS), &playing, &recording, &HashMap::new(), OURS),
            None
        );
    }

    #[test]
    fn sessions_that_are_not_running_do_not_count() {
        let mut idle = session(SPEAKERS, 4100);
        idle.active = false;
        let playing = [idle, session(HEADSET, 4100)];
        let recording = [session(HEADSET_MIC, 4100)];
        assert_eq!(
            choose(Some(SPEAKERS), &playing, &recording, &HashMap::new(), OURS),
            Some(HEADSET.into())
        );
        let mut stopped = session(HEADSET_MIC, 4100);
        stopped.active = false;
        assert_eq!(
            choose(
                Some(SPEAKERS),
                &[session(HEADSET, 4100)],
                &[stopped],
                &HashMap::new(),
                OURS
            ),
            None
        );
    }

    #[test]
    fn an_apps_helper_process_plays_for_it() {
        // The app records; its embedded browser's helper plays.
        let tree = procs(&[
            (10, 1, "explorer.exe"),
            (20, 10, "ms-teams.exe"),
            (30, 20, "msedgewebview2.exe"),
            (31, 30, "msedgewebview2.exe"),
            (32, 30, "msedgewebview2.exe"),
        ]);
        let recording = [session(HEADSET_MIC, 20)];
        assert_eq!(
            choose(
                Some(SPEAKERS),
                &[session(HEADSET, 31)],
                &recording,
                &tree,
                OURS
            ),
            Some(HEADSET.into())
        );
        // Two helpers side by side under the same program.
        let recording = [session(HEADSET_MIC, 32)];
        assert_eq!(
            choose(
                Some(SPEAKERS),
                &[session(HEADSET, 31)],
                &recording,
                &tree,
                OURS
            ),
            Some(HEADSET.into())
        );
        // A media helper records and the embedded browser's audio service
        // plays, both under the app.
        let tree = procs(&[
            (10, 1, "explorer.exe"),
            (20, 10, "ms-teams.exe"),
            (25, 20, "ms-teams_modulehost.exe"),
            (30, 20, "msedgewebview2.exe"),
            (31, 30, "msedgewebview2.exe"),
        ]);
        let recording = [session(HEADSET_MIC, 25)];
        assert_eq!(
            choose(
                Some(SPEAKERS),
                &[session(HEADSET, 31)],
                &recording,
                &tree,
                OURS
            ),
            Some(HEADSET.into())
        );
    }

    #[test]
    fn processes_with_nothing_known_about_them_stay_apart() {
        let recording = [session(HEADSET_MIC, 20)];
        assert_eq!(
            choose(
                Some(SPEAKERS),
                &[session(HEADSET, 31)],
                &recording,
                &HashMap::new(),
                OURS
            ),
            None
        );
        let tree = procs(&[(20, 5, "a.exe"), (31, 5, "b.exe")]);
        assert_eq!(
            choose(
                Some(SPEAKERS),
                &[session(HEADSET, 31)],
                &recording,
                &tree,
                OURS
            ),
            None,
            "a parent nothing is known of is no app"
        );
    }

    #[test]
    fn apps_started_by_the_same_shell_stay_apart() {
        // A call app on the speakers, a music app (also started from the
        // shell) on the headset: the music is not the call.
        let tree = procs(&[
            (10, 1, "explorer.exe"),
            (20, 10, "zoom.exe"),
            (40, 10, "spotify.exe"),
            (50, 60, "pwsh.exe"),
            (51, 50, "recorder.exe"),
            (52, 50, "player.exe"),
        ]);
        let recording = [session(HEADSET_MIC, 20)];
        assert_eq!(
            choose(
                Some(SPEAKERS),
                &[session(SPEAKERS, 20), session(HEADSET, 40)],
                &recording,
                &tree,
                OURS
            ),
            None
        );
        let recording = [session(HEADSET_MIC, 51)];
        assert_eq!(
            choose(
                Some(SPEAKERS),
                &[session(HEADSET, 52)],
                &recording,
                &tree,
                OURS
            ),
            None
        );
    }

    #[test]
    fn a_loop_in_the_process_list_ends() {
        let tree = procs(&[(20, 21, "a.exe"), (21, 20, "b.exe")]);
        assert!(!same_app(20, 99, &tree));
        assert!(same_app(20, 21, &tree));
    }

    #[test]
    fn no_default_output_follows_the_only_call_output() {
        let playing = [session(HEADSET, 4100)];
        let recording = [session(HEADSET_MIC, 4100)];
        assert_eq!(
            choose(None, &playing, &recording, &HashMap::new(), OURS),
            Some(HEADSET.into())
        );
    }

    #[test]
    fn a_silent_stream_on_the_default_does_not_hold_a_heard_call() {
        // A browser call on the headset; the page's audio context keeps a
        // silent stream on the speakers.
        let recording = [session(HEADSET_MIC, 4100)];
        let mut chooser = Chooser::default();
        let quiet = [session(SPEAKERS, 4100), session(HEADSET, 4100)];
        assert_eq!(
            chooser.choose(Some(SPEAKERS), &quiet, &recording, &HashMap::new(), OURS),
            None,
            "nothing heard yet: both outputs count"
        );
        let talking = [session(SPEAKERS, 4100), heard(HEADSET, 4100)];
        assert_eq!(
            chooser.choose(Some(SPEAKERS), &talking, &recording, &HashMap::new(), OURS),
            Some(HEADSET.into())
        );
        // A pause in the call: still the headset.
        assert_eq!(
            chooser.choose(Some(SPEAKERS), &quiet, &recording, &HashMap::new(), OURS),
            Some(HEADSET.into())
        );
    }

    #[test]
    fn a_call_heard_on_the_default_never_moves() {
        // The control: the call on the speakers, a silent stream on the
        // headset, then silence.
        let recording = [session(HEADSET_MIC, 4100)];
        let mut chooser = Chooser::default();
        let talking = [heard(SPEAKERS, 4100), session(HEADSET, 4100)];
        assert_eq!(
            chooser.choose(Some(SPEAKERS), &talking, &recording, &HashMap::new(), OURS),
            None
        );
        let quiet = [session(SPEAKERS, 4100), session(HEADSET, 4100)];
        for _ in 0..5 {
            assert_eq!(
                chooser.choose(Some(SPEAKERS), &quiet, &recording, &HashMap::new(), OURS),
                None
            );
        }
    }

    #[test]
    fn a_call_heard_on_both_outputs_keeps_the_default() {
        let recording = [session(HEADSET_MIC, 4100)];
        let mut chooser = Chooser::default();
        let both = [heard(SPEAKERS, 4100), heard(HEADSET, 4100)];
        assert_eq!(
            chooser.choose(Some(SPEAKERS), &both, &recording, &HashMap::new(), OURS),
            None
        );
    }

    #[test]
    fn the_last_heard_output_holds_only_while_the_call_plays_there() {
        let recording = [session(HEADSET_MIC, 4100)];
        let mut chooser = Chooser::default();
        assert_eq!(
            chooser.choose(
                Some(SPEAKERS),
                &[heard(HEADSET, 4100)],
                &recording,
                &HashMap::new(),
                OURS
            ),
            Some(HEADSET.into())
        );
        // The headset is gone (unplugged): the silent stream on the speakers
        // is all the call app plays.
        assert_eq!(
            chooser.choose(
                Some(SPEAKERS),
                &[session(SPEAKERS, 4100)],
                &recording,
                &HashMap::new(),
                OURS
            ),
            None
        );
        // The call ends (no one records): a new call starts afresh.
        assert_eq!(
            chooser.choose(
                Some(SPEAKERS),
                &[session(HEADSET, 4100)],
                &[],
                &HashMap::new(),
                OURS
            ),
            None
        );
        assert_eq!(
            chooser.choose(
                Some(SPEAKERS),
                &[session(SPEAKERS, 4100), session(HEADSET, 4100)],
                &recording,
                &HashMap::new(),
                OURS
            ),
            None
        );
    }

    #[test]
    fn music_heard_elsewhere_in_another_app_is_not_the_call() {
        let recording = [session(HEADSET_MIC, 4100)];
        let mut chooser = Chooser::default();
        let playing = [
            heard(SPEAKERS, 5200),
            session(SPEAKERS, 4100),
            heard(HEADSET, 4100),
        ];
        assert_eq!(
            chooser.choose(Some(SPEAKERS), &playing, &recording, &HashMap::new(), OURS),
            Some(HEADSET.into())
        );
    }

    #[test]
    fn a_launcher_never_joins_the_apps_it_started() {
        // The shell (or a terminal) plays a sound and started the call app:
        // its sound is not the call's.
        let tree = procs(&[
            (10, 1, "explorer.exe"),
            (20, 10, "chrome.exe"),
            (21, 20, "chrome.exe"),
            (50, 1, "powershell.exe"),
            (51, 50, "chrome.exe"),
            (52, 51, "chrome.exe"),
        ]);
        assert!(!same_app(10, 21, &tree));
        assert!(!same_app(50, 52, &tree));
        let recording = [session(HEADSET_MIC, 52)];
        let playing = [
            heard(SPEAKERS, 50),
            session(SPEAKERS, 52),
            heard(HEADSET, 52),
        ];
        assert_eq!(
            Chooser::default().choose(Some(SPEAKERS), &playing, &recording, &tree, OURS),
            Some(HEADSET.into())
        );
        // An app that started its own helper still is one app.
        assert!(same_app(20, 21, &tree));
    }
}
