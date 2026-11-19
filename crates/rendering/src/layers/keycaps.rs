//! Key presses drawn as keycaps: what goes on each key, how each keyboard
//! shapes its keys, and the colours of each theme. The GPU side lives in
//! [`super::keyboard`] and `shaders/keycap.wgsl`; everything here is plain
//! data so it can be tested without a device.

/// The typefaces the keycaps and captions are set in, embedded so every
/// platform draws them alike. See `assets/fonts/overlay/README.md` for their
/// licences.
pub const OVERLAY_FONTS: [&[u8]; 5] = [
    include_bytes!("../../assets/fonts/overlay/Inter-Medium-Keycaps.ttf"),
    include_bytes!("../../assets/fonts/overlay/Selawik-Regular.ttf"),
    include_bytes!("../../assets/fonts/overlay/Ubuntu-Medium.ttf"),
    include_bytes!("../../assets/fonts/overlay/IBMPlexSans-Medium.ttf"),
    include_bytes!("../../assets/fonts/overlay/Inter-SemiBold-Captions.ttf"),
];

/// The caption and label face that ships with the renderer, as the font
/// setting names it.
pub const OVERLAY_TEXT_FONT: &str = "Inter";

/// The face a key is printed in: an SF-like grotesk on Apple's keys,
/// Segoe's open twin on Windows', Ubuntu's own on Linux', and IBM's Plex on
/// the beige keys of an old desk keyboard. The weight is the file's own.
pub fn keycap_font(style: KeycapStyle, theme: KeycapTheme) -> (&'static str, u16) {
    match (theme, style) {
        (KeycapTheme::Retro, _) => ("IBM Plex Sans", 500),
        (_, KeycapStyle::Mechanical) => ("Inter Keycaps", 500),
        (_, KeycapStyle::Windows) => ("Selawik", 400),
        (_, KeycapStyle::Linux) => ("Ubuntu", 500),
        _ => ("Inter Keycaps", 500),
    }
}

/// The face every key symbol is printed in, whatever the key's own face, so
/// a modifier's mark looks the same on every keyboard and every platform
/// rather than falling back to whichever system font has it.
pub const KEY_SYMBOL_FONT: &str = "Inter Keycaps";

/// A mark printed on a key in place of a letter: modifiers, named keys and
/// arrows.
pub fn is_key_symbol(c: char) -> bool {
    matches!(
        c,
        '⌘' | '⌥' | '⇧' | '⌃' | '⇪' | '↵' | '␣' | '▲' | '▼' | '◀' | '▶'
    ) || is_special_key(c)
}

/// `text` split into runs of key symbols and runs of everything else, each
/// with whether it is symbols.
pub fn symbol_runs(text: &str) -> Vec<(&str, bool)> {
    let mut runs: Vec<(&str, bool)> = Vec::new();
    let mut start = 0;
    let mut current = None;
    for (at, c) in text.char_indices() {
        let symbol = is_key_symbol(c);
        if current.is_some_and(|held| held != symbol) {
            runs.push((&text[start..at], current.unwrap_or(false)));
            start = at;
        }
        current = Some(symbol);
    }
    if let Some(symbol) = current {
        runs.push((&text[start..], symbol));
    }
    runs
}

/// Which keyboard the keys are drawn from. `Classic` is the single rounded
/// label the overlay has always drawn; `Mechanical` is a desk keyboard's
/// tall, sculpted caps, printed for the platform it runs on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeycapStyle {
    Classic,
    MacOs,
    Windows,
    Linux,
    Mechanical,
}

impl KeycapStyle {
    pub fn from_setting(style: &str) -> Self {
        match style {
            "macos" => Self::MacOs,
            "windows" => Self::Windows,
            "linux" => Self::Linux,
            "mechanical" => Self::Mechanical,
            _ => Self::Classic,
        }
    }

