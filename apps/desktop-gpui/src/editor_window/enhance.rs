//! Enhance in the player toolbar: a quiet chip that takes the accent while it
//! is on, and a card that explains what it does and stays up while the pointer
//! is on the chip, so toggling shows the change and the new state together.
//! The card is its own small view, so its entrance repaints only the card.

use super::*;

/// How long the pointer rests on the chip before the card opens.
const CARD_DELAY: Duration = Duration::from_millis(350);
const CARD_ENTER: Duration = Duration::from_millis(180);
const CARD_RISE: f32 = 6.;
const CARD_WIDTH: f32 = 284.;

pub(crate) struct EnhanceCard {
    theme: Theme,
    on: bool,
    still: bool,
}

impl Render for EnhanceCard {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let editor = self.theme.editor;
        let on = self.on;
        let row = |icon: &'static str, text: SharedString| {
            div()
                .flex()
                .flex_row()
                .items_start()
                .gap(px(8.))
                .child(
                    svg()
                        .path(icon)
                        .size(px(13.))
                        .mt(px(2.))
                        .flex_none()
                        .text_color(Hsla::from(editor.text_2)),
                )
                .child(div().flex_1().min_w_0().child(text))
        };
        let state = div()
            .flex()
            .items_center()
            .h(px(18.))
            .px(px(7.))
            .rounded_full()
            .text_size(px(11.))
            .font_weight(FontWeight::MEDIUM)
            .map(|this| {
                if on {
                    this.bg(Hsla::from(editor.accent).opacity(0.14))
                        .text_color(Hsla::from(editor.accent_ink))
                        .child(tr::editor::window::transport::enhance_on())
                } else {
                    this.bg(Hsla::from(editor.ctl_hover))
                        .text_color(Hsla::from(editor.text_2))
                        .child(tr::editor::window::transport::enhance_off())
                }
            });
        let card = div()
            .w(px(CARD_WIDTH))
            .flex()
            .flex_col()
            .gap(px(10.))
            .p(px(14.))
            .rounded(px(12.))
            .border_1()
            .border_color(editor.pop_line())
            .bg(editor.pop_bg())
            .shadow(editor.pop_shadow())
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(7.))
                            .text_size(px(13.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(Hsla::from(editor.text_1))
                            .child(svg().path("icons/scan-text.svg").size(px(14.)).text_color(
                                Hsla::from(if on { editor.accent_ink } else { editor.text_1 }),
                            ))
                            .child(tr::editor::window::transport::enhance()),
                    )
                    .child(state),
            )
            .child(
                div()
                    .text_size(px(12.))
                    .line_height(px(17.))
                    .text_color(Hsla::from(editor.text_1))
                    .child(tr::editor::window::transport::enhance_card_body()),
            )
            .child(div().h(px(1.)).bg(Hsla::from(editor.line)))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(7.))
                    .text_size(px(12.))
                    .line_height(px(16.))
                    .text_color(Hsla::from(editor.text_2))
                    .child(row(
                        "icons/laptop.svg",
                        tr::editor::window::transport::enhance_card_local().into(),
                    ))
                    .child(row(
                        "icons/upload-arrow.svg",
                        tr::editor::window::transport::enhance_card_export().into(),
                    ))
                    .child(row(
                        "icons/pause.svg",
                        tr::editor::window::transport::enhance_card_preview().into(),
                    )),
            );
        if self.still {
            return card.into_any_element();
        }
        card.with_animation(
            "enhance-card-enter",
            Animation::new(CARD_ENTER),
            |card, progress| {
                let eased = ease_out_quint(progress);
                card.opacity(eased).mt(px(CARD_RISE * (1. - eased)))
            },
        )
        .into_any_element()
    }
}

