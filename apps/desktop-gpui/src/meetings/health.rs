//! What a live meeting tells the person about itself: one line, the most
//! important true thing, shown only once it has lasted (so a blip never
//! flashes a warning) and the watchdog that notices when Cap stopped hearing
//! the call.

use std::time::{Duration, Instant};

use super::{
    ActiveMeeting, HealthIssue, SourceHealth,
    engine::{CloudState, EngineKind},
};

/// One thing worth saying about a meeting while it records, most urgent
/// first in [`concerns`].
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Concern {
    MicPermission,
    NoMicrophone,
    /// The microphone stopped delivering audio, or failed.
    MicNotWorking,
    SystemPermission,
    /// A call is on but no audio comes from it.
    NotHearingApp(Option<String>),
    SystemFailed(String),
    /// Audio or transcript could not be saved, or soon can't be.
    DiskFull,
    /// The cloud refused the sign-in; the audio waits for a new one.
    SignIn,
    /// The cloud isn't answering and nothing stands in: the audio is kept.
    CloudCatchingUp,
    /// The cloud isn't answering; this computer transcribes meanwhile.
    CloudLocal,
    /// The day's cloud audio is used up; the audio waits for the reset.
    CloudLimitWaiting,
    /// The day's cloud audio is used up; this computer transcribes.
    CloudLimitLocal,
    /// Words did not land and the meeting keeps no audio to find them in.
    WordsMissing,
    /// The microphone sends nothing but digital silence.
    MicSilent,
    NoModel,
    TapUnsupported,
}

impl Concern {
    /// How long it must last before it is shown. Problems that only matter
    /// when they persist wait; ones that are simply true show at once.
    fn delay(&self) -> Duration {
        match self {
            Concern::MicNotWorking | Concern::CloudCatchingUp => Duration::from_secs(5),
            Concern::CloudLocal => Duration::from_secs(10),
            _ => Duration::ZERO,
        }
    }

    fn kind(&self) -> u8 {
        match self {
            Concern::MicPermission => 0,
            Concern::NoMicrophone => 1,
            Concern::MicNotWorking => 2,
            Concern::SystemPermission => 3,
            Concern::NotHearingApp(_) => 4,
            Concern::SystemFailed(_) => 5,
            Concern::DiskFull => 6,
            Concern::SignIn => 7,
            Concern::CloudCatchingUp => 8,
            Concern::CloudLocal => 9,
            Concern::CloudLimitWaiting => 10,
            Concern::CloudLimitLocal => 11,
            Concern::WordsMissing => 12,
            Concern::MicSilent => 13,
            Concern::NoModel => 14,
            Concern::TapUnsupported => 15,
        }
    }

    /// Transient problems keep their line a moment after they clear, so a
    /// flapping source does not blink.
    fn lingers(&self) -> bool {
        matches!(
            self,
            Concern::MicNotWorking
                | Concern::NotHearingApp(_)
                | Concern::CloudCatchingUp
                | Concern::CloudLocal
        )
    }
}

const LINGER: Duration = Duration::from_secs(3);

/// What macOS says about Cap recording the computer's audio.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AudioGrant {
    Granted,
    Denied,
    /// Never answered.
    NotDetermined,
    /// The answer can't be read.
    Unknown,
}

/// What the computer audio tap has delivered since the meeting began.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TapHeard {
    /// Any callback at all.
    pub callbacks: bool,
    /// Any sample above digital silence.
    pub sound: bool,
}

/// Whether the call's audio is missing its permission. Before macOS 27.3
/// only a refusal with a tap that never called back counts. From 27.3 the
/// system audio prompt still appears (measured on 27.3 beta 2), but a tap
/// without the grant records exact zeros, so anything short of a grant counts
/// while the tap has heard no sound. The grant alone never decides it there:
/// this process's copy can lag a grant made in System Settings, and Unknown
/// means it couldn't be read.
pub fn system_audio_missing(grant: AudioGrant, settings_only: bool, tap: TapHeard) -> bool {
    match grant {
        AudioGrant::Granted => false,
        _ if settings_only => !tap.sound,
        AudioGrant::Denied => !tap.callbacks,
        AudioGrant::NotDetermined | AudioGrant::Unknown => false,
    }
}

