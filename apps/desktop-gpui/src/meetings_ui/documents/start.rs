use gpui::{
    AnyElement, Context, EventEmitter, FontWeight, Hsla, InteractiveElement, IntoElement,
    MouseButton, ParentElement, Pixels, Point, Render, StatefulInteractiveElement, Styled, Window,
    div, point, prelude::FluentBuilder, px, svg,
};

use super::{menu, style::Palette};
use crate::{
    i18n::tr,
    meetings::Meetings,
    theme::{Appearance, Theme},
};
pub use cap_meetings::settings::StartChoice;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartEvent {
    Start(StartChoice),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartSize {
    /// The home page's toolbar.
    Toolbar,
    /// The home page when there are no notes yet.
    Hero,
    /// The top of the sidebar, as wide as the sidebar.
    Sidebar,
}

/// The one way to start a note, everywhere it is offered: a split pill whose
/// main half does the last choice made from it, and whose chevron offers both
/// choices. The host carries the choice out and remembers it.
pub struct StartButton {
    id: &'static str,
    palette: Palette,
    size: StartSize,
    menu: Option<Point<Pixels>>,
    _subscription: Option<gpui::Subscription>,
}

impl EventEmitter<StartEvent> for StartButton {}

/// What one click does right now.
pub fn current(cx: &gpui::App) -> StartChoice {
    Meetings::try_global(cx)
        .map(|m| m.read(cx).settings().notes.start)
        .unwrap_or_default()
}

/// Remember the choice for the next one-click start.
pub fn remember(choice: StartChoice, cx: &mut gpui::App) {
    if let Some(meetings) = Meetings::try_global(cx)
        && meetings.read(cx).settings().notes.start != choice
    {
        meetings.update(cx, |m, cx| {
            m.update_settings(|s| s.notes.start = choice, cx)
        });
    }
}

pub fn label(choice: StartChoice) -> &'static str {
    match choice {
        StartChoice::Record => tr::documents::home::start_notes(),
        StartChoice::Blank => tr::documents::toolbar::new_note(),
    }
}

fn detail(choice: StartChoice) -> &'static str {
    match choice {
        StartChoice::Record => tr::documents::start::record_detail(),
        StartChoice::Blank => tr::documents::start::blank_detail(),
    }
}

fn mark(choice: StartChoice, palette: &Palette, ink: Hsla) -> AnyElement {
    match choice {
        StartChoice::Record => div()
            .size(px(8.))
            .flex_shrink_0()
            .rounded_full()
            .bg(palette.live)
            .into_any_element(),
        StartChoice::Blank => svg()
            .path("icons/square-pen.svg")
            .size(px(13.))
            .flex_shrink_0()
            .text_color(ink)
            .into_any_element(),
    }
}

impl StartButton {
    pub fn new(id: &'static str, size: StartSize, theme: &Theme, cx: &mut Context<Self>) -> Self {
        // The label follows the remembered choice, wherever it was made.
        let subscription = Meetings::try_global(cx).map(|meetings| {
            cx.subscribe(
                &meetings,
                |_, _, event: &crate::meetings::MeetingEvent, cx| {
                    if matches!(event, crate::meetings::MeetingEvent::SettingsChanged) {
                        cx.notify();
                    }
                },
            )
        });
        Self {
            id,
            palette: Palette::new(theme),
            size,
            menu: None,
            _subscription: subscription,
        }
    }

    pub fn set_theme(&mut self, theme: &Theme, cx: &mut Context<Self>) {
        self.palette = Palette::new(theme);
        cx.notify();
    }

    pub fn dismiss(&mut self, cx: &mut Context<Self>) -> bool {
        if self.menu.take().is_some() {
            cx.notify();
            return true;
        }
        false
    }

    fn pick(&mut self, choice: StartChoice, cx: &mut Context<Self>) {
        self.menu = None;
        cx.emit(StartEvent::Start(choice));
        cx.notify();
    }

