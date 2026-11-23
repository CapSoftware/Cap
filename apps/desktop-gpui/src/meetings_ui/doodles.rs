//! Meeting Mode doodles, drawn in the onboarding window's ink language: path
//! data on the same 120x104 grid, round-capped strokes, accents in blue,
//! entrances only. Nothing here loops except [`crate::onboarding_doodles::WAITING`],
//! which the setup window borrows while it waits on macOS.

use crate::doodle::{Doodle, Ink, Stroke};

/// Two speech bubbles: Cap notices a call.
pub static CALL: Doodle = Doodle {
    view: (120., 104.),
    strokes: &[
        Stroke::ink("M 22 12 L 62 12 Q 72 12 72 22 L 72 42 Q 72 52 62 52 L 36 52 L 22 64 L 24 52 Q 12 52 12 42 L 12 22 Q 12 12 22 12 Z")
            .draw(60, 800),
        Stroke::ink("M 30 32.5 L 30 32.5 M 42 32.5 L 42 32.5 M 54 32.5 L 54 32.5")
            .with_ink(Ink::Soft)
            .width(5.5)
            .fade(650, 300),
        Stroke::ink("M 98 46 L 58 46 Q 48 46 48 56 L 48 74 Q 48 84 58 84 L 86 84 L 100 95 L 98 84 Q 108 84 108 74 L 108 56 Q 108 46 98 46 Z")
            .with_ink(Ink::Accent)
            .width(3.5)
            .draw(700, 750),
        Stroke::ink("M 60 60 L 94 60 M 60 70 L 84 70")
            .with_ink(Ink::Accent)
            .width(3.)
            .draw(1250, 350),
    ],
};

/// A record button under a fingertip's click: nothing records until you say so.
pub static RECORD: Doodle = Doodle {
    view: (120., 104.),
    strokes: &[
        Stroke::ink("M 58 18 C 76.8 18 92 33.2 92 52 C 92 70.8 76.8 86 58 86 C 39.2 86 24 70.8 24 52 C 24 34 38 19.5 55 18.2 C 60 17.8 65 18.6 69 20.4")
            .draw(60, 850),
        Stroke::ink("M 58 39 C 65.2 39 71 44.8 71 52 C 71 59.2 65.2 65 58 65 C 50.8 65 45 59.2 45 52 C 45 44.8 50.8 39 58 39 Z")
            .with_ink(Ink::Red)
            .filled()
            .pop(800, 450),
        Stroke::ink("M 96 20 L 103 13 M 100 32 L 110 31 M 86 13 L 87 4")
            .with_ink(Ink::Soft)
            .width(3.)
            .draw(1150, 300),
    ],
};

/// A page of notes with a tick beside it: the transcript and clear notes.
pub static NOTES: Doodle = Doodle {
    view: (120., 104.),
    strokes: &[
        Stroke::ink("M 22 10 L 62 10 L 78 26 L 78 92 L 22 92 Z").draw(60, 800),
        Stroke::ink("M 62 10 L 62 26 L 78 26").draw(650, 250),
        Stroke::ink("M 33 40 L 66 40 M 33 52 L 66 52 M 33 64 L 54 64 M 33 76 L 60 76")
            .with_ink(Ink::Soft)
            .width(3.)
            .draw(800, 600),
        Stroke::ink("M 84 62 L 93 72 L 110 48")
            .with_ink(Ink::Green)
            .width(5.)
            .draw(1300, 400),
    ],
};

/// A speaker with sound coming out: everyone else in the call.
pub static SPEAKER: Doodle = Doodle {
    view: (120., 104.),
    strokes: &[
        Stroke::ink(
            "M 18 40 L 34 40 L 56 20 L 56 84 L 34 64 L 18 64 Q 14 64 14 60 L 14 44 Q 14 40 18 40 Z",
        )
        .draw(60, 800),
        Stroke::ink("M 70 40 Q 78 52 70 64")
            .with_ink(Ink::Accent)
            .width(3.5)
            .pop(800, 450),
        Stroke::ink("M 81 31 Q 94 52 81 73")
            .with_ink(Ink::Accent)
            .width(3.5)
            .pop(950, 450),
        Stroke::ink("M 92 22 Q 110 52 92 82")
            .with_ink(Ink::Accent)
            .width(3.5)
            .pop(1100, 450),
    ],
};

/// A browser window holding a video call: meeting pages, told apart.
pub static BROWSER: Doodle = Doodle {
    view: (120., 104.),
    strokes: &[
        Stroke::ink("M 18 14 L 102 14 Q 110 14 110 22 L 110 82 Q 110 90 102 90 L 18 90 Q 10 90 10 82 L 10 22 Q 10 14 18 14 Z")
            .draw(60, 850),
        Stroke::ink("M 10 31 L 110 31").draw(700, 300),
        Stroke::ink("M 20 22.5 L 20 22.5 M 28 22.5 L 28 22.5 M 36 22.5 L 36 22.5")
            .with_ink(Ink::Soft)
            .width(4.5)
            .fade(850, 250),
        Stroke::ink("M 48 22.5 L 98 22.5")
            .with_ink(Ink::Track)
            .width(5.)
            .draw(900, 300),
        Stroke::ink("M 38 47 L 64 47 Q 69 47 69 52 L 69 69 Q 69 74 64 74 L 38 74 Q 33 74 33 69 L 33 52 Q 33 47 38 47 Z")
            .with_ink(Ink::Accent)
            .width(3.5)
            .draw(1050, 450),
        Stroke::ink("M 69 56 L 86 47 L 86 74 L 69 65")
            .with_ink(Ink::Accent)
            .width(3.5)
            .draw(1350, 300),
    ],
};

