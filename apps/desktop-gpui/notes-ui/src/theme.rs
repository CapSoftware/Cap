use gpui::{Hsla, Pixels, SharedString, px, rgb};

#[derive(Clone, Debug, PartialEq)]
pub struct NotesTheme {
    pub background: Hsla,
    /// What shows behind the text. New words written into the page fade in
    /// under a veil of this colour; it is `background` unless the host draws
    /// the page itself and leaves `background` transparent.
    pub page: Hsla,
    pub ink: Hsla,
    pub ink_secondary: Hsla,
    pub ink_tertiary: Hsla,
    pub accent: Hsla,
    pub separator: Hsla,
    pub selection: Hsla,
    pub code_fill: Hsla,
    pub highlight: Hsla,
    pub find_match: Hsla,
    pub find_current: Hsla,
    pub check_mark: Hsla,
    pub link_underline_alpha: f32,
    pub quote_bar_alpha: f32,
    pub popover_fill: Hsla,
    pub popover_border: Hsla,
    pub popover_shadow: Hsla,
    pub popover_highlight: Hsla,
    pub popover_text: Hsla,
    pub popover_muted: Hsla,
    pub scrollbar: Hsla,

    pub body_font: SharedString,
    pub mono_fonts: Vec<SharedString>,
    pub body_size: Pixels,
    pub body_line_height: f32,
    pub heading_sizes: [Pixels; 3],
    pub heading_line_height: f32,
    pub heading_space_above: [Pixels; 3],
    pub heading_space_below: [Pixels; 3],
    pub code_size: Pixels,
    pub code_line_height: f32,
    pub code_padding_y: Pixels,
    pub code_padding_x: Pixels,
    pub ui_size: Pixels,

    pub block_spacing: Pixels,
    pub list_spacing: Pixels,
    pub code_spacing: Pixels,
    pub list_indent: Pixels,
    pub marker_gap: Pixels,
    pub quote_bar_width: Pixels,
    pub quote_inset: Pixels,
    pub rule_margin: Pixels,

    pub max_content_width: Pixels,
    pub side_padding: Pixels,
    pub narrow_side_padding: Pixels,
    pub narrow_breakpoint: Pixels,
    pub top_padding: Pixels,
    pub bottom_padding_ratio: f32,

    pub popover_radius: Pixels,
    pub toolbar_radius: Pixels,
    pub popover_padding: Pixels,
    pub popover_row_height: Pixels,
    pub code_radius: Pixels,
    pub inline_code_radius: Pixels,
    pub inline_code_padding: Pixels,
    pub highlight_radius: Pixels,
    pub selection_radius: Pixels,
    pub checkbox_size: Pixels,
    pub checkbox_radius: Pixels,
    pub checkbox_border: Pixels,
    pub caret_width: Pixels,
}

fn hex(value: u32, alpha: f32) -> Hsla {
    let mut color = Hsla::from(rgb(value));
    color.a = alpha;
    color
}

fn with_alpha(color: Hsla, alpha: f32) -> Hsla {
    Hsla { a: alpha, ..color }
}

fn platform_body_font() -> SharedString {
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        ".SystemUIFont".into()
    } else {
        "Geist".into()
    }
}

fn platform_mono_fonts() -> Vec<SharedString> {
    let names: &[&str] = if cfg!(target_os = "macos") {
        &["Menlo", "SF Mono", "Monaco"]
    } else if cfg!(target_os = "windows") {
        &["Cascadia Mono", "Consolas", "Courier New"]
    } else {
        &["Geist Mono", "DejaVu Sans Mono", "Liberation Mono"]
    };
    names.iter().map(|name| SharedString::from(*name)).collect()
}