/// The computer audio's health after this look at its grant and tap, when it
/// changes: the permission line goes up when the audio is missing and comes
/// down once the tap delivers sound. `None` while the tap has not run long
/// enough to judge, or when nothing changes.
pub fn system_permission_health(
    current: &SourceHealth,
    grant: AudioGrant,
    settings_only: bool,
    tap: Option<TapHeard>,
) -> Option<SourceHealth> {
    let tap = tap?;
    let flagged = *current == SourceHealth::Error(HealthIssue::MissingPermission);
    if flagged {
        return tap.sound.then_some(SourceHealth::Ok);
    }
    (!current.is_error() && system_audio_missing(grant, settings_only, tap))
        .then_some(SourceHealth::Error(HealthIssue::MissingPermission))
}

/// Everything true about the meeting right now, most urgent first.
pub fn concerns(active: &ActiveMeeting) -> Vec<Concern> {
    concerns_with(active, false)
}

/// The same, when the service knows audio went missing (the app was held
/// up and the timeline filled the time with silence).
pub fn concerns_with(active: &ActiveMeeting, audio_missed: bool) -> Vec<Concern> {
    let mut out = Vec::new();
    match &active.mic.health {
        SourceHealth::Error(HealthIssue::MissingPermission) => out.push(Concern::MicPermission),
        SourceHealth::Error(HealthIssue::NoInputDevice) => out.push(Concern::NoMicrophone),
        SourceHealth::Error(HealthIssue::NoCallbacks | HealthIssue::Failed(_)) => {
            out.push(Concern::MicNotWorking)
        }
        _ => {}
    }
    match &active.system.health {
        SourceHealth::Error(HealthIssue::MissingPermission) => out.push(Concern::SystemPermission),
        SourceHealth::Error(HealthIssue::Failed(reason)) => {
            out.push(Concern::SystemFailed(reason.clone()))
        }
        _ => {}
    }
    if active.not_hearing {
        out.push(Concern::NotHearingApp(active.app_name.clone()));
    }
    if active.audio_failed || active.low_disk || active.engine.disk_failed {
        out.push(Concern::DiskFull);
    }
    match active.engine.cloud {
        CloudState::SignIn { .. } => out.push(Concern::SignIn),
        CloudState::Down { local: false } => out.push(Concern::CloudCatchingUp),
        CloudState::Down { local: true } => out.push(Concern::CloudLocal),
        CloudState::DailyLimit { local: false } => out.push(Concern::CloudLimitWaiting),
        CloudState::DailyLimit { local: true } => out.push(Concern::CloudLimitLocal),
        CloudState::Ok => {}
    }
    if active.engine.unrepairable > 0 || audio_missed {
        out.push(Concern::WordsMissing);
    }
    if active.mic.health == SourceHealth::Silent {
        out.push(Concern::MicSilent);
    }
    if active.engine.kind == EngineKind::None && active.engine.issue.is_some() {
        out.push(Concern::NoModel);
    }
    if active.system.health == SourceHealth::Error(HealthIssue::TapUnsupported) {
        out.push(Concern::TapUnsupported);
    }
    out.sort_by_key(Concern::kind);
    out
}

/// Holds back a concern until it has lasted, and keeps a transient one a
/// moment after it clears. Gives every concern worth showing, most urgent
/// first: the line shows the first one the person has not dismissed.
#[derive(Debug, Default)]
pub struct Hysteresis {
    since: Vec<(u8, Instant)>,
    shown: Vec<(Concern, Option<Instant>)>,
}

