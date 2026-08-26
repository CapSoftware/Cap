//! Onboarding -- permissions-first, simpler than the Tauri tour.
//!
//! The shipping flow is an 8-step product tour plus a startup overlay
//! (`onboarding.tsx`). This window keeps the gates that actually block the
//! app: welcome on first launch, then the macOS permission grants, then Cap.
//! Windows and Linux skip the permission step because every status there is
//! `NotNeeded`.
//!
//! The permissions step is the app's one permissions surface -- first-run
//! onboarding, the revoked-permissions revisit (`store::should_show_onboarding`
//! routes back here, the Tauri `permissionsOnly` flow), and the
//! `CAP_GPUI_AUTO_PERMISSIONS=1` harness all render it. State machine in
//! `permissions_ui`; the poll lifecycle lives here with the task that runs it:
//!
//! * armed only while the permissions step is actually visible, at 1s;
//! * every sweep is preflight-only (`permissions::check_raw`, never
//!   `SCShareableContent` -- the 82GB lesson) and runs on the background
//!   executor so the ~ms of TCC XPC stays off the main thread;
//! * the task returns the moment everything is granted, and dies with the
//!   window (`update_in` erroring out) otherwise.

use gpui::{
    Context, FocusHandle, FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement, Pixels,
    Point, Render, SharedString, StatefulInteractiveElement, Styled, Window, div,
    prelude::FluentBuilder, px, svg,
};

use crate::{
    permissions::{self, OSPermission, OSPermissionStatus},
    permissions_ui::{PermissionsState, RowAction},
    store,
    theme::Theme,
    ui,
};

pub const ONBOARDING_WIDTH: f32 = 860.;
pub const ONBOARDING_HEIGHT: f32 = 690.;
pub const TRAFFIC_LIGHTS: Point<Pixels> = Point {
    x: px(20.),
    y: px(20.),
};

/// The 1s cadence the spec allows while the surface is visible.
const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);
/// How long a system prompt gets before the required-permission fallback
/// deep-links System Settings -- the Tauri app's 10 x 200ms wait.
const REQUEST_GRACE: std::time::Duration = std::time::Duration::from_secs(2);
/// Breathing room between the last grant landing and the window closing
/// itself, so the all-green state is actually seen.
const AUTO_FINISH_DELAY: std::time::Duration = std::time::Duration::from_millis(1200);

const CARD_W: f32 = 440.;
const ROW_PAD_X: f32 = 16.;
const ROW_GAP: f32 = 16.;
const ROW_ACTION_W: f32 = 112.;
const ROW_TEXT_W: f32 = CARD_W - 2. * ROW_PAD_X - ROW_GAP - ROW_ACTION_W;
const HINT_ICON: f32 = 16.;
const HINT_BUTTON_W: f32 = 116.;
const HINT_TEXT_W: f32 = CARD_W - 2. * ROW_PAD_X - HINT_ICON - 2. * ROW_GAP - HINT_BUTTON_W;
const FOOTER_CTA_W: f32 = 144.;
const FOOTER_TEXT_W: f32 = CARD_W - FOOTER_CTA_W - 16.;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    Welcome,
    Permissions,
}

pub struct OnboardingWindow {
    theme: Theme,
    step: Step,
    state: PermissionsState,
    /// A request cycle in flight: every row action is disabled until the
    /// grace period runs out or the answer lands (Tauri's
    /// `requestingPermission`).
    pending: Option<OSPermission>,
    poll: Option<gpui::Task<()>>,
    verify: Option<gpui::Task<()>>,
    revisit: bool,
    /// `CAP_GPUI_AUTO_PERMISSIONS=1` -- suppresses the auto-finish so the
    /// harness can photograph an all-granted surface.
    forced: bool,
    focus: FocusHandle,
}

impl OnboardingWindow {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        window.on_window_should_close(cx, |_window, cx| {
            cx.defer(crate::app_windows::onboarding_closed);
            true
        });

        let forced = crate::permissions_ui::surface_forced();
        let state = PermissionsState::initial();
        let revisit = store::has_completed_onboarding() && !state.necessary_granted();
        let step = if !store::has_completed_startup() && !revisit && !forced {
            Step::Welcome
        } else {
            Step::Permissions
        };

