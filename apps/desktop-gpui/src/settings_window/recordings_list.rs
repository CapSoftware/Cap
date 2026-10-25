use gpui::{
    Context, InteractiveElement, IntoElement, ParentElement, Styled, div, list,
    prelude::FluentBuilder, px,
};

use super::{CONTENT_PADDING_X, SettingsWindow, has_more_recordings, load_more_count};
use crate::ui;

impl SettingsWindow {
    /// `settings/recordings.tsx`.
    ///
    /// The header is a `<Section>` with an Import button; below it a filter bar
    /// (three tab pills and the search field) and the bordered list, which is
    /// replaced wholesale by "No recordings found" when the library is empty.
    pub(super) fn render_recordings(&self, cx: &mut Context<Self>) -> Vec<gpui::AnyElement> {
        let visible = self.recordings.visible_rows();
        let has_search = !self.recordings.trimmed_search().is_empty();
        let more = has_more_recordings(visible.matching, has_search, self.recordings.visible_count);
        let empty_library = self.recordings.items.as_ref().is_none_or(Vec::is_empty);
        let count = if empty_library {
            1
        } else {
            1 + visible.indices.len() + usize::from(visible.matching == 0) + usize::from(more)
        };
        let old_count = self.recordings.list.item_count();
        let had_footer = self.recordings.has_footer.replace(more);
        if old_count != count || had_footer != more {
            let scroll_top = self.recordings.list.logical_scroll_top();
            // Pagination moves the footer, so its focus handle must follow the shared tail.
            let start = old_count.min(count).saturating_sub(1);
            self.recordings.list.splice_focusable(
                start..old_count,
                (start..count).map(|index| {
                    if index == 0 {
                        Some(self.recordings.header_focus.clone())
                    } else if more && index + 1 == count {
                        Some(self.recordings.footer_focus.clone())
                    } else {
                        None
                    }
                }),
            );
            self.recordings.list.scroll_to(scroll_top);
        }
        let theme = self.theme;
        vec![
            list(
                self.recordings.list.clone(),
                cx.processor(move |this, index, _, cx| {
                    let content = if index == 0 {
                        div()
                            .track_focus(&this.recordings.header_focus)
                            .pb(px(if empty_library { 0. } else { 10. }))
                            .child(this.render_recordings_header(empty_library, cx))
                            .into_any_element()
                    } else {
                        let first = index == 1;
                        let last = index + 1 == count;
                        div()
                            .border_x_1()
                            .border_color(theme.settings_border())
                            .bg(theme.settings_card_bg())
                            .when(first, |this| this.border_t_1().rounded_t(px(10.)))
                            .when(last, |this| this.border_b_1().rounded_b(px(10.)))
                            .overflow_hidden()
                            .child(if let Some(&row_index) = visible.indices.get(index - 1) {
                                let row = &this.recordings.items.as_ref().unwrap()[row_index];
                                this.render_recording_row(
                                    index - 1,
                                    row,
                                    index == visible.indices.len(),
                                    cx,
                                )
                                .into_any_element()
                            } else if visible.matching == 0 {
                                this.recordings_message(super::recordings_empty_message(
                                    this.recordings.tab,
                                    this.recordings.trimmed_search(),
                                ))
                                .into_any_element()
                            } else {
                                div()
                                    .track_focus(&this.recordings.footer_focus)
                                    .child(this.render_recordings_footer(cx))
                                    .into_any_element()
                            })
                            .into_any_element()
                    };
                    div()
                        .w_full()
                        .px(px(CONTENT_PADDING_X))
                        .when(index == 0, |this| this.pt(px(18.)))
                        .when(index + 1 == count, |this| this.pb(px(28.)))
                        .child(content)
                        .into_any_element()
                }),
            )
            .flex_1()
            .min_h_0()
            .into_any_element(),
        ]
    }

    fn render_recordings_header(
        &self,
        empty_library: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        // `variant="gray" size="sm" class="h-[36px] px-3 gap-1.5"` --
        // `importVideoFromPicker` (`recordings.tsx:192-215`), through this
        // build's own remux pipeline.
        let import = self
            .button(
                "recordings-import",
                (ui::ButtonVariant::Gray, Some("icons/import.svg")),
                "Import",
                false,
                cx,
                |_, _, cx| crate::import::pick_and_import_video(cx),
            )
            .height(px(36.))
            .into_any_element();
        // `when={recordings.data && recordings.data.length > 0}`: an empty
        // library and a scan still in flight take the same branch, because the
        // route has no loading state of its own.
        let children = if empty_library {
            vec![
                self.recordings_message("No recordings found")
                    .into_any_element(),
            ]
        } else {
            vec![self.render_recordings_filters(cx).into_any_element()]
        };
        self.section(
            "Recordings",
            Some("Manage your recordings and perform actions."),
            Some(import),
            children,
        )
    }

    fn render_recordings_footer(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_row()
            .justify_center()
            .p(px(12.))
            .border_t_1()
            .border_color(self.theme.settings_border())
            .child(self.button(
                "recordings-load-more",
                (ui::ButtonVariant::Gray, None),
                "Load more",
                false,
                cx,
                |this, window, cx| {
                    let total = this.recordings.visible_rows().matching;
                    this.recordings.visible_count =
                        load_more_count(this.recordings.visible_count, total);
                    this.decode_visible_recordings(window, cx);
                    cx.notify();
                },
            ))
    }
}

#[cfg(test)]
mod tests;
