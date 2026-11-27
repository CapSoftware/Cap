use std::time::Duration;

use gpui::{
    Animation, AnimationExt, AnyElement, App, AppContext as _, Context, FontWeight,
    InteractiveElement, IntoElement, ParentElement, Render, StatefulInteractiveElement, Styled,
    Subscription, Window, WindowBounds, WindowKind, WindowOptions, div, hsla,
    prelude::FluentBuilder, px, size, svg,
};

use super::{
    doodles,
    style::{self, Palette},
};
use crate::{
    i18n::tr,
    meetings_ui::cap_ai::{CapAi, CapAiEvent, Host, flow::Phase, pitch},
    theme::{LocaleFont as _, Theme},
};

const SHEET_WIDTH: f32 = 440.;
const WINDOW_SIZE: (f32, f32) = (480., 560.);

fn with_cap_ai(cx: &mut App, f: impl FnOnce(&mut CapAi, &mut Context<CapAi>)) {
    if let Some(cap_ai) = CapAi::global(cx) {
        cap_ai.update(cx, f);
    }
}

fn ease(t: f32) -> f32 {
    1. - (1. - t.clamp(0., 1.)).powi(3)
}

fn line(palette: &Palette, text: String) -> AnyElement {
    div()
        .flex()
        .gap(px(10.))
        .child(
            div().pt(px(3.)).flex_shrink_0().child(
                svg()
                    .path("icons/check.svg")
                    .size(px(14.))
                    .text_color(palette.green),
            ),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_size(px(13.5))
                .line_height(px(20.))
                .text_color(palette.text)
                .child(text),
        )
        .into_any_element()
}

fn quiet(palette: &Palette, id: &'static str, label: &'static str) -> gpui::Stateful<gpui::Div> {
    let palette = *palette;
    div()
        .id(id)
        .h(px(30.))
        .px(px(12.))
        .flex()
        .items_center()
        .rounded_full()
        .text_size(px(13.))
        .text_color(palette.muted)
        .cursor_pointer()
        .hover(move |s| s.bg(palette.hover).text_color(palette.text))
        .child(label)
}

