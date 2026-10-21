use bytemuck::{Pod, Zeroable};
use cap_project::KeycapTheme;

pub const MAX_KEYCAPS: usize = 12;
pub const KEYCAP_UNIT_HEIGHT: f32 = 74.0;
const KEYCAP_GAP_UNITS: f32 = 6.0;
const CAP_CENTER_UNITS: f32 = 33.5;

#[derive(Debug, Clone, PartialEq)]
pub struct Keycap {
    pub label: String,
    pub width_units: f32,
    pub modifier: bool,
    pub fit_legend: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlacedKeycap {
    pub x: f32,
    pub width: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct KeycapLayout {
    pub keys: Vec<PlacedKeycap>,
    pub scale: f32,
    pub width: f32,
    pub height: f32,
}

impl KeycapLayout {
    pub fn cap_center_y(&self) -> f32 {
        CAP_CENTER_UNITS * self.scale
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct KeycapPalette {
    pub under_edge: [f32; 3],
    pub under_center: [f32; 3],
    pub stroke: [f32; 3],
    pub cap_top: [f32; 3],
    pub cap_bottom: [f32; 3],
    pub text: [f32; 3],
}

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable, Debug)]
pub struct KeycapUniform {
    pub rect: [f32; 4],
    pub under_edge: [f32; 4],
    pub under_center: [f32; 4],
    pub cap_top: [f32; 4],
    pub cap_bottom: [f32; 4],
    pub stroke: [f32; 4],
}

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable, Debug)]
pub struct KeycapUniforms {
    pub viewport: [f32; 4],
    pub keys: [KeycapUniform; MAX_KEYCAPS],
}

impl KeycapUniform {
    pub fn new(
        placed: PlacedKeycap,
        left: f32,
        top: f32,
        scale: f32,
        palette: &KeycapPalette,
        opacity: f32,
    ) -> Self {
        let color = |rgb: [f32; 3]| [rgb[0], rgb[1], rgb[2], 1.0];
        Self {
            rect: [left + placed.x, top, placed.width, scale],
            under_edge: color(palette.under_edge),
            under_center: color(palette.under_center),
            cap_top: color(palette.cap_top),
            cap_bottom: color(palette.cap_bottom),
            stroke: [
                palette.stroke[0],
                palette.stroke[1],
                palette.stroke[2],
                opacity,
            ],
        }
    }
}

impl Keycap {
    pub fn is_symbol(&self) -> bool {
        !self.label.is_empty() && !self.label.chars().all(char::is_alphanumeric)
    }
}

fn keycap_for(character: char) -> Keycap {
    let (width_units, modifier) = match character {
        '⌘' => (86.0, true),
        '⇧' => (92.0, true),
        '⌃' | '⌥' => (74.0, true),
        '␣' => (130.0, false),
        '⏎' => (120.0, false),
        '⇥' | '⌫' | '⌦' | '⎋' => (110.0, false),
        _ => (KEYCAP_UNIT_HEIGHT, false),
    };
    let label = if character == '␣' {
        String::new()
    } else {
        character.to_string()
    };
    Keycap {
        label,
        width_units,
        modifier,
        fit_legend: false,
    }
}

fn is_modifier_glyph(character: char) -> bool {
    matches!(character, '⌘' | '⌃' | '⌥' | '⇧')
}

pub fn parse_keycaps(display_text: &str) -> Vec<Keycap> {
    let characters: Vec<char> = display_text
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    let leading = characters
        .iter()
        .take_while(|character| is_modifier_glyph(**character))
        .count();
    let merges_rest = characters[..leading]
        .iter()
        .any(|character| matches!(character, '⌘' | '⌃'));

    let keys: Vec<Keycap> = if merges_rest {
        let mut keys: Vec<Keycap> = characters[..leading]
            .iter()
            .copied()
            .map(keycap_for)
            .collect();
        match &characters[leading..] {
            [] => {}
            [only] => keys.push(keycap_for(*only)),
            rest => keys.push(Keycap {
                label: rest.iter().collect(),
                width_units: KEYCAP_UNIT_HEIGHT,
                modifier: false,
                fit_legend: true,
            }),
        }
        keys
    } else {
        characters.iter().copied().map(keycap_for).collect()
    };

    let skipped = keys.len().saturating_sub(MAX_KEYCAPS);
    keys.into_iter().skip(skipped).collect()
}

