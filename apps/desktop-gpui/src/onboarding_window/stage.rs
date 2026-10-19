//! The permissions step: one permission at a time on the right, the checklist
//! on the left, in the paper-and-ink look of Cap's Chrome extension pages.
//!
//! Only presentation and focus live here. Requests, polling and the
//! grant/denied classification are still `OnboardingWindow::act`, the poll
//! task and [`PermissionsState`](crate::permissions_ui::PermissionsState).

use std::time::{Duration, Instant};

use gpui::{
    AnyElement, Context, Div, FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement,
    SharedString, StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder, px, rgb,
    rgba,
};

use super::OnboardingWindow;
use crate::doodle::{self, Doodle, Palette};
use crate::onboarding_doodles as art;
use crate::permissions::{self, OSPermission, OSPermissionStatus};
use crate::permissions_ui::RowAction;
use crate::theme::Theme;

/// How long a freshly granted permission stays on stage, check drawn, before
/// the next one slides in.
const ADVANCE_AFTER: Duration = Duration::from_millis(1400);
const LIST_W: f32 = 296.;
const STAGE_W: f32 = 420.;

#[derive(Clone, Copy)]
pub struct Paper {
    pub bg: Hsla,
    pub card: Hsla,
    pub ink: Hsla,
    pub soft: Hsla,
    pub accent: Hsla,
    pub red: Hsla,
    pub green: Hsla,
    pub track: Hsla,
}

impl Paper {
    pub fn new(theme: &Theme) -> Self {
        if theme.is_dark() {
            Self {
                bg: rgb(0x18181b).into(),
                card: rgba(0xffffff0d).into(),
                ink: rgb(0xf2f2f3).into(),
                soft: rgb(0x8e8e96).into(),
                accent: rgb(0x4d8dff).into(),
                red: rgb(0xff6369).into(),
                green: rgb(0x3dd68c).into(),
                track: rgb(0x3a3a40).into(),
            }
        } else {
            Self {
                bg: rgb(0xfbfaf7).into(),
                card: rgba(0xffffffa6).into(),
                ink: rgb(0x20242c).into(),
                soft: rgb(0x8b8f98).into(),
                accent: rgb(0x4785ff).into(),
                red: rgb(0xe5484d).into(),
                green: rgb(0x2f9e69).into(),
                track: rgb(0xdcdcd4).into(),
            }
        }
    }

