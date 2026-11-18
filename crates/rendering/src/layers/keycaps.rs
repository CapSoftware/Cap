//! Key presses drawn as keycaps: what goes on each key, how each keyboard
//! shapes its keys, and the colours of each theme. The GPU side lives in
//! [`super::keyboard`] and `shaders/keycap.wgsl`; everything here is plain
//! data so it can be tested without a device.

/// The typefaces the keycaps are set in, embedded so every platform draws
/// them alike. See `assets/fonts/keycaps/README.md` for their licences.
pub const KEYCAP_FONTS: [&[u8]; 4] = [
    include_bytes!("../../assets/fonts/keycaps/Inter-Medium-Keycaps.ttf"),
    include_bytes!("../../assets/fonts/keycaps/Selawik-Regular.ttf"),
    include_bytes!("../../assets/fonts/keycaps/Ubuntu-Medium.ttf"),
    include_bytes!("../../assets/fonts/keycaps/IBMPlexSans-Medium.ttf"),
];

/// The face a key is printed in: an SF-like grotesk on Apple's keys,
/// Segoe's open twin on Windows', Ubuntu's own on Linux', and IBM's Plex on
/// the beige keys of an old desk keyboard. The weight is the file's own.
pub fn keycap_font(style: KeycapStyle, theme: KeycapTheme) -> (&'static str, u16) {
    match (theme, style) {
        (KeycapTheme::Retro, _) => ("IBM Plex Sans", 500),
        (_, KeycapStyle::Windows) => ("Selawik", 400),
        (_, KeycapStyle::Linux) => ("Ubuntu", 500),
        _ => ("Inter", 500),
    }
}

/// Which keyboard the keys are drawn from. `Classic` is the single rounded
/// label the overlay has always drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeycapStyle {
    Classic,
    MacOs,
    Windows,
    Linux,
}

impl KeycapStyle {
    pub fn from_str(style: &str) -> Self {
        match style {
            "macos" => Self::MacOs,
            "windows" => Self::Windows,
            "linux" => Self::Linux,
            _ => Self::Classic,
        }
    }