    /// Whether keys print Apple's legends: a symbol over its word in the
    /// corner. A mechanical keyboard prints the legends of the platform it
    /// is plugged into, as Mac and PC keycap sets do.
    pub fn mac_legends(self) -> bool {
        match self {
            Self::MacOs | Self::Classic => true,
            Self::Windows | Self::Linux => false,
            Self::Mechanical => cfg!(target_os = "macos"),
        }
    }

    /// The word a PC prints on the key Apple calls command.
    fn meta_word(self) -> &'static str {
        match self {
            Self::Linux => "Super",
            Self::Mechanical if cfg!(target_os = "linux") => "Super",
            _ => "Win",
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
                depth: 0.035,
                inset: 0.01,
                dish: 0.0,
                sculpt: 0.0,
            },
            Self::Windows => KeycapGeometry {
                radius: 0.08,
                depth: 0.07,
                inset: 0.016,
                dish: 0.0,
                sculpt: 0.0,
            },
            Self::Linux => KeycapGeometry {
                radius: 0.12,
                depth: 0.13,
                inset: 0.085,
                dish: 1.0,
                sculpt: 0.0,
            },
            // A tall, cylinder-dished cap seen from the front: a deep front
            // wall, narrow tapered sides and a sliver of back wall, each lit
            // as it faces the light.
            Self::Mechanical => KeycapGeometry {
                radius: 0.11,
                depth: 0.21,
                inset: 0.1,
                dish: 1.0,
                sculpt: 1.0,
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
    /// 1 for a cap whose walls are lit as solid plastic sloping away from
    /// its top, 0 for a laptop key's skirt.
    pub sculpt: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeycapTheme {
    Light,
    Dark,
    Retro,
}

impl KeycapTheme {
    pub fn from_setting(theme: &str) -> Self {
        match theme {
            "light" => Self::Light,
            "retro" => Self::Retro,
            _ => Self::Dark,
        }
    }

    /// The paint for `cap` on a `style` keyboard. A mechanical set is one
    /// plastic throughout, except on the retro theme, which sets its
    /// modifiers and named keys apart in grey as every retro keyboard does.
    pub fn palette_for(self, style: KeycapStyle, cap: &Keycap) -> KeycapPalette {
        if style == KeycapStyle::Mechanical {
            self.mechanical_palette(cap.modifier || cap.kind == KeycapKind::Named)
        } else {
            self.palette(cap.modifier)
        }
    }

    /// A mechanical set in PBT: the walls are the same plastic as the top,
    /// so their colours sit close to it and the light does the shaping.
    pub fn mechanical_palette(self, modifier: bool) -> KeycapPalette {
        match (self, modifier) {
            // Every key in one white plastic.
            (Self::Light, _) => KeycapPalette {
                top: [hex(0xf7f6f3), hex(0xeeece7)],
                side: [hex(0xe3e1db), hex(0xc4c1b9)],
                border: rgba(0x2a2824, 0.18),
                highlight: rgba(0xffffff, 0.9),
                label: hex(0x2b2b2d),
                legend: hex(0x4a4a4d),
                shadow: 0.4,
                grain: 0.014,
                gloss: 0.03,
            },
            // Every key in one charcoal plastic, with pale print.
            (Self::Dark, _) => KeycapPalette {
                top: [hex(0x45464b), hex(0x3c3d42)],
                side: [hex(0x38393e), hex(0x232427)],
                border: rgba(0x000000, 0.45),
                highlight: rgba(0xffffff, 0.16),
                label: hex(0xeeeef0),
                legend: hex(0xd8d8dc),
                shadow: 0.5,
                grain: 0.01,
                gloss: 0.03,
            },
            (Self::Retro, false) => KeycapPalette {
                top: [hex(0xf0e9d6), hex(0xe4dbc3)],
                side: [hex(0xd9cfb4), hex(0xb3a685)],
                border: rgba(0x3a3328, 0.24),
                highlight: rgba(0xfffdf5, 0.85),
                label: hex(0x2b2721),
                legend: hex(0x4f493f),
                shadow: 0.42,
                grain: 0.018,
                gloss: 0.02,
            },
            (Self::Retro, true) => KeycapPalette {
                top: [hex(0xaeaba2), hex(0xa29f96)],
                side: [hex(0x97948b), hex(0x76736b)],
                border: rgba(0x2c2a25, 0.28),
                highlight: rgba(0xf4f1e8, 0.6),
                label: hex(0x1f1d1a),
                legend: hex(0x2f2c28),
                shadow: 0.44,
                grain: 0.018,
                gloss: 0.02,
            },
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
            },
            // A space black MacBook: deep charcoal caps, a near-black skirt,
            // pale print and a faint satin sheen.
            // A MacBook Pro: flat, matte near-black caps whose rims catch a
            // little light, light grey print, sunk in a black well.
            (Self::Dark, _) => KeycapPalette {
                top: [hex(0x2c2c2f), hex(0x202023)],
                side: [hex(0x161618), hex(0x0b0b0c)],
                border: rgba(0x000000, 0.35),
                highlight: rgba(0xffffff, 0.1),
                label: hex(0xf5f5f7),
                legend: hex(0xe5e5ea),
                shadow: 0.42,
                grain: 0.004,
                gloss: 0.02,
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
const DISPLAY_ORDER: [char; 4] = ['⌘', '⌥', '⇧', '⌃'];

/// The keys a key-press overlay's text stands for. A shortcut is its
/// modifiers, one key each, then the key they modify; typed text is one long
/// key. `uppercase` only touches typed text: a letter key is always printed
/// in capitals, as on the keyboard.
pub fn keycaps_for(text: &str, style: KeycapStyle) -> Vec<Keycap> {
    let mut caps = Vec::new();
    let mut rest = text;
    let mut modifiers = Vec::new();
    while let Some(symbol) = rest.chars().next().filter(|c| MODIFIERS.contains(c)) {
        modifiers.push(symbol);
        rest = &rest[symbol.len_utf8()..];
    }
    // Command leads, then option, shift and control, the way demo overlays
    // read a shortcut out.
    modifiers.sort_by_key(|symbol| DISPLAY_ORDER.iter().position(|c| c == symbol));
    caps.extend(
        modifiers
            .into_iter()
            .map(|symbol| modifier_cap(symbol, style)),
    );
    // Shift alone before text is typing in capitals, not a shortcut.
    let shortcut = caps
        .iter()
        .any(|cap| cap.label != "⇧" && cap.label != "Shift");
    let mut chars = rest.chars();
    match (chars.next(), chars.next()) {
        (None, _) => {}
        // Shift and one letter typed a capital.
        (Some(single), None) if !shortcut && !caps.is_empty() && single.is_alphabetic() => {
            caps.clear();
            caps.push(single_cap(single, style));
        }
        (Some(single), None) => caps.push(single_cap(single, style)),
        (Some(_), Some(_)) if shortcut => caps.push(Keycap {
            label: rest.to_uppercase(),
            legend: None,
            modifier: false,
            kind: KeycapKind::Named,
            align: LegendAlign::Left,
        }),
        (Some(_), Some(_)) => {
            // Shift before a letter typed a capital: show the capital.
            let mut typed = String::with_capacity(rest.len());
            if caps.len() == 1
                && let Some(first) = rest.chars().next().filter(|c| c.is_alphabetic())
            {
                caps.clear();
                typed.extend(first.to_uppercase());
                typed.push_str(&rest[first.len_utf8()..]);
            } else {
                typed.push_str(rest);
            }
            push_typed(&mut caps, &typed, style);
        }
    }
    caps
}

/// The keys typed text stands for: the text as long keys from its first
/// letter, with Shift folded into capitals and special keys between.
pub fn typed_keycaps(text: &str, style: KeycapStyle) -> Vec<Keycap> {
    let mut caps = Vec::new();
    push_typed(&mut caps, text, style);
    caps
}

/// Typed text as long keys, with each special key (delete, return, tab,
/// escape, arrows) struck in it as a key of its own between them.
fn push_typed(caps: &mut Vec<Keycap>, typed: &str, style: KeycapStyle) {
    let mut run = String::new();
    let flush = |caps: &mut Vec<Keycap>, run: &mut String| {
        // A comma or full stop that ends a typed word reads as clutter on a
        // key; the words carry the typing.
        let word = run.trim_end_matches([',', '.']).to_string();
        run.clear();
        if !word.trim().is_empty() {
            caps.push(Keycap {
                label: word,
                legend: None,
                modifier: false,
                kind: KeycapKind::Wide,
                align: LegendAlign::Left,
            });
        }
    };
    let mut chars = typed.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '␣' => run.push(' '),
            '⇧' => match chars.peek().copied().filter(|next| next.is_alphabetic()) {
                Some(letter) => {
                    chars.next();
                    run.extend(letter.to_uppercase());
                }
                None => {
                    flush(caps, &mut run);
                    caps.push(modifier_cap(c, style));
                }
            },
            _ if MODIFIERS.contains(&c) || is_special_key(c) => {
                flush(caps, &mut run);
                let cap = if MODIFIERS.contains(&c) {
                    modifier_cap(c, style)
                } else {
                    single_cap(c, style)
                };
                // A key struck again and again is one key, as a repeated
                // shortcut is.
                if caps.last() != Some(&cap) {
                    caps.push(cap);
                }
            }
            _ => run.push(c),
        }
    }
    flush(caps, &mut run);
}

/// A key that prints a symbol for its name rather than a character.
fn is_special_key(c: char) -> bool {
    matches!(
        c,
        '⏎' | '⇥' | '⌫' | '⌦' | '⎋' | '⇱' | '⇲' | '⇞' | '⇟' | '↑' | '↓' | '←' | '→'
    )
}

fn modifier_cap(symbol: char, style: KeycapStyle) -> Keycap {
    let (mac, pc) = match symbol {
        '⌃' => ("control", "Ctrl"),
        '⌥' => ("option", "Alt"),
        '⇧' => ("shift", "Shift"),
        _ => ("command", style.meta_word()),
    };
    match style.mac_legends() {
        // The symbol over its word, both on the key's left.
        true => Keycap {
            label: symbol.to_string(),
            legend: Some(mac.to_string()),
            modifier: true,
            kind: KeycapKind::Named,
            align: LegendAlign::Left,
        },
        false => Keycap {
            label: pc.to_string(),
            legend: None,
            modifier: true,
            kind: KeycapKind::Named,
            align: LegendAlign::Left,
        },
    }
}

fn single_cap(key: char, style: KeycapStyle) -> Keycap {
    let mac = style.mac_legends();
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
        // Return reads best as its arrow alone.
        '⏎' if mac => Keycap {
            label: "↵".into(),
            legend: None,
            modifier: false,
            kind: KeycapKind::Named,
            align: LegendAlign::Left,
        },
        '⏎' => named("", "return", "Enter", LegendAlign::Left),
        '⇥' => named("⇥", "tab", "Tab", LegendAlign::Left),
        '⌫' => named("⌫", "delete", "Backspace", LegendAlign::Left),
        '⌦' => named("⌦", "delete", "Del", LegendAlign::Left),
        '⎋' => named("⎋", "esc", "Esc", LegendAlign::Left),
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
    let mac = style.mac_legends();
    // Every key's main print is one size, letters and typed words alike, so
    // a row reads as one set; only the corner symbols, Apple's arrows and a
    // PC key's printed name are set smaller, as on the real keys.
    let text = if mac { 0.33 } else { 0.34 };
    match (cap.kind, single, cap.legend.is_some()) {
        (_, _, true) => height * 0.25,
        (KeycapKind::Square, _, _) if mac && "▲▼◀▶".contains(cap.label.as_str()) => {
            height * 0.2
        }
        (KeycapKind::Named, false, _) if !mac => height * 0.27,
        _ => height * text,
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

pub fn cap_gap(height: f32) -> f32 {
    height * 0.16
}

/// How far a key is pushed in, `since` seconds after it was struck: down in
/// 60 ms, back up over the next 140 ms, as a key springs back.
pub fn press_depth(since: f64) -> f32 {
    // A soft dip: halfway down, eased in and out, then a slower rise.
    const DOWN: f64 = 0.08;
    const UP: f64 = 0.22;
    const DEPTH: f64 = 0.55;
    if !(0.0..DOWN + UP).contains(&since) {
        return 0.;
    }
    let smooth = |t: f64| t * t * (3. - 2. * t);
    if since < DOWN {
        (DEPTH * smooth(since / DOWN)) as f32
    } else {
        (DEPTH * (1. - smooth((since - DOWN) / UP))) as f32
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
                ("⌘".into(), Some("command".into()), KeycapKind::Named),
                ("⇧".into(), Some("shift".into()), KeycapKind::Named),
                ("P".into(), None, KeycapKind::Square),
            ]
        );
        assert_eq!(
            labels("⌃⇧⌘P", KeycapStyle::Windows),
            vec![
                ("Win".into(), None, KeycapKind::Named),
                ("Shift".into(), None, KeycapKind::Named),
                ("Ctrl".into(), None, KeycapKind::Named),
                ("P".into(), None, KeycapKind::Square),
            ]
        );
        assert_eq!(labels("⌘c", KeycapStyle::Linux)[0].0, "Super");
        assert_eq!(labels("⌘c", KeycapStyle::Linux)[1].0, "C");
    }

    #[test]
    fn named_keys_print_the_way_each_keyboard_does() {
        assert_eq!(labels("⏎", KeycapStyle::MacOs)[0].0, "↵");
        assert_eq!(
            labels("⎋", KeycapStyle::MacOs)[0],
            ("⎋".into(), Some("esc".into()), KeycapKind::Named)
        );
        assert_eq!(labels("←", KeycapStyle::MacOs)[0].0, "◀");
        assert_eq!(
            keycaps_for("⌘", KeycapStyle::MacOs)[0].align,
            LegendAlign::Left
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
        // Shift then a letter is typing a capital.
        assert_eq!(
            labels("⇧i'll", KeycapStyle::MacOs),
            vec![("I'll".into(), None, KeycapKind::Wide)]
        );
        // Shift then a symbol keeps its Shift key.
        assert_eq!(labels("⇧;0", KeycapStyle::MacOs)[0].0, "⇧");
        assert_eq!(labels("⇧;0", KeycapStyle::MacOs)[1].0, ";0");
        // Special keys struck while typing are keys of their own.
        assert_eq!(
            labels("⌫e,", KeycapStyle::MacOs),
            vec![
                ("⌫".into(), Some("delete".into()), KeycapKind::Named),
                ("e".into(), None, KeycapKind::Wide),
            ]
        );
        assert_eq!(
            labels("hi⏎there", KeycapStyle::Windows),
            vec![
                ("hi".into(), None, KeycapKind::Wide),
                ("Enter".into(), None, KeycapKind::Named),
                ("there".into(), None, KeycapKind::Wide),
            ]
        );
        assert_eq!(labels("my⇧name", KeycapStyle::MacOs)[0].0, "myName");
        // A word's first letter is already typed text, in its own case.
        let first = typed_keycaps("l", KeycapStyle::MacOs);
        assert_eq!(
            (first[0].label.as_str(), first[0].kind),
            ("l", KeycapKind::Wide)
        );
        assert_eq!(typed_keycaps("⇧i", KeycapStyle::MacOs)[0].label, "I");
        // Held or repeated special keys are one key, so what is typed after
        // them always fits.
        let arrows = format!("{}x", "←".repeat(17));
        assert_eq!(
            labels(&arrows, KeycapStyle::MacOs),
            vec![
                ("◀".into(), None, KeycapKind::Square),
                ("x".into(), None, KeycapKind::Wide),
            ]
        );
        assert_eq!(
            labels("⇧a", KeycapStyle::MacOs),
            vec![("A".into(), None, KeycapKind::Square)]
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
        assert!((press_depth(0.08) - 0.55).abs() < 1e-6);
        assert!(press_depth(0.04) > 0. && press_depth(0.04) < 0.55);
        assert!(press_depth(0.2) > 0. && press_depth(0.2) < 0.55);
        assert_eq!(press_depth(0.3), 0.);
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
            for (modifier, palette) in [false, true].into_iter().flat_map(|modifier| {
                [
                    (modifier, theme.palette(modifier)),
                    (modifier, theme.mechanical_palette(modifier)),
                ]
            }) {
                for face in palette.top {
                    let (a, b) = (luminance(face), luminance(palette.label));
                    let ratio = (a.max(b) + 0.05) / (a.min(b) + 0.05);
                    assert!(ratio >= 4.5, "{theme:?} {modifier}: {ratio}");
                }
            }
        }
    }

    #[test]
    fn key_symbols_print_in_one_face_and_words_in_the_keys_own() {
        assert_eq!(symbol_runs("⇧"), vec![("⇧", true)]);
        assert_eq!(symbol_runs("Shift"), vec![("Shift", false)]);
        assert_eq!(
            symbol_runs("a⌘⇧b"),
            vec![("a", false), ("⌘⇧", true), ("b", false)]
        );
        assert!(symbol_runs("").is_empty());
        for symbol in "⌘⌥⇧⌃⇪↵⏎⇥⌫⌦⎋▲▼◀▶↑↓←→".chars() {
            assert!(is_key_symbol(symbol), "{symbol}");
        }
        assert!(!is_key_symbol('A') && !is_key_symbol(';'));
    }

    #[test]
    fn a_mechanical_keyboard_is_a_tall_sculpted_set() {
        let mechanical = KeycapStyle::from_setting("mechanical");
        assert_eq!(mechanical, KeycapStyle::Mechanical);
        let geometry = mechanical.geometry();
        assert_eq!(geometry.sculpt, 1.0);
        assert!(geometry.depth > KeycapStyle::Linux.geometry().depth);
        for style in [KeycapStyle::MacOs, KeycapStyle::Windows, KeycapStyle::Linux] {
            assert_eq!(style.geometry().sculpt, 0.0, "{style:?}");
        }
        // One plastic on light and dark; retro sets its modifiers and named
        // keys apart in grey.
        let letter = &keycaps_for("a", mechanical)[0];
        let named = &keycaps_for("⏎", mechanical)[0];
        let shift = &keycaps_for("⇧⌘a", mechanical)
            .into_iter()
            .find(|cap| cap.label == "⇧" || cap.label == "Shift")
            .unwrap();
        for theme in [KeycapTheme::Light, KeycapTheme::Dark, KeycapTheme::Retro] {
            let letters = theme.palette_for(mechanical, letter);
            assert_eq!(
                letters == theme.palette_for(mechanical, named),
                theme != KeycapTheme::Retro,
                "{theme:?}"
            );
            assert_eq!(
                theme.palette_for(mechanical, named),
                theme.palette_for(mechanical, shift),
                "{theme:?}"
            );
            // Other keyboards keep their own paint.
            assert_eq!(
                theme.palette_for(KeycapStyle::MacOs, letter),
                theme.palette(false)
            );
        }
        // It prints the legends of the platform it is plugged into.
        assert_eq!(mechanical.mac_legends(), cfg!(target_os = "macos"));
        let command = &keycaps_for("⌘c", mechanical)[0];
        if cfg!(target_os = "macos") {
            assert_eq!(command.label, "⌘");
        } else if cfg!(target_os = "linux") {
            assert_eq!(command.label, "Super");
        } else {
            assert_eq!(command.label, "Win");
        }
        assert_eq!(
            keycap_font(mechanical, KeycapTheme::Dark).0,
            KEY_SYMBOL_FONT
        );
    }
}
