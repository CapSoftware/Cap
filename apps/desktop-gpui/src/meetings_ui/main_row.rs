//! The main window's one meeting row. It uses the device row's look and is
//! only there while a meeting is being recorded, or while one is about to
//! start or a call is detected. Every other time the main window is exactly
//! as it is without Notes.

use chrono::Utc;
use gpui::{
    Context, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement, Styled,
    Subscription, Task, div, px,
};

use crate::i18n::tr;
use crate::main_window::{MainWindow, PillState};
use crate::meetings::{StartSource, StopReason};
use crate::meetings_ui::live::{self, Live, LiveEvent, model};

pub struct MeetingRow {
    tick: Option<Task<()>>,
    _live: Option<Subscription>,
}

impl MeetingRow {
    pub fn new(cx: &mut Context<MainWindow>) -> Self {
        let subscription = Live::global(cx).map(|live| {
            cx.subscribe(&live, |this, _, event, cx| {
                if matches!(event, LiveEvent::Changed) {
                    this.rearm_meeting_row(cx);
                    cx.notify();
                }
            })
        });
        // The first arm runs once the window exists, so a meeting already
        // under way when Cap opens is on the row from the start.
        let first = cx.spawn(async move |this, cx| {
            this.update(cx, |this, cx| {
                this.rearm_meeting_row(cx);
                cx.notify();
            })
            .ok();
        });
        Self {
            tick: Some(first),
            _live: subscription,
        }
    }
}

fn current(cx: &gpui::App) -> (Option<model::MainRow>, Option<std::time::Duration>) {
    let now = Utc::now();
    let detection_on = live::ready(cx);
    let events = if detection_on {
        live::events(cx)
    } else {
        Vec::new()
    };
    let active = live::active(cx);
    let row = model::main_row(
        active.as_ref(),
        &live::calls(cx),
        &events,
        detection_on,
        now,
    );
    let wake = model::main_row_wake(row.as_ref(), &events, detection_on, now);
    (row, wake)
}

impl MainWindow {
    /// Re-render when the row's text changes by itself: once a second while
    /// recording, at minute boundaries while a meeting is close, and when the
    /// next meeting comes within reach. Nothing runs when there is no row and
    /// no meeting ahead.
    pub(crate) fn rearm_meeting_row(&mut self, cx: &mut Context<Self>) {
        let (_, wake) = current(cx);
        self.meeting_row.tick = wake.map(|wake| {
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(wake).await;
                this.update(cx, |this, cx| {
                    this.rearm_meeting_row(cx);
                    cx.notify();
                })
                .ok();
            })
        });
    }

    pub(crate) fn render_meeting_row(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let row = current(cx).0?;
        let (label, pill, recording) = match &row {
            model::MainRow::Recording { title, secs } => {
                let title = if title.is_empty() {
                    tr::meeting::row::untitled().to_string()
                } else {
                    model::short_title(title, 32)
                };
                (
                    tr::meeting::row::recording(title, model::elapsed(*secs)),
                    PillState::Label(tr::meeting::row::stop()),
                    true,
                )
            }
            model::MainRow::Offer {
                title,
                starts_in_minutes,
                ..
            } => {
                let title = if title.is_empty() {
                    tr::meeting::prompt::upcoming().to_string()
                } else {
                    model::short_title(title, 32)
                };
                (
                    match starts_in_minutes {
                        Some(minutes) => tr::meeting::row::starts_in(title, *minutes),
                        None => tr::meeting::row::now(title),
                    },
                    PillState::Accent(tr::meeting::row::record()),
                    false,
                )
            }
        };
        let source = match &row {
            model::MainRow::Offer {
                event_id: Some(id), ..
            } => StartSource::Event(id.clone()),
            _ => StartSource::Manual,
        };
        let pill_source = source.clone();
        Some(
            div().flex().flex_col().child(
                self.render_device_row("meeting-row", "icons/notebook.svg", label, pill, None, cx)
                    .on_click(cx.listener(move |_, _, _, cx| {
                        if recording {
                            cx.defer(|cx| live::open_document(None, cx));
                        } else {
                            let source = source.clone();
                            cx.defer(move |cx| {
                                crate::meetings_ui::documents::start_listening(source, cx)
                            });
                        }
                    }))
                    .child(
                        div()
                            .id("meeting-row-action")
                            .absolute()
                            .right(px(6.))
                            .top_0()
                            .bottom_0()
                            .w(px(64.))
                            .on_click(cx.listener(move |_, _, _, cx| {
                                cx.stop_propagation();
                                if recording {
                                    cx.defer(|cx| live::stop(StopReason::User, cx));
                                } else {
                                    let source = pill_source.clone();
                                    cx.defer(move |cx| {
                                        crate::meetings_ui::documents::start_listening(source, cx)
                                    });
                                }
                            })),
                    ),
            )
            .into_any_element(),
        )
    }
}