    /// The key's outline: corner radius, the depth of the visible side, and
    /// how far the top face sits in from the body's edges, all as fractions
    /// of the key's height. Apple's keys are low and rounded, a Windows
    /// laptop's are flat and squarer, and a desktop PC's are taller with a
    /// sculpted, inset top.
    pub fn geometry(self) -> KeycapGeometry {
        match self {
            Self::MacOs | Self::Classic => KeycapGeometry {
                radius: 0.13,
                depth: 0.05,
                inset: 0.012,
                dish: 0.0,
            },
            Self::Windows => KeycapGeometry {
                radius: 0.08,
                depth: 0.07,
                inset: 0.016,
                dish: 0.0,
            },
            Self::Linux => KeycapGeometry {
                radius: 0.12,
                depth: 0.13,
                inset: 0.085,
                dish: 1.0,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct KeycapGeometry {
    pub radius: f32,
    pub depth: f32,
    pub inset: f32,
    /// How deeply the top is dished, 0 for a flat laptop key.
    pub dish: f32,
}

/// The keycaps' colours.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeycapTheme {
    Light,
    Dark,
    Retro,
}

impl KeycapTheme {
    pub fn from_str(theme: &str) -> Self {
        match theme {
            "light" => Self::Light,
            "retro" => Self::Retro,
            _ => Self::Dark,
        }
    }

    /// The paint for one key. Retro keyboards set their modifiers apart in
    /// a darker grey; the others paint every key alike.
    pub fn palette(self, modifier: bool) -> KeycapPalette {
        match (self, modifier) {
            // A white Magic Keyboard: near-white matte caps with a pale grey
            // skirt and dark grey print.
            (Self::Light, _) => KeycapPalette {
                top: [hex(0xfdfdfe), hex(0xeeeef1)],
                side: [hex(0xd6d6db), hex(0xb4b4bb)],
                border: rgba(0x000000, 0.14),
                highlight: rgba(0xffffff, 0.95),
                label: hex(0x2c2c2e),
                legend: hex(0x6e6e73),
                shadow: 0.34,
                grain: 0.012,
                gloss: 0.0,
                // Silver aluminium.
                plate: [hex(0xe4e5e9), hex(0xcbccd1)],
            },
            // A space black MacBook: deep charcoal caps, a near-black skirt,
            // pale print and a faint satin sheen.
            // A MacBook Pro: flat, matte near-black caps whose rims catch a
            // little light, light grey print, sunk in a black well.
            (Self::Dark, _) => KeycapPalette {
                top: [hex(0x2e2e31), hex(0x232326)],
                side: [hex(0x141416), hex(0x060607)],
                border: rgba(0x000000, 0.7),
                highlight: rgba(0xffffff, 0.2),
                label: hex(0xededf2),
                legend: hex(0xd6d6dc),
                shadow: 0.5,
                grain: 0.006,
                gloss: 0.025,
                plate: [hex(0x0e0e10), hex(0x080809)],
            },
            // An old desk keyboard: cream letter keys and grey modifiers in
            // thick, slightly yellowed plastic.
            (Self::Retro, false) => KeycapPalette {
                top: [hex(0xf2ecdc), hex(0xe0d7c0)],
                side: [hex(0xc9bea2), hex(0x9f9275)],
                border: rgba(0x3a3328, 0.26),
                highlight: rgba(0xfffdf5, 0.85),
                label: hex(0x2b2721),
                legend: hex(0x5f584c),
                shadow: 0.36,
                grain: 0.016,
                gloss: 0.0,
                plate: [hex(0xd9d0b9), hex(0xc3b89c)],
            },
            (Self::Retro, true) => KeycapPalette {
                top: [hex(0xa8a59c), hex(0x939087)],
                side: [hex(0x84817a), hex(0x625f59)],
                border: rgba(0x2c2a25, 0.3),
                highlight: rgba(0xf4f1e8, 0.55),
                label: hex(0x1f1d1a),
                legend: hex(0x34312c),
                shadow: 0.38,
                grain: 0.016,
                gloss: 0.0,
                plate: [hex(0xd9d0b9), hex(0xc3b89c)],
            },
        }
    }
}

/// Colours as linear-free sRGB in 0..1, the way the overlay's target takes
/// them.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct KeycapPalette {
    /// The top face, from its top edge to its bottom edge.
    pub top: [[f32; 4]; 2],
    /// The skirt, from where it meets the top face down to the desk.
    pub side: [[f32; 4]; 2],
    pub border: [f32; 4],
    pub highlight: [f32; 4],
    pub label: [f32; 4],
    pub legend: [f32; 4],
    /// The drop shadow's strength.
    pub shadow: f32,
    /// How much matte texture the plastic shows.
    pub grain: f32,
    /// A soft sheen across the top of the face, for satin caps.
    pub gloss: f32,
    /// The keyboard the keys sit in: its deck from top to bottom.
    pub plate: [[f32; 4]; 2],
}

fn hex(value: u32) -> [f32; 4] {
    rgba(value, 1.)
}

fn rgba(value: u32, alpha: f32) -> [f32; 4] {
    [
        ((value >> 16) & 0xff) as f32 / 255.,
        ((value >> 8) & 0xff) as f32 / 255.,
        (value & 0xff) as f32 / 255.,
        alpha,
    ]
}

/// How a key is laid out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeycapKind {
    /// A letter, digit, arrow or symbol: a square key.
    Square,
    /// A modifier or a named key: wider, with a word on it.
    Named,
    /// Typed text, or the space bar: one long key.
    Wide,
}

/// Which side of the key Apple prints a symbol and its word on: towards the
/// space bar, so the keys left of it print on their right.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LegendAlign {
    Left,
    Right,
}

/// One key: its main label, and on Apple's keys the small word printed in a
/// bottom corner, the way the physical key prints it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Keycap {
    pub label: String,
    pub legend: Option<String>,
    pub modifier: bool,
    pub kind: KeycapKind,
    pub align: LegendAlign,
}

const MODIFIERS: [char; 4] = ['⌃', '⌥', '⇧', '⌘'];

