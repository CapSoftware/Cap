//! `Kbd` -- one keycap chip for the three the Solid app grew independently:
//! the one inside `Tooltip`'s bubble, onboarding's "physical key" look, and
//! `settings/hotkeys.tsx`'s `HotkeyText` squares. All three re-implement the
//! macOS-glyph-versus-Windows-label mapping; that lives here once.

use gpui::{
    App, Hsla, IntoElement, ParentElement, Pixels, RenderOnce, SharedString, Styled, Window, div,
    prelude::FluentBuilder, px,
};

use crate::theme::Theme;

/// `kbdSymbolModifier(key, os)`: macOS renders the glyphs, every other OS
/// renders the word. Non-modifier keys pass through with the `Key` prefix
/// stripped, which is what `HotkeyText` does with a `KeyboardEvent.code`.
pub fn kbd_symbol(key: &str) -> SharedString {
    let mac = cfg!(target_os = "macos");
    let symbol = match key.to_ascii_lowercase().as_str() {
        "meta" | "cmd" | "command" | "super" => {
            if mac {
                "⌘"
            } else {
                "Win"
            }
        }
        "ctrl" | "control" => {
            if mac {
                "⌃"
            } else {
                "Ctrl"
            }
        }
        "shift" => {
            if mac {
                "⇧"
            } else {
                "Shift"
            }
        }
        "alt" | "option" => {
            if mac {
                "⌥"
            } else {
                "Alt"
            }
        }
        "enter" | "return" => "↩",
        "escape" | "esc" => "esc",
        "backspace" => "⌫",
        "space" => "␣",
        _ => return SharedString::from(key.strip_prefix("Key").unwrap_or(key).to_string()),
    };
    SharedString::from(symbol)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KbdSize {
    /// Inside a tooltip bubble: `py-0.5 px-[5px] text-[10px] rounded-md`.
    Sm,
    /// Standalone in a settings row: `size-6` square, `text-[11px]`.
    Md,
}

#[derive(IntoElement)]
pub struct KbdChip {
    key: SharedString,
    size: KbdSize,
    bg: Hsla,
    text: Hsla,
    border: Option<Hsla>,
}

impl KbdChip {
    /// The tooltip variant: a light chip on the tooltip's dark bubble.
    pub fn tooltip(theme: &Theme, key: impl AsRef<str>) -> Self {
        Self {
            key: kbd_symbol(key.as_ref()),
            size: KbdSize::Sm,
            bg: theme.gray(1),
            text: theme.gray(12),
            border: None,
        }
    }

    /// `HotkeyText`'s square: `bg-gray-5 border-gray-6`, the most tactile of
    /// the three and the one meant to be legible on its own.
    pub fn row(theme: &Theme, key: impl AsRef<str>) -> Self {
        Self {
            key: kbd_symbol(key.as_ref()),
            size: KbdSize::Md,
            bg: theme.gray(5),
            text: theme.gray(12),
            border: Some(theme.gray(6)),
        }
    }
}

impl RenderOnce for KbdChip {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let KbdChip {
            key,
            size,
            bg,
            text,
            border,
        } = self;
        let (padding_x, padding_y, text_size, min_size): (Pixels, Pixels, Pixels, Option<Pixels>) =
            match size {
                KbdSize::Sm => (px(5.), px(2.), px(10.), None),
                KbdSize::Md => (px(4.), px(2.), px(11.), Some(px(24.))),
            };

        div()
            .flex()
            .items_center()
            .justify_center()
            .flex_shrink_0()
            .px(padding_x)
            .py(padding_y)
            .when_some(min_size, |this, size| this.min_w(size).h(size))
            .rounded(px(6.))
            .bg(bg)
            .text_size(text_size)
            .text_color(text)
            .when_some(border, |this, border| this.border_1().border_color(border))
            .child(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "macos")]
    fn modifiers_render_as_glyphs_on_macos() {
        assert_eq!(kbd_symbol("meta").as_ref(), "⌘");
        assert_eq!(kbd_symbol("ctrl").as_ref(), "⌃");
        assert_eq!(kbd_symbol("shift").as_ref(), "⇧");
        assert_eq!(kbd_symbol("alt").as_ref(), "⌥");
    }

    #[test]
    fn a_key_code_loses_its_prefix() {
        assert_eq!(kbd_symbol("KeyA").as_ref(), "A");
        assert_eq!(kbd_symbol("F5").as_ref(), "F5");
    }

    #[test]
    fn the_mapping_is_case_insensitive() {
        assert_eq!(kbd_symbol("Shift"), kbd_symbol("shift"));
        assert_eq!(kbd_symbol("COMMAND"), kbd_symbol("cmd"));
    }
}
