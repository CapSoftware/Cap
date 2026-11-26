//! A meeting's microphone that stops mid-meeting (headphones disconnected,
//! a USB microphone unplugged, the device reset): the meeting moves to the
//! computer's default input so the rest of the meeting is still heard, and
//! back to its own microphone when that returns. A screen recording's feed
//! has its own watch (`session/input_watch.rs`); this one only acts while
//! no screen recording holds the feed.

use std::time::{Duration, Instant};

/// Where the meeting's microphone goes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MicMove {
    /// The device the feed is on: open it again.
    Reopen(String),
    /// Another device: the meeting's own microphone back, or the default.
    Switch(String),
}

/// Tries at the meeting's own microphone before a stalled meeting settles
/// for the default input: a device that is listed but not delivering.
const OWN_TRIES: u32 = 2;

/// `own` is the meeting's microphone (the one its settings name, or the one
/// it started on), `current` the one the feed is on now, `listed` the inputs
/// the computer has and `default` its default input. `stalled` with the
/// try count when the microphone stopped delivering; otherwise only a way
/// back to `own` is a move. Nothing when there is nowhere to go.
pub fn mic_move(
    own: Option<&str>,
    current: Option<&str>,
    listed: &[String],
    default: Option<&str>,
    stalled: Option<u32>,
) -> Option<MicMove> {
    let present = |name: &&str| listed.iter().any(|listed| listed == name);
    let own = own.filter(present);
    let target = match stalled {
        None => own.filter(|own| Some(*own) != current)?,
        Some(tries) => own
            .filter(|_| tries <= OWN_TRIES)
            .or(default.filter(present))
            .or(own)?,
    };
    Some(if Some(target) == current {
        MicMove::Reopen(target.to_string())
    } else {
        MicMove::Switch(target.to_string())
    })
}

/// Whether the meeting may go back to its own microphone. Given up on while
/// it was still listed (it is there but sends nothing), it stays out until
/// it shows it recovered by being unplugged and plugged back in; otherwise
/// the meeting would go back to it every few seconds, lose its audio again,
/// and keep interrupting the recording.
#[derive(Debug, Default)]
pub struct OwnReturn {
    failed: bool,
    gone_since: bool,
}

impl OwnReturn {
    /// One look at the device list: whether the own microphone may be used.
    fn returnable(&mut self, own_listed: bool) -> bool {
        if !self.failed {
            return true;
        }
        if !own_listed {
            self.gone_since = true;
            return false;
        }
        if self.gone_since {
            *self = Self::default();
            return true;
        }
        false
    }
}

/// [`mic_move`] for a meeting that remembers giving up on its own microphone.
pub fn decide(
    own_return: &mut OwnReturn,
    own: Option<&str>,
    current: Option<&str>,
    listed: &[String],
    default: Option<&str>,
    stalled: Option<u32>,
) -> Option<MicMove> {
    let own_listed = own.is_some_and(|own| listed.iter().any(|name| name == own));
    let usable = own.filter(|_| own_return.returnable(own_listed));
    let step = mic_move(usable, current, listed, default, stalled);
    if stalled.is_some()
        && own_listed
        && let Some(MicMove::Switch(to)) = &step
        && Some(to.as_str()) != own
    {
        own_return.failed = true;
        own_return.gone_since = false;
    }
    step
}

/// How long a stalled microphone waits before the next try: soon at first
/// (a device switch takes a moment), then every few seconds while nothing
/// is there to go to.
fn wait_after(tries: u32) -> Duration {
    Duration::from_secs(match tries {
        0 | 1 => 2,
        2 => 4,
        _ => 8,
    })
}

/// While the meeting is on another microphone, how often to look for its own.
const AWAY_EVERY: Duration = Duration::from_secs(5);

/// When to look at the computer's microphones while a meeting records.
#[derive(Debug, Default)]
pub struct MicWatch {
    tries: u32,
    next_at: Option<Instant>,
    busy: bool,
}