/// The keys a key-press overlay's text stands for. A shortcut is its
/// modifiers, one key each, then the key they modify; typed text is one long
/// key. `uppercase` only touches typed text: a letter key is always printed
/// in capitals, as on the keyboard.
pub fn keycaps_for(text: &str, style: KeycapStyle) -> Vec<Keycap> {
    let mut caps = Vec::new();
    let mut rest = text;
    while let Some(symbol) = rest.chars().next().filter(|c| MODIFIERS.contains(c)) {
        caps.push(modifier_cap(symbol, style));
        rest = &rest[symbol.len_utf8()..];
    }
    // Shift alone before text is typing in capitals, not a shortcut.
    let shortcut = caps
        .iter()
        .any(|cap| cap.label != "⇧" && cap.label != "Shift");
    let mut chars = rest.chars();
    match (chars.next(), chars.next()) {
        (None, _) => {}
        (Some(single), None) => caps.push(single_cap(single, style)),
        (Some(_), Some(_)) if shortcut => caps.push(Keycap {
            label: rest.to_uppercase(),
            legend: None,
            modifier: false,
            kind: KeycapKind::Named,
            align: LegendAlign::Left,
        }),
        (Some(_), Some(_)) => caps.push(Keycap {
            label: rest.replace('␣', " "),
            legend: None,
            modifier: false,
            kind: KeycapKind::Wide,
            align: LegendAlign::Left,
        }),
    }
    caps
}

fn modifier_cap(symbol: char, style: KeycapStyle) -> Keycap {
    let (mac, pc) = match symbol {
        '⌃' => ("control", "Ctrl"),
        '⌥' => ("option", "Alt"),
        '⇧' => ("shift", "Shift"),
        _ => (
            "command",
            if style == KeycapStyle::Linux {
                "Super"
            } else {
                "Win"
            },
        ),
    };
    match style {
        // Shift sits at the far left and prints on its left; control,
        // option and command sit against the space bar and print on their
        // right.
        KeycapStyle::MacOs | KeycapStyle::Classic => Keycap {
            label: symbol.to_string(),
            legend: Some(mac.to_string()),
            modifier: true,
            kind: KeycapKind::Named,
            align: if symbol == '⇧' {
                LegendAlign::Left
            } else {
                LegendAlign::Right
            },
        },
        KeycapStyle::Windows | KeycapStyle::Linux => Keycap {
            label: pc.to_string(),
            legend: None,
            modifier: true,
            kind: KeycapKind::Named,
            align: LegendAlign::Left,
        },
    }
}

fn single_cap(key: char, style: KeycapStyle) -> Keycap {
    let mac = matches!(style, KeycapStyle::MacOs | KeycapStyle::Classic);
    // Apple prints a named key's word small in a bottom corner, with its
    // symbol above it where the key has one; a PC prints the word in the
    // middle.
    let named = |symbol: &str, mac_word: &str, pc_word: &str, align: LegendAlign| {
        if mac {
            Keycap {
                label: symbol.to_string(),
                legend: Some(mac_word.to_string()),
                modifier: false,
                kind: KeycapKind::Named,
                align,
            }
        } else {
            Keycap {
                label: pc_word.to_string(),
                legend: None,
                modifier: false,
                kind: KeycapKind::Named,
                align: LegendAlign::Left,
            }
        }
    };
    let square = |label: String| Keycap {
        label,
        legend: None,
        modifier: false,
        kind: KeycapKind::Square,
        align: LegendAlign::Left,
    };
    match key {
        '⏎' => named("", "return", "Enter", LegendAlign::Right),
        '⇥' => named("⇥", "tab", "Tab", LegendAlign::Left),
        '⌫' => named("", "delete", "Backspace", LegendAlign::Right),
        '⌦' => named("", "delete", "Del", LegendAlign::Right),
        '⎋' => named("", "esc", "Esc", LegendAlign::Left),
        '⇱' => named("", "home", "Home", LegendAlign::Left),
        '⇲' => named("", "end", "End", LegendAlign::Right),
        '⇞' => named("", "page up", "PgUp", LegendAlign::Left),
        '⇟' => named("", "page down", "PgDn", LegendAlign::Right),
        '␣' | ' ' => Keycap {
            label: String::new(),
            legend: None,
            modifier: false,
            kind: KeycapKind::Wide,
            align: LegendAlign::Left,
        },
        // Apple's arrow keys carry solid triangles.
        '↑' if mac => square("▲".into()),
        '↓' if mac => square("▼".into()),
        '←' if mac => square("◀".into()),
        '→' if mac => square("▶".into()),
        other => square(other.to_uppercase().collect()),
    }
}

