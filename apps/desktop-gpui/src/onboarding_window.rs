//! Onboarding -- permissions-first, simpler than the Tauri tour.
//!
//! The shipping flow is an 8-step product tour plus a startup overlay
//! (`onboarding.tsx`). This window keeps the gates that actually block the
//! app: welcome on first launch, then the full macOS accessibility /
//! screen-recording / mic / camera grant flow, then Cap. Windows and Linux
//! skip the permission step because those statuses are `notNeeded`.

use gpui::{
    Context, FocusHandle, FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement, Pixels,
    Point, Render, SharedString, Styled, Window, div, prelude::FluentBuilder, px, svg,
};

use crate::{
    permissions::{
        self, OSPermission, OSPermissionStatus, OSPermissionsCheck, do_permissions_check,
    },
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    Welcome,
    Permissions,
}

pub struct OnboardingWindow {
    theme: Theme,
    step: Step,
    permissions: OSPermissionsCheck,
    interacted: bool,
    poll: Option<gpui::Task<()>>,
    revisit: bool,
    focus: FocusHandle,
}

impl OnboardingWindow {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        window.on_window_should_close(cx, |_window, cx| {
            cx.defer(crate::app_windows::onboarding_closed);
            true
        });

        let permissions = do_permissions_check(true);
        let revisit = store::has_completed_onboarding() && !permissions.necessary_granted();
        let step = if !store::has_completed_startup() && !revisit {
            Step::Welcome
        } else {
            Step::Permissions
        };

        crate::theme::bind_window(window, cx);
        let mut this = Self {
            theme: Theme::for_window(window, cx, false),
            step,
            permissions,
            interacted: false,
            poll: None,
            revisit,
            focus: cx.focus_handle(),
        };
        this.arm_poll(window, cx);
        this
    }

    pub fn focus_root(&self, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
    }

    fn arm_poll(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.poll = Some(cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(250))
                    .await;
                if this
                    .update_in(cx, |this, _window, cx| {
                        this.permissions = do_permissions_check(!this.interacted);
                        cx.notify();
                    })
                    .is_err()
                {
                    return;
                }
            }
        }));
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

    fn continue_from_welcome(&mut self, cx: &mut Context<Self>) {
        store::set_has_completed_startup(true);
        if cfg!(target_os = "macos") && !self.permissions.necessary_granted() {
            self.step = Step::Permissions;
            cx.notify();
            return;
        }
        self.finish(cx);
    }

    fn request(&mut self, permission: OSPermission, cx: &mut Context<Self>) {
        self.interacted = true;
        let status = self.permissions.get(permission);
        if status == OSPermissionStatus::Denied {
            permissions::open_permission_settings(permission);
        } else {
            permissions::request_permission(permission);
            let check = do_permissions_check(false);
            if !check.get(permission).permitted()
                && matches!(
                    permission,
                    OSPermission::ScreenRecording | OSPermission::Accessibility
                )
            {
                permissions::open_permission_settings(permission);
            }
        }
        self.permissions = do_permissions_check(false);
        cx.notify();
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
                    .on_click(cx.listener(|this, _, _window, cx| this.continue_from_welcome(cx))),
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
        let can_continue = self.permissions.necessary_granted();

        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .px(px(48.))
            .pt(px(28.))
            .pb(px(24.))
            .gap(px(16.))
            .child(
                div()
                    .text_size(px(22.))
                    .font_weight(FontWeight::BOLD)
                    .text_color(Hsla::from(theme.gray_12))
                    .child("Permissions"),
            )
            .child(
                div()
                    .text_size(px(13.))
                    .text_color(Hsla::from(theme.gray_11))
                    .child(
                        "Screen Recording and Accessibility are required. Microphone and Camera are optional.",
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .gap(px(10.))
                    .children(
                        OSPermission::ALL
                            .iter()
                            .copied()
                            .filter_map(|permission| {
                                let status = self.permissions.get(permission);
                                if status == OSPermissionStatus::NotNeeded {
                                    return None;
                                }
                                Some(
                                    self.render_permission_row(permission, status, cx)
                                        .into_any_element(),
                                )
                            })
                            .collect::<Vec<_>>(),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_end()
                    .gap(px(12.))
                    .child(
                        ui::Button::plain(
                            &theme,
                            "onboarding-continue",
                            ui::ButtonVariant::Primary,
                            ui::ButtonSize::Lg,
                        )
                        .label(if self.revisit {
                            "Continue to Cap"
                        } else {
                            "Start Using Cap"
                        })
                        .disabled(!can_continue)
                        .on_click(cx.listener(|this, _, _window, cx| {
                            if this.permissions.necessary_granted() {
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
        let granted = status == OSPermissionStatus::Granted;

        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(14.))
            .p(px(14.))
            .rounded(px(12.))
            .border_1()
            .border_color(Hsla::from(theme.gray_4))
            .bg(Hsla::from(theme.gray_2))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(36.))
                    .rounded(px(10.))
                    .bg(Hsla::from(theme.gray_3))
                    .child(
                        svg()
                            .path(permission.icon())
                            .size(px(18.))
                            .text_color(Hsla::from(theme.gray_12)),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .gap(px(2.))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(8.))
                            .child(
                                div()
                                    .text_size(px(14.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(Hsla::from(theme.gray_12))
                                    .child(permission.label()),
                            )
                            .when(permission.required(), |this| {
                                this.child(
                                    div()
                                        .text_size(px(10.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .px(px(6.))
                                        .py(px(2.))
                                        .rounded_full()
                                        .bg(Hsla::from(theme.gray_3))
                                        .text_color(Hsla::from(theme.gray_11))
                                        .child("Required"),
                                )
                            }),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(Hsla::from(theme.gray_11))
                            .child(permission.description()),
                    ),
            )
            .child(if granted {
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .px(px(10.))
                    .h(px(32.))
                    .rounded(px(8.))
                    .bg(Hsla::from(theme.gray_3))
                    .text_size(px(12.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(Hsla::from(theme.gray_12))
                    .child(
                        svg()
                            .path("icons/check.svg")
                            .size(px(12.))
                            .text_color(Hsla::from(theme.gray_12)),
                    )
                    .child("Granted")
                    .into_any_element()
            } else {
                let label = if status == OSPermissionStatus::Denied {
                    "Open Settings"
                } else {
                    "Grant"
                };
                ui::Button::plain(
                    &theme,
                    SharedString::from(format!("grant-{}", permission.label())),
                    ui::ButtonVariant::Gray,
                    ui::ButtonSize::Sm,
                )
                .label(label)
                .on_click(cx.listener(move |this, _, _window, cx| this.request(permission, cx)))
                .into_any_element()
            })
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