impl Hysteresis {
    pub fn update(&mut self, now: Instant, concerns: &[Concern]) -> Vec<Concern> {
        self.since
            .retain(|(kind, _)| concerns.iter().any(|c| c.kind() == *kind));
        for concern in concerns {
            if !self.since.iter().any(|(kind, _)| *kind == concern.kind()) {
                self.since.push((concern.kind(), now));
            }
        }
        let mut next: Vec<(Concern, Option<Instant>)> = concerns
            .iter()
            .filter(|c| {
                self.since
                    .iter()
                    .find(|(kind, _)| *kind == c.kind())
                    .is_some_and(|(_, at)| now.saturating_duration_since(*at) >= c.delay())
            })
            .map(|c| (c.clone(), None))
            .collect();
        for (shown, cleared) in self.shown.drain(..) {
            if concerns.contains(&shown) || !shown.lingers() {
                continue;
            }
            let cleared = cleared.unwrap_or(now);
            if now.saturating_duration_since(cleared) < LINGER {
                next.push((shown, Some(cleared)));
            }
        }
        next.sort_by_key(|(c, _)| c.kind());
        self.shown = next.clone();
        next.into_iter().map(|(c, _)| c).collect()
    }
}

/// What the watchdog sees of the computer-audio track each tick.
#[derive(Clone, Copy, Debug, Default)]
pub struct TapView {
    /// A meeting app holds the microphone: a call is on.
    pub call: bool,
    /// Since real audio last arrived (None: no computer-audio track).
    pub since_real: Option<Duration>,
    /// Since that audio last carried any sound.
    pub since_sound: Option<Duration>,
    /// The meeting app showed someone else speaking in the last 30 s.
    pub remote_speaking: bool,
    /// The capture gave up rebuilding itself.
    pub gave_up: bool,
    /// Another app is playing sound while this capture, which has its
    /// grant, hands over nothing: it stopped (a macOS tap; asked only once
    /// audio has been missing long enough to matter).
    pub playing_elsewhere: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Verdict {
    /// Say "not hearing the call".
    pub not_hearing: bool,
    /// Start the capture again.
    pub restart: bool,
}

pub const RESTARTS_MAX: u32 = 10;
/// The wait after a restart before the next, doubling each time.
const RESTART_FIRST_GAP: Duration = Duration::from_secs(10);
const RESTART_MAX_GAP: Duration = Duration::from_secs(120);
const NO_AUDIO_WARN: Duration = Duration::from_secs(10);
/// No audio at all during a call is a dead capture: started again at once.
/// With nothing arriving there is nothing a restart could cut off.
pub const NO_AUDIO_RESTART: Duration = Duration::from_secs(5);
/// Digital silence may be a quiet call: given longer.
const SILENCE_RESTART: Duration = Duration::from_secs(60);
const SPEAKING_BUT_QUIET: Duration = Duration::from_secs(30);

/// Notices a computer-audio capture that went quiet while a call is on: no
/// audio at all (a dead tap or loopback), digital silence for a minute, or
/// the meeting app showing someone talking while nothing is heard. It
/// restarts the capture, at most ten times a meeting for a capture that
/// looks dead and ten for digital silence alone.
#[derive(Debug, Default)]
pub struct Watchdog {
    /// Restarts of a capture that looked dead.
    pub restarts: u32,
    /// Restarts for digital silence alone. Counted apart: a far side that
    /// stays quiet for a few minutes at a time uses all of these within one
    /// meeting, and a capture that dies afterwards still needs its own.
    pub quiet_restarts: u32,
    last: Option<Instant>,
}

fn restart_gap(restarts: u32) -> Duration {
    RESTART_FIRST_GAP
        .saturating_mul(1 << restarts.saturating_sub(1).min(8))
        .min(RESTART_MAX_GAP)
}

impl Watchdog {
    pub fn check(&mut self, now: Instant, view: TapView) -> Verdict {
        let (Some(since_real), Some(since_sound)) = (view.since_real, view.since_sound) else {
            return Verdict::default();
        };
        // A capture that gave up, or one that stopped handing over audio
        // where a working one always does, is dead whether or not a call is
        // on.
        let stopped = view.playing_elsewhere && since_real >= NO_AUDIO_RESTART;
        if !view.call && !view.gave_up && !stopped {
            return Verdict::default();
        }
        if !view.call {
            let restart = self.restarts < RESTARTS_MAX
                && self
                    .last
                    .is_none_or(|at| now.saturating_duration_since(at) >= restart_gap(self.restarts));
            if restart {
                self.restarts += 1;
                self.last = Some(now);
            }
            return Verdict {
                not_hearing: false,
                restart,
            };
        }
        let speaking_quiet = view.remote_speaking && since_sound >= SPEAKING_BUT_QUIET;
        let not_hearing = since_real >= NO_AUDIO_WARN || view.gave_up || speaking_quiet;
        let dead = since_real >= NO_AUDIO_RESTART || speaking_quiet || view.gave_up;
        let quiet = since_sound >= SILENCE_RESTART;
        let spent = if dead {
            &mut self.restarts
        } else {
            &mut self.quiet_restarts
        };
        let restart = (dead || quiet)
            && *spent < RESTARTS_MAX
            && self
                .last
                .is_none_or(|at| now.saturating_duration_since(at) >= restart_gap(*spent));
        if restart {
            *spent += 1;
            self.last = Some(now);
        }
        Verdict {
            not_hearing,
            restart,
        }
    }
}

/// Free space on the volume holding `path`, in bytes.
pub fn free_bytes(path: &std::path::Path) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
        let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(c.as_ptr(), &mut stat) } != 0 {
            return None;
        }
        Some((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut free = 0u64;
        let ok = unsafe {
            windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut free,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        (ok != 0).then_some(free)
    }
}

/// A jump in filled-in silence this large means audio was never captured
/// (the app was stopped or starved); the line says words may be missing.
pub const MISSED_AUDIO: Duration = Duration::from_secs(5);
/// How long that line stays after the jump.
pub const MISSED_SHOWN: Duration = Duration::from_secs(60);

/// Below this, a meeting may not finish saving.
pub const LOW_DISK_BYTES: u64 = 500 * 1024 * 1024;

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    const SILENT: TapHeard = TapHeard {
        callbacks: false,
        sound: false,
    };
    const ZEROS: TapHeard = TapHeard {
        callbacks: true,
        sound: false,
    };
    const LIVE: TapHeard = TapHeard {
        callbacks: true,
        sound: true,
    };

    #[test]
    fn before_macos_27_3_only_a_refusal_with_a_dead_tap_counts() {
        use AudioGrant::*;
        assert!(system_audio_missing(Denied, false, SILENT));
        assert!(!system_audio_missing(Denied, false, ZEROS));
        assert!(!system_audio_missing(Granted, false, SILENT));
        assert!(!system_audio_missing(NotDetermined, false, SILENT));
        assert!(!system_audio_missing(Unknown, false, SILENT));
    }

    #[test]
    fn from_macos_27_3_no_grant_and_no_sound_is_missing_call_audio() {
        use AudioGrant::*;
        // An ungranted tap records exact zeros, with or without callbacks.
        assert!(system_audio_missing(NotDetermined, true, ZEROS));
        assert!(system_audio_missing(NotDetermined, true, SILENT));
        assert!(system_audio_missing(Denied, true, ZEROS));
        assert!(system_audio_missing(Unknown, true, ZEROS));
        assert!(!system_audio_missing(Granted, true, ZEROS));
    }

    #[test]
    fn a_tap_that_hears_sound_outweighs_a_stale_or_unreadable_grant() {
        use AudioGrant::*;
        // Granted in System Settings while Cap runs: the process's copy can
        // still say "not determined" until a relaunch.
        assert!(!system_audio_missing(NotDetermined, true, LIVE));
        // The TCC lookup failed.
        assert!(!system_audio_missing(Unknown, true, LIVE));
        assert!(!system_audio_missing(Denied, true, LIVE));
    }

    #[test]
    fn the_permission_line_follows_the_tap_on_macos_27_3() {
        use AudioGrant::*;
        let missing = SourceHealth::Error(HealthIssue::MissingPermission);
        // Not judged before the tap has run a moment.
        assert_eq!(
            system_permission_health(&SourceHealth::Ok, NotDetermined, true, None),
            None
        );
        // Up while only zeros arrive.
        assert_eq!(
            system_permission_health(&SourceHealth::Ok, NotDetermined, true, Some(ZEROS)),
            Some(missing.clone())
        );
        assert_eq!(
            system_permission_health(&missing, NotDetermined, true, Some(ZEROS)),
            None
        );
        // Down once real sound arrives, whatever the grant copy says.
        assert_eq!(
            system_permission_health(&missing, NotDetermined, true, Some(LIVE)),
            Some(SourceHealth::Ok)
        );
        // Never up while sound flows.
        assert_eq!(
            system_permission_health(&SourceHealth::Ok, Unknown, true, Some(LIVE)),
            None
        );
        // Another fault is left alone.
        let failed = SourceHealth::Error(HealthIssue::Failed("x".into()));
        assert_eq!(
            system_permission_health(&failed, NotDetermined, true, Some(ZEROS)),
            None
        );
    }

    #[test]
    fn the_version_decides_which_rule_applies() {
        use AudioGrant::*;
        let on = |version: &str, grant, tap| {
            system_audio_missing(
                grant,
                crate::permissions::version_has_settings_only_grants(version),
                tap,
            )
        };
        assert!(on("27.3", NotDetermined, ZEROS));
        assert!(!on("27.0.1", NotDetermined, ZEROS));
        assert!(on("27.0.1", Denied, SILENT));
    }

    #[test]
    fn a_blip_never_shows_and_a_lasting_problem_does() {
        let t0 = Instant::now();
        let mut h = Hysteresis::default();
        let first = |v: Vec<Concern>| v.into_iter().next();
        assert_eq!(first(h.update(t0, &[Concern::MicNotWorking])), None);
        assert_eq!(first(h.update(t0 + secs(2), &[])), None, "cleared before it was shown");
        assert_eq!(first(h.update(t0 + secs(3), &[Concern::MicNotWorking])), None);
        assert_eq!(
            first(h.update(t0 + secs(8), &[Concern::MicNotWorking])),
            Some(Concern::MicNotWorking)
        );
        // Lingers a moment after it clears, then goes.
        assert_eq!(first(h.update(t0 + secs(9), &[])), Some(Concern::MicNotWorking));
        assert_eq!(first(h.update(t0 + secs(13), &[])), None);
    }

    #[test]
    fn plain_facts_show_at_once_and_the_most_urgent_wins() {
        let t0 = Instant::now();
        let mut h = Hysteresis::default();
        assert_eq!(h.update(t0, &[Concern::NoModel]), vec![Concern::NoModel]);
        let both = [Concern::MicPermission, Concern::NoModel];
        assert_eq!(h.update(t0, &both), both.to_vec());
        // A waiting concern does not hide a ripe lesser one.
        let waiting = [Concern::MicNotWorking, Concern::NoModel];
        assert_eq!(h.update(t0 + secs(1), &waiting), vec![Concern::NoModel]);
    }

    fn calling(real: u64, sound: u64) -> TapView {
        TapView {
            call: true,
            since_real: Some(secs(real)),
            since_sound: Some(secs(sound)),
            ..TapView::default()
        }
    }

    #[test]
    fn a_dead_tap_restarts_after_five_seconds_and_warns_after_ten() {
        let t0 = Instant::now();
        let mut w = Watchdog::default();
        assert_eq!(w.check(t0, calling(3, 3)), Verdict::default());
        assert_eq!(
            w.check(t0, calling(6, 6)),
            Verdict { not_hearing: false, restart: true }
        );
        assert_eq!(
            w.check(t0 + secs(5), calling(11, 11)),
            Verdict { not_hearing: true, restart: false },
            "the next restart waits 10 s"
        );
        assert!(w.check(t0 + secs(10), calling(16, 16)).restart);
        assert!(!w.check(t0 + secs(25), calling(31, 31)).restart, "then 20 s");
        assert!(w.check(t0 + secs(30), calling(36, 36)).restart);
    }

    #[test]
    fn no_call_means_no_warning_and_restarts_are_capped() {
        let t0 = Instant::now();
        let mut w = Watchdog::default();
        let quiet = TapView { call: false, ..calling(600, 600) };
        assert_eq!(w.check(t0, quiet), Verdict::default(), "silence without a call is normal");
        for n in 0..RESTARTS_MAX {
            assert!(w.check(t0 + secs(121 * u64::from(n)), calling(600, 600)).restart);
        }
        assert!(!w.check(t0 + secs(121 * 11), calling(600, 600)).restart);
    }

    #[test]
    fn a_capture_that_gave_up_restarts_even_without_a_call() {
        let t0 = Instant::now();
        let mut w = Watchdog::default();
        let dead = TapView { call: false, gave_up: true, ..calling(30, 30) };
        assert_eq!(w.check(t0, dead), Verdict { not_hearing: false, restart: true });
        assert!(!w.check(t0 + secs(5), dead).restart, "not again at once");
    }

    #[test]
    fn a_capture_that_hears_nothing_while_another_app_plays_restarts_without_a_call() {
        let t0 = Instant::now();
        let mut w = Watchdog::default();
        let tap = |real| TapView { call: false, playing_elsewhere: true, ..calling(real, real) };
        assert_eq!(w.check(t0, tap(3)), Verdict::default(), "a moment's gap is fine");
        assert_eq!(w.check(t0, tap(6)), Verdict { not_hearing: false, restart: true });
        assert!(!w.check(t0 + secs(5), tap(11)).restart, "the next restart waits 10 s");
        assert!(w.check(t0 + secs(10), tap(16)).restart);
        let quiet = TapView { call: false, ..calling(600, 600) };
        assert_eq!(w.check(t0 + secs(600), quiet), Verdict::default(), "nothing playing is a quiet room");
    }

    #[test]
    fn digital_silence_restarts_quietly_but_a_speaker_we_cannot_hear_warns() {
        let t0 = Instant::now();
        let mut w = Watchdog::default();
        assert_eq!(
            w.check(t0, calling(0, 61)),
            Verdict { not_hearing: false, restart: true },
            "a silent call is not reported, only retried"
        );
        let mut w = Watchdog::default();
        let speaking = TapView { remote_speaking: true, ..calling(0, 31) };
        assert_eq!(w.check(t0, speaking), Verdict { not_hearing: true, restart: true });
    }

    #[test]
    fn a_quiet_call_leaves_the_restarts_a_dead_capture_needs() {
        let t0 = Instant::now();
        let mut w = Watchdog::default();
        let mut quiet = 0;
        for s in 0..1800 {
            quiet += u32::from(w.check(t0 + secs(s), calling(0, s)).restart);
        }
        assert_eq!(quiet, RESTARTS_MAX, "half an hour of silence is retried ten times, no more");
        assert_eq!(
            w.check(t0 + secs(1800), calling(6, 1800)),
            Verdict { not_hearing: false, restart: true },
            "a capture that dies after it still starts again"
        );
    }

    #[test]
    fn concerns_come_most_urgent_first() {
        let mut active = crate::meetings::tests::active_meeting();
        active.mic.health = SourceHealth::Silent;
        active.engine.cloud = CloudState::Down { local: false };
        active.not_hearing = true;
        active.app_name = Some("Zoom".into());
        assert_eq!(
            concerns(&active),
            vec![
                Concern::NotHearingApp(Some("Zoom".into())),
                Concern::CloudCatchingUp,
                Concern::MicSilent
            ]
        );
    }

    #[test]
    fn free_space_reads_on_this_computer() {
        let dir = tempfile::tempdir().unwrap();
        assert!(free_bytes(dir.path()).is_some_and(|b| b > 0));
    }
}
