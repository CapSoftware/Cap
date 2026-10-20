use std::future::Future;

use gpui::{
    App, AppContext as _, Context, EventEmitter, FocusHandle, Focusable, FontWeight, Hsla,
    InteractiveElement, IntoElement, KeystrokeEvent, MouseButton, ParentElement, PromptButton,
    PromptResponse, Render, ScrollHandle, StatefulInteractiveElement, Styled, Subscription, Window,
    div, prelude::FluentBuilder, px,
};

use crate::{theme::Theme, ui};

#[derive(Clone, Copy)]
enum MessageKind {
    Retained,
    Confirmation,
}

pub(crate) fn retained_alert(
    message: &str,
    window: &mut Window,
    cx: &mut App,
) -> impl Future<Output = ()> + use<> {
    let response = informational_alert("Recording retained", message, window, cx);
    async move {
        let _ = response.await;
    }
}

pub(crate) fn informational_alert(
    title: &str,
    message: &str,
    window: &mut Window,
    cx: &mut App,
) -> impl Future<Output = bool> + use<> {
    let response = request(
        MessageKind::Retained,
        title,
        message,
        vec![PromptButton::ok("OK")],
        window,
        cx,
    );
    async move { response.await == Some(0) }
}

pub(crate) fn confirm_cancel_export(
    window: &mut Window,
    cx: &mut App,
) -> impl Future<Output = bool> + use<> {
    confirm_action(
        "Cancel export?",
        "Are you sure you want to cancel the export?",
        "Cancel export",
        "Keep exporting",
        window,
        cx,
    )
}

pub(crate) fn confirm_action(
    title: &str,
    message: &str,
    accept: &str,
    cancel: &str,
    window: &mut Window,
    cx: &mut App,
) -> impl Future<Output = bool> + use<> {
    let response = request(
        MessageKind::Confirmation,
        title,
        message,
        vec![
            PromptButton::ok(accept.to_string()),
            PromptButton::cancel(cancel.to_string()),
        ],
        window,
        cx,
    );
    async move { response.await == Some(0) }
}

fn request(
    kind: MessageKind,
    message: &str,
    detail: &str,
    actions: Vec<PromptButton>,
    window: &mut Window,
    cx: &mut App,
) -> impl Future<Output = Option<usize>> + use<> {
    let response = if window.has_active_prompt() {
        None
    } else {
        // Cap has no other custom prompt builder. Restore Default before returning;
        // this App borrow must not await, reenter, or invoke another prompt.
        cx.set_prompt_builder(move |_, message, detail, actions, handle, window, cx| {
            let owner = window.window_handle().window_id();
            let modal = cx.new(|cx: &mut Context<EditorModal>| {
                let weak = cx.entity().downgrade();
                let keyboard = cx.intercept_keystrokes(move |event, window, cx| {
                    if window.window_handle().window_id() == owner {
                        let _ = weak.update(cx, |modal, cx| modal.intercept(event, window, cx));
                    }
                });
                let interaction = Interaction::new(kind);
                let scroll = ScrollHandle::new();
                EditorModal {
                    message: message.to_string(),
                    detail: detail.unwrap_or_default().to_string(),
                    actions: actions.to_vec(),
                    focus: cx.focus_handle(),
                    interaction,
                    scroll,
                    _keyboard: keyboard,
                }
            });
            handle.with_view(modal, window, cx)
        });
        let response = window.prompt(
            gpui::PromptLevel::Warning,
            message,
            Some(detail),
            &actions,
            cx,
        );
        cx.reset_prompt_builder();
        Some(response)
    };
    async move {
        match response {
            Some(response) => response.await.ok(),
            None => None,
        }
    }
}

struct Interaction {
    selected: usize,
    cancel: usize,
    count: usize,
    completed: bool,
}

impl Interaction {
    fn new(kind: MessageKind) -> Self {
        let cancel = usize::from(matches!(kind, MessageKind::Confirmation));
        Self {
            selected: cancel,
            cancel,
            count: cancel + 1,
            completed: false,
        }
    }

    fn select(&mut self, index: usize) -> Option<usize> {
        if self.completed || index >= self.count {
            return None;
        }
        self.completed = true;
        Some(index)
    }

    fn key(&mut self, key: &str, shift: bool) -> Option<usize> {
        if self.completed {
            return None;
        }
        match key {
            "escape" => self.select(self.cancel),
            "enter" | "space" => self.select(self.selected),
            "tab" => {
                self.selected = if shift {
                    (self.selected + self.count - 1) % self.count
                } else {
                    (self.selected + 1) % self.count
                };
                None
            }
            _ => None,
        }
    }
}

struct EditorModal {
    message: String,
    detail: String,
    actions: Vec<PromptButton>,
    focus: FocusHandle,
    interaction: Interaction,
    scroll: ScrollHandle,
    _keyboard: Subscription,
}