impl EditorWindow {
    /// The chip. Its width never changes with its state, so it stays under
    /// the pointer to be clicked again.
    pub(super) fn render_preview_enhance(
        &self,
        labels: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let editor = theme.editor;
        let ready = self.project_ready();
        let on = self.preview_enhance;
        let wash = Hsla::from(editor.accent);
        let ink = Hsla::from(if on { editor.accent_ink } else { editor.text_2 });
        let bounds = self.enhance_chip_bounds.clone();
        let chip = div()
            .id("transport-enhance")
            .group("transport-enhance")
            .relative()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.))
            .h(px(28.))
            .px(px(9.))
            .rounded(px(9.))
            .text_size(px(12.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(ink)
            // At rest it sits in the same faint trough as the quality picker
            // beside it, so it reads as a control and not a label; on, the
            // trough fills with the accent.
            .map(|this| {
                if on {
                    this.bg(wash.opacity(0.14))
                } else {
                    this.bg(Hsla::from(editor.ctl)).shadow(editor.trough_ring())
                }
            })
            .when(!ready, |this| this.opacity(0.45))
            .when(ready, |this| {
                this.cursor_pointer()
                    .hover(move |style| {
                        if on {
                            style.bg(wash.opacity(0.22))
                        } else {
                            style
                                .bg(Hsla::from(editor.ctl_hover))
                                .text_color(Hsla::from(editor.text_1))
                        }
                    })
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.toggle_preview_enhance(window, cx);
                        // The card answers the click straight away, with the
                        // new state, and stays until the pointer leaves.
                        if this.enhance_hovered {
                            this.show_enhance_card(cx);
                        }
                    }))
            })
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                this.hover_enhance(*hovered, cx);
            }))
            .child(
                svg()
                    .path("icons/scan-text.svg")
                    .size(px(14.))
                    .flex_none()
                    .text_color(ink)
                    .when(ready && !on, |this| {
                        this.group_hover("transport-enhance", |style| {
                            style.text_color(Hsla::from(editor.text_1))
                        })
                    }),
            )
            .when(labels, |this| {
                this.child(tr::editor::window::transport::enhance())
            })
            .child(
                gpui::canvas(move |value, _, _| bounds.set(Some(value)), |_, _, _, _| {})
                    .absolute()
                    .size_full(),
            );
        chip
    }

    /// Opens the card once the pointer has rested on the chip, and closes it
    /// as soon as the pointer leaves.
    fn hover_enhance(&mut self, hovered: bool, cx: &mut Context<Self>) {
        self.enhance_hovered = hovered;
        if !hovered {
            self.hide_enhance_card(cx);
            return;
        }
        if self.enhance_card.is_some() || self.enhance_card_task.is_some() {
            return;
        }
        self.enhance_card_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(CARD_DELAY).await;
            let _ = this.update(cx, |this, cx| {
                this.enhance_card_task = None;
                if this.enhance_hovered {
                    this.show_enhance_card(cx);
                }
            });
        }));
    }

    fn show_enhance_card(&mut self, cx: &mut Context<Self>) {
        self.enhance_card_task = None;
        if self.enhance_card.is_some() {
            return;
        }
        let (theme, on, still) = (self.theme, self.preview_enhance, cx.reduce_motion());
        self.enhance_card = Some(cx.new(|_| EnhanceCard { theme, on, still }));
        cx.notify();
    }

    /// An open card follows the setting, from the chip or the export page.
    pub(super) fn update_enhance_card(&mut self, cx: &mut Context<Self>) {
        let on = self.preview_enhance;
        if let Some(card) = &self.enhance_card {
            card.update(cx, |card, cx| {
                if card.on != on {
                    card.on = on;
                    cx.notify();
                }
            });
        }
    }

    fn hide_enhance_card(&mut self, cx: &mut Context<Self>) {
        self.enhance_card_task = None;
        if self.enhance_card.take().is_some() {
            cx.notify();
        }
    }

    /// Below the chip and to its left, over the video's corner rather than
    /// under the pointer.
    pub(super) fn render_enhance_card(&self) -> Option<impl IntoElement> {
        let card = self.enhance_card.clone()?;
        let bounds = self.enhance_chip_bounds.get()?;
        Some(
            gpui::anchored()
                .anchor(gpui::Anchor::TopRight)
                .position(gpui::point(bounds.right(), bounds.bottom() + px(10.)))
                .snap_to_window_with_margin(px(12.))
                .child(card),
        )
    }
}

// gpui's test windows have no platform window handle on macOS or Windows,
// which the editor needs.
#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    /// The card waits for the pointer to rest and closes when it leaves; a
    /// click opens it at once and it follows the new state.
    #[gpui::test]
    fn the_enhance_card_opens_on_rest_follows_clicks_and_closes_on_leave(
        cx: &mut gpui::TestAppContext,
    ) {
        let project = tempfile::tempdir().unwrap();
        let project_path = project.path().to_path_buf();
        let (editor, cx) = cx
            .add_window_view(move |window, cx| EditorWindow::new(project_path.clone(), window, cx));

        editor.update(cx, |editor, cx| editor.hover_enhance(true, cx));
        assert!(editor.update(cx, |editor, _| editor.enhance_card.is_none()));
        cx.executor().advance_clock(CARD_DELAY);
        cx.run_until_parked();
        assert!(editor.update(cx, |editor, _| editor.enhance_card.is_some()));

        editor.update(cx, |editor, cx| editor.hover_enhance(false, cx));
        assert!(editor.update(cx, |editor, _| editor.enhance_card.is_none()));

        // Leaving before the delay never opens it.
        editor.update(cx, |editor, cx| {
            editor.hover_enhance(true, cx);
            editor.hover_enhance(false, cx);
        });
        cx.executor().advance_clock(CARD_DELAY);
        cx.run_until_parked();
        assert!(editor.update(cx, |editor, _| editor.enhance_card.is_none()));

        // A click before the delay opens it straight away with the new
        // state, and a second click updates it in place.
        let card_on = |editor: &EditorWindow, cx: &gpui::App| {
            editor.enhance_card.as_ref().map(|card| card.read(cx).on)
        };
        editor.update_in(cx, |editor, window, cx| {
            editor.preview_enhance = false;
            editor.hover_enhance(true, cx);
            editor.set_enhance(true, window, cx);
            editor.show_enhance_card(cx);
            assert_eq!(card_on(editor, cx), Some(true));
            editor.set_enhance(false, window, cx);
            assert_eq!(card_on(editor, cx), Some(false));
            editor.hover_enhance(false, cx);
            assert!(editor.enhance_card.is_none());
        });
    }
}