impl MicWatch {
    /// Called once a second. `Some(tries)` when a look is due now for a
    /// stalled microphone, `Some(0)` for a look for the meeting's own one
    /// (`away`); while the microphone it should be on delivers, it rests.
    pub fn due(&mut self, now: Instant, stalled: bool, away: bool) -> Option<u32> {
        if self.busy || self.next_at.is_some_and(|at| now < at) {
            if !stalled && self.tries > 0 {
                self.tries = 0;
                self.next_at = None;
            }
            return None;
        }
        if stalled {
            self.tries += 1;
            self.next_at = Some(now + wait_after(self.tries));
        } else {
            self.tries = 0;
            if !away {
                self.next_at = None;
                return None;
            }
            self.next_at = Some(now + AWAY_EVERY);
        }
        self.busy = true;
        Some(self.tries)
    }

    /// The look (and any move it made) finished.
    pub fn done(&mut self) {
        self.busy = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    const BUILT_IN: &str = "MacBook Pro Microphone";

    #[test]
    fn unplugged_headphones_move_the_meeting_to_the_default_input() {
        let listed = names(&[BUILT_IN]);
        assert_eq!(
            mic_move(
                Some("AirPods Pro"),
                Some("AirPods Pro"),
                &listed,
                Some(BUILT_IN),
                Some(1)
            ),
            Some(MicMove::Switch(BUILT_IN.into()))
        );
    }

    #[test]
    fn the_meetings_own_microphone_is_reopened_first_then_the_default_taken() {
        let listed = names(&[BUILT_IN, "Studio Mic"]);
        for tries in 1..=OWN_TRIES {
            assert_eq!(
                mic_move(
                    Some("Studio Mic"),
                    Some("Studio Mic"),
                    &listed,
                    Some(BUILT_IN),
                    Some(tries)
                ),
                Some(MicMove::Reopen("Studio Mic".into()))
            );
        }
        // Listed but still not delivering: the default input hears the rest.
        assert_eq!(
            mic_move(
                Some("Studio Mic"),
                Some("Studio Mic"),
                &listed,
                Some(BUILT_IN),
                Some(OWN_TRIES + 1)
            ),
            Some(MicMove::Switch(BUILT_IN.into()))
        );
    }

    #[test]
    fn a_listed_microphone_that_sends_nothing_is_not_gone_back_to_until_replugged() {
        let both = names(&[BUILT_IN, "Studio Mic"]);
        let mut back = OwnReturn::default();
        let own = Some("Studio Mic");
        let step = |back: &mut OwnReturn,
                    current: Option<&str>,
                    listed: &[String],
                    stalled: Option<u32>| {
            decide(back, own, current, listed, Some(BUILT_IN), stalled)
        };
        for tries in 1..=OWN_TRIES {
            assert_eq!(
                step(&mut back, own, &both, Some(tries)),
                Some(MicMove::Reopen("Studio Mic".into()))
            );
        }
        assert_eq!(
            step(&mut back, own, &both, Some(OWN_TRIES + 1)),
            Some(MicMove::Switch(BUILT_IN.into()))
        );
        // The default delivers. Before, the next look went straight back to
        // the listed but silent microphone and the loop began again.
        assert_eq!(
            mic_move(own, Some(BUILT_IN), &both, Some(BUILT_IN), None),
            Some(MicMove::Switch("Studio Mic".into())),
            "what a look without the memory would do"
        );
        for _ in 0..5 {
            assert_eq!(step(&mut back, Some(BUILT_IN), &both, None), None);
        }
        // A stall on the default does not reach for the silent one either.
        assert_eq!(
            step(&mut back, Some(BUILT_IN), &both, Some(1)),
            Some(MicMove::Reopen(BUILT_IN.into()))
        );
        // Unplugged and plugged back in: the meeting goes back to it.
        let without = names(&[BUILT_IN]);
        assert_eq!(step(&mut back, Some(BUILT_IN), &without, None), None);
        assert_eq!(
            step(&mut back, Some(BUILT_IN), &both, None),
            Some(MicMove::Switch("Studio Mic".into()))
        );
    }

    #[test]
    fn an_unplugged_microphone_is_still_gone_back_to_when_it_returns() {
        let mut back = OwnReturn::default();
        let own = Some("AirPods Pro");
        let without = names(&[BUILT_IN]);
        assert_eq!(
            decide(&mut back, own, own, &without, Some(BUILT_IN), Some(1)),
            Some(MicMove::Switch(BUILT_IN.into()))
        );
        let with = names(&[BUILT_IN, "AirPods Pro"]);
        assert_eq!(
            decide(&mut back, own, Some(BUILT_IN), &with, Some(BUILT_IN), None),
            Some(MicMove::Switch("AirPods Pro".into()))
        );
    }

    #[test]
    fn the_meeting_goes_back_to_its_own_microphone_when_it_returns() {
        let without = names(&[BUILT_IN]);
        assert_eq!(
            mic_move(
                Some("Studio Mic"),
                Some(BUILT_IN),
                &without,
                Some(BUILT_IN),
                None
            ),
            None
        );
        let with = names(&[BUILT_IN, "Studio Mic"]);
        assert_eq!(
            mic_move(
                Some("Studio Mic"),
                Some(BUILT_IN),
                &with,
                Some(BUILT_IN),
                None
            ),
            Some(MicMove::Switch("Studio Mic".into()))
        );
        assert_eq!(
            mic_move(
                Some("Studio Mic"),
                Some("Studio Mic"),
                &with,
                Some(BUILT_IN),
                None
            ),
            None
        );
    }

    #[test]
    fn a_stalled_default_with_nothing_else_is_reopened_in_place() {
        let listed = names(&["USB Mic"]);
        assert_eq!(
            mic_move(
                Some("USB Mic"),
                Some("USB Mic"),
                &listed,
                Some("USB Mic"),
                Some(5)
            ),
            Some(MicMove::Reopen("USB Mic".into()))
        );
    }

    #[test]
    fn no_input_at_all_is_nothing_to_do() {
        assert_eq!(
            mic_move(Some("USB Mic"), Some("USB Mic"), &[], None, Some(1)),
            None
        );
        // A default the list does not have yet (it is still appearing).
        assert_eq!(mic_move(None, None, &[], Some("USB Mic"), Some(1)), None);
    }

    #[test]
    fn a_microphone_plugged_in_after_the_start_is_taken() {
        let listed = names(&["USB Mic"]);
        assert_eq!(
            mic_move(None, None, &listed, Some("USB Mic"), Some(1)),
            Some(MicMove::Switch("USB Mic".into()))
        );
    }

    #[test]
    fn the_watch_tries_soon_then_backs_off_and_rests_while_audio_arrives() {
        let t0 = Instant::now();
        let at = |s: u64| t0 + Duration::from_secs(s);
        let mut watch = MicWatch::default();
        assert_eq!(watch.due(t0, false, false), None);
        assert_eq!(watch.due(t0, true, false), Some(1));
        // One look at a time.
        assert_eq!(watch.due(at(5), true, false), None);
        watch.done();
        assert_eq!(watch.due(at(1), true, false), None);
        assert_eq!(watch.due(at(2), true, false), Some(2));
        watch.done();
        assert_eq!(watch.due(at(5), true, false), None);
        assert_eq!(watch.due(at(6), true, false), Some(3));
        watch.done();
        assert_eq!(watch.due(at(13), true, false), None);
        assert_eq!(watch.due(at(14), true, false), Some(4));
        watch.done();
        // Audio again: the next stall starts from a quick try.
        assert_eq!(watch.due(at(15), false, false), None);
        assert_eq!(watch.due(at(16), true, false), Some(1));
    }

    #[test]
    fn away_from_its_own_microphone_the_watch_looks_every_few_seconds() {
        let t0 = Instant::now();
        let at = |s: u64| t0 + Duration::from_secs(s);
        let mut watch = MicWatch::default();
        assert_eq!(watch.due(t0, false, true), Some(0));
        watch.done();
        assert_eq!(watch.due(at(4), false, true), None);
        assert_eq!(watch.due(at(5), false, true), Some(0));
        watch.done();
        // Back on it: nothing to look for.
        assert_eq!(watch.due(at(10), false, false), None);
        assert_eq!(watch.due(at(11), false, false), None);
    }
}
