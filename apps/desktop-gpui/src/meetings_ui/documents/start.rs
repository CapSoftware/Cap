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
    /// The menu asked once to start new notes while a meeting records: the
    /// next pick of that row replaces the meeting.
    confirm_replace: bool,
    /// Ticks the "Recording 2:47" clock once a second while one records.
    ticker: Option<gpui::Task<()>>,
    _subscription: Option<gpui::Subscription>,
}

/// The meeting recording right now and for how long: while there is one the
/// pill shows it instead of offering to start, so a click never quietly
/// ends it.
fn recording(cx: &gpui::App) -> Option<(String, u64)> {
    crate::meetings_ui::live::active(cx)
        .filter(|active| {
            matches!(
                active.state,
                crate::meetings::ActiveState::Starting | crate::meetings::ActiveState::Recording
            )
        })
        .map(|active| (active.doc_id, active.started.elapsed().as_secs()))
}

pub fn recording_label(elapsed_secs: u64) -> String {
    tr::documents::start::recording(crate::meetings_ui::live::model::elapsed(elapsed_secs))
}

/// What picking a row of the menu does: while a meeting records, starting
/// new notes ends it, so the first pick only asks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuPick {
    Start(StartChoice),
    Confirm,
}

pub fn menu_pick(choice: StartChoice, recording: bool, confirmed: bool) -> MenuPick {
    if choice == StartChoice::Record && recording && !confirmed {
        MenuPick::Confirm
    } else {
        MenuPick::Start(choice)
    }
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
                    if matches!(
                        event,
                        crate::meetings::MeetingEvent::SettingsChanged
                            | crate::meetings::MeetingEvent::RecordingStarted { .. }
                            | crate::meetings::MeetingEvent::RecordingStopped { .. }
                            | crate::meetings::MeetingEvent::ActiveChanged
                    ) {
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
            confirm_replace: false,
            ticker: None,
            _subscription: subscription,
        }
    }

    pub fn set_theme(&mut self, theme: &Theme, cx: &mut Context<Self>) {
        self.palette = Palette::new(theme);
        cx.notify();
    }

    pub fn dismiss(&mut self, cx: &mut Context<Self>) -> bool {
        self.confirm_replace = false;
        if self.menu.take().is_some() {
            cx.notify();
            return true;
        }
        false
    }

    fn pick(&mut self, choice: StartChoice, cx: &mut Context<Self>) {
        self.menu = None;
        self.confirm_replace = false;
        cx.emit(StartEvent::Start(choice));
        cx.notify();
    }

    pub fn pick_from_menu(&mut self, choice: StartChoice, recording: bool, cx: &mut Context<Self>) {
        match menu_pick(choice, recording, self.confirm_replace) {
            MenuPick::Confirm => {
                self.confirm_replace = true;
                cx.notify();
            }
            MenuPick::Start(choice) => self.pick(choice, cx),
        }
    }

    fn tick_while_recording(&mut self, recording: bool, cx: &mut Context<Self>) {
        if !recording {
            self.ticker = None;
            return;
        }
        if self.ticker.is_none() {
            self.ticker = Some(cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor()
                        .timer(std::time::Duration::from_secs(1))
                        .await;
                    if this.update(cx, |_, cx| cx.notify()).is_err() {
                        break;
                    }
                }
            }));
        }
    }

    fn render_menu(
        &self,
        at: Point<Pixels>,
        recording: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = self.palette;
        let now = current(cx);
        let confirm = self.confirm_replace;
        let row = |choice: StartChoice, index: usize| {
            let replaces = recording && choice == StartChoice::Record;
            let (title, about) = match (replaces, confirm) {
                (false, _) => (label(choice).to_string(), detail(choice).to_string()),
                (true, false) => (
                    tr::documents::start::replace_label().to_string(),
                    tr::documents::start::replace_detail().to_string(),
                ),
                (true, true) => (
                    tr::documents::start::replace_confirm().to_string(),
                    tr::documents::start::replace_detail().to_string(),
                ),
            };
            let title_color = if replaces && confirm {
                palette.live
            } else {
                palette.text
            };
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
                                .text_color(title_color)
                                .child(title),
                        )
                        .child(
                            div()
                                .text_size(px(12.))
                                .text_color(palette.muted)
                                .child(about),
                        ),
                )
                .child(
                    div()
                        .w(px(14.))
                        .flex_shrink_0()
                        .when(now == choice && !replaces, |el| {
                            el.child(
                                svg()
                                    .path("icons/check.svg")
                                    .size(px(12.))
                                    .text_color(palette.muted),
                            )
                        }),
                )
                .on_click(
                    cx.listener(move |this, _, _, cx| this.pick_from_menu(choice, recording, cx)),
                )
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
                    this.confirm_replace = false;
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
        let live = recording(cx);
        self.tick_while_recording(live.is_some(), cx);
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
        let menu = self.menu.map(|at| self.render_menu(at, live.is_some(), cx));
        let (main_mark, main_label) = match &live {
            Some((_, secs)) => (
                mark(StartChoice::Record, &palette, palette.on_ink),
                recording_label(*secs),
            ),
            None => (
                mark(choice, &palette, palette.on_ink),
                label(choice).to_string(),
            ),
        };
        let open_doc = live.map(|(doc, _)| doc);
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
                    .child(main_mark)
                    .child(div().truncate().child(main_label))
                    .on_click(cx.listener(move |this, _, _, cx| match &open_doc {
                        // The meeting recording now: open it.
                        Some(doc) => {
                            let doc = doc.clone();
                            this.menu = None;
                            cx.defer(move |cx| crate::meetings_ui::documents::open(Some(doc), cx));
                        }
                        None => this.pick(choice, cx),
                    })),
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
                        this.confirm_replace = false;
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
