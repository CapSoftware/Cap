//! What a meeting note says about its own health: the live line's words
//! (the banner above the bottom bar shows them), and a one-time line on a
//! meeting Cap finished after it closed by itself or that missed audio.

use cap_meetings::library::DocMeta;
use gpui::{AnyElement, App};

use super::super::{cap_ai, style::Palette};
use crate::{
    i18n::tr,
    meetings::{Meetings, health::Concern, persist},
};

impl Concern {
    /// The line's words: short, calm, and only what is true.
    pub fn message(&self) -> String {
        match self {
            Concern::SystemPermission => tr::documents::health::system_permission().into(),
            Concern::NoMicrophone => tr::documents::health::no_microphone().into(),
            Concern::MicPermission => tr::documents::health::mic_permission().into(),
            Concern::MicNotWorking => tr::documents::health::mic_not_working().into(),
            Concern::MicSilent => tr::documents::health::mic_silent().into(),
            Concern::TapUnsupported => tr::documents::health::tap_unsupported().into(),
            Concern::NotHearingApp(Some(app)) => tr::documents::health::not_hearing_app(app),
            Concern::NotHearingApp(None) => tr::documents::health::no_call_audio().into(),
            Concern::SystemFailed(reason) => tr::documents::health::failed(reason),
            Concern::DiskFull => tr::documents::health::disk_full().into(),
            Concern::SignIn => tr::documents::health::sign_in_again().into(),
            Concern::CloudCatchingUp => tr::documents::health::offline_catching_up().into(),
            Concern::CloudLocal => tr::documents::health::cloud_local().into(),
            Concern::CloudLimitWaiting => tr::documents::health::cloud_limit_waiting().into(),
            Concern::CloudLimitLocal => tr::documents::health::cloud_limit_local().into(),
            Concern::WordsMissing => tr::documents::health::words_missing().into(),
            Concern::NoModel => tr::documents::health::no_model().into(),
        }
    }
}

/// The note's own copy forgets its one-time line once it was dismissed.
pub fn forget(doc: &mut DocMeta) {
    persist::set_flag(doc, persist::RECOVERED_KEY, false);
    persist::set_flag(doc, persist::NOTES_STALE_KEY, false);
    persist::clear_missed_audio(doc);
}

/// How much of a meeting was never recorded, in words: seconds rounded to
/// the nearest 5 under a minute, else whole minutes.
pub fn missed_line(missed_ms: u64) -> String {
    let secs = (missed_ms + 500) / 1000;
    let rounded = ((secs + 2) / 5 * 5).max(5);
    if rounded < 60 {
        tr::documents::notes::missed_seconds(rounded as usize)
    } else {
        tr::documents::notes::missed_minutes(((secs + 30) / 60).max(1) as usize)
    }
}

pub fn is_recovered(doc: &DocMeta) -> bool {
    persist::flag(doc, persist::RECOVERED_KEY)
}

/// The note's one-time line, until dismissed: "Recovered after Cap closed
/// unexpectedly", how much audio the meeting missed while it recorded, or,
/// when a repair added words after the notes were written, "Transcript
/// updated" with a way to update the notes.
/// `dismissed` runs after the note's flags are cleared.
pub fn recovered(
    doc: Option<&DocMeta>,
    palette: &Palette,
    dismissed: impl Fn(&mut App) + 'static,
) -> Option<AnyElement> {
    let doc = doc?;
    let recovered = is_recovered(doc);
    let missed = persist::missed_audio_ms(doc);
    if !recovered && missed == 0 && !persist::flag(doc, persist::NOTES_STALE_KEY) {
        return None;
    }
    let id = doc.id.clone();
    let dismissed = std::rc::Rc::new(dismissed);
    let clear = {
        let id = id.clone();
        let dismissed = dismissed.clone();
        move |cx: &mut App| {
            if let Some(meetings) = Meetings::try_global(cx) {
                meetings.update(cx, |m, cx| m.clear_recovered(&id, cx));
            }
            dismissed(cx);
        }
    };
    let clear = std::rc::Rc::new(clear);
    let dismiss: cap_ai::Handler = {
        let clear = clear.clone();
        Box::new(move |_, _, cx| clear(cx))
    };
    if recovered {
        return Some(cap_ai::dock_line(
            palette,
            tr::documents::notes::recovered().into(),
            None,
            Some(dismiss),
        ));
    }
    if missed > 0 {
        return Some(cap_ai::dock_line(
            palette,
            missed_line(missed).into(),
            None,
            Some(dismiss),
        ));
    }
    let update: cap_ai::Handler = Box::new(move |_, _, cx| {
        if let Some(meetings) = Meetings::try_global(cx) {
            meetings.update(cx, |m, cx| m.update_notes(&id, cx));
        }
        clear(cx);
    });
    Some(cap_ai::dock_line(
        palette,
        tr::documents::notes::transcript_updated().into(),
        Some((tr::documents::notes::update_notes(), update)),
        Some(dismiss),
    ))
}