impl EditorModal {
    fn intercept(&mut self, event: &KeystrokeEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.interaction.completed
            || !(self.focus.is_focused(window) || self.focus.contains_focused(window, cx))
        {
            return;
        }
        // GPUI dispatches key bindings before element key handlers. The owner-scoped
        // interceptor consumes the keystroke before an editor or global action can run.
        window.prevent_default();
        cx.stop_propagation();
        let modifiers = event.keystroke.modifiers;
        if !modifiers.control && !modifiers.alt && !modifiers.platform && !modifiers.function {
            if let Some(index) = self.interaction.key(&event.keystroke.key, modifiers.shift) {
                cx.emit(PromptResponse(index));
            }
            cx.notify();
        }
    }
}

impl Render for EditorModal {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::for_window(window, cx, false);
        let viewport = window.viewport_size();
        let width = (f32::from(viewport.width) - 24.).clamp(0., 440.);
        let height = (f32::from(viewport.height) - 24.).max(0.);
        let padding = (width / 10.).min(if height < 200. { 8. } else { 16. });

        div()
            .id("editor-modal-backdrop")
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .occlude()
            .track_focus(&self.focus)
            .flex()
            .items_center()
            .justify_center()
            .bg(gpui::hsla(0., 0., 0., 0.5))
            .on_any_mouse_down(|_, _, cx| cx.stop_propagation())
            .map(|this| {
                MouseButton::all().into_iter().fold(this, |this, button| {
                    this.on_mouse_up(button, |_, _, cx| cx.stop_propagation())
                })
            })
            .on_scroll_wheel(|_, _, cx| cx.stop_propagation())
            .on_key_down(|_, window, cx| {
                window.prevent_default();
                cx.stop_propagation();
            })
            .child(
                div()
                    .id("editor-modal-card")
                    .occlude()
                    .w(px(width))
                    .max_h(px(height))
                    .min_w(px(0.))
                    .overflow_hidden()
                    .on_any_mouse_down(|_, _, cx| cx.stop_propagation())
                    .map(|this| {
                        MouseButton::all().into_iter().fold(this, |this, button| {
                            this.on_mouse_up(button, |_, _, cx| cx.stop_propagation())
                        })
                    })
                    .flex()
                    .flex_col()
                    .gap(px(padding.min(12.)))
                    .p(px(padding))
                    .rounded(px(12.))
                    .border_1()
                    .border_color(Hsla::from(theme.gray_3))
                    .bg(Hsla::from(theme.gray_1))
                    .text_color(Hsla::from(theme.gray_12))
                    .shadow_lg()
                    .child(
                        div()
                            .id("editor-modal-message")
                            .min_h(px(0.))
                            .flex_shrink_1()
                            .overflow_y_scroll()
                            .track_scroll(&self.scroll)
                            .flex()
                            .flex_col()
                            .gap(px(padding.min(12.)))
                            .child(
                                div()
                                    .flex_shrink_0()
                                    .text_size(px(15.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(self.message.clone()),
                            )
                            .child(
                                div()
                                    .flex_shrink_0()
                                    .text_size(px(13.))
                                    .text_color(Hsla::from(theme.gray_11))
                                    .child(self.detail.clone()),
                            ),
                    )
                    .child(
                        div()
                            .id("editor-modal-actions")
                            .flex()
                            .flex_shrink_0()
                            .gap(px(8.))
                            .children(self.actions.iter().enumerate().map(|(index, action)| {
                                div()
                                    .id(("editor-modal-action", index))
                                    .flex_1()
                                    .min_w(px(0.))
                                    .rounded(px(10.))
                                    .p(px(2.))
                                    .border_1()
                                    .border_color(Hsla::from(theme.gray_3))
                                    .when(self.interaction.selected == index, |this| {
                                        this.border_color(Hsla::from(theme.gray_12))
                                    })
                                    .child(
                                        ui::Button::plain(
                                            &theme,
                                            ("editor-modal-button", index),
                                            if action.is_cancel() {
                                                ui::ButtonVariant::Gray
                                            } else {
                                                ui::ButtonVariant::Primary
                                            },
                                            ui::ButtonSize::Md,
                                        )
                                        .label(action.label().clone())
                                        .radius(px(8.))
                                        .full_width()
                                        .on_click(
                                            cx.listener(move |modal, _, _, cx| {
                                                if let Some(index) = modal.interaction.select(index)
                                                {
                                                    cx.emit(PromptResponse(index));
                                                }
                                                cx.stop_propagation();
                                            }),
                                        ),
                                    )
                            })),
                    ),
            )
    }
}

impl EventEmitter<PromptResponse> for EditorModal {}

impl Focusable for EditorModal {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}