impl NotesTheme {
    fn base(dark: bool) -> Self {
        let accent = if dark {
            hex(0x0a84ff, 1.)
        } else {
            hex(0x007aff, 1.)
        };
        let ink = if dark {
            hex(0xf5f5f7, 1.)
        } else {
            hex(0x1d1d1f, 1.)
        };
        let background = if dark {
            hex(0x1c1c1e, 1.)
        } else {
            hex(0xffffff, 1.)
        };
        Self {
            background,
            page: background,
            ink,
            ink_secondary: if dark {
                hex(0xa1a1a6, 1.)
            } else {
                hex(0x6e6e73, 1.)
            },
            ink_tertiary: if dark {
                hex(0x6e6e73, 1.)
            } else {
                hex(0xaeaeb2, 1.)
            },
            accent,
            separator: if dark {
                hex(0xffffff, 0.14)
            } else {
                hex(0x000000, 0.12)
            },
            selection: with_alpha(accent, if dark { 0.30 } else { 0.22 }),
            code_fill: with_alpha(ink, if dark { 0.07 } else { 0.04 }),
            highlight: hex(0xffc53d, if dark { 0.26 } else { 0.30 }),
            find_match: hex(0xffd60a, if dark { 0.28 } else { 0.32 }),
            find_current: hex(0xff9f0a, if dark { 0.62 } else { 0.55 }),
            check_mark: hex(0xffffff, 1.),
            link_underline_alpha: 0.4,
            quote_bar_alpha: 0.55,
            popover_fill: if dark {
                hex(0x2c2c2e, 0.98)
            } else {
                hex(0xffffff, 0.97)
            },
            popover_border: if dark {
                hex(0xffffff, 0.10)
            } else {
                hex(0x000000, 0.08)
            },
            popover_shadow: if dark {
                hex(0x000000, 0.30)
            } else {
                hex(0x000000, 0.12)
            },
            popover_highlight: with_alpha(accent, 0.12),
            popover_text: ink,
            popover_muted: if dark {
                hex(0xa1a1a6, 1.)
            } else {
                hex(0x6e6e73, 1.)
            },
            scrollbar: if dark {
                hex(0xffffff, 0.34)
            } else {
                hex(0x000000, 0.30)
            },

            body_font: platform_body_font(),
            mono_fonts: platform_mono_fonts(),
            body_size: px(15.),
            body_line_height: 1.6,
            heading_sizes: [px(26.), px(20.), px(16.5)],
            heading_line_height: 1.25,
            heading_space_above: [px(22.), px(18.), px(14.)],
            heading_space_below: [px(6.), px(4.), px(2.)],
            code_size: px(13.),
            code_line_height: 1.55,
            code_padding_y: px(12.),
            code_padding_x: px(14.),
            ui_size: px(13.),

            block_spacing: px(6.),
            list_spacing: px(2.),
            code_spacing: px(10.),
            list_indent: px(24.),
            marker_gap: px(8.),
            quote_bar_width: px(3.),
            quote_inset: px(14.),
            rule_margin: px(14.),

            max_content_width: px(680.),
            side_padding: px(32.),
            narrow_side_padding: px(16.),
            narrow_breakpoint: px(520.),
            top_padding: px(28.),
            bottom_padding_ratio: 0.4,

            popover_radius: px(12.),
            toolbar_radius: px(10.),
            popover_padding: px(6.),
            popover_row_height: px(30.),
            code_radius: px(10.),
            inline_code_radius: px(5.),
            inline_code_padding: px(3.),
            highlight_radius: px(3.),
            selection_radius: px(4.),
            checkbox_size: px(16.),
            checkbox_radius: px(5.),
            checkbox_border: px(1.5),
            caret_width: px(2.),
        }
    }

    pub fn light() -> Self {
        Self::base(false)
    }

    pub fn dark() -> Self {
        Self::base(true)
    }

    pub(crate) fn ink_alpha(&self, alpha: f32) -> Hsla {
        with_alpha(self.ink, alpha)
    }

    pub(crate) fn accent_alpha(&self, alpha: f32) -> Hsla {
        with_alpha(self.accent, alpha)
    }
}

impl Default for NotesTheme {
    fn default() -> Self {
        Self::light()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotesLabels {
    pub editor: SharedString,
    pub placeholder: SharedString,
    pub heading_placeholder: SharedString,
    pub slash_text: SharedString,
    pub slash_heading_1: SharedString,
    pub slash_heading_2: SharedString,
    pub slash_heading_3: SharedString,
    pub slash_bullet_list: SharedString,
    pub slash_numbered_list: SharedString,
    pub slash_checkbox: SharedString,
    pub slash_quote: SharedString,
    pub slash_code_block: SharedString,
    pub slash_divider: SharedString,
    pub bold: SharedString,
    pub italic: SharedString,
    pub underline: SharedString,
    pub strikethrough: SharedString,
    pub code: SharedString,
    pub highlight: SharedString,
    pub link: SharedString,
    pub link_placeholder: SharedString,
    pub cut: SharedString,
    pub copy: SharedString,
    pub paste: SharedString,
    pub select_all: SharedString,
    pub open_link: SharedString,
    pub copy_link: SharedString,
    pub remove_link: SharedString,
    pub find_placeholder: SharedString,
    pub find_no_results: SharedString,
    pub find_previous: SharedString,
    pub find_next: SharedString,
    pub find_close: SharedString,
}

impl Default for NotesLabels {
    fn default() -> Self {
        Self {
            editor: "Note".into(),
            placeholder: "Start writing".into(),
            heading_placeholder: "Heading".into(),
            slash_text: "Text".into(),
            slash_heading_1: "Heading 1".into(),
            slash_heading_2: "Heading 2".into(),
            slash_heading_3: "Heading 3".into(),
            slash_bullet_list: "Bullet list".into(),
            slash_numbered_list: "Numbered list".into(),
            slash_checkbox: "Checkbox".into(),
            slash_quote: "Quote".into(),
            slash_code_block: "Code block".into(),
            slash_divider: "Divider".into(),
            bold: "Bold".into(),
            italic: "Italic".into(),
            underline: "Underline".into(),
            strikethrough: "Strikethrough".into(),
            code: "Code".into(),
            highlight: "Highlight".into(),
            link: "Link".into(),
            link_placeholder: "Paste or type a link".into(),
            cut: "Cut".into(),
            copy: "Copy".into(),
            paste: "Paste".into(),
            select_all: "Select All".into(),
            open_link: "Open Link".into(),
            copy_link: "Copy Link".into(),
            remove_link: "Remove Link".into(),
            find_placeholder: "Find".into(),
            find_no_results: "No results".into(),
            find_previous: "Previous match".into(),
            find_next: "Next match".into(),
            find_close: "Close".into(),
        }
    }
}