/// The type sizes on a key `height` tall: its main label, and the small
/// corner word.
pub fn label_size(cap: &Keycap, height: f32, style: KeycapStyle) -> f32 {
    let single = cap.label.chars().count() <= 1;
    let mac = matches!(style, KeycapStyle::MacOs | KeycapStyle::Classic);
    match (cap.kind, single, cap.legend.is_some()) {
        (_, _, true) => height * 0.25,
        // Apple's letters are small on a large key; the triangles smaller.
        (KeycapKind::Square, _, _) if mac && "▲▼◀▶".contains(cap.label.as_str()) => {
            height * 0.2
        }
        (KeycapKind::Square, _, _) if mac => height * 0.33,
        (KeycapKind::Square, _, _) | (KeycapKind::Wide, _, _) => height * 0.4,
        (KeycapKind::Named, true, _) => height * 0.4,
        (KeycapKind::Named, false, _) => height * 0.25,
    }
}

/// How tall a label's ink sits above its baseline, as a share of its size:
/// capitals and symbols stand at cap height; running text centres lower.
pub fn ink_height(cap: &Keycap) -> f32 {
    if cap.kind == KeycapKind::Wide && cap.label.chars().any(char::is_lowercase) {
        0.62
    } else {
        0.71
    }
}

pub fn legend_size(height: f32) -> f32 {
    height * 0.185
}

/// How wide a key is, given how wide its label and corner word are set.
pub fn cap_width(cap: &Keycap, height: f32, label_width: f32, legend_width: f32) -> f32 {
    match cap.kind {
        KeycapKind::Square => height.max(label_width + height * 0.5),
        // A word-only Apple key (return, delete) is wide, like the real one.
        KeycapKind::Named if cap.legend.is_some() && cap.label.is_empty() => {
            (height * 1.6).max(legend_width + height * 0.5)
        }
        KeycapKind::Named if cap.legend.is_some() => {
            (height * 1.32).max(label_width.max(legend_width) + height * 0.55)
        }
        KeycapKind::Named => (height * 1.2).max(label_width + height * 0.62),
        KeycapKind::Wide if cap.label.is_empty() => height * 3.2,
        KeycapKind::Wide => (height * 1.6).max(label_width + height * 0.75),
    }
}

/// The gap between two keys.
pub fn cap_gap(height: f32) -> f32 {
    height * 0.16
}

