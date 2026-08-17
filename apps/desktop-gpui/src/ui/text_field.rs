//! The single-line text field.
//!
//! gpui ships no text input, so this is the same hand-rolled field the main
//! window's search and the settings window's two inputs were each carrying:
//! focus tracking, `key_char` for the typed character (so dead keys and
//! option-layouts work), a static 1px caret, and a placeholder. Selection,
//! cursor movement, blink and paste remain the known deviation.
//!
//! The classification of a keystroke is separated from the drawing so the
//! window that owns the string keeps owning it -- Escape means "clear the
//! filter, then close the panel" in the main window and "revert to the stored
//! value" in settings, and neither belongs in a component.

use gpui::{
    App, FocusHandle, Hsla, InteractiveElement, IntoElement, Keystroke, ParentElement,
    Pixels, RenderOnce, SharedString, Styled, Window, div, prelude::FluentBuilder, px, svg,
};

use crate::theme::Theme;

/// What a keystroke means to a text field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TextEdit {
    /// Append this text. Never empty, never a control character.
    Insert(String),
    /// Delete the last character.
    Backspace,
    /// The caller decides what reverting means.
    Escape,
    /// Not text -- a shortcut chord, a modifier, an arrow.
    Ignored,
}

/// Classify a keystroke for a focused text field.
///
/// Command and control chords are shortcuts, not text (Cmd-W closes a chrome
/// window from the root handler), so they never insert. Backspace and Escape
/// are recognised whatever the modifiers are: they are edits, not characters.
pub fn text_edit_for(keystroke: &Keystroke) -> TextEdit {
    match keystroke.key.as_str() {
        "backspace" => TextEdit::Backspace,
        "escape" => TextEdit::Escape,
        _ => {
            if keystroke.modifiers.platform || keystroke.modifiers.control {
                return TextEdit::Ignored;
            }
            match keystroke.key_char.as_ref() {
                Some(text) if !text.is_empty() && !text.chars().any(char::is_control) => {
                    TextEdit::Insert(text.clone())
                }
                _ => TextEdit::Ignored,
            }
        }
    }
}

#[derive(IntoElement)]
pub struct TextField {
    value: SharedString,
    placeholder: Option<SharedString>,
    icon: Option<SharedString>,
    focus: Option<FocusHandle>,
    caret: bool,
    height: Pixels,
    padding_x: Pixels,
    radius: Pixels,
    gap: Pixels,
    text_size: Pixels,
    bg: Option<Hsla>,
    border: Option<Hsla>,
    text: Hsla,
    muted: Hsla,
    icon_color: Hsla,
    caret_color: Hsla,
    caret_height: Pixels,
    flex: bool,
}

impl TextField {
    fn base(theme: &Theme, value: impl Into<SharedString>) -> Self {
        Self {
            value: value.into(),
            placeholder: None,
            icon: None,
            focus: None,
            caret: false,
            height: px(32.),
            padding_x: px(8.),
            radius: px(8.),
            gap: px(2.),
            text_size: px(12.),
            bg: None,
            border: None,
            text: theme.gray(12),
            muted: theme.gray(10),
            icon_color: theme.gray(10),
            caret_color: theme.gray(12),
            caret_height: px(14.),
            flex: false,
        }
    }

    /// The settings window's inputs: `<Input>` is `h-8 rounded-lg bg-gray-2
    /// px-2 text-xs` in `editor/ui.tsx`, re-fillled here from the settings
    /// material's `--macos-settings-fill` / `-border` / `-text` / `-muted`.
    pub fn settings(theme: &Theme, value: impl Into<SharedString>) -> Self {
        Self {
            bg: Some(theme.settings_fill()),
            border: Some(theme.settings_border()),
            text: theme.settings_text(),
            muted: theme.settings_muted(),
            caret_color: theme.settings_text(),
            ..Self::base(theme, value)
        }
    }

    /// The main window's search field: `h-9 px-2 rounded-md border-gray-5
    /// bg-gray-2` with a leading magnifier, over the panel material's body
    /// remaps.
    pub fn search(theme: &Theme, value: impl Into<SharedString>) -> Self {
        Self {
            height: px(36.),
            radius: px(6.),
            gap: px(4.),
            bg: Some(theme.body_fill(2)),
            border: Some(theme.body_border(5)),
            icon: Some(SharedString::from("icons/search.svg")),
            text: theme.gray(12),
            muted: theme.gray(10),
            caret_color: theme.gray(12),
            flex: true,
            ..Self::base(theme, value)
        }
    }