pub fn layout_keycaps(keys: &[Keycap], key_height: f32, max_width: f32) -> KeycapLayout {
    let units: f32 = keys.iter().map(|key| key.width_units).sum::<f32>()
        + KEYCAP_GAP_UNITS * keys.len().saturating_sub(1) as f32;
    let mut scale = key_height / KEYCAP_UNIT_HEIGHT;
    if units * scale > max_width && max_width > 0.0 {
        scale = max_width / units;
    }

    let mut cursor = 0.0;
    let placed = keys
        .iter()
        .map(|key| {
            let width = key.width_units * scale;
            let key = PlacedKeycap { x: cursor, width };
            cursor += width + KEYCAP_GAP_UNITS * scale;
            key
        })
        .collect();

    KeycapLayout {
        keys: placed,
        scale,
        width: units * scale,
        height: KEYCAP_UNIT_HEIGHT * scale,
    }
}

fn rgb(hex: u32) -> [f32; 3] {
    [
        ((hex >> 16) & 0xff) as f32 / 255.0,
        ((hex >> 8) & 0xff) as f32 / 255.0,
        (hex & 0xff) as f32 / 255.0,
    ]
}

fn lightened(color: [f32; 3], fraction: f32) -> [f32; 3] {
    color.map(|channel| channel + (1.0 - channel) * fraction)
}

fn darkened(color: [f32; 3], fraction: f32) -> [f32; 3] {
    color.map(|channel| channel * (1.0 - fraction))
}

fn derived_palette(hex: u32) -> KeycapPalette {
    let base = rgb(hex);
    let luminance = 0.299 * base[0] + 0.587 * base[1] + 0.114 * base[2];
    KeycapPalette {
        under_edge: darkened(base, 0.22),
        under_center: base,
        stroke: darkened(base, 0.35),
        cap_top: lightened(base, 0.12),
        cap_bottom: darkened(base, 0.18),
        text: if luminance > 0.6 {
            rgb(0x18181b)
        } else {
            rgb(0xffffff)
        },
    }
}

