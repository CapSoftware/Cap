//! The permission doodles: path data in a 120x104 view (the Chrome
//! extension's camera-permission doodle grid) unless noted.

use crate::doodle::{Doodle, Ink, Stroke};

pub static SCREEN: Doodle = Doodle {
    view: (120., 104.),
    strokes: &[
        Stroke::ink("M 18 12 L 102 12 Q 110 12 110 20 L 110 66 Q 110 74 102 74 L 18 74 Q 10 74 10 66 L 10 20 Q 10 12 18 12 Z")
            .draw(80, 850),
        Stroke::ink("M 52 74 L 49 88 M 68 74 L 71 88 M 40 90 L 80 90").draw(750, 400),
        Stroke::ink("M 24 24 L 96 24 L 96 62 L 24 62 Z")
            .with_ink(Ink::Accent)
            .width(2.5)
            .marching()
            .fade(900, 350),
        Stroke::ink("M 33 29.5 C 35.5 29.5 37.5 31.5 37.5 34 C 37.5 36.5 35.5 38.5 33 38.5 C 30.5 38.5 28.5 36.5 28.5 34 C 28.5 31.5 30.5 29.5 33 29.5 Z")
            .with_ink(Ink::Red)
            .filled()
            .pop(1100, 450)
            .pulsing(),
        Stroke::ink("M 72 38 L 72 56 L 76.5 51.5 L 80 59 L 83 57.6 L 79.6 50.4 L 85.5 50.4 Z")
            .width(2.5)
            .fade(1250, 300)
            .bobbing(),
    ],
};

pub static CURSOR: Doodle = Doodle {
    view: (120., 104.),
    strokes: &[
        Stroke::ink("M 24 14 L 96 14 Q 104 14 104 22 L 104 74 Q 104 82 96 82 L 24 82 Q 16 82 16 74 L 16 22 Q 16 14 24 14 Z")
            .with_ink(Ink::Accent)
            .width(2.5)
            .marching()
            .fade(700, 400),
        Stroke::ink("M 52 32 L 52 78 L 63 67 L 71 86 L 79 82.5 L 71 64 L 87 64 Z")
            .draw(60, 800)
            .bobbing(),
        Stroke::ink("M 44 26 L 38 20 M 42 34 L 33 34 M 50 24 L 50 15")
            .with_ink(Ink::Soft)
            .width(3.)
            .draw(850, 300),
    ],
};

pub static MICROPHONE: Doodle = Doodle {
    view: (120., 104.),
    strokes: &[
        Stroke::ink("M 48 24 Q 48 12 60 12 Q 72 12 72 24 L 72 48 Q 72 60 60 60 Q 48 60 48 48 Z")
            .draw(60, 700),
        Stroke::ink("M 54 26 L 66 26 M 54 34 L 66 34 M 54 42 L 66 42")
            .with_ink(Ink::Soft)
            .width(3.)
            .fade(700, 300),
        Stroke::ink("M 38 44 Q 38 72 60 72 Q 82 72 82 44").draw(600, 500),
        Stroke::ink("M 60 72 L 60 86 M 46 88 L 74 88").draw(1000, 300),
        Stroke::ink("M 92 30 Q 99 40 92 50")
            .with_ink(Ink::Accent)
            .width(3.5)
            .pop(1200, 450)
            .pulsing(),
        Stroke::ink("M 28 30 Q 21 40 28 50")
            .with_ink(Ink::Accent)
            .width(3.5)
            .pop(1300, 450)
            .pulsing(),
        Stroke::ink("M 101 22 Q 112 40 101 58")
            .with_ink(Ink::Accent)
            .width(3.5)
            .pop(1400, 450),
        Stroke::ink("M 19 22 Q 8 40 19 58")
            .with_ink(Ink::Accent)
            .width(3.5)
            .pop(1500, 450),
    ],
};