        crate::theme::bind_window(window, cx);
        let mut this = Self {
            theme: Theme::for_window(window, cx, false),
            step,
            state,
            pending: None,
            poll: None,
            verify: None,
            revisit,
            forced,
            focus: cx.focus_handle(),
        };
        cx.observe_window_activation(window, |this: &mut Self, window, cx| {
            if window.is_window_active() && this.step == Step::Permissions {
                this.refresh_permissions(window, cx);
            }
        })
        .detach();
        this.arm_poll(window, cx);
        if this.step == Step::Permissions && this.state.all_shown_granted() && !this.forced {
            this.schedule_auto_finish(cx);
        }
        this
    }

    pub fn focus_root(&self, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
    }

    /// Start the 1s preflight poll -- only while the permissions step is
    /// visible and something is still ungranted. The task stops itself the
    /// moment everything is granted, and `update_in` failing (window gone)
    /// ends it otherwise; nothing polls behind a closed or finished surface.
    fn arm_poll(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.step != Step::Permissions || self.poll.is_some() || self.state.all_shown_granted() {
            return;
        }
        tracing::debug!("permissions poll started (1s preflight sweeps)");
        self.poll = Some(cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor().timer(POLL_INTERVAL).await;
                // Preflight-only sweep, off the main thread.
                let raw = cx
                    .background_executor()
                    .spawn(async { crate::permissions_ui::sweep_raw() })
                    .await;
                let done = match this.update_in(cx, |this, _window, cx| {
                    if this.state.apply_raw(raw) {
                        this.grants_changed(cx);
                        cx.notify();
                    }
                    this.state.all_shown_granted()
                }) {
                    Ok(done) => done,
                    Err(_) => return,
                };
                if done {
                    tracing::info!("permissions poll stopped: everything granted");
                    this.update_in(cx, |this, _window, cx| {
                        this.poll = None;
                        this.pending = None;
                        this.verify = None;
                        if !this.forced {
                            this.schedule_auto_finish(cx);
                        }
                    })
                    .ok();
                    return;
                }
            }
        }));
    }

    /// A sweep changed something: settle any in-flight request whose answer
    /// has landed.
    fn grants_changed(&mut self, _cx: &mut Context<Self>) {
        if let Some(pending) = self.pending
            && self.state.status(pending) != OSPermissionStatus::NotDetermined
        {
            self.pending = None;
            self.verify = None;
        }
    }

    fn refresh_permissions(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        cx.spawn_in(window, async move |this, cx| {
            let raw = cx
                .background_executor()
                .spawn(async { crate::permissions_ui::sweep_raw() })
                .await;

            this.update_in(cx, |this, window, cx| {
                if this.step != Step::Permissions {
                    return;
                }

                if this.state.apply_raw(raw) {
                    this.grants_changed(cx);
                    cx.notify();
                }

                if this.state.all_shown_granted() {
                    this.pending = None;
                    this.verify = None;
                    this.poll = None;
                    if !this.forced {
                        this.schedule_auto_finish(cx);
                    }
                } else {
                    this.arm_poll(window, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    /// Everything granted: close the surface on its own after a beat -- the
    /// "finish gracefully" half of the poll contract.
    fn schedule_auto_finish(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(AUTO_FINISH_DELAY).await;
            this.update(cx, |this, cx| {
                if this.step == Step::Permissions && this.state.all_shown_granted() {
                    tracing::info!("permissions all granted; finishing onboarding");
                    this.finish(cx);
                }
            })
            .ok();
        })
        .detach();
    }

    fn finish(&mut self, cx: &mut Context<Self>) {
        if !self.revisit {
            store::set_has_completed_onboarding(true);
        }
        store::set_has_completed_startup(true);
        cx.defer(|cx| {
            crate::app_windows::onboarding_finished(cx);
        });
    }

    fn continue_from_welcome(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        store::set_has_completed_startup(true);
        if cfg!(target_os = "macos") && !self.state.necessary_granted() {
            self.step = Step::Permissions;
            self.arm_poll(window, cx);
            cx.notify();
            return;
        }
        self.finish(cx);
    }

    /// The one action a row offers, per state: `notDetermined` shows the
    /// system prompt (with the Tauri fallback -- required permissions that
    /// don't land within the grace period get deep-linked to their System
    /// Settings pane, since the boolean-API prompts only ever fire once);
    /// `denied` deep-links System Settings directly.
    fn act(&mut self, permission: OSPermission, window: &mut Window, cx: &mut Context<Self>) {
        if self.pending.is_some() {
            return;
        }

        self.pending = Some(permission);
        self.verify = Some(cx.spawn_in(window, async move |this, cx| {
            let raw = cx
                .background_executor()
                .spawn(async { crate::permissions_ui::sweep_raw() })
                .await;

            let should_verify = match this.update_in(cx, |this, window, cx| {
                let action = this.state.refreshed_action(permission, raw);
                match action {
                    None => {
                        this.pending = None;
                        if this.state.all_shown_granted() {
                            this.poll = None;
                            if !this.forced {
                                this.schedule_auto_finish(cx);
                            }
                        }
                        cx.notify();
                        false
                    }
                    Some(RowAction::OpenSettings) => {
                        this.pending = None;
                        this.state.note_settings_opened(permission);
                        permissions::open_permission_settings(permission);
                        this.arm_poll(window, cx);
                        cx.notify();
                        false
                    }
                    Some(RowAction::Request) => {
                        permissions::request_permission(permission);
                        this.arm_poll(window, cx);
                        cx.notify();
                        true
                    }
                }
            }) {
                Ok(should_verify) => should_verify,
                Err(_) => return,
            };

            if !should_verify {
                return;
            }

            cx.background_executor().timer(REQUEST_GRACE).await;
            let raw = cx
                .background_executor()
                .spawn(async { crate::permissions_ui::sweep_raw() })
                .await;

            this.update_in(cx, |this, _window, cx| {
                this.state.apply_raw(raw);
                this.pending = None;
                if permission.required() && !this.state.status(permission).permitted() {
                    this.state.note_request_failed(permission);
                    this.state.note_settings_opened(permission);
                    permissions::open_permission_settings(permission);
                }
                if this.state.all_shown_granted() {
                    this.poll = None;
                    if !this.forced {
                        this.schedule_auto_finish(cx);
                    }
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// (background, border, foreground) for the granted state -- the theme
    /// has no green scale, so the success tint lives here, per appearance.
    fn success_palette(&self) -> (Hsla, Hsla, Hsla) {
        if self.theme.is_dark() {
            (
                Theme::with_alpha(gpui::rgb(0x46a758), 0.16),
                Theme::with_alpha(gpui::rgb(0x46a758), 0.38),
                gpui::rgb(0x63d489).into(),
            )
        } else {
            (
                gpui::rgb(0xebf9ef).into(),
                gpui::rgb(0xc9ebd5).into(),
                gpui::rgb(0x18794e).into(),
            )
        }
    }

    fn render_welcome(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        div()
            .flex()
            .flex_col()
            .flex_1()
            .items_center()
            .justify_center()
            .gap(px(20.))
            .px(px(48.))
            .child(
                svg()
                    .path(if theme.is_dark() {
                        "icons/logo-full.svg"
                    } else {
                        "icons/logo-full-dark.svg"
                    })
                    .h(px(36.))
                    .w(px(120.))
                    .text_color(Hsla::from(theme.gray_12)),
            )
            .child(
                div()
                    .text_size(px(28.))
                    .font_weight(FontWeight::BOLD)
                    .text_color(Hsla::from(theme.gray_12))
                    .child("Welcome to Cap"),
            )
            .child(
                div()
                    .max_w(px(420.))
                    .text_size(px(14.))
                    .text_color(Hsla::from(theme.gray_11))
                    .text_center()
                    .child(
                        "Beautiful screen recordings, instantly. Grant a couple of permissions and you are ready to capture.",
                    ),
            )
            .child(self.mode_cards())
            .child(
                ui::Button::plain(&theme, "onboarding-get-started", ui::ButtonVariant::Primary, ui::ButtonSize::Lg)
                    .label("Get Started")
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.continue_from_welcome(window, cx)
                    })),
            )
    }

    fn mode_cards(&self) -> impl IntoElement {
        let theme = self.theme;
        div().flex().flex_row().gap(px(12.)).mt(px(8.)).children(
            [
                (
                    "icons/instant.svg",
                    "Instant",
                    "Share a link the moment you stop.",
                ),
                (
                    "icons/film-cut.svg",
                    "Studio",
                    "Record locally, edit, then export.",
                ),
                (
                    "icons/screenshot.svg",
                    "Screenshot",
                    "Capture and annotate in one click.",
                ),
            ]
            .into_iter()
            .map(|(icon, title, body)| {
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .w(px(200.))
                    .p(px(16.))
                    .rounded(px(12.))
                    .bg(Hsla::from(theme.gray_2))
                    .border_1()
                    .border_color(Hsla::from(theme.gray_4))
                    .child(
                        svg()
                            .path(icon)
                            .size(px(20.))
                            .text_color(Hsla::from(theme.gray_12)),
                    )
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(theme.gray_12))
                            .child(title),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(Hsla::from(theme.gray_11))
                            .child(body),
                    )
            }),
        )
    }

    fn render_permissions(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let (granted, total) = self.state.granted_counts();
        let all_granted = self.state.all_shown_granted();
        let can_continue = self.state.necessary_granted();
        let (_, _, success_fg) = self.success_palette();

        let rows = self
            .state
            .shown()
            .map(|(permission, status)| {
                self.render_permission_row(permission, status, cx)
                    .into_any_element()
            })
            .collect::<Vec<_>>();

        let content = div()
            .flex()
            .flex_col()
            .min_h_full()
            .w_full()
            .items_center()
            .justify_center()
            .gap(px(24.))
            .py(px(24.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_none()
                    .items_center()
                    .gap(px(12.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(48.))
                            .rounded(px(16.))
                            .border_1()
                            .border_color(Hsla::from(theme.gray_4))
                            .bg(Hsla::from(theme.gray_2))
                            .child(
                                svg()
                                    .path("icons/shield.svg")
                                    .size(px(20.))
                                    .text_color(Hsla::from(theme.gray_11)),
                            ),
                    )
                    .child(
                        div()
                            .text_size(px(24.))
                            .font_weight(FontWeight::BOLD)
                            .text_color(Hsla::from(theme.gray_12))
                            .child("Permissions Required"),
                    )
                    .child(
                        div()
                            .max_w(px(CARD_W))
                            .text_size(px(14.))
                            .line_height(px(20.))
                            .text_color(Hsla::from(theme.gray_10))
                            .text_center()
                            .child(if self.revisit {
                                "Cap needs these permissions again to continue recording."
                            } else {
                                "Cap needs a few permissions to record your screen and capture audio."
                            }),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_none()
                    .w(px(CARD_W))
                    .gap(px(8.))
                    .children(rows),
            )
            .when(self.state.relaunch_hint(), |this| {
                this.child(
                    div()
                        .flex()
                        .flex_row()
                        .flex_none()
                        .items_center()
                        .gap(px(ROW_GAP))
                        .w(px(CARD_W))
                        .px(px(ROW_PAD_X))
                        .py(px(10.))
                        .rounded(px(12.))
                        .bg(Hsla::from(theme.amber_3))
                        .border_1()
                        .border_color(Hsla::from(theme.amber_6))
                        .child(
                            svg()
                                .path("icons/triangle-alert.svg")
                                .size(px(HINT_ICON))
                                .flex_none()
                                .text_color(Hsla::from(theme.amber_11)),
                        )
                        .child(
                            div()
                                .w(px(HINT_TEXT_W))
                                .flex_none()
                                .text_size(px(11.))
                                .line_height(px(15.))
                                .text_color(Hsla::from(theme.amber_11))
                                .child("Granted it in System Settings? Relaunch Cap to apply."),
                        )
                        .child(
                            div()
                                .w(px(HINT_BUTTON_W))
                                .flex_none()
                                .flex()
                                .justify_end()
                                .child(
                                    ui::Button::plain(
                                        &theme,
                                        "perm-relaunch",
                                        ui::ButtonVariant::White,
                                        ui::ButtonSize::Sm,
                                    )
                                    .radius(px(8.))
                                    .icon("icons/rotate-ccw.svg")
                                    .label("Relaunch Cap")
                                    .on_click(cx.listener(|_, _, _, _| permissions::relaunch())),
                                ),
                        ),
                )
            });

        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .items_center()
            .px(px(48.))
            .pb(px(24.))
            .child(
                div()
                    .id("onboarding-permissions-content")
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .overflow_y_scroll()
                    .child(content),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .flex_none()
                    .items_center()
                    .justify_between()
                    .w(px(CARD_W))
                    .pt(px(16.))
                    .child(
                        div()
                            .w(px(FOOTER_TEXT_W))
                            .flex_none()
                            .truncate()
                            .text_size(px(12.))
                            .text_color(if all_granted {
                                success_fg
                            } else {
                                Hsla::from(theme.gray_11)
                            })
                            .child(SharedString::from(if all_granted {
                                "You're all set.".to_string()
                            } else if !can_continue {
                                format!("{granted} of {total} permissions granted")
                            } else {
                                "Microphone and Camera are optional.".to_string()
                            })),
                    )
                    .child(
                        ui::Button::plain(
                            &theme,
                            "onboarding-continue",
                            ui::ButtonVariant::Primary,
                            ui::ButtonSize::Lg,
                        )
                        .radius(px(8.))
                        .label(if self.revisit {
                            "Continue to Cap"
                        } else {
                            "Start Using Cap"
                        })
                        .disabled(!can_continue)
                        .on_click(cx.listener(|this, _, _window, cx| {
                            if this.state.necessary_granted() {
                                this.finish(cx);
                            }
                        })),
                    ),
            )
    }

    fn render_permission_row(
        &self,
        permission: OSPermission,
        status: OSPermissionStatus,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let (success_bg, success_border, success_fg) = self.success_palette();
        let granted = status == OSPermissionStatus::Granted;
        let busy = self.pending.is_some();

        let action: gpui::AnyElement = if granted {
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.))
                .px(px(12.))
                .h(px(28.))
                .rounded(px(8.))
                .bg(success_bg)
                .border_1()
                .border_color(success_border)
                .text_size(px(12.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(success_fg)
                .child(
                    svg()
                        .path("icons/check.svg")
                        .size(px(12.))
                        .text_color(success_fg),
                )
                .child("Granted")
                .into_any_element()
        } else {
            let label = match self.state.action(permission) {
                Some(RowAction::OpenSettings) => "Open Settings",
                _ => "Grant",
            };
            ui::Button::plain(
                &theme,
                SharedString::from(format!("perm-action-{}", permission.label())),
                ui::ButtonVariant::Gray,
                ui::ButtonSize::Sm,
            )
            .radius(px(8.))
            .label(label)
            .disabled(busy)
            .on_click(cx.listener(move |this, _, window, cx| this.act(permission, window, cx)))
            .into_any_element()
        };

        div()
            .flex()
            .flex_row()
            .flex_none()
            .items_center()
            .gap(px(ROW_GAP))
            .w(px(CARD_W))
            .px(px(ROW_PAD_X))
            .py(px(12.))
            .rounded(px(12.))
            .border_1()
            .border_color(Hsla::from(theme.gray_4))
            .bg(Hsla::from(theme.gray_2))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_none()
                    .w(px(ROW_TEXT_W))
                    .gap(px(2.))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(8.))
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(Hsla::from(theme.gray_12))
                                    .child(permission.label()),
                            )
                            .when(!permission.required(), |this| {
                                this.child(
                                    div()
                                        .text_size(px(10.))
                                        .px(px(6.))
                                        .py(px(2.))
                                        .rounded_full()
                                        .bg(Hsla::from(theme.gray_3))
                                        .text_color(Hsla::from(theme.gray_10))
                                        .child("Optional"),
                                )
                            }),
                    )
                    .child(
                        div()
                            .text_size(px(11.))
                            .line_height(px(15.))
                            .text_color(Hsla::from(theme.gray_10))
                            .child(permission.blurb()),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_none()
                    .w(px(ROW_ACTION_W))
                    .justify_end()
                    .child(action),
            )
    }
}

impl Render for OnboardingWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.theme.refresh(window, cx, false);
        let theme = self.theme;

        div()
            .size_full()
            .flex()
            .flex_col()
            .font_family("Geist")
            .bg(Hsla::from(theme.gray_1))
            .text_color(Hsla::from(theme.gray_12))
            .track_focus(&self.focus)
            .child(div().h(px(52.)).w_full().flex_shrink_0().on_mouse_down(
                gpui::MouseButton::Left,
                |_, window, _| {
                    window.start_window_move();
                },
            ))
            .child(match self.step {
                Step::Welcome => self.render_welcome(cx).into_any_element(),
                Step::Permissions => self.render_permissions(cx).into_any_element(),
            })
    }
}
