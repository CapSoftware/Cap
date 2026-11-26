//! Settings > Dictionary: one list of how names and terms are spelled, for
//! meeting notes, captions, Ask and cloud transcription alike. Each word can
//! carry what it sounds like in a transcript; most people only type the
//! spelling.

use cap_meetings::dictionary::MAX_ENTRIES;
use gpui::{
    AnyElement, Context, FontWeight, InteractiveElement, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, div, px,
};

use super::shared::{Palette, glyph};
use crate::{i18n::tr, settings_window::SettingsWindow, ui};

impl SettingsWindow {
    pub(crate) fn render_dictionary(&self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let palette = Palette::new(&self.theme);
        let entries = self
            .pages
            .meetings
            .settings
            .transcription
            .entries()
            .to_vec();
        let full = entries.len() >= MAX_ENTRIES;
        self.pages.meetings.vocab_input.update(cx, |input, _| {
            input.set_placeholder(tr::settings::dictionary::placeholder())
        });
        self.pages.meetings.sounds_input.update(cx, |input, _| {
            input.set_placeholder(tr::settings::dictionary::sounds_placeholder())
        });

        let add = div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.))
                    .child(div().flex_1().min_w_0().child(ui::TextInput::settings(
                        &self.theme,
                        "dictionary-add",
                        &self.pages.meetings.vocab_input,
                    )))
                    .child(self.button(
                        "dictionary-add-button",
                        (ui::ButtonVariant::Primary, Some("icons/plus.svg")),
                        tr::common::add(),
                        self.pages.meetings.vocab_draft.trim().is_empty() || full,
                        cx,
                        |this, _, cx| this.meetings_add_term(cx),
                    )),
            )
            .child(
                div()
                    .text_size(px(12.))
                    .line_height(px(17.))
                    .text_color(palette.muted)
                    .child(tr::settings::dictionary::how()),
            );

        let rows: Vec<AnyElement> = entries
            .iter()
            .enumerate()
            .map(|(index, entry)| self.dictionary_row(index, entry, &palette, cx))
            .collect();

        let mut sections = vec![
            self.section(
                tr::settings::dictionary::title(),
                Some(tr::settings::dictionary::description()),
                None,
                vec![self.card(true).child(add).into_any_element()],
            )
            .into_any_element(),
        ];
        if !rows.is_empty() {
            sections.push(
                self.section(
                    tr::settings::dictionary::words(),
                    None,
                    Some(
                        div()
                            .text_size(px(12.))
                            .text_color(palette.muted)
                            .child(tr::settings::dictionary::count(entries.len()))
                            .into_any_element(),
                    ),
                    vec![self.rows(rows).into_any_element()],
                )
                .into_any_element(),
            );
        }
        sections
    }

    fn dictionary_row(
        &self,
        index: usize,
        entry: &cap_meetings::dictionary::Entry,
        palette: &Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = *palette;
        let editing = self.pages.meetings.sounds_for == Some(index);
        let spelling = entry.spelling.clone();
        let chips = entry
            .sounds_like
            .iter()
            .enumerate()
            .map(|(j, form)| {
                let remove = form.clone();
                div()
                    .id(SharedString::from(format!("dictionary-sound-{index}-{j}")))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.))
                    .h(px(22.))
                    .pl(px(8.))
                    .pr(px(6.))
                    .rounded_full()
                    .bg(palette.fill)
                    .text_size(px(12.))
                    .text_color(palette.muted)
                    .cursor_pointer()
                    .hover(move |el| el.bg(palette.hover).text_color(palette.text))
                    .child(form.clone())
                    .child(glyph("icons/x.svg", 9., palette.muted))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.meetings_remove_sound(index, &remove, cx)
                    }))
            })
            .collect::<Vec<_>>();
        let trailing: AnyElement = if editing {
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.))
                .child(div().w(px(170.)).child(ui::TextInput::settings(
                    &self.theme,
                    "dictionary-sounds",
                    &self.pages.meetings.sounds_input,
                )))
                .child(self.button(
                    "dictionary-sounds-add",
                    (ui::ButtonVariant::Gray, None),
                    tr::common::add(),
                    self.pages.meetings.sounds_draft.trim().is_empty(),
                    cx,
                    |this, _, cx| this.meetings_add_sound(cx),
                ))
                .into_any_element()
        } else {
            div()
                .id(SharedString::from(format!(
                    "dictionary-sounds-open-{index}"
                )))
                .h(px(22.))
                .px(px(8.))
                .flex()
                .items_center()
                .rounded_full()
                .text_size(px(12.))
                .text_color(palette.muted)
                .cursor_pointer()
                .hover(move |el| el.bg(palette.hover).text_color(palette.text))
                .child(tr::settings::dictionary::sounds_like())
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.meetings_edit_sounds(Some(index), cx);
                    let handle = this.pages.meetings.sounds_input.read(cx).focus_handle();
                    window.focus(&handle, cx);
                }))
                .into_any_element()
        };
        div()
            .id(SharedString::from(format!("dictionary-row-{index}")))
            .min_h(px(44.))
            .px(px(12.))
            .py(px(8.))
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap(px(8.))
            .child(
                div()
                    .min_w(px(90.))
                    .text_size(px(13.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(palette.text)
                    .child(spelling.clone()),
            )
            .children(chips)
            .child(trailing)
            .child(div().flex_1())
            .child(
                div()
                    .id(SharedString::from(format!("dictionary-remove-{index}")))
                    .size(px(24.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_full()
                    .cursor_pointer()
                    .hover(move |el| el.bg(palette.hover))
                    .child(glyph("icons/x.svg", 11., palette.muted))
                    .on_click(
                        cx.listener(move |this, _, _, cx| this.meetings_remove_term(&spelling, cx)),
                    ),
            )
            .into_any_element()
    }
}