/// A cloud turning sound into lines of text: Cap Cloud.
pub static CLOUD: Doodle = Doodle {
    view: (120., 104.),
    strokes: &[
        Stroke::ink("M 34 60 L 88 60 C 98 60 106 52 106 43 C 106 34 98.5 27 89.5 27 C 86.5 27 84 27.7 81.8 29 C 79 18.5 69.5 11 58.5 11 C 47 11 37.5 18.8 34.8 29.5 C 25.2 30 17.5 37.4 17.5 46 C 17.5 54 24.8 60 34 60 Z")
            .draw(60, 850),
        Stroke::ink("M 44 39 L 44 45 M 52 33 L 52 51 M 60 37 L 60 47 M 68 31 L 68 53 M 76 38 L 76 46")
            .with_ink(Ink::Accent)
            .width(4.)
            .draw(800, 500),
        Stroke::ink("M 30 76 L 90 76 M 30 89 L 70 89")
            .with_ink(Ink::Soft)
            .width(3.)
            .draw(1200, 450),
    ],
};

/// A laptop doing the listening itself: on this computer.
pub static LAPTOP: Doodle = Doodle {
    view: (120., 104.),
    strokes: &[
        Stroke::ink("M 26 16 L 94 16 Q 100 16 100 22 L 100 70 L 20 70 L 20 22 Q 20 16 26 16 Z")
            .draw(60, 800),
        Stroke::ink("M 8 70 L 112 70 Q 110 82 100 82 L 20 82 Q 10 82 8 70 Z").draw(700, 400),
        Stroke::ink(
            "M 44 37 L 44 43 M 52 31 L 52 49 M 60 35 L 60 45 M 68 29 L 68 51 M 76 36 L 76 44",
        )
        .with_ink(Ink::Accent)
        .width(4.)
        .draw(950, 500),
        Stroke::ink("M 40 60 L 80 60")
            .with_ink(Ink::Soft)
            .width(3.)
            .draw(1300, 300),
    ],
};

/// A calendar page with one day circled.
pub static CALENDAR: Doodle = Doodle {
    view: (120., 104.),
    strokes: &[
        Stroke::ink("M 20 20 L 100 20 Q 108 20 108 28 L 108 88 Q 108 96 100 96 L 20 96 Q 12 96 12 88 L 12 28 Q 12 20 20 20 Z")
            .draw(60, 850),
        Stroke::ink("M 12 38 L 108 38").draw(650, 300),
        Stroke::ink("M 36 10 L 36 28 M 84 10 L 84 28").draw(800, 300),
        Stroke::ink("M 30 54 L 30 54 M 48 54 L 48 54 M 66 54 L 66 54 M 84 54 L 84 54 M 30 69 L 30 69 M 48 69 L 48 69 M 84 69 L 84 69 M 30 84 L 30 84 M 48 84 L 48 84 M 66 84 L 66 84")
            .with_ink(Ink::Soft)
            .width(5.)
            .fade(900, 350),
        Stroke::ink("M 66 59.5 C 73 59.5 77.5 63.5 77.5 69 C 77.5 75 72.5 79 65.5 79 C 59 79 54.5 75 54.5 69 C 54.5 63 59.5 58.5 67.5 59.8")
            .with_ink(Ink::Accent)
            .width(3.5)
            .draw(1200, 450),
        Stroke::ink("M 66 69 L 66 69")
            .with_ink(Ink::Accent)
            .width(5.)
            .pop(1500, 300),
    ],
};

/// A bell with a little ring: reminders before meetings.
pub static BELL: Doodle = Doodle {
    view: (120., 104.),
    strokes: &[
        Stroke::ink("M 60 16 C 43 16 37 30 37 46 L 37 62 L 27 74 L 93 74 L 83 62 L 83 46 C 83 30 77 16 60 16 Z")
            .draw(60, 850),
        Stroke::ink("M 60 8 L 60 16").draw(700, 200),
        Stroke::ink("M 51 82 Q 60 92 69 82").draw(850, 300),
        Stroke::ink("M 96 24 Q 106 34 103 48")
            .with_ink(Ink::Accent)
            .width(3.5)
            .pop(1100, 450),
        Stroke::ink("M 24 24 Q 14 34 17 48")
            .with_ink(Ink::Accent)
            .width(3.5)
            .pop(1200, 450),
    ],
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_meeting_doodle_settles_within_two_seconds() {
        for doodle in [
            &CALL, &RECORD, &NOTES, &SPEAKER, &BROWSER, &CLOUD, &LAPTOP, &CALENDAR, &BELL,
        ] {
            assert_eq!(doodle.view, (120., 104.));
            assert!(doodle.settled_at() <= 2000);
            assert!(
                doodle
                    .strokes
                    .iter()
                    .all(|stroke| !stroke.march && !stroke.bob && !stroke.pulse),
                "meeting doodles draw on once and then hold still"
            );
        }
    }
}