/// How far a key is pushed in, `since` seconds after it was struck: down in
/// 60 ms, back up over the next 140 ms, as a key springs back.
pub fn press_depth(since: f64) -> f32 {
    const DOWN: f64 = 0.06;
    const UP: f64 = 0.14;
    if !(0.0..DOWN + UP).contains(&since) {
        return 0.;
    }
    if since < DOWN {
        let t = since / DOWN;
        (1. - (1. - t) * (1. - t)) as f32
    } else {
        let t = (since - DOWN) / UP;
        (1. - t * t * (3. - 2. * t)) as f32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(text: &str, style: KeycapStyle) -> Vec<(String, Option<String>, KeycapKind)> {
        keycaps_for(text, style)
            .into_iter()
            .map(|cap| (cap.label, cap.legend, cap.kind))
            .collect()
    }

    #[test]
    fn a_shortcut_is_one_key_per_modifier_then_its_key() {
        assert_eq!(
            labels("⇧⌘P", KeycapStyle::MacOs),
            vec![
                ("⇧".into(), Some("shift".into()), KeycapKind::Named),
                ("⌘".into(), Some("command".into()), KeycapKind::Named),
                ("P".into(), None, KeycapKind::Square),
            ]
        );
        assert_eq!(
            labels("⌃⇧⌘P", KeycapStyle::Windows),
            vec![
                ("Ctrl".into(), None, KeycapKind::Named),
                ("Shift".into(), None, KeycapKind::Named),
                ("Win".into(), None, KeycapKind::Named),
                ("P".into(), None, KeycapKind::Square),
            ]
        );
        assert_eq!(labels("⌘c", KeycapStyle::Linux)[0].0, "Super");
        assert_eq!(labels("⌘c", KeycapStyle::Linux)[1].0, "C");
    }

    #[test]
    fn named_keys_print_the_way_each_keyboard_does() {
        assert_eq!(
            labels("⏎", KeycapStyle::MacOs)[0],
            (String::new(), Some("return".into()), KeycapKind::Named)
        );
        assert_eq!(labels("←", KeycapStyle::MacOs)[0].0, "◀");
        assert_eq!(
            keycaps_for("⇧", KeycapStyle::MacOs)[0].align,
            LegendAlign::Left
        );
        assert_eq!(
            keycaps_for("⌘", KeycapStyle::MacOs)[0].align,
            LegendAlign::Right
        );
        assert_eq!(labels("⏎", KeycapStyle::Windows)[0].0, "Enter");
        assert_eq!(labels("⌫", KeycapStyle::Linux)[0].0, "Backspace");
        let space = keycaps_for("␣", KeycapStyle::MacOs);
        assert_eq!(space[0].kind, KeycapKind::Wide);
        assert!(space[0].label.is_empty());
    }

    #[test]
    fn typed_text_is_one_long_key_and_keeps_its_case() {
        assert_eq!(
            labels("hello", KeycapStyle::MacOs),
            vec![("hello".into(), None, KeycapKind::Wide)]
        );
        assert_eq!(labels("a", KeycapStyle::MacOs)[0].0, "A");
        assert!(keycaps_for("", KeycapStyle::MacOs).is_empty());
        // Shift then text is typing: the text keeps its case.
        assert_eq!(
            labels("⇧i'll", KeycapStyle::MacOs)[1],
            ("i'll".into(), None, KeycapKind::Wide)
        );
        // A function key after a modifier stays one key.
        assert_eq!(
            labels("⌘F5", KeycapStyle::Windows)[1],
            ("F5".into(), None, KeycapKind::Named)
        );
    }

    #[test]
    fn keys_are_at_least_square_and_grow_with_their_label() {
        let square = &keycaps_for("a", KeycapStyle::MacOs)[0];
        assert_eq!(cap_width(square, 80., 20., 0.), 80.);
        let named = &keycaps_for("⏎", KeycapStyle::Windows)[0];
        assert!(cap_width(named, 80., 120., 0.) > 120.);
        let space = &keycaps_for("␣", KeycapStyle::MacOs)[0];
        assert_eq!(cap_width(space, 80., 0., 0.), 256.);
    }

    #[test]
    fn a_struck_key_dips_and_springs_back() {
        assert_eq!(press_depth(-0.01), 0.);
        assert_eq!(press_depth(0.), 0.);
        assert!((press_depth(0.06) - 1.).abs() < 1e-6);
        assert!(press_depth(0.1) > 0. && press_depth(0.1) < 1.);
        assert_eq!(press_depth(0.2), 0.);
        assert_eq!(press_depth(1.), 0.);
    }

    #[test]
    fn every_theme_keeps_its_label_readable_on_its_key() {
        fn luminance(c: [f32; 4]) -> f32 {
            let f = |v: f32| {
                if v <= 0.03928 {
                    v / 12.92
                } else {
                    ((v + 0.055) / 1.055).powf(2.4)
                }
            };
            0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
        }
        for theme in [KeycapTheme::Light, KeycapTheme::Dark, KeycapTheme::Retro] {
            for modifier in [false, true] {
                let palette = theme.palette(modifier);
                for face in palette.top {
                    let (a, b) = (luminance(face), luminance(palette.label));
                    let ratio = (a.max(b) + 0.05) / (a.min(b) + 0.05);
                    assert!(ratio >= 4.5, "{theme:?} {modifier}: {ratio}");
                }
            }
        }
    }
}