pub fn render_sheet(
    palette: &Palette,
    cap_ai: &CapAi,
    reduce_motion: bool,
    framed: bool,
) -> AnyElement {
    let palette = *palette;
    let phase = cap_ai.phase();
    let shown_at = cap_ai.shown_at();
    let from_note = cap_ai.doc_id().is_some();
    let pitch = cap_ai.pitch().cloned();
    let art = if phase == Phase::Welcome {
        &doodles::PAGE
    } else {
        &doodles::WRITING
    };
    let title: String = match phase {
        Phase::Pitch | Phase::Closed => pitch
            .as_ref()
            .map(pitch::Pitch::headline)
            .unwrap_or_else(pitch::generic_headline),
        Phase::SigningIn => tr::cap_ai::sheet::signing_in_title().into(),
        Phase::Starting => tr::cap_ai::sheet::starting_title().into(),
        Phase::Waiting => tr::cap_ai::sheet::waiting_title().into(),
        Phase::Welcome => tr::cap_ai::sheet::welcome_title().into(),
    };
    let mut body = div().w_full().flex().flex_col().gap(px(10.));
    let mut actions = div().w_full().flex().flex_col().items_center().gap(px(8.));
    match phase {
        Phase::Pitch | Phase::Closed => {
            let ask = pitch
                .as_ref()
                .map(pitch::Pitch::ask_line)
                .unwrap_or_else(|| tr::cap_ai::sheet::ask_any().to_string());
            body = body
                .child(line(&palette, tr::cap_ai::sheet::notes_line().into()))
                .child(line(&palette, ask))
                .child(line(&palette, tr::cap_ai::sheet::pro_line().into()));
            actions = actions
                .child(
                    style::ink_pill(&palette, "cap-ai-continue")
                        .w_full()
                        .h(px(40.))
                        .justify_center()
                        .text_size(px(14.))
                        .child(tr::cap_ai::sheet::continue_label())
                        .on_click(|_, _, cx| with_cap_ai(cx, |c, cx| c.proceed(cx))),
                )
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(palette.faint)
                        .child(tr::cap_ai::sheet::cancel_anytime()),
                );
        }
        Phase::SigningIn => {
            body = body.child(muted(&palette, tr::cap_ai::sheet::signing_in_body()));
        }
        Phase::Starting => {}
        Phase::Waiting => {
            body = body.child(muted(&palette, tr::cap_ai::sheet::waiting_body()));
            actions = actions.child(
                style::quiet_pill(&palette, "cap-ai-reopen")
                    .child(tr::cap_ai::sheet::open_again())
                    .on_click(|_, _, cx| with_cap_ai(cx, |c, cx| c.reopen_checkout(cx))),
            );
        }
        Phase::Welcome => {
            body = body.child(muted(
                &palette,
                if from_note {
                    tr::cap_ai::sheet::welcome_note()
                } else {
                    tr::cap_ai::sheet::welcome_any()
                },
            ));
        }
    }
    let closable = phase != Phase::Welcome;
    let content = div()
        .w_full()
        .flex()
        .flex_col()
        .items_center()
        .gap(px(18.))
        .child(style::art(art, palette.doodle(), shown_at, 104., 90.))
        .child(
            div()
                .w_full()
                .flex()
                .flex_col()
                .items_center()
                .child(
                    div()
                        .max_w(px(360.))
                        .text_center()
                        .text_size(px(21.))
                        .line_height(px(27.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(palette.text)
                        .child(title),
                )
                .child(div().mt(px(4.)).child(style::art(
                    &crate::onboarding_doodles::UNDERLINE,
                    palette.doodle(),
                    shown_at,
                    96.,
                    9.,
                ))),
        )
        .child(body)
        .child(actions);
    let content = if reduce_motion {
        content.into_any_element()
    } else {
        content
            .with_animation(
                ("cap-ai-sheet", phase as usize),
                Animation::new(Duration::from_millis(520)),
                |el, t| {
                    let t = ease(t);
                    el.relative().top(px(14. * (1. - t))).opacity(t)
                },
            )
            .into_any_element()
    };
    div()
        .id("cap-ai-sheet")
        .occlude()
        .relative()
        .w(px(SHEET_WIDTH))
        .max_w_full()
        .px(px(30.))
        .pt(px(30.))
        .pb(px(24.))
        .when(framed, |el| {
            el.rounded(px(24.))
                .border(px(1.5))
                .border_color(palette.track)
                .bg(palette.content)
                .shadow(palette.shadow())
        })
        .child(content)
        .when(closable && framed, |el| {
            el.child(
                div().absolute().top(px(12.)).right(px(12.)).child(
                    style::icon_button(
                        &palette,
                        "cap-ai-close",
                        "icons/x.svg",
                        28.,
                        tr::common::close(),
                    )
                    .on_click(|_, _, cx| with_cap_ai(cx, |c, cx| c.close(cx))),
                ),
            )
        })
        .when(phase == Phase::Pitch, |el| {
            el.child(
                div().mt(px(2.)).flex().justify_center().child(
                    quiet(&palette, "cap-ai-not-now", tr::cap_ai::sheet::not_now())
                        .on_click(|_, _, cx| with_cap_ai(cx, |c, cx| c.close(cx))),
                ),
            )
        })
        .into_any_element()
}

fn muted(palette: &Palette, text: &'static str) -> AnyElement {
    div()
        .w_full()
        .text_center()
        .text_size(px(13.5))
        .line_height(px(20.))
        .text_color(palette.muted)
        .child(text)
        .into_any_element()
}

pub fn overlay(palette: &Palette, cap_ai: &CapAi, reduce_motion: bool) -> AnyElement {
    let scrim = if palette.dark {
        hsla(0., 0., 0., 0.42)
    } else {
        hsla(0., 0., 0., 0.16)
    };
    div()
        .id("cap-ai-scrim")
        .absolute()
        .inset_0()
        .occlude()
        .bg(scrim)
        .flex()
        .items_center()
        .justify_center()
        .p(px(16.))
        .on_click(|_, _, cx| {
            with_cap_ai(cx, |c, cx| {
                if c.phase() == Phase::Pitch {
                    c.close(cx)
                }
            })
        })
        .child(render_sheet(palette, cap_ai, reduce_motion, true))
        .into_any_element()
}

pub struct UpgradeWindow {
    theme: Theme,
    _subscriptions: Vec<Subscription>,
}

impl UpgradeWindow {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        crate::theme::bind_window(window, cx);
        let mut subscriptions = vec![
            cx.observe_window_activation(window, |_, window, cx| {
                if window.is_window_active() {
                    with_cap_ai(cx, |c, cx| c.activated(cx));
                }
            }),
            cx.on_release(|_, cx| {
                with_cap_ai(cx, |c, cx| {
                    if c.is_open_in(Host::Window) {
                        c.close(cx);
                    }
                });
            }),
        ];
        if let Some(cap_ai) = CapAi::global(cx) {
            subscriptions.push(cx.subscribe_in(
                &cap_ai,
                window,
                |_, cap_ai, event: &CapAiEvent, window, cx| {
                    if *event == CapAiEvent::Changed {
                        if cap_ai.read(cx).is_open_in(Host::Window) {
                            cx.notify();
                        } else {
                            window.remove_window();
                        }
                    }
                },
            ));
        }
        Self {
            theme: Theme::for_window(window, cx, true),
            _subscriptions: subscriptions,
        }
    }
}

impl Render for UpgradeWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.theme.refresh(window, cx, true);
        let palette = Palette::new(&self.theme);
        let sheet = CapAi::global(cx)
            .map(|c| render_sheet(&palette, c.read(cx), cx.reduce_motion(), false));
        div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(palette.content)
            .font_family(crate::theme::UI_FONT)
            .locale_font()
            .text_color(palette.text)
            .pt(px(12.))
            .window_control_area(gpui::WindowControlArea::Drag)
            .children(sheet)
    }
}

struct UpgradeWindowSlot(Option<gpui::WindowHandle<UpgradeWindow>>);

impl gpui::Global for UpgradeWindowSlot {}

pub fn open_window(cx: &mut App) {
    if let Some(handle) = cx.try_global::<UpgradeWindowSlot>().and_then(|s| s.0)
        && handle
            .update(cx, |_, window, _| window.activate_window())
            .is_ok()
    {
        return;
    }
    let bounds = gpui::Bounds::centered(None, size(px(WINDOW_SIZE.0), px(WINDOW_SIZE.1)), cx);
    let handle = cx.open_window(
        WindowOptions {
            #[cfg(target_os = "linux")]
            app_id: Some(crate::app_windows::app_id().into()),
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(gpui::TitlebarOptions {
                title: Some("Cap Pro".into()),
                appears_transparent: true,
                traffic_light_position: None,
            }),
            kind: WindowKind::Normal,
            focus: true,
            show: true,
            is_resizable: false,
            is_minimizable: true,
            window_background: gpui::WindowBackgroundAppearance::Opaque,
            ..Default::default()
        },
        |window, cx| cx.new(|cx| UpgradeWindow::new(window, cx)),
    );
    match handle {
        Ok(handle) => cx.set_global(UpgradeWindowSlot(Some(handle))),
        Err(error) => {
            tracing::error!("upgrade window failed to open: {error:#}");
            with_cap_ai(cx, |c, cx| c.close(cx));
        }
    }
}