    pub fn placeholder(mut self, placeholder: impl Into<SharedString>) -> Self {
        self.placeholder = Some(placeholder.into());
        self
    }

    /// The focus handle to `track_focus` on. Pass it and the field takes key
    /// events; the caller still installs its own `on_key_down`.
    pub fn focus(mut self, focus: &FocusHandle) -> Self {
        self.focus = Some(focus.clone());
        self
    }

    /// Whether to draw the caret. Deliberately explicit: settings draws it
    /// while the field has focus (there are two on the page and two blinkless
    /// bars would read as two active inputs), the main window's search draws it
    /// whenever the filter is non-empty.
    pub fn caret(mut self, caret: bool) -> Self {
        self.caret = caret;
        self
    }
}

impl RenderOnce for TextField {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let TextField {
            value,
            placeholder,
            icon,
            focus,
            caret,
            height,
            padding_x,
            radius,
            gap,
            text_size,
            bg,
            border,
            text,
            muted,
            icon_color,
            caret_color,
            caret_height,
            flex,
        } = self;

        let empty = value.is_empty();
        let shown: SharedString = if empty {
            placeholder.clone().unwrap_or_default()
        } else {
            value
        };

        div()
            .when_some(focus.as_ref(), |this, focus| this.track_focus(focus))
            .relative()
            .flex()
            .flex_row()
            .items_center()
            .gap(gap)
            .when(flex, |this| this.flex_1().min_w_0())
            .h(height)
            .px(padding_x)
            .rounded(radius)
            .when_some(bg, |this, bg| this.bg(bg))
            .when_some(border, |this, border| this.border_1().border_color(border))
            .text_size(text_size)
            .text_color(text)
            .children(icon.map(|icon| {
                svg()
                    .path(icon)
                    .size(px(12.))
                    .flex_shrink_0()
                    .text_color(icon_color)
            }))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .when(empty, |this| this.text_color(muted))
                    .child(shown),
            )
            .when(caret, |this| {
                this.child(
                    div()
                        .w(px(1.))
                        .h(caret_height)
                        .flex_shrink_0()
                        .bg(caret_color),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::Modifiers;

    fn keystroke(key: &str, key_char: Option<&str>, modifiers: Modifiers) -> Keystroke {
        Keystroke {
            modifiers,
            key: key.to_string(),
            key_char: key_char.map(str::to_string),
        }
    }

    #[test]
    fn a_printable_character_is_inserted() {
        let edit = text_edit_for(&keystroke("a", Some("a"), Modifiers::none()));
        assert_eq!(edit, TextEdit::Insert("a".into()));
    }

    /// `key_char` rather than `key` is what makes dead keys and option layouts
    /// type the glyph the user actually produced.
    #[test]
    fn the_composed_character_wins_over_the_key_name() {
        let edit = text_edit_for(&keystroke("e", Some("é"), Modifiers::none()));
        assert_eq!(edit, TextEdit::Insert("é".into()));
    }

    #[test]
    fn a_command_chord_is_never_text() {
        assert_eq!(
            text_edit_for(&keystroke("w", Some("w"), Modifiers::command())),
            TextEdit::Ignored
        );
        assert_eq!(
            text_edit_for(&keystroke("c", Some("c"), Modifiers::control())),
            TextEdit::Ignored
        );
    }

    #[test]
    fn control_characters_never_reach_the_string() {
        assert_eq!(
            text_edit_for(&keystroke("enter", Some("\r"), Modifiers::none())),
            TextEdit::Ignored
        );
        assert_eq!(
            text_edit_for(&keystroke("tab", Some("\t"), Modifiers::none())),
            TextEdit::Ignored
        );
    }

    #[test]
    fn a_key_with_no_character_is_ignored() {
        assert_eq!(
            text_edit_for(&keystroke("left", None, Modifiers::none())),
            TextEdit::Ignored
        );
    }

    /// Both are edits, not characters, so a modifier held down does not turn
    /// them into shortcuts as far as the field is concerned.
    #[test]
    fn backspace_and_escape_are_recognised_whatever_is_held() {
        assert_eq!(
            text_edit_for(&keystroke("backspace", None, Modifiers::none())),
            TextEdit::Backspace
        );
        assert_eq!(
            text_edit_for(&keystroke("backspace", None, Modifiers::command())),
            TextEdit::Backspace
        );
        assert_eq!(
            text_edit_for(&keystroke("escape", None, Modifiers::none())),
            TextEdit::Escape
        );
    }
}
