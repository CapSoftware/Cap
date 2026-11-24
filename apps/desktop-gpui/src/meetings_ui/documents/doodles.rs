//! The notes window's hand-drawn art, in the onboarding doodles' vocabulary:
//! a 120x104 grid unless noted, round strokes, the same inks.

use crate::doodle::{Doodle, Ink, Stroke};

/// The empty home: a page of notes, ticked off.
pub static PAGE: Doodle = Doodle {
    view: (120., 104.),
    strokes: &[
        Stroke::ink(
            "M 36 12 L 72 12 L 88 28 L 88 88 Q 88 94 82 94 L 36 94 Q 30 94 30 88 L 30 18 Q 30 12 36 12 Z",
        )
        .draw(60, 800),
        Stroke::ink("M 72 12 L 72 24 Q 72 28 76 28 L 88 28").draw(700, 260),
        Stroke::ink("M 40 44 L 72 44 M 40 55 L 77 55 M 40 66 L 62 66")
            .with_ink(Ink::Soft)
            .width(3.)
            .draw(820, 450),
        Stroke::ink("M 66 79 L 75 87.5 L 98 63")
            .with_ink(Ink::Green)
            .width(5.)
            .draw(1250, 380),
    ],
};

/// An empty "Coming up": a calendar page with one day circled.
pub static CALENDAR: Doodle = Doodle {
    view: (120., 104.),
    strokes: &[
        Stroke::ink(
            "M 26 22 L 94 22 Q 102 22 102 30 L 102 84 Q 102 92 94 92 L 26 92 Q 18 92 18 84 L 18 30 Q 18 22 26 22 Z",
        )
        .draw(60, 850),
        Stroke::ink("M 18 40 L 102 40").draw(700, 280),
        Stroke::ink("M 40 13 L 40 29 M 80 13 L 80 29").draw(850, 300),
        Stroke::ink(
            "M 34 56 L 35 56 M 50 56 L 51 56 M 66 56 L 67 56 M 82 56 L 83 56 M 34 72 L 35 72 M 50 72 L 51 72 M 66 72 L 67 72",
        )
        .with_ink(Ink::Soft)
        .width(5.)
        .fade(1000, 300),
        Stroke::ink(
            "M 83 62 C 90 62 94.5 66.5 94.5 72 C 94.5 77.5 89.5 81.5 83 81.5 C 76.5 81.5 72 77.5 72 72 C 72 66 77 62.5 85 61.8",
        )
        .with_ink(Ink::Accent)
        .width(3.)
        .draw(1150, 450),
        Stroke::ink("M 83 72 L 83.5 72")
            .with_ink(Ink::Accent)
            .width(5.)
            .pop(1500, 300),
    ],
};

/// An empty transcript: two people talking, the other side's bubble full of
/// sound.
pub static TALK: Doodle = Doodle {
    view: (120., 104.),
    strokes: &[
        Stroke::ink(
            "M 20 12 L 56 12 Q 64 12 64 20 L 64 38 Q 64 46 56 46 L 34 46 L 24 56 L 25 46 L 20 46 Q 12 46 12 38 L 12 20 Q 12 12 20 12 Z",
        )
        .draw(60, 800),
        Stroke::ink("M 22 25 L 52 25 M 22 33 L 43 33")
            .with_ink(Ink::Soft)
            .width(3.)
            .draw(700, 320),
        Stroke::ink(
            "M 62 52 L 100 52 Q 108 52 108 60 L 108 78 Q 108 86 100 86 L 96 86 L 97 96 L 86 86 L 62 86 Q 54 86 54 78 L 54 60 Q 54 52 62 52 Z",
        )
        .with_ink(Ink::Accent)
        .width(3.5)
        .draw(520, 800),
        Stroke::ink(
            "M 68 69 L 68 69.5 M 75 64 L 75 74 M 82 60 L 82 78 M 89 64 L 89 74 M 96 69 L 96 69.5",
        )
        .with_ink(Ink::Accent)
        .width(3.5)
        .draw(1150, 420),
    ],
};

/// Notes being written after a meeting: a page and a pencil.
pub static WRITING: Doodle = Doodle {
    view: (120., 104.),
    strokes: &[
        Stroke::ink(
            "M 30 14 L 78 14 Q 86 14 86 22 L 86 86 Q 86 94 78 94 L 30 94 Q 22 94 22 86 L 22 22 Q 22 14 30 14 Z",
        )
        .draw(60, 700),
        Stroke::ink("M 34 36 L 72 36")
            .with_ink(Ink::Soft)
            .width(3.)
            .draw(620, 300),
        Stroke::ink("M 34 50 L 68 50")
            .with_ink(Ink::Soft)
            .width(3.)
            .draw(860, 300),
        Stroke::ink("M 34 64 L 56 64")
            .with_ink(Ink::Soft)
            .width(3.)
            .draw(1100, 260),
        Stroke::ink("M 96 46 L 104 54 L 72 86 L 61 89 L 64 78 Z M 90 52 L 98 60")
            .with_ink(Ink::Accent)
            .width(3.5)
            .draw(1250, 520),
    ],
};

/// The problem banner's mark, 44x44: a drawn circle with an exclamation.
/// Drawn with the `Red` ink, which the banner maps to its amber.
pub static MARK_ALERT: Doodle = Doodle {
    view: (44., 44.),
    strokes: &[
        Stroke::ink(
            "M 22 6.5 C 30.8 6.5 37.5 13.5 37.5 22 C 37.5 30.8 30.5 37.5 22 37.5 C 13.2 37.5 6.5 30.5 6.5 22 C 6.5 14 12.5 7.5 20 6.8 C 23 6.6 26 7.2 28.5 8.6",
        )
        .with_ink(Ink::Red)
        .width(3.),
        Stroke::ink("M 22 14 L 22 24.5 M 22 30.5 L 22 31")
            .with_ink(Ink::Red)
            .width(3.5),
    ],
};

/// A note that is recording right now, 44x44: a red ring around a dot.
pub static MARK_RECORDING: Doodle = Doodle {
    view: (44., 44.),
    strokes: &[
        Stroke::ink(
            "M 22 7 C 30.3 7 37 13.7 37 22 C 37 30.3 30.3 37 22 37 C 13.7 37 7 30.3 7 22 C 7 13.7 13.7 7 22 7 Z",
        )
        .with_ink(Ink::Red)
        .width(3.),
        Stroke::ink(
            "M 22 16 C 25.3 16 28 18.7 28 22 C 28 25.3 25.3 28 22 28 C 18.7 28 16 25.3 16 22 C 16 18.7 18.7 16 22 16 Z",
        )
        .with_ink(Ink::Red)
        .filled(),
    ],
};