    pub fn palette(&self) -> Palette {
        Palette {
            ink: self.ink,
            soft: self.soft,
            accent: self.accent,
            red: self.red,
            green: self.green,
            track: self.track,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Stage {
    Permission(OSPermission),
    AllSet,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mark {
    Pending,
    Active,
    Granted,
    Skipped,
}

pub(super) struct StageState {
    /// Pinned by a row click, or by a grant landing on the permission on
    /// stage (held for [`ADVANCE_AFTER`]). `None` follows the first
    /// permission still to do.
    focused: Option<OSPermission>,
    skipped: Vec<OSPermission>,
    pub(super) waiting_on: Option<OSPermission>,
    shown: Option<(Stage, bool)>,
    shown_at: Instant,
    marks: [(Mark, Instant); 4],
    granted: [bool; 4],
    page_at: Instant,
    /// Screen Recording was already granted when Cap launched. A grant that
    /// lands mid-session only reaches capture after a restart.
    screen_at_launch: bool,
    advance: Option<gpui::Task<()>>,
}

impl StageState {
    pub(super) fn new(granted: [bool; 4]) -> Self {
        let now = Instant::now();
        Self {
            focused: None,
            skipped: Vec::new(),
            waiting_on: None,
            shown: None,
            shown_at: now,
            marks: [(Mark::Pending, now); 4],
            granted,
            page_at: now,
            screen_at_launch: granted[0],
            advance: None,
        }
    }
}

fn index(permission: OSPermission) -> usize {
    OSPermission::ALL
        .iter()
        .position(|&candidate| candidate == permission)
        .unwrap_or(0)
}

struct Copy {
    title: &'static str,
    body: &'static str,
    done_title: &'static str,
    done_body: &'static str,
    allow: &'static str,
    doodle: &'static Doodle,
}

fn copy_for(permission: OSPermission) -> Copy {
    match permission {
        OSPermission::ScreenRecording => Copy {
            title: "Let Cap see your screen",
            body: "Screen Recording lets Cap capture your displays, windows and system audio.",
            done_title: "Screen recording is on",
            done_body: "Cap can capture your screen.",
            allow: "Allow screen recording",
            doodle: &art::SCREEN,
        },
        OSPermission::Accessibility => Copy {
            title: "Let Cap follow your cursor",
            body: "Accessibility lets Cap see your clicks and cursor, on this Mac only, so auto zoom knows where to look.",
            done_title: "Accessibility is on",
            done_body: "Auto zoom can follow your clicks.",
            allow: "Allow accessibility",
            doodle: &art::CURSOR,
        },
        OSPermission::Microphone => Copy {
            title: "Let Cap hear you",
            body: "Add your voice to your recordings. You can skip this and turn it on later.",
            done_title: "Microphone is on",
            done_body: "Your voice can be in your recordings.",
            allow: "Allow microphone",
            doodle: &art::MICROPHONE,
        },
        OSPermission::Camera => Copy {
            title: "Let Cap see you",
            body: "Show yourself in a corner of your recordings. Skip it if you don't need it.",
            done_title: "Camera is on",
            done_body: "You can add your camera to any recording.",
            allow: "Allow camera",
            doodle: &art::CAMERA,
        },
    }
}

impl OnboardingWindow {
    pub(super) fn needs_relaunch(&self) -> bool {
        !self.stage.screen_at_launch
            && self.state.status(OSPermission::ScreenRecording).permitted()
            && self.state.status(OSPermission::ScreenRecording) != OSPermissionStatus::NotNeeded
    }

    fn is_skipped(&self, permission: OSPermission) -> bool {
        self.stage.skipped.contains(&permission)
    }

    pub(super) fn current_stage(&self) -> Stage {
        let shown: Vec<(OSPermission, OSPermissionStatus)> = self.state.shown().collect();
        if let Some(focused) = self.stage.focused
            && shown.iter().any(|(permission, _)| *permission == focused)
        {
            return Stage::Permission(focused);
        }
        shown
            .iter()
            .find(|(permission, status)| !status.permitted() && !self.is_skipped(*permission))
            .map(|(permission, _)| Stage::Permission(*permission))
            .unwrap_or(Stage::AllSet)
    }

    /// Reconcile focus, marks and entrance clocks with the latest grants.
    /// Called from `render`, so every path that folds in a sweep is covered.
    pub(super) fn sync_stage(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let now = Instant::now();
        let granted: [bool; 4] =
            std::array::from_fn(|i| self.state.status(OSPermission::ALL[i]).permitted());
        for (i, &permission) in OSPermission::ALL.iter().enumerate() {
            if !granted[i] || self.stage.granted[i] {
                continue;
            }
            if self.stage.waiting_on == Some(permission) {
                self.stage.waiting_on = None;
            }
            // The grant already moved `current_stage` on to the next missing
            // permission, so the card the user was looking at is the shown one.
            let on_screen = self.stage.shown.map(|(stage, _)| stage);
            if on_screen == Some(Stage::Permission(permission))
                || self.current_stage() == Stage::Permission(permission)
            {
                self.stage.focused = Some(permission);
                self.stage.advance = Some(cx.spawn_in(window, async move |this, cx| {
                    cx.background_executor().timer(ADVANCE_AFTER).await;
                    this.update(cx, |this, cx| {
                        if this.stage.focused == Some(permission) {
                            this.stage.focused = None;
                            cx.notify();
                        }
                        this.stage.advance = None;
                    })
                    .ok();
                }));
            }
        }
        self.stage.granted = granted;

        let stage = self.current_stage();
        let stage_done = match stage {
            Stage::Permission(permission) => granted[index(permission)],
            Stage::AllSet => true,
        };
        if self.stage.shown != Some((stage, stage_done)) {
            if self
                .stage
                .shown
                .is_none_or(|(previous, _)| previous != stage)
            {
                self.stage.shown_at = now;
            }
            self.stage.shown = Some((stage, stage_done));
        }
        if let Stage::Permission(on_stage) = stage
            && self
                .stage
                .waiting_on
                .is_some_and(|waiting| waiting != on_stage)
        {
            self.stage.waiting_on = None;
        }
        if let Some(waiting) = self.stage.waiting_on
            && !waiting.required()
            && self.pending.is_none()
            && self.state.status(waiting) == OSPermissionStatus::Denied
        {
            self.stage.waiting_on = None;
        }
        for (i, &permission) in OSPermission::ALL.iter().enumerate() {
            let mark = if granted[i] {
                Mark::Granted
            } else if self.is_skipped(permission) {
                Mark::Skipped
            } else if stage == Stage::Permission(permission) {
                Mark::Active
            } else {
                Mark::Pending
            };
            if self.stage.marks[i].0 != mark {
                self.stage.marks[i] = (mark, now);
            }
        }
    }

    fn focus_permission(&mut self, permission: OSPermission, cx: &mut Context<Self>) {
        self.stage.advance = None;
        self.stage.focused = Some(permission);
        self.stage.skipped.retain(|&skipped| skipped != permission);
        cx.notify();
    }

    fn skip_permission(&mut self, permission: OSPermission, cx: &mut Context<Self>) {
        if permission.required() {
            return;
        }
        self.stage.advance = None;
        if !self.is_skipped(permission) {
            self.stage.skipped.push(permission);
        }
        if self.stage.focused == Some(permission) {
            self.stage.focused = None;
        }
        if self.stage.waiting_on == Some(permission) {
            self.stage.waiting_on = None;
        }
        cx.notify();
    }

    pub(super) fn render_permissions(&self, cx: &mut Context<Self>) -> AnyElement {
        let paper = Paper::new(&self.theme);
        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_center()
            .min_h_full()
            .px(px(40.))
            .py(px(24.))
            .gap(px(44.))
            .child(self.render_checklist(&paper, cx))
            .child(self.render_stage(&paper, cx))
            .into_any_element()
    }

    fn render_checklist(&self, paper: &Paper, cx: &mut Context<Self>) -> Div {
        let (title, lede) = if self.permissions_only {
            (
                "Cap needs a permission back",
                "Something was switched off in System Settings. Turn it back on to keep recording.",
            )
        } else {
            (
                "Let's get Cap ready",
                "macOS asks you to OK a few things first. It only takes a minute.",
            )
        };
        let stage = self.current_stage();
        div()
            .flex()
            .flex_col()
            .w(px(LIST_W))
            .flex_none()
            .child(
                div()
                    .text_size(px(28.))
                    .line_height(px(34.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(paper.ink)
                    .child(title),
            )
            .child(div().mt(px(2.)).child(doodle::doodle(
                &art::UNDERLINE,
                paper.palette(),
                self.stage.page_at,
                !self.animated,
                132.,
                12.,
            )))
            .child(
                div()
                    .mt(px(10.))
                    .text_size(px(14.))
                    .line_height(px(21.))
                    .font_weight(FontWeight::NORMAL)
                    .text_color(paper.soft)
                    .child(lede),
            )
            .child(div().mt(px(26.)).flex().flex_col().gap(px(6.)).children(
                self.state.shown().map(|(permission, status)| {
                    self.render_check_row(
                        paper,
                        permission,
                        status,
                        stage == Stage::Permission(permission),
                        cx,
                    )
                }),
            ))
    }

    fn render_check_row(
        &self,
        paper: &Paper,
        permission: OSPermission,
        status: OSPermissionStatus,
        active: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (mark, mark_at) = self.stage.marks[index(permission)];
        let doodle = match mark {
            Mark::Pending => &art::MARK_PENDING,
            Mark::Active => &art::MARK_ACTIVE,
            Mark::Granted => &art::MARK_GRANTED,
            Mark::Skipped => &art::MARK_SKIPPED,
        };
        let (caption, caption_color) = if status.permitted() {
            ("Allowed", paper.green)
        } else if self.is_skipped(permission) {
            ("Skipped for now", paper.soft)
        } else if status == OSPermissionStatus::Denied {
            ("Off in System Settings", paper.red)
        } else if permission.required() {
            ("Required", paper.soft)
        } else {
            ("Optional", paper.soft)
        };
        let paper = *paper;
        div()
            .id(SharedString::from(format!(
                "perm-row-{}",
                permission.label()
            )))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(12.))
            .h(px(56.))
            .px(px(12.))
            .rounded(px(14.))
            .border(px(1.5))
            .border_color(if active {
                paper.ink
            } else {
                gpui::transparent_black()
            })
            .when(active, |row| row.bg(paper.card))
            .when(!active, |row| {
                row.cursor_pointer()
                    .hover(move |row| row.bg(paper.card))
                    .on_click(
                        cx.listener(move |this, _, _, cx| this.focus_permission(permission, cx)),
                    )
            })
            .child(doodle::doodle(
                doodle,
                paper.palette(),
                mark_at,
                !self.animated,
                30.,
                30.,
            ))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(1.))
                    .child(
                        div()
                            .text_size(px(14.))
                            .line_height(px(18.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(paper.ink)
                            .child(permission.label()),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .line_height(px(16.))
                            .font_weight(FontWeight::NORMAL)
                            .text_color(caption_color)
                            .child(caption),
                    ),
            )
            .into_any_element()
    }

    fn render_stage(&self, paper: &Paper, cx: &mut Context<Self>) -> AnyElement {
        let stage = self.current_stage();
        let shown_at = self.stage.shown_at;
        let still = !self.animated;
        let card = div()
            .id("perm-stage")
            .flex()
            .flex_col()
            .items_center()
            .w(px(STAGE_W))
            .flex_none()
            .min_h(px(420.))
            .justify_center()
            .px(px(36.))
            .py(px(30.))
            .rounded(px(24.))
            .border(px(1.5))
            .border_color(paper.track)
            .bg(paper.card);

        let card = match stage {
            Stage::AllSet if self.needs_relaunch() => card
                .child(doodle::doodle(
                    &art::ALL_SET,
                    paper.palette(),
                    shown_at,
                    still,
                    168.,
                    146.,
                ))
                .child(stage_title(paper, "One restart and you're set"))
                .child(stage_body(
                    paper,
                    "macOS turns on screen recording once Cap restarts. You'll pick up right here.",
                ))
                .child(div().mt(px(24.)).child(paper_button(
                    paper,
                    "perm-relaunch-done",
                    "Relaunch Cap",
                    true,
                    true,
                    cx.listener(|_, _, _, cx| permissions::relaunch(cx)),
                ))),
            Stage::AllSet => card
                .child(doodle::doodle(
                    &art::ALL_SET,
                    paper.palette(),
                    shown_at,
                    still,
                    168.,
                    146.,
                ))
                .child(stage_title(paper, "You're all set"))
                .child(stage_body(
                    paper,
                    if self.permissions_only {
                        "Thanks. Cap can record again."
                    } else {
                        "Cap has everything it needs. Next, a quick look at what it can do."
                    },
                )),
            Stage::Permission(permission) => {
                let copy = copy_for(permission);
                let status = self.state.status(permission);
                let granted = status.permitted();
                let card = card
                    .child(doodle::doodle(
                        copy.doodle,
                        paper.palette(),
                        shown_at,
                        still,
                        168.,
                        146.,
                    ))
                    .child(stage_title(
                        paper,
                        if granted {
                            copy.done_title
                        } else if self.stage.waiting_on == Some(permission) && permission.required()
                        {
                            "Switch Cap on in System Settings"
                        } else {
                            copy.title
                        },
                    ));
                if granted {
                    let done_body = if permission == OSPermission::ScreenRecording
                        && self.needs_relaunch()
                    {
                        "macOS applies it after Cap restarts. You can do that once you're done here."
                    } else {
                        copy.done_body
                    };
                    card.child(stage_body(paper, done_body)).child(allowed_pill(
                        paper,
                        self.stage.marks[index(permission)].1,
                        still,
                    ))
                } else {
                    self.render_stage_actions(card, paper, permission, status, &copy, cx)
                }
            }
        };

        card.into_any_element()
    }

    fn render_stage_actions(
        &self,
        card: gpui::Stateful<Div>,
        paper: &Paper,
        permission: OSPermission,
        status: OSPermissionStatus,
        copy: &Copy,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<Div> {
        let action = self.state.action(permission);
        let busy = self.pending.is_some();
        let waiting = self.stage.waiting_on == Some(permission);
        let guided = crate::permission_guide::eligible(permission);
        let waiting_required = waiting && permission.required();
        let body = if waiting_required && guided {
            "Drag Cap from the panel under System Settings into the list. Already listed? Just switch it on."
        } else if waiting_required {
            "Find Cap in the list and switch it on. If macOS asked first, choose Open System Settings."
        } else if status == OSPermissionStatus::Denied && !permission.required() {
            "It was turned off earlier, so switch Cap on in System Settings. Or skip it for now."
        } else if action == Some(RowAction::OpenSettings) && permission.required() {
            "Open System Settings, find Cap in the list and switch it on."
        } else {
            copy.body
        };
        let primary_label = if waiting_required {
            "Open System Settings again"
        } else {
            match action {
                Some(RowAction::OpenSettings) => "Open System Settings",
                _ => copy.allow,
            }
        };
        let paper_copy = *paper;
        let card = card.child(stage_body(paper, body)).child(
            div()
                .mt(px(24.))
                .flex()
                .flex_row()
                .items_center()
                .justify_center()
                .gap(px(10.))
                .child(paper_button(
                    paper,
                    SharedString::from(format!("perm-action-{}", permission.label())),
                    primary_label,
                    true,
                    !busy,
                    cx.listener(move |this, _, window, cx| this.act(permission, window, cx)),
                ))
                .when(!permission.required(), |row| {
                    row.child(paper_button(
                        &paper_copy,
                        SharedString::from(format!("perm-skip-{}", permission.label())),
                        "Skip for now",
                        false,
                        true,
                        cx.listener(move |this, _, _, cx| this.skip_permission(permission, cx)),
                    ))
                }),
        );

        // The AV request returned without macOS ever showing its prompt
        // (still undetermined once the request settled): say so and offer
        // the pane, instead of waiting on a dialog that is not there.
        let no_prompt = waiting
            && !permission.required()
            && !busy
            && !self.media_request_pending
            && status == OSPermissionStatus::NotDetermined;
        let card = if no_prompt {
            card.child(
                div()
                    .mt(px(18.))
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(10.))
                    .child(
                        div()
                            .text_size(px(12.))
                            .font_weight(FontWeight::NORMAL)
                            .text_color(paper.soft)
                            .child("No prompt showed up? Switch Cap on in System Settings."),
                    )
                    .child(paper_button(
                        paper,
                        SharedString::from(format!("perm-settings-{}", permission.label())),
                        "Open System Settings",
                        false,
                        true,
                        cx.listener(move |this, _, _, cx| {
                            this.state.note_settings_opened(permission);
                            permissions::open_permission_settings(permission);
                            cx.notify();
                        }),
                    )),
            )
        } else if waiting {
            let hint = if permission.required() || action == Some(RowAction::OpenSettings) {
                "Waiting for System Settings"
            } else {
                "Choose Allow in the macOS prompt"
            };
            card.child(
                div()
                    .mt(px(18.))
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(4.))
                    .child(doodle::doodle(
                        &art::WAITING,
                        paper.palette(),
                        self.stage.shown_at,
                        !self.animated,
                        150.,
                        16.,
                    ))
                    .child(
                        div()
                            .text_size(px(12.))
                            .font_weight(FontWeight::NORMAL)
                            .text_color(paper.soft)
                            .child(hint),
                    ),
            )
        } else {
            card
        };

        if permission == OSPermission::ScreenRecording && waiting && self.state.relaunch_hint() {
            card.child(
                div()
                    .mt(px(18.))
                    .w_full()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(12.))
                    .px(px(14.))
                    .py(px(10.))
                    .rounded(px(14.))
                    .border(px(1.5))
                    .border_color(paper.track)
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_size(px(12.))
                            .line_height(px(17.))
                            .font_weight(FontWeight::NORMAL)
                            .text_color(paper.soft)
                            .child("Switched on but still waiting? Restart Cap to apply it."),
                    )
                    .child(paper_button(
                        paper,
                        "perm-relaunch",
                        "Relaunch",
                        false,
                        true,
                        cx.listener(|_, _, _, cx| permissions::relaunch(cx)),
                    )),
            )
        } else {
            card
        }
    }
}

fn stage_title(paper: &Paper, title: &'static str) -> Div {
    div()
        .mt(px(22.))
        .text_size(px(22.))
        .line_height(px(28.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(paper.ink)
        .text_center()
        .child(title)
}

fn stage_body(paper: &Paper, body: &'static str) -> Div {
    div()
        .mt(px(8.))
        .max_w(px(320.))
        .text_size(px(14.))
        .line_height(px(21.))
        .font_weight(FontWeight::NORMAL)
        .text_color(paper.soft)
        .text_center()
        .child(body)
}

fn allowed_pill(paper: &Paper, shown_at: Instant, still: bool) -> Div {
    div()
        .mt(px(24.))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.))
        .h(px(42.))
        .px(px(18.))
        .rounded_full()
        .border(px(1.5))
        .border_color(paper.green)
        .text_size(px(14.))
        .text_color(paper.green)
        .child(doodle::doodle(
            &art::MARK_GRANTED,
            paper.palette(),
            shown_at,
            still,
            22.,
            22.,
        ))
        .child("Allowed")
}

/// The extension's `.cta`: an ink pill. Primary is filled; secondary is the
/// outlined `ghost`.
pub(super) fn paper_button(
    paper: &Paper,
    id: impl Into<gpui::ElementId>,
    label: &'static str,
    primary: bool,
    enabled: bool,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> gpui::Stateful<Div> {
    let paper = *paper;
    let (bg, fg, border) = if primary {
        (paper.ink, paper.bg, paper.ink)
    } else {
        (gpui::transparent_black(), paper.ink, paper.track)
    };
    div()
        .id(id.into())
        .flex()
        .items_center()
        .justify_center()
        .h(px(42.))
        .px(px(22.))
        .rounded_full()
        .border(px(1.5))
        .border_color(border)
        .bg(bg)
        .text_size(px(14.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(fg)
        .child(label)
        .when(!enabled, |button| button.opacity(0.45))
        .when(enabled, |button| {
            button
                .cursor_pointer()
                .hover(move |button| {
                    if primary {
                        button.opacity(0.88)
                    } else {
                        button.border_color(paper.soft)
                    }
                })
                .on_click(on_click)
        })
}
