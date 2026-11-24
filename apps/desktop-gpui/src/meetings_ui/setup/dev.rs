use std::time::Duration;

use gpui::App;

use super::{Ask, Perm, SetupMenu, SetupWindow, Step};
use crate::settings_window::Page;

pub fn run_from_env(cx: &mut App) {
    if let Ok(spec) = std::env::var("CAP_GPUI_AUTO_MEETING_SETUP")
        && !spec.is_empty()
    {
        let tour: Vec<Step> = if spec == "tour" {
            Step::ALL.to_vec()
        } else {
            spec.split(',').filter_map(Step::from_slug).collect()
        };
        cx.spawn(async move |cx| {
            cx.background_executor()
                .timer(Duration::from_millis(600))
                .await;
            for (index, step) in tour.into_iter().enumerate() {
                if index > 0 {
                    cx.background_executor()
                        .timer(Duration::from_millis(2000))
                        .await;
                }
                cx.update(|cx| super::open_at(Some(step), cx));
                cx.background_executor()
                    .timer(Duration::from_millis(300))
                    .await;
                cx.update(apply_setup_state);
            }
        })
        .detach();
    }

    let scrolls: Vec<f32> = std::env::var("CAP_GPUI_AUTO_MEETING_SETTINGS_SCROLL")
        .unwrap_or_default()
        .split(',')
        .filter_map(|v| v.trim().parse::<f32>().ok())
        .collect();
    let open = std::env::var("CAP_GPUI_AUTO_MEETING_SETTINGS_OPEN").unwrap_or_default();
    if scrolls.is_empty() && open.is_empty() {
        return;
    }
    let steps: Vec<Option<f32>> = if scrolls.is_empty() {
        vec![None]
    } else {
        scrolls.into_iter().map(Some).collect()
    };
    cx.spawn(async move |cx| {
        cx.background_executor()
            .timer(Duration::from_millis(2000))
            .await;
        for (index, scroll) in steps.into_iter().enumerate() {
            if index > 0 {
                cx.background_executor()
                    .timer(Duration::from_millis(2000))
                    .await;
            }
            let open = open.clone();
            cx.update(|cx| apply(scroll, &open, cx));
        }
    })
    .detach();
}

fn apply(scroll: Option<f32>, open: &str, cx: &mut App) {
    {
        {
            let Some(handle) = cx
                .try_global::<crate::app_windows::AppWindows>()
                .and_then(|w| w.settings)
            else {
                tracing::info!("meeting settings hook: no settings window");
                return;
            };
            tracing::info!(?scroll, "meeting settings hook");
            handle
                .update(cx, |view, window, cx| {
                    if view.page != Page::Meetings {
                        view.set_page(Page::Meetings, window, cx);
                    }
                    let state = &mut view.pages.meetings;
                    let mut disconnect = false;
                    for flag in open.split(',') {
                        match flag.trim() {
                            "help" => state.help_open = true,
                            "link" => state.link_form = true,
                            "system" => state.expanded_system = true,
                            "disconnect" => disconnect = true,
                            _ => {}
                        }
                    }
                    // `disconnect`: the first calendar account's Disconnect.
                    let account = disconnect
                        .then(|| crate::meetings::Meetings::try_global(cx))
                        .flatten()
                        .and_then(|meetings| {
                            meetings
                                .read(cx)
                                .calendar_sources()
                                .iter()
                                .find(|source| {
                                    crate::meetings_ui::settings::accounts::provider_of(
                                        source.config.kind(),
                                    )
                                    .is_some()
                                })
                                .map(|source| source.id.clone())
                        });
                    if let Some(id) = account {
                        tracing::info!("meeting settings hook: disconnect");
                        view.meetings_remove_calendar(&id, cx);
                    }
                    if let Some(y) = scroll {
                        view.page_scroll
                            .set_offset(gpui::point(gpui::px(0.), gpui::px(-y)));
                    }
                    cx.notify();
                    window.refresh();
                })
                .ok();
        }
    }
}

/// `CAP_GPUI_AUTO_MEETING_SETUP_STATE`: comma-separated states to put the
/// setup window in once a step opens, for screenshots without clicking.
/// `focus=mic|audio|ax`, `<perm>=waiting|noanswer|settings`, `ax=skipped`,
/// `link` (the calendar link form), `menu=lead|auto`, `try_error`.
fn apply_setup_state(cx: &mut App) {
    let Ok(spec) = std::env::var("CAP_GPUI_AUTO_MEETING_SETUP_STATE") else {
        return;
    };
    let Some(handle) = super::MeetingWindows::get(cx).setup else {
        return;
    };
    handle
        .update(cx, |view, window, cx| {
            let Ok(view) = view.downcast::<SetupWindow>() else {
                return;
            };
            view.update(cx, |this, cx| {
                for token in spec.split(',').map(str::trim) {
                    let (name, value) = token.split_once('=').unwrap_or((token, ""));
                    match (name, value) {
                        ("focus", perm) => this.focused = Perm::from_slug(perm),
                        ("ax", "skipped") => this.ax_skipped = true,
                        ("link", _) => this.link_open = true,
                        ("try_error", _) => this.try_error = true,
                        ("menu", which) => {
                            let kind = if which == "auto" {
                                SetupMenu::AutoRecord
                            } else {
                                SetupMenu::Lead
                            };
                            let origin = window.viewport_size();
                            this.open_menu(
                                kind,
                                gpui::point(origin.width * 0.62, origin.height * 0.42),
                                window,
                                cx,
                            );
                        }
                        (perm, ask) => {
                            let ask = match ask {
                                "waiting" => Ask::Waiting,
                                "noanswer" => Ask::NoAnswer,
                                "settings" => Ask::InSettings,
                                _ => continue,
                            };
                            if let Some(perm) = Perm::from_slug(perm) {
                                this.asks[perm.index()] = ask;
                                this.focused = Some(perm);
                            }
                        }
                    }
                }
                cx.notify();
            });
            window.refresh();
        })
        .ok();
}