    fn render_menu(&self, at: Point<Pixels>, cx: &mut Context<Self>) -> AnyElement {
        let palette = self.palette;
        let now = current(cx);
        let row = |choice: StartChoice, index: usize| {
            div()
                .id((self.id, index))
                .px(px(10.))
                .py(px(8.))
                .rounded(px(7.))
                .flex()
                .items_center()
                .gap(px(10.))
                .cursor_pointer()
                .hover(move |s| s.bg(palette.accent_soft))
                .child(div().w(px(14.)).flex().justify_center().child(mark(
                    choice,
                    &palette,
                    palette.text,
                )))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .gap(px(1.))
                        .child(
                            div()
                                .text_size(px(13.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(palette.text)
                                .child(label(choice)),
                        )
                        .child(
                            div()
                                .text_size(px(12.))
                                .text_color(palette.muted)
                                .child(detail(choice)),
                        ),
                )
                .child(div().w(px(14.)).flex_shrink_0().when(now == choice, |el| {
                    el.child(
                        svg()
                            .path("icons/check.svg")
                            .size(px(12.))
                            .text_color(palette.muted),
                    )
                }))
                .on_click(cx.listener(move |this, _, _, cx| this.pick(choice, cx)))
        };
        menu::float(
            at,
            menu::surface(&palette)
                .id("start-menu")
                .w(px(272.))
                .p(px(5.))
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(row(StartChoice::Record, 0))
                .child(row(StartChoice::Blank, 1))
                .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                    this.menu = None;
                    cx.notify();
                }))
                .into_any_element(),
        )
    }
}

impl Render for StartButton {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = self.palette;
        let choice = current(cx);
        let (height, text, wide) = match self.size {
            StartSize::Toolbar => (32., 13., false),
            StartSize::Hero => (38., 14., false),
            StartSize::Sidebar => (34., 13., true),
        };
        let soft = Hsla {
            a: 0.14,
            ..palette.on_ink
        };
        let dark = Theme::new(Appearance::Dark);
        let menu = self.menu.map(|at| self.render_menu(at, cx));
        div()
            .id(self.id)
            .h(px(height))
            .when(wide, |el| el.w_full())
            .flex()
            .flex_shrink_0()
            .items_center()
            .rounded_full()
            .bg(palette.text)
            .text_color(palette.on_ink)
            .text_size(px(text))
            .font_weight(FontWeight::MEDIUM)
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .id((self.id, 10usize))
                    .h_full()
                    .when(wide, |el| el.flex_1().min_w_0())
                    .pl(px(if wide { 14. } else { 15. }))
                    .pr(px(11.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .rounded_l_full()
                    .cursor_pointer()
                    .hover(move |s| s.bg(soft))
                    .child(mark(choice, &palette, palette.on_ink))
                    .child(div().truncate().child(label(choice)))
                    .on_click(cx.listener(move |this, _, _, cx| this.pick(choice, cx))),
            )
            .child(div().w(px(1.)).h(px(height * 0.45)).bg(Hsla {
                a: 0.22,
                ..palette.on_ink
            }))
            .child(
                div()
                    .id((self.id, 11usize))
                    .h_full()
                    .pl(px(8.))
                    .pr(px(11.))
                    .flex()
                    .items_center()
                    .rounded_r_full()
                    .cursor_pointer()
                    .hover(move |s| s.bg(soft))
                    .tooltip(move |_, cx| {
                        crate::ui::Tooltip::new(&dark, tr::documents::start::more()).view(cx)
                    })
                    .child(
                        svg()
                            .path("icons/chevron-down.svg")
                            .size(px(12.))
                            .text_color(palette.on_ink),
                    )
                    .on_click(cx.listener(move |this, e: &gpui::ClickEvent, _, cx| {
                        let at = e.position();
                        this.menu = if this.menu.is_some() {
                            None
                        } else {
                            Some(point(at.x - px(250.), at.y + px(16.)))
                        };
                        cx.notify();
                    })),
            )
            .children(menu)
    }
}

#[cfg(debug_assertions)]
impl StartButton {
    pub fn debug_open_menu(&mut self, at: Point<Pixels>, cx: &mut Context<Self>) {
        self.menu = Some(at);
        cx.notify();
    }
}