pub static CAMERA: Doodle = Doodle {
    view: (120., 104.),
    strokes: &[
        Stroke::ink("M 30 36 L 44 36 L 50 26 L 70 26 L 76 36 L 90 36 Q 98 36 98 44 L 98 80 Q 98 88 90 88 L 30 88 Q 22 88 22 80 L 22 44 Q 22 36 30 36 Z")
            .draw(150, 900),
        Stroke::ink("M 60 47 C 68.3 47 75 53.7 75 62 C 75 70.3 68.3 77 60 77 C 51.7 77 45 70.3 45 62 C 45 53.7 51.7 47 60 47 Z")
            .draw(900, 500),
        Stroke::ink("M 60 56 C 63.3 56 66 58.7 66 62 C 66 65.3 63.3 68 60 68 C 56.7 68 54 65.3 54 62 C 54 58.7 56.7 56 60 56 Z")
            .with_ink(Ink::Accent)
            .filled()
            .fade(1200, 300)
            .pulsing(),
        Stroke::ink("M 88 43.5 C 89.4 43.5 90.5 44.6 90.5 46 C 90.5 47.4 89.4 48.5 88 48.5 C 86.6 48.5 85.5 47.4 85.5 46 C 85.5 44.6 86.6 43.5 88 43.5 Z")
            .with_ink(Ink::Accent)
            .filled()
            .fade(1350, 300),
    ],
};

pub static ALL_SET: Doodle = Doodle {
    view: (120., 104.),
    strokes: &[
        Stroke::ink("M 60 12 C 84 12 102 30 102 52 C 102 75 84 92 60 92 C 35 92 18 74 18 52 C 18 31 34 14 56 12.5 C 62 12 68 13 73 15")
            .with_ink(Ink::Soft)
            .width(3.)
            .draw(450, 750),
        Stroke::ink("M 38 54 L 54 70 L 84 34")
            .with_ink(Ink::Green)
            .width(5.5)
            .draw(80, 500),
    ],
};

/// Row markers, 44x44.
pub static MARK_PENDING: Doodle = Doodle {
    view: (44., 44.),
    strokes: &[Stroke::ink(
        "M 22 7 C 30.3 7 37 13.7 37 22 C 37 30.3 30.3 37 22 37 C 13.7 37 7 30.3 7 22 C 7 13.7 13.7 7 22 7 Z",
    )
    .with_ink(Ink::Track)
    .width(3.)],
};

pub static MARK_ACTIVE: Doodle = Doodle {
    view: (44., 44.),
    strokes: &[
        Stroke::ink(
            "M 22 7 C 30.3 7 37 13.7 37 22 C 37 30.3 30.3 37 22 37 C 13.7 37 7 30.3 7 22 C 7 13.7 13.7 7 22 7 Z",
        )
        .with_ink(Ink::Accent)
        .width(3.)
        .draw(0, 450),
        Stroke::ink("M 22 17 C 24.8 17 27 19.2 27 22 C 27 24.8 24.8 27 22 27 C 19.2 27 17 24.8 17 22 C 17 19.2 19.2 17 22 17 Z")
            .with_ink(Ink::Accent)
            .filled()
            .pop(300, 350),
    ],
};

pub static MARK_GRANTED: Doodle = Doodle {
    view: (44., 44.),
    strokes: &[
        Stroke::ink(
            "M 22 6.5 C 30.8 6.5 37.5 13.5 37.5 22 C 37.5 30.8 30.5 37.5 22 37.5 C 13.2 37.5 6.5 30.5 6.5 22 C 6.5 14 12.5 7.5 20 6.8 C 23 6.6 26 7.2 28.5 8.6",
        )
        .with_ink(Ink::Green)
        .width(3.)
        .draw(0, 500),
        Stroke::ink("M 14 23 L 20 29 L 30.5 15.5")
            .with_ink(Ink::Green)
            .width(3.5)
            .draw(250, 350),
    ],
};

pub static MARK_SKIPPED: Doodle = Doodle {
    view: (44., 44.),
    strokes: &[
        Stroke::ink(
            "M 22 7 C 30.3 7 37 13.7 37 22 C 37 30.3 30.3 37 22 37 C 13.7 37 7 30.3 7 22 C 7 13.7 13.7 7 22 7 Z",
        )
        .with_ink(Ink::Track)
        .width(3.),
        Stroke::ink("M 15 22 L 29 22")
            .with_ink(Ink::Soft)
            .width(3.)
            .draw(0, 300),
    ],
};

/// The waiting squiggle, 240x26.
pub static WAITING: Doodle = Doodle {
    view: (240., 26.),
    strokes: &[Stroke::ink(
        "M 6 14 q 6 -7 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0",
    )
    .with_ink(Ink::Soft)
    .width(2.5)
    .marching()],
};