pub fn keycap_palette(theme: KeycapTheme, modifier: bool) -> KeycapPalette {
    match theme {
        KeycapTheme::Black if modifier => KeycapPalette {
            under_edge: rgb(0x0c0c0c),
            under_center: rgb(0x141414),
            stroke: rgb(0x474747),
            cap_top: rgb(0x151515),
            cap_bottom: rgb(0x191919),
            text: rgb(0xffffff),
        },
        KeycapTheme::Black => derived_palette(0x3f3f46),
        KeycapTheme::White => KeycapPalette {
            under_edge: rgb(0xcecece),
            under_center: rgb(0xe1e1e1),
            stroke: rgb(0xc7c7c7),
            cap_top: rgb(0xf0f0f0),
            cap_bottom: rgb(0xe2e2e2),
            text: rgb(0x63625d),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-4
    }

    #[test]
    fn splits_a_shortcut_into_one_key_per_symbol() {
        let keys = parse_keycaps("⌘⇧T");
        let labels: Vec<_> = keys.iter().map(|key| key.label.as_str()).collect();
        assert_eq!(labels, ["⌘", "⇧", "T"]);
        assert!(keys[0].modifier && keys[1].modifier && !keys[2].modifier);
    }

    #[test]
    fn space_has_no_legend_and_is_wide() {
        let keys = parse_keycaps("␣");
        assert_eq!(keys[0].label, "");
        assert!(close(keys[0].width_units, 130.0));
    }

    #[test]
    fn keeps_only_the_most_recent_keys() {
        let keys = parse_keycaps("abcdefghijklmnop");
        assert_eq!(keys.len(), MAX_KEYCAPS);
        assert_eq!(keys.last().unwrap().label, "p");
        assert_eq!(keys[0].label, "e");
    }

    #[test]
    fn only_non_alphanumeric_legends_are_symbols() {
        let symbols: Vec<_> = parse_keycaps("⌘").iter().map(Keycap::is_symbol).collect();
        assert_eq!(symbols, [true]);
        let symbols: Vec<_> = parse_keycaps("T7␣").iter().map(Keycap::is_symbol).collect();
        assert_eq!(symbols, [false, false, false]);
    }

    #[test]
    fn a_combo_is_modifiers_plus_one_key() {
        let keys = parse_keycaps("⌃F5");
        let labels: Vec<_> = keys.iter().map(|key| key.label.as_str()).collect();
        assert_eq!(labels, ["⌃", "F5"]);
        assert!(keys[0].modifier && !keys[0].fit_legend);
        assert!(!keys[1].modifier && keys[1].fit_legend);

        let keys = parse_keycaps("⌘⇧F12");
        let labels: Vec<_> = keys.iter().map(|key| key.label.as_str()).collect();
        assert_eq!(labels, ["⌘", "⇧", "F12"]);
    }

    #[test]
    fn single_key_combos_keep_their_fixed_width() {
        let keys = parse_keycaps("⌘⏎");
        assert_eq!(keys.len(), 2);
        assert!(!keys[1].fit_legend);
        assert!(close(keys[1].width_units, 120.0));
    }

    #[test]
    fn shift_or_option_prefixed_typing_is_one_key_per_character() {
        let labels = |text: &str| -> Vec<String> {
            parse_keycaps(text)
                .into_iter()
                .map(|key| key.label)
                .collect()
        };
        assert_eq!(labels("⇧Hello"), ["⇧", "H", "e", "l", "l", "o"]);
        assert_eq!(labels("⌥F5"), ["⌥", "F", "5"]);
        assert!(parse_keycaps("⇧Hello").iter().all(|key| !key.fit_legend));
    }

    #[test]
    fn a_command_or_control_combo_merges_even_after_shift() {
        let keys = parse_keycaps("⇧⌘F12");
        let labels: Vec<_> = keys.iter().map(|key| key.label.as_str()).collect();
        assert_eq!(labels, ["⇧", "⌘", "F12"]);
        assert!(keys[2].fit_legend);
    }

    #[test]
    fn typed_text_stays_one_key_per_character() {
        let keys = parse_keycaps("F5x");
        assert_eq!(keys.len(), 3);
        assert!(keys.iter().all(|key| !key.fit_legend));
    }

    #[test]
    fn whitespace_is_not_a_key() {
        assert!(parse_keycaps("  \n").is_empty());
    }

    #[test]
    fn layout_spaces_keys_by_their_unit_widths() {
        let keys = parse_keycaps("⌘T");
        let layout = layout_keycaps(&keys, KEYCAP_UNIT_HEIGHT, 10_000.0);
        assert!(close(layout.scale, 1.0));
        assert!(close(layout.keys[0].x, 0.0));
        assert!(close(layout.keys[1].x, 86.0 + 6.0));
        assert!(close(layout.width, 86.0 + 6.0 + 74.0));
        assert!(close(layout.height, KEYCAP_UNIT_HEIGHT));
    }

    #[test]
    fn layout_shrinks_to_fit_the_available_width() {
        let keys = parse_keycaps("⌘⇧⌥⌃T");
        let layout = layout_keycaps(&keys, KEYCAP_UNIT_HEIGHT, 200.0);
        assert!(layout.scale < 1.0);
        assert!(close(layout.width, 200.0));
    }

    #[test]
    fn derived_palette_matches_the_reference_tokens() {
        let palette = keycap_palette(KeycapTheme::Black, false);
        let base = rgb(0x3f3f46);
        assert!(close(palette.under_center[0], base[0]));
        assert!(close(palette.cap_top[2], base[2] + (1.0 - base[2]) * 0.12));
        assert!(close(palette.cap_bottom[1], base[1] * (1.0 - 0.18)));
        assert_eq!(palette.text, rgb(0xffffff));
    }

    #[test]
    fn white_theme_uses_dark_legends() {
        let palette = keycap_palette(KeycapTheme::White, true);
        assert_eq!(palette.text, rgb(0x63625d));
        assert_eq!(palette, keycap_palette(KeycapTheme::White, false));
    }
}