/// The drag guide's frame around the app icon, 80x80: a dashed, marching
/// rounded square that says "pick this up".
pub static DRAG_FRAME: Doodle = Doodle {
    view: (80., 80.),
    strokes: &[Stroke::ink(
        "M 20 6 L 60 6 Q 74 6 74 20 L 74 60 Q 74 74 60 74 L 20 74 Q 6 74 6 60 L 6 20 Q 6 6 20 6 Z",
    )
    .with_ink(Ink::Accent)
    .width(2.5)
    .marching()
    .fade(0, 300)],
};

/// The drag guide's arrow, 34x44, curling up toward the Settings list.
pub static UP_ARROW: Doodle = Doodle {
    view: (34., 44.),
    strokes: &[
        Stroke::ink("M 12 40 C 6 30 8 16 22 6")
            .with_ink(Ink::Accent)
            .width(3.)
            .draw(200, 450),
        Stroke::ink("M 12 6 L 23 5 L 22 16")
            .with_ink(Ink::Accent)
            .width(3.)
            .draw(600, 250)
            .bobbing(),
    ],
};

/// The accent swoosh under a heading, 132x12.
pub static UNDERLINE: Doodle = Doodle {
    view: (132., 12.),
    strokes: &[Stroke::ink("M 4 8 C 34 4 78 3 128 6")
        .with_ink(Ink::Accent)
        .width(3.5)
        .draw(350, 650)],
};

/// Instant mode: the web recorder's upload cloud, arrow bobbing.
pub static UPLOAD: Doodle = Doodle {
    view: (120., 104.),
    strokes: &[
        Stroke::ink("M 34 58 L 88 58 C 98 58 106 50 106 41 C 106 32 98.5 25 89.5 25 C 86.5 25 84 25.7 81.8 27 C 79 16.5 69.5 9 58.5 9 C 47 9 37.5 16.8 34.8 27.5 C 25.2 28 17.5 35.4 17.5 44 C 17.5 52 24.8 58 34 58 Z")
            .draw(60, 800),
        Stroke::ink("M 60 94 L 60 70 M 49 80 L 60 68 L 71 80")
            .with_ink(Ink::Accent)
            .fade(700, 350)
            .bobbing(),
    ],
};

/// Studio mode: the editor's tracks with a playhead.
pub static TRACKS: Doodle = Doodle {
    view: (120., 104.),
    strokes: &[
        Stroke::ink("M 18 30 L 102 30")
            .with_ink(Ink::Accent)
            .width(9.)
            .draw(60, 500),
        Stroke::ink("M 18 52 L 84 52")
            .with_ink(Ink::Soft)
            .width(9.)
            .draw(260, 500),
        Stroke::ink("M 18 74 L 94 74")
            .with_ink(Ink::Green)
            .width(9.)
            .draw(460, 500),
        Stroke::ink("M 62 14 L 62 90")
            .with_ink(Ink::Red)
            .width(2.5)
            .fade(900, 300),
    ],
};

/// Screenshot mode: crop corners around a little landscape.
pub static SNAP: Doodle = Doodle {
    view: (120., 104.),
    strokes: &[
        Stroke::ink("M 18 30 L 18 16 L 32 16 M 88 16 L 102 16 L 102 30 M 102 74 L 102 88 L 88 88 M 32 88 L 18 88 L 18 74")
            .draw(60, 700),
        Stroke::ink("M 32 74 L 50 50 L 62 63 L 72 53 L 88 74")
            .with_ink(Ink::Accent)
            .width(3.5)
            .draw(600, 500),
        Stroke::ink("M 76 30 C 79.3 30 82 32.7 82 36 C 82 39.3 79.3 42 76 42 C 72.7 42 70 39.3 70 36 C 70 32.7 72.7 30 76 30 Z")
            .with_ink(Ink::Accent)
            .filled()
            .pop(1000, 400),
    ],
};

/// A small drawn tick, 24x24.
pub static TICK: Doodle = Doodle {
    view: (24., 24.),
    strokes: &[Stroke::ink("M 4 13 L 9.5 18 L 20 6")
        .with_ink(Ink::Accent)
        .width(3.)
        .draw(0, 300)],
};
