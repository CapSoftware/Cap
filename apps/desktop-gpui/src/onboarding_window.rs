use std::time::Duration;

use gpui::{
    Animation, AnimationExt, AnyElement, Context, Div, FocusHandle, FontWeight, Hsla,
    InteractiveElement, IntoElement, KeyDownEvent, ObjectFit, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, StyledImage, Window, div, img, linear_color_stop,
    linear_gradient, prelude::FluentBuilder, px, relative, rgb, rgba, svg,
};

use crate::{
    main_window::Mode,
    onboarding_audio::OnboardingAudio,
    permissions::{self, OSPermission, OSPermissionStatus},
    permissions_ui::{PermissionsState, RowAction},
    store,
    theme::Theme,
    ui,
};

pub const ONBOARDING_WIDTH: f32 = 860.;
pub const ONBOARDING_HEIGHT: f32 = 690.;
pub const ONBOARDING_HEADER_HEIGHT: f32 = 36.;

const POLL_INTERVAL: Duration = Duration::from_secs(1);
const REQUEST_GRACE: Duration = Duration::from_secs(2);
const WELCOME_EXIT: Duration = Duration::from_millis(600);
const CARD_W: f32 = 440.;
const ROW_PAD_X: f32 = 16.;
const ROW_GAP: f32 = 16.;
const ROW_ACTION_W: f32 = 112.;
const ROW_TEXT_W: f32 = CARD_W - 2. * ROW_PAD_X - ROW_GAP - ROW_ACTION_W;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(usize)]
enum Step {
    Permissions,
    Overview,
    Instant,
    Studio,
    Screenshot,
    Toggle,
    Shortcuts,
    Faq,
}

impl Step {
    const ALL: [Self; 8] = [
        Self::Permissions,
        Self::Overview,
        Self::Instant,
        Self::Studio,
        Self::Screenshot,
        Self::Toggle,
        Self::Shortcuts,
        Self::Faq,
    ];

    fn first(macos: bool, permissions_only: bool) -> Self {
        if macos || permissions_only {
            Self::Permissions
        } else {
            Self::Overview
        }
    }

    fn next(self, permissions_only: bool, core_granted: bool) -> Option<Self> {
        if permissions_only || (self == Self::Permissions && !core_granted) {
            return None;
        }
        Self::ALL.get(self as usize + 1).copied()
    }

    fn previous(self, first: Self) -> Option<Self> {
        if self as usize <= first as usize {
            return None;
        }
        Self::ALL.get(self as usize - 1).copied()
    }

    fn demo_timing(self) -> Option<(&'static [u64], u64)> {
        match self {
            Self::Instant => Some((&[300, 2350, 3350, 4350, 5350, 6350, 7350, 8350], 9550)),
            Self::Studio => Some((
                &[
                    300, 2350, 3350, 4350, 5350, 6350, 7350, 8150, 9150, 10150, 11150,
                ],
                12250,
            )),
            Self::Screenshot => Some((&[200, 700, 1400, 2600, 3400, 3900, 4900, 5900, 6700], 8000)),
            Self::Toggle => Some((&[2500, 5000], 7500)),
            _ => None,
        }
    }
}

struct ModeDetail {
    mode: Mode,
    title: &'static str,
    tagline: &'static str,
    description: &'static str,
    icon: &'static str,
    features: [&'static str; 4],
}

const MODES: [ModeDetail; 3] = [
    ModeDetail {
        mode: Mode::Instant,
        title: "Instant Mode",
        tagline: "Record & share in seconds",
        description: "Your recording uploads as you capture. Stop recording and instantly get a shareable link — no waiting.",
        icon: "icons/instant.svg",
        features: [
            "Instant shareable link",
            "Background uploading",
            "AI transcription & summary",
            "Browser-based playback",
        ],
    },
    ModeDetail {
        mode: Mode::Studio,
        title: "Studio Mode",
        tagline: "Professional editing tools",
        description: "Record in full quality locally, then use the built-in editor to add backgrounds, padding, cursor effects, and more.",
        icon: "icons/film-cut.svg",
        features: [
            "Full quality local recording",
            "Built-in editor & effects",
            "Custom backgrounds & padding",
            "Export or share when ready",
        ],
    },
    ModeDetail {
        mode: Mode::Screenshot,
        title: "Screenshot Mode",
        tagline: "Capture & beautify instantly",
        description: "Take screenshots with a single hotkey, add annotations and beautiful backgrounds, then share or copy instantly.",
        icon: "icons/screenshot.svg",
        features: [
            "Instant hotkey capture",
            "Annotation & drawing tools",
            "Beautiful backgrounds",
            "Copy, save, or share",
        ],
    },
];

const FAQ: [(&str, &str); 5] = [
    (
        "Is Cap free to use?",
        "Cap is free for personal use. For teams and commercial use, check out our pricing plans.",
    ),
    (
        "What's the difference between Instant and Studio?",
        "Instant mode uploads as you record — stop recording and you'll have a shareable link immediately. Studio mode records locally in full quality, letting you edit with backgrounds, effects, and more before sharing.",
    ),
    (
        "Where are my recordings stored?",
        "All recordings are stored locally on your computer. In Instant mode, they're also uploaded to Cap's cloud for easy sharing. You can manage storage in Settings.",
    ),
    (
        "Can I change my shortcuts later?",
        "Head to Settings → Shortcuts at any time to customize all your keyboard shortcuts.",
    ),
    (
        "How does sharing work?",
        "In Instant mode, you get a shareable link automatically when you stop recording. In Studio mode, export your edited video and share via Cap's cloud or save locally.",
    ),
];

pub struct OnboardingWindow {
    theme: Theme,
    step: Step,
    first_step: Step,
    permissions_only: bool,
    state: PermissionsState,
    pending: Option<OSPermission>,
    poll: Option<gpui::Task<()>>,
    verify: Option<gpui::Task<()>>,
    refresh: Option<gpui::Task<()>>,
    animated: bool,
    welcome: bool,
    welcome_exiting: bool,
    welcome_exit: Option<gpui::Task<()>>,
    audio: Option<OnboardingAudio>,
    muted: bool,
    bounce: usize,
    demo_task: Option<gpui::Task<()>>,
    demo_phase: usize,
    demo_cycle: usize,
    chosen_mode: Option<usize>,
    step_revision: usize,
    transition_direction: f32,
    faq_open: [bool; FAQ.len()],
    error: Option<String>,
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
        let permissions_only = revisit || forced;
        let first_step = Step::first(cfg!(target_os = "macos"), permissions_only);
        let welcome = !store::has_completed_startup() && !permissions_only;
        let muted = store::store_section("audioSettings")
            .get("isMuted")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        crate::theme::bind_window(window, cx);
        let mut this = Self {
            theme: Theme::for_window(window, cx, true),
            step: first_step,
            first_step,
            permissions_only,
            state,
            pending: None,
            poll: None,
            verify: None,
            refresh: None,
            animated: window.is_window_active(),
            welcome,
            welcome_exiting: false,
            welcome_exit: None,
            audio: welcome.then(|| OnboardingAudio::new(muted, cx)),
            muted,
            bounce: 0,
            demo_task: None,
            demo_phase: 0,
            demo_cycle: 0,
            chosen_mode: None,
            step_revision: 0,
            transition_direction: 1.,
            faq_open: [false; FAQ.len()],
            error: None,
            focus: cx.focus_handle(),
        };
        cx.observe_window_activation(window, |this: &mut Self, window, cx| {
            this.animated = window.is_window_active();
            if this.animated {
                if this.permissions_visible() {
                    this.refresh_permissions(window, cx);
                }
                this.arm_demo(window, cx);
            } else {
                this.demo_task = None;
                if !surface_visible(window) {
                    this.poll = None;
                    this.refresh = None;
                }
            }
            cx.notify();
        })
        .detach();
        this.arm_poll(window, cx);
        this.arm_demo(window, cx);
        this
    }

    pub fn focus_root(&self, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
    }

    fn permissions_visible(&self) -> bool {
        !self.welcome && self.step == Step::Permissions
    }

    fn arm_poll(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.permissions_visible()
            || !surface_visible(window)
            || self.poll.is_some()
            || self.state.all_shown_granted()
        {
            return;
        }
        self.poll = Some(cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor().timer(POLL_INTERVAL).await;
                let visible = this
                    .update_in(cx, |this, window, _| {
                        let visible = this.permissions_visible() && surface_visible(window);
                        if !visible {
                            this.poll = None;
                        }
                        visible
                    })
                    .unwrap_or(false);
                if !visible {
                    return;
                }
                let raw = cx
                    .background_executor()
                    .spawn(async { crate::permissions_ui::sweep_raw() })
                    .await;
                let done = this
                    .update_in(cx, |this, window, cx| {
                        if !this.permissions_visible() || !surface_visible(window) {
                            return true;
                        }
                        if this.state.apply_raw(raw) {
                            this.grants_changed();
                            cx.notify();
                        }
                        this.state.all_shown_granted()
                    })
                    .unwrap_or(true);
                if done {
                    this.update_in(cx, |this, _, _| {
                        this.poll = None;
                        this.pending = None;
                        this.verify = None;
                    })
                    .ok();
                    return;
                }
            }
        }));
    }

    fn grants_changed(&mut self) {
        if let Some(pending) = self.pending
            && self.state.status(pending) != OSPermissionStatus::NotDetermined
        {
            self.pending = None;
            self.verify = None;
        }
    }

    fn refresh_permissions(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !surface_visible(window) || self.refresh.is_some() {
            return;
        }
        self.refresh = Some(cx.spawn_in(window, async move |this, cx| {
            let raw = cx
                .background_executor()
                .spawn(async { crate::permissions_ui::sweep_raw() })
                .await;
            this.update_in(cx, |this, window, cx| {
                this.refresh = None;
                if !this.permissions_visible() || !surface_visible(window) {
                    return;
                }
                if this.state.apply_raw(raw) {
                    this.grants_changed();
                }
                if this.state.all_shown_granted() {
                    this.pending = None;
                    this.verify = None;
                    this.poll = None;
                } else {
                    this.arm_poll(window, cx);
                }
                cx.notify();
            })
            .ok();
        }));
    }

    fn finish(&mut self, cx: &mut Context<Self>) {
        if !self.state.necessary_granted() {
            return;
        }
        if !store::set_has_completed_onboarding(true) || !store::set_has_completed_startup(true) {
            self.error = Some("Could not save onboarding progress. Please try again.".into());
            cx.notify();
            return;
        }
        self.poll = None;
        self.verify = None;
        self.refresh = None;
        self.demo_task = None;
        self.audio = None;
        cx.defer(crate::app_windows::onboarding_finished);
    }

    fn continue_from_welcome(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.welcome || self.welcome_exiting {
            return;
        }
        if !store::set_has_completed_startup(true) {
            self.error = Some("Could not save onboarding progress. Please try again.".into());
            cx.notify();
            return;
        }
        self.welcome_exiting = true;
        self.welcome_exit = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(WELCOME_EXIT).await;
            this.update_in(cx, |this, window, cx| {
                this.welcome = false;
                this.welcome_exiting = false;
                this.audio = None;
                this.step_revision = this.step_revision.wrapping_add(1);
                this.focus_root(window, cx);
                if this.permissions_visible() {
                    this.refresh_permissions(window, cx);
                }
                this.arm_poll(window, cx);
                this.arm_demo(window, cx);
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn go_to(&mut self, step: Step, window: &mut Window, cx: &mut Context<Self>) {
        if self.welcome || self.permissions_only || self.step == step {
            return;
        }
        self.transition_direction = if step as usize > self.step as usize {
            1.
        } else {
            -1.
        };
        self.step = step;
        self.step_revision = self.step_revision.wrapping_add(1);
        self.poll = None;
        self.verify = None;
        self.refresh = None;
        self.pending = None;
        self.demo_task = None;
        self.demo_phase = 0;
        self.demo_cycle = 0;
        self.chosen_mode = None;
        self.focus_root(window, cx);
        if self.permissions_visible() {
            self.refresh_permissions(window, cx);
        }
        self.arm_poll(window, cx);
        self.arm_demo(window, cx);
        cx.notify();
    }

    fn next(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.welcome || (self.step == Step::Permissions && !self.state.necessary_granted()) {
            return;
        }
        if self.permissions_only || self.step == Step::Faq {
            self.finish(cx);
        } else if let Some(next) = self
            .step
            .next(self.permissions_only, self.state.necessary_granted())
        {
            self.go_to(next, window, cx);
        }
    }

    fn back(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.permissions_only
            && let Some(previous) = self.step.previous(self.first_step)
        {
            self.go_to(previous, window, cx);
        }
    }

    fn on_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = &event.keystroke;
        if key.modifiers.platform && key.key == "w" {
            cx.stop_propagation();
            cx.defer(crate::app_windows::close_onboarding);
            return;
        }
        if key.modifiers.platform || key.modifiers.control || key.modifiers.alt {
            return;
        }
        if self.welcome {
            if key.key == "space" || key.key == " " {
                cx.stop_propagation();
                self.continue_from_welcome(window, cx);
            }
            return;
        }
        match key.key.as_str() {
            "right" if !self.permissions_only && self.step != Step::Faq => self.next(window, cx),
            "left" => self.back(window, cx),
            "enter" => self.next(window, cx),
            _ => return,
        }
        cx.stop_propagation();
    }

    fn arm_demo(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.welcome
            || !window.is_window_active()
            || self.demo_task.is_some()
            || self.chosen_mode.is_some()
        {
            return;
        }
        let Some((timings, cycle)) = self.step.demo_timing() else {
            return;
        };
        let step = self.step;
        self.demo_task = Some(cx.spawn_in(window, async move |this, cx| {
            loop {
                let mut previous = 0_u64;
                for (index, &at) in timings.iter().enumerate() {
                    cx.background_executor()
                        .timer(Duration::from_millis(at.saturating_sub(previous)))
                        .await;
                    previous = at;
                    let current = this
                        .update_in(cx, |this, window, cx| {
                            if this.welcome || this.step != step || !window.is_window_active() {
                                this.demo_task = None;
                                return false;
                            }
                            this.demo_phase = index + 1;
                            cx.notify();
                            true
                        })
                        .unwrap_or(false);
                    if !current {
                        return;
                    }
                }
                cx.background_executor()
                    .timer(Duration::from_millis(cycle.saturating_sub(previous)))
                    .await;
                let current = this
                    .update_in(cx, |this, window, cx| {
                        if this.welcome || this.step != step || !window.is_window_active() {
                            this.demo_task = None;
                            return false;
                        }
                        this.demo_phase = 0;
                        this.demo_cycle = this.demo_cycle.wrapping_add(1);
                        cx.notify();
                        true
                    })
                    .unwrap_or(false);
                if !current {
                    return;
                }
            }
        }));
    }

    fn toggle_mute(&mut self, cx: &mut Context<Self>) {
        self.muted = !self.muted;
        if let Some(audio) = &self.audio {
            audio.set_muted(self.muted);
        }
        if !store::set_store_setting(
            "audioSettings",
            "isMuted",
            serde_json::Value::Bool(self.muted),
        ) {
            self.error = Some("Could not save the sound preference.".into());
        }
        cx.notify();
    }

    fn act(&mut self, permission: OSPermission, window: &mut Window, cx: &mut Context<Self>) {
        if self.pending.is_some() || !self.permissions_visible() {
            return;
        }
        self.pending = Some(permission);
        self.verify = Some(cx.spawn_in(window, async move |this, cx| {
            let raw = cx
                .background_executor()
                .spawn(async { crate::permissions_ui::sweep_raw() })
                .await;
            let should_verify = this
                .update_in(cx, |this, window, cx| {
                    if !this.permissions_visible() {
                        this.pending = None;
                        return false;
                    }
                    let action = this.state.refreshed_action(permission, raw);
                    match action {
                        None => {
                            this.pending = None;
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
                })
                .unwrap_or(false);
            if !should_verify {
                return;
            }
            cx.background_executor().timer(REQUEST_GRACE).await;
            let raw = cx
                .background_executor()
                .spawn(async { crate::permissions_ui::sweep_raw() })
                .await;
            this.update_in(cx, |this, _, cx| {
                if !this.permissions_visible() {
                    return;
                }
                this.state.apply_raw(raw);
                this.pending = None;
                if permission.required() && !this.state.status(permission).permitted() {
                    this.state.note_request_failed(permission);
                    this.state.note_settings_opened(permission);
                    permissions::open_permission_settings(permission);
                }
                if this.state.all_shown_granted() {
                    this.poll = None;
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

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
            .border_color(theme.body_border(4))
            .bg(if theme.is_dark() {
                theme.body_fill(2)
            } else {
                gpui::white()
            })
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

fn surface_visible(window: &Window) -> bool {
    #[cfg(target_os = "macos")]
    {
        crate::platform::window_is_visible(window)
    }
    #[cfg(not(target_os = "macos"))]
    {
        window.is_window_active()
    }
}

fn copy(text: impl Into<SharedString>, size: f32, color: impl Into<Hsla>) -> Div {
    div()
        .text_size(px(size))
        .text_color(color.into())
        .child(text.into())
}

fn glyph(path: &'static str, size: f32, color: impl Into<Hsla>) -> gpui::Svg {
    svg().path(path).size(px(size)).text_color(color.into())
}

fn ease(value: f32) -> f32 {
    value * value * (3. - 2. * value)
}

impl OnboardingWindow {
    fn card(&self) -> Div {
        div()
            .rounded(px(12.))
            .border_1()
            .border_color(self.theme.body_border(4))
            .bg(if self.theme.is_dark() {
                self.theme.body_fill(2)
            } else {
                gpui::white()
            })
    }

    fn heading(
        &self,
        title: &'static str,
        subtitle: &'static str,
        icon: Option<&'static str>,
    ) -> Div {
        let theme = self.theme;
        div()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(12.))
            .max_w(px(480.))
            .text_center()
            .when_some(icon, |el, path| {
                el.child(
                    self.card()
                        .size(px(48.))
                        .rounded(px(16.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(glyph(path, 20., theme.gray_11)),
                )
            })
            .child(
                copy(title, 24., theme.gray_12)
                    .font_weight(FontWeight::BOLD)
                    .line_height(px(30.)),
            )
            .child(copy(subtitle, 14., theme.gray_10).line_height(px(21.)))
    }

    fn ambient(&self, width: f32, height: f32, welcome: bool) -> AnyElement {
        let cloud_width = width * 0.8;
        let exiting = welcome && self.welcome_exiting;
        let first = div()
            .absolute()
            .top_0()
            .right(px(-160.))
            .opacity(0.7)
            .child(
                img("onboarding/cloud-1.png")
                    .w(px(cloud_width))
                    .h(px(cloud_width * 1138. / 1657.)),
            );
        let second = div().absolute().top_0().left(px(-160.)).opacity(0.7).child(
            img("onboarding/cloud-2.png")
                .w(px(cloud_width))
                .h(px(cloud_width * 892. / 1923.)),
        );
        let third_width = width;
        let third = div()
            .absolute()
            .left_0()
            .bottom(px(-height * 0.15))
            .opacity(0.7)
            .child(
                img("onboarding/cloud-3.png")
                    .w(px(third_width))
                    .h(px(third_width * 703. / 3007.)),
            );
        let clouds = if !self.animated {
            div().size_full().child(first).child(second).child(third)
        } else if exiting {
            div()
                .size_full()
                .child(first.with_animation(
                    "welcome-cloud-one-exit",
                    Animation::new(WELCOME_EXIT).with_easing(ease),
                    |el, t| {
                        el.right(px(-160. + 200. * t))
                            .top(px(-150. * t))
                            .opacity(0.7 * (1. - t))
                    },
                ))
                .child(second.with_animation(
                    "welcome-cloud-two-exit",
                    Animation::new(WELCOME_EXIT).with_easing(ease),
                    |el, t| {
                        el.left(px(-160. + 200. * t))
                            .top(px(-150. * t))
                            .opacity(0.7 * (1. - t))
                    },
                ))
                .child(third.with_animation(
                    "welcome-cloud-three-exit",
                    Animation::new(WELCOME_EXIT).with_easing(ease),
                    move |el, t| {
                        el.bottom(px(-height * 0.15 - 200. * t))
                            .opacity(0.7 * (1. - t))
                    },
                ))
        } else {
            div()
                .size_full()
                .child(first.with_animation(
                    if welcome {
                        "welcome-cloud-one"
                    } else {
                        "ambient-cloud-one"
                    },
                    Animation::new(Duration::from_secs(30)).repeat(),
                    |el, t| {
                        let amount = 1. - (2. * t - 1.).abs();
                        el.right(px(-160. + 20. * amount)).top(px(10. * amount))
                    },
                ))
                .child(second.with_animation(
                    if welcome {
                        "welcome-cloud-two"
                    } else {
                        "ambient-cloud-two"
                    },
                    Animation::new(Duration::from_secs(35)).repeat(),
                    |el, t| {
                        let amount = 1. - (2. * t - 1.).abs();
                        el.left(px(-160. + 20. * amount)).top(px(10. * amount))
                    },
                ))
                .child(third.with_animation(
                    if welcome {
                        "welcome-cloud-three"
                    } else {
                        "ambient-cloud-three"
                    },
                    if welcome {
                        Animation::new(Duration::from_secs(60)).with_easing(ease)
                    } else {
                        Animation::new(Duration::from_secs(120)).repeat()
                    },
                    move |el, t| {
                        let t = if welcome { t } else { 1. - (2. * t - 1.).abs() };
                        let (x, y) = if t < 0.5 {
                            (width * 0.04 * t, 20. * (1. - t * 2.))
                        } else {
                            (width * 0.04 * (1. - t), 0.)
                        };
                        el.left(px(x)).bottom(px(-height * 0.15 - y))
                    },
                ))
        };
        div()
            .absolute()
            .inset_0()
            .overflow_hidden()
            .bg(linear_gradient(
                180.,
                linear_color_stop(rgb(0x3b82f6), 0.),
                linear_color_stop(rgb(0x2563eb), 1.),
            ))
            .opacity(if welcome { 1. } else { 0.1 })
            .child(clouds)
            .child(
                img("onboarding/grain.svg")
                    .absolute()
                    .inset_0()
                    .size_full()
                    .object_fit(ObjectFit::Fill)
                    .opacity(0.14),
            )
            .into_any_element()
    }

    fn render_welcome(&self, width: f32, height: f32, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let glass = theme
            .material
            .filter(|material| material.kind == crate::platform::MaterialKind::LiquidGlass);
        let button_fill = glass
            .map(|material| Hsla::from(material.control_fill))
            .unwrap_or_else(gpui::white);
        let button_hover = glass
            .map(|material| Hsla::from(material.control_hover))
            .unwrap_or_else(|| rgba(0xfffffff2).into());
        let button_text = glass
            .map(|material| Hsla::from(material.text))
            .unwrap_or_else(|| rgb(0x161b26).into());
        let logo = img("onboarding/logo.svg")
            .w(px(80.))
            .h(px(96.))
            .object_fit(ObjectFit::Contain);
        let logo = if self.bounce == 0 || !self.animated {
            logo.into_any_element()
        } else {
            div()
                .relative()
                .child(logo)
                .with_animation(
                    ("onboarding-logo", self.bounce),
                    Animation::new(Duration::from_secs(1)),
                    |el, t| el.top(px(-20. * (std::f32::consts::PI * t).sin())),
                )
                .into_any_element()
        };
        let content = div()
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .px(px(16.))
            .child(
                div()
                    .id("onboarding-logo")
                    .cursor_pointer()
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.bounce = this.bounce.wrapping_add(1);
                        cx.notify();
                    }))
                    .child(logo),
            )
            .child(
                copy("Welcome to Cap", 48., gpui::white())
                    .font_weight(FontWeight::BOLD)
                    .line_height(px(48.))
                    .mt(px(40.))
                    .mb(px(16.)),
            )
            .child(
                copy(
                    "Beautiful screen recordings, owned by you.",
                    24.,
                    gpui::white(),
                )
                .line_height(px(32.))
                .opacity(0.8)
                .whitespace_nowrap(),
            )
            .child(
                div()
                    .id("onboarding-get-started")
                    .tab_index(0)
                    .cursor_pointer()
                    .mt(px(56.))
                    .w(px(274.))
                    .h(px(60.))
                    .px(px(64.))
                    .py(px(8.))
                    .rounded_full()
                    .border_1()
                    .border_color(if glass.is_some() {
                        gpui::transparent_black()
                    } else {
                        rgba(0xffffff4d).into()
                    })
                    .bg(button_fill)
                    .hover(move |el| el.bg(button_hover))
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .gap(px(2.))
                    .on_click(
                        cx.listener(|this, _, window, cx| this.continue_from_welcome(window, cx)),
                    )
                    .child(
                        copy("Get Started", 14., button_text)
                            .line_height(px(20.))
                            .font_weight(FontWeight::MEDIUM),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_center()
                            .gap(px(4.))
                            .child(
                                copy("Click here, or press", 11., rgba(0x161b2694))
                                    .font_weight(FontWeight::NORMAL)
                                    .line_height(px(14.)),
                            )
                            .child(
                                copy("Space", 10., theme.gray_11)
                                    .font_weight(FontWeight::MEDIUM)
                                    .line_height(px(14.))
                                    .px(px(4.))
                                    .py(px(1.))
                                    .rounded(px(3.))
                                    .border_1()
                                    .border_color(theme.gray_6)
                                    .bg(if theme.is_dark() {
                                        theme.body_fill(3)
                                    } else {
                                        gpui::white()
                                    }),
                            ),
                    ),
            )
            .when_some(self.error.clone(), |el, error| {
                el.child(copy(error, 12., gpui::white()).mt(px(12.)))
            });
        let mute = div()
            .id("onboarding-mute")
            .tab_index(0)
            .absolute()
            .top(px(12.))
            .p(px(4.))
            .when(cfg!(target_os = "macos"), |el| el.right(px(16.)))
            .when(!cfg!(target_os = "macos"), |el| el.left(px(16.)))
            .cursor_pointer()
            .hover(|el| el.opacity(0.8))
            .on_click(cx.listener(|this, _, _, cx| this.toggle_mute(cx)))
            .child(glyph(
                if self.muted {
                    "onboarding/volume-x.svg"
                } else {
                    "onboarding/volume-2.svg"
                },
                24.,
                gpui::white(),
            ));
        let overlay = div()
            .absolute()
            .inset_0()
            .overflow_hidden()
            .child(self.ambient(width, height, true))
            .child(content)
            .when(!self.welcome_exiting, |el| el.child(mute));
        if self.welcome_exiting && self.animated {
            overlay
                .with_animation(
                    "onboarding-welcome-exit",
                    Animation::new(WELCOME_EXIT).with_easing(ease),
                    |el, t| el.opacity(1. - t),
                )
                .into_any_element()
        } else {
            overlay.into_any_element()
        }
    }

    fn render_permissions(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        div()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .min_h_full()
            .px(px(48.))
            .py(px(24.))
            .gap(px(24.))
            .child(self.heading(
                "Permissions Required",
                "Cap needs a few permissions to record your screen and capture audio.",
                Some("icons/shield.svg"),
            ))
            .child(div().flex().flex_col().w(px(CARD_W)).gap(px(8.)).children(
                self.state.shown().map(|(permission, status)| {
                    self.render_permission_row(permission, status, cx)
                        .into_any_element()
                }),
            ))
            .when(self.state.relaunch_hint(), |el| {
                el.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(12.))
                        .w(px(CARD_W))
                        .p(px(12.))
                        .rounded(px(12.))
                        .bg(theme.amber_3)
                        .border_1()
                        .border_color(theme.amber_6)
                        .child(glyph("icons/triangle-alert.svg", 16., theme.amber_11))
                        .child(
                            copy(
                                "Granted it in System Settings? Relaunch Cap to apply.",
                                11.,
                                theme.amber_11,
                            )
                            .flex_1()
                            .min_w_0(),
                        )
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
                            .on_click(cx.listener(|_, _, _, cx| permissions::relaunch(cx))),
                        ),
                )
            })
            .into_any_element()
    }

    fn render_overview(&self) -> AnyElement {
        let theme = self.theme;
        div().flex().flex_col().items_center().justify_center().min_h_full().px(px(40.)).gap(px(32.))
            .child(self.heading("One app, every workflow", "Whether you need speed, studio quality, or a quick screenshot — Cap has a mode for it.", None))
            .child(div().flex().gap(px(16.)).w_full().max_w(px(540.)).children(MODES.iter().enumerate().map(|(index, mode)| {
                let card = self.card().flex_1().min_w_0().flex().flex_col().items_center().gap(px(12.)).p(px(20.)).rounded(px(16.))
                    .child(self.card().size(px(48.)).rounded(px(16.)).flex().items_center().justify_center()
                        .child(glyph(mode.icon, 20., theme.gray_12)))
                    .child(copy(mode.title, 14., theme.gray_12).font_weight(FontWeight::BOLD).text_center())
                    .child(copy(mode.tagline, 11., theme.gray_9).line_height(px(15.)).text_center());
                if !self.animated { return card.into_any_element(); }
                card.with_animation(("overview-card", index), Animation::new(Duration::from_millis(700 + index as u64 * 100)),
                        |el, t| el.relative().top(px(16. * (1. - ease(t)))).opacity(ease(t))).into_any_element()
            }))).into_any_element()
    }

    fn render_detail(&self, index: usize) -> AnyElement {
        let theme = self.theme;
        let mode = &MODES[index];
        div()
            .flex()
            .items_center()
            .min_h_full()
            .px(px(40.))
            .py(px(24.))
            .gap(px(32.))
            .child(
                div()
                    .w(px(240.))
                    .flex_shrink_0()
                    .flex()
                    .flex_col()
                    .gap(px(16.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(12.))
                            .child(
                                self.card()
                                    .size(px(44.))
                                    .flex_shrink_0()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .child(glyph(mode.icon, 20., theme.gray_12)),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(3.))
                                    .child(
                                        copy(mode.title, 18., theme.gray_12)
                                            .font_weight(FontWeight::BOLD),
                                    )
                                    .child(
                                        copy(mode.tagline, 11., theme.gray_9)
                                            .font_weight(FontWeight::MEDIUM),
                                    ),
                            ),
                    )
                    .child(copy(mode.description, 13., theme.gray_10).line_height(px(20.)))
                    .child(div().flex().flex_col().gap(px(10.)).children(
                        mode.features.iter().map(|feature| {
                            div()
                                .flex()
                                .items_center()
                                .gap(px(10.))
                                .child(
                                    div()
                                        .size(px(20.))
                                        .rounded_full()
                                        .bg(theme.blue_9)
                                        .flex_shrink_0()
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .child(glyph("icons/check.svg", 10., gpui::white())),
                                )
                                .child(copy(*feature, 12., theme.gray_11))
                        }),
                    )),
            )
            .child(
                self.card()
                    .flex_1()
                    .min_w_0()
                    .h(px(if index == 1 { 300. } else { 288. }))
                    .rounded(px(16.))
                    .p(px(16.))
                    .child(self.render_demo(index)),
            )
            .into_any_element()
    }

    fn choose_mode(&mut self, index: usize, cx: &mut Context<Self>) {
        let Some(mode) = MODES.get(index) else {
            return;
        };
        self.chosen_mode = Some(index);
        self.demo_task = None;
        let mode = mode.mode;
        cx.defer(move |cx| crate::app_windows::set_recording_mode(mode, cx));
        cx.notify();
    }

    fn render_toggle(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let active = self.chosen_mode.unwrap_or(self.demo_phase % MODES.len());
        div()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .min_h_full()
            .px(px(48.))
            .gap(px(32.))
            .child(self.heading(
                "Switch modes anytime",
                "Toggle between modes with a single click from the main Cap window.",
                None,
            ))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(20.))
                    .child(
                        self.card()
                            .rounded_full()
                            .flex()
                            .gap(px(24.))
                            .p(px(16.))
                            .children(MODES.iter().enumerate().map(|(index, mode)| {
                                div()
                                    .id(("onboarding-mode", index))
                                    .tab_index(0)
                                    .size(px(80.))
                                    .rounded_full()
                                    .border_2()
                                    .border_color(if active == index {
                                        theme.blue_9
                                    } else {
                                        theme.gray_5
                                    })
                                    .bg(if active == index {
                                        theme.body_fill(7)
                                    } else if theme.is_dark() {
                                        theme.body_fill(3)
                                    } else {
                                        gpui::white()
                                    })
                                    .cursor_pointer()
                                    .hover(|el| el.opacity(0.85))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.choose_mode(index, cx)
                                    }))
                                    .child(
                                        glyph(
                                            mode.icon,
                                            if active == index { 35. } else { 32. },
                                            theme.gray_12,
                                        )
                                        .opacity(if active == index { 1. } else { 0.5 }),
                                    )
                            })),
                    )
                    .child(div().flex().gap(px(24.)).px(px(16.)).children(
                        MODES.iter().enumerate().map(|(index, mode)| {
                            copy(
                                mode.title,
                                14.,
                                if active == index {
                                    theme.gray_12
                                } else {
                                    theme.gray_9
                                },
                            )
                            .w(px(80.))
                            .text_center()
                            .font_weight(FontWeight::MEDIUM)
                            .id(("onboarding-mode-label", index))
                            .cursor_pointer()
                            .on_click(
                                cx.listener(move |this, _, _, cx| this.choose_mode(index, cx)),
                            )
                        }),
                    )),
            )
            .into_any_element()
    }

    fn render_shortcuts(&self) -> AnyElement {
        let theme = self.theme;
        div().flex().flex_col().items_center().justify_center().min_h_full().px(px(48.)).gap(px(24.))
            .child(self.heading("Make Cap yours", "Customize everything from keyboard shortcuts to storage. Cap adapts to your workflow.", Some("icons/settings.svg")))
            .child(div().flex().flex_col().w_full().max_w(px(420.)).gap(px(8.)).children([
                ("Keyboard Shortcuts", "Global hotkeys for recording, screenshots, and switching modes"),
                ("Custom S3 Storage", "Connect your own S3-compatible bucket for full control over your recordings"),
                ("Custom Domain", "Use your own domain for shareable links instead of cap.so"),
                ("Recording Preferences", "FPS, quality, countdown timer, cursor effects, and more"),
            ].into_iter().map(|(title, description)| {
                self.card().px(px(16.)).py(px(12.)).flex().flex_col().gap(px(4.))
                    .child(copy(title, 13., theme.gray_12).font_weight(FontWeight::MEDIUM))
                    .child(copy(description, 11., theme.gray_10).line_height(px(15.)))
            })))
            .child(copy("Change any of these at any time in Settings", 12., theme.gray_9))
            .into_any_element()
    }

    fn render_faq(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        div()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .min_h_full()
            .px(px(48.))
            .py(px(24.))
            .gap(px(24.))
            .child(self.heading(
                "Frequently Asked Questions",
                "Everything you need to know to get started.",
                None,
            ))
            .child(
                self.card()
                    .w_full()
                    .max_w(px(480.))
                    .overflow_hidden()
                    .children(FAQ.iter().enumerate().map(|(index, (question, answer))| {
                        let open = self.faq_open[index];
                        div()
                            .when(index > 0, |el| {
                                el.border_t_1().border_color(theme.body_border(4))
                            })
                            .child(
                                div()
                                    .id(("onboarding-faq", index))
                                    .tab_index(0)
                                    .cursor_pointer()
                                    .px(px(20.))
                                    .py(px(16.))
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .gap(px(12.))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.faq_open[index] = !this.faq_open[index];
                                        cx.notify();
                                    }))
                                    .child(
                                        copy(*question, 13., theme.gray_12)
                                            .font_weight(FontWeight::MEDIUM),
                                    )
                                    .child(glyph(
                                        if open {
                                            "icons/chevron-up.svg"
                                        } else {
                                            "icons/chevron-down.svg"
                                        },
                                        16.,
                                        theme.gray_10,
                                    )),
                            )
                            .when(open, |el| {
                                el.child(
                                    div()
                                        .px(px(20.))
                                        .pb(px(16.))
                                        .child(
                                            copy(*answer, 13., theme.gray_10).line_height(px(20.)),
                                        )
                                        .when(index == 0, |el| {
                                            el.child(
                                                copy("View pricing plans", 13., theme.blue_10)
                                                    .id("onboarding-faq-pricing")
                                                    .cursor_pointer()
                                                    .mt(px(8.))
                                                    .on_click(|_, _, cx| {
                                                        cx.open_url("https://cap.so/pricing")
                                                    }),
                                            )
                                        }),
                                )
                            })
                    })),
            )
            .child(
                copy("View pricing plans ↗", 13., theme.blue_10)
                    .id("onboarding-pricing")
                    .cursor_pointer()
                    .on_click(|_, _, cx| cx.open_url("https://cap.so/pricing")),
            )
            .into_any_element()
    }

    fn render_navigation(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let first = self.first_step as usize;
        let current = self.step as usize - first;
        let total = if self.permissions_only {
            1
        } else {
            Step::ALL.len() - first
        };
        let disabled = self.step == Step::Permissions && !self.state.necessary_granted();
        let last = self.permissions_only || self.step == Step::Faq;
        let label = if self.permissions_only {
            "Continue to Cap"
        } else if last {
            "Start Using Cap"
        } else {
            "Continue"
        };
        div()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(8.))
            .px(px(32.))
            .pb(px(20.))
            .pt(px(8.))
            .flex_shrink_0()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .w_full()
                    .child(div().flex_1().when(current > 0, |el| {
                        el.child(
                            copy("←  Back", 13., theme.gray_10)
                                .id("onboarding-back")
                                .cursor_pointer()
                                .hover(move |el| el.text_color(theme.gray_12))
                                .on_click(cx.listener(|this, _, window, cx| this.back(window, cx))),
                        )
                    }))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(4.))
                            .children((0..total).map(|index| {
                                div()
                                    .h(px(6.))
                                    .w(px(if current == index { 20. } else { 6. }))
                                    .rounded_full()
                                    .bg(if current == index {
                                        theme.gray_12
                                    } else if current > index {
                                        theme.gray_8
                                    } else {
                                        theme.gray_5
                                    })
                            })),
                    )
                    .child(
                        div().flex_1().flex().justify_end().child(
                            div()
                                .flex()
                                .flex_col()
                                .items_center()
                                .gap(px(6.))
                                .child(
                                    div()
                                        .id("onboarding-continue")
                                        .tab_index(0)
                                        .min_w(px(152.))
                                        .min_h(px(48.))
                                        .px(px(40.))
                                        .py(px(12.))
                                        .rounded_full()
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .gap(px(8.))
                                        .bg(if disabled {
                                            theme.gray_6
                                        } else {
                                            theme.gray_12
                                        })
                                        .text_color(if disabled {
                                            theme.gray_9
                                        } else {
                                            theme.gray_1
                                        })
                                        .when(!disabled, |el| {
                                            el.cursor_pointer().on_click(cx.listener(
                                                |this, _, window, cx| this.next(window, cx),
                                            ))
                                        })
                                        .child(
                                            div()
                                                .text_size(px(15.))
                                                .font_weight(FontWeight::MEDIUM)
                                                .child(label),
                                        )
                                        .child(glyph(
                                            if last {
                                                "icons/check.svg"
                                            } else {
                                                "icons/move-right.svg"
                                            },
                                            16.,
                                            if disabled { theme.gray_9 } else { theme.gray_1 },
                                        )),
                                )
                                .when(
                                    self.state.necessary_granted() && !self.permissions_only,
                                    |el| {
                                        el.child(
                                            copy("Skip onboarding", 11., theme.gray_9)
                                                .id("onboarding-skip")
                                                .cursor_pointer()
                                                .on_click(
                                                    cx.listener(|this, _, _, cx| this.finish(cx)),
                                                ),
                                        )
                                    },
                                ),
                        ),
                    ),
            )
            .child(copy(
                "Press Enter ↵ or use ← → arrow keys",
                10.,
                theme.gray_8,
            ))
            .when_some(self.error.clone(), |el, error| {
                el.child(copy(error, 12., theme.gray_12))
            })
            .into_any_element()
    }
}

impl OnboardingWindow {
    fn demo_steps(&self, labels: [&'static str; 3], active: usize) -> Div {
        let theme = self.theme;
        div()
            .flex()
            .items_center()
            .justify_center()
            .gap(px(8.))
            .pb(px(12.))
            .children(labels.into_iter().enumerate().map(|(index, label)| {
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .when(index > 0, |el| {
                        el.child(div().w(px(12.)).h(px(1.)).bg(theme.gray_5))
                    })
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(5.))
                            .px(px(8.))
                            .py(px(4.))
                            .rounded_full()
                            .border_1()
                            .border_color(if index == active {
                                theme.blue_5
                            } else {
                                theme.gray_4
                            })
                            .bg(if index == active {
                                Hsla::from(theme.blue_3)
                            } else {
                                theme.body_fill(1)
                            })
                            .child(copy(
                                format!("{}", index + 1),
                                9.,
                                if index == active {
                                    theme.blue_11
                                } else {
                                    theme.gray_9
                                },
                            ))
                            .child(copy(
                                label,
                                10.,
                                if index == active {
                                    theme.blue_11
                                } else {
                                    theme.gray_10
                                },
                            )),
                    )
            }))
    }

    fn demo_cursor(&self) -> gpui::Img {
        let windows = cfg!(target_os = "windows");
        img(if windows {
            "onboarding/cursor-windows.svg"
        } else {
            "onboarding/cursor-macos.svg"
        })
        .w(px(if windows { 24. } else { 22. }))
        .h(px(if windows { 34. } else { 32. }))
        .object_fit(ObjectFit::Contain)
    }

    fn demo_start(&self, index: usize) -> AnyElement {
        let theme = self.theme;
        let cursor = div().absolute().child(self.demo_cursor());
        let cursor = if self.animated {
            cursor
                .with_animation(
                    ("demo-start-cursor", self.demo_cycle),
                    Animation::new(Duration::from_millis(1950)),
                    |el, t| {
                        let arrival = ease(((t * 1950. - 40.) / 1450.).clamp(0., 1.));
                        let press = if t * 1950. >= 1770. { 3. } else { 0. };
                        el.left(px(-44. + 124. * arrival))
                            .top(px(54. - 28. * arrival + press))
                    },
                )
                .into_any_element()
        } else {
            cursor.left(px(80.)).top(px(29.)).into_any_element()
        };
        div()
            .relative()
            .w_full()
            .max_w(px(288.))
            .pb(px(32.))
            .child(
                div()
                    .h(px(44.))
                    .w_full()
                    .rounded_full()
                    .flex()
                    .overflow_hidden()
                    .bg(linear_gradient(
                        90.,
                        linear_color_stop(theme.blue_10, 0.),
                        linear_color_stop(theme.blue_11, 1.),
                    ))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .items_center()
                            .pl(px(16.))
                            .gap(px(12.))
                            .child(glyph(MODES[index].icon, 16., gpui::white()))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .child(
                                        copy("Start Recording", 15., gpui::white())
                                            .font_weight(FontWeight::MEDIUM)
                                            .whitespace_nowrap(),
                                    )
                                    .child(
                                        copy(MODES[index].title, 11., gpui::white()).opacity(0.9),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .px(px(12.))
                            .border_l_1()
                            .border_color(rgba(0xffffff33))
                            .bg(rgba(0xffffff0d))
                            .child(glyph("icons/caret-down.svg", 16., gpui::white())),
                    ),
            )
            .child(cursor)
            .into_any_element()
    }

    fn demo_recording(&self) -> Div {
        let theme = self.theme;
        let stopped = self.demo_phase >= 6;
        let time = format!("0:0{}", self.demo_phase.saturating_sub(2).min(3));
        self.card()
            .bg(if theme.is_dark() {
                theme.gray_1.into()
            } else {
                gpui::white()
            })
            .w_full()
            .min_w(px(280.))
            .h(px(40.))
            .rounded(px(16.))
            .flex()
            .items_stretch()
            .overflow_hidden()
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .justify_between()
                    .p(px(4.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(4.))
                            .px(px(8.))
                            .flex_shrink_0()
                            .when(stopped, |el| {
                                el.child(div().size(px(8.)).rounded_full().bg(theme.gray_8))
                            })
                            .when(!stopped, |el| {
                                el.child(glyph("icons/stop-circle.svg", 20., rgb(0xf87171)))
                            })
                            .child(copy(
                                if stopped { "Stopped".into() } else { time },
                                14.,
                                if stopped {
                                    Hsla::from(theme.gray_10)
                                } else {
                                    rgb(0xf87171).into()
                                },
                            )),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .opacity(if stopped { 0.45 } else { 1. })
                            .child(
                                div()
                                    .relative()
                                    .size(px(28.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .child(glyph("icons/microphone.svg", 20., theme.gray_12))
                                    .child(
                                        div()
                                            .absolute()
                                            .bottom(px(3.))
                                            .left(px(4.))
                                            .right(px(4.))
                                            .h(px(2.))
                                            .rounded_full()
                                            .bg(theme.gray_10)
                                            .child(
                                                div().w(relative(0.6)).h_full().bg(theme.blue_9),
                                            ),
                                    ),
                            )
                            .children(
                                [
                                    "icons/pause-circle.svg",
                                    "icons/restart.svg",
                                    "icons/trash.svg",
                                    "icons/settings.svg",
                                ]
                                .into_iter()
                                .map(|path| {
                                    div()
                                        .size(px(28.))
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .child(glyph(path, 20., theme.gray_11))
                                }),
                            ),
                    ),
            )
            .child(
                div()
                    .w(px(32.))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .border_l_1()
                    .border_color(theme.gray_5)
                    .opacity(if stopped { 0.45 } else { 1. })
                    .child(glyph("icons/more-vertical.svg", 20., theme.gray_10)),
            )
    }

    fn demo_link(&self) -> Div {
        let theme = self.theme;
        let copied = self.demo_phase >= 8;
        self.card()
            .bg(if theme.is_dark() {
                theme.gray_1.into()
            } else {
                gpui::white()
            })
            .w_full()
            .max_w(px(340.))
            .overflow_hidden()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .px(px(16.))
                    .pt(px(14.))
                    .pb(px(10.))
                    .child(
                        div()
                            .size(px(20.))
                            .rounded_full()
                            .bg(self.success_palette().0)
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(glyph("icons/check.svg", 12., self.success_palette().2)),
                    )
                    .child(copy("Link ready to share!", 12., theme.gray_12)),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .m(px(12.))
                    .mt_0()
                    .p(px(8.))
                    .rounded(px(8.))
                    .bg(theme.body_fill(3))
                    .child(
                        copy("cap.so/s/m4k92x", 11., theme.gray_11)
                            .flex_1()
                            .min_w_0(),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(4.))
                            .px(px(8.))
                            .py(px(5.))
                            .rounded(px(6.))
                            .bg(if copied {
                                self.success_palette().0
                            } else {
                                theme.body_fill(1)
                            })
                            .child(glyph(
                                if copied {
                                    "icons/check.svg"
                                } else {
                                    "icons/copy.svg"
                                },
                                12.,
                                if copied {
                                    self.success_palette().2
                                } else {
                                    theme.body_text()
                                },
                            ))
                            .child(copy(
                                if copied { "Copied!" } else { "Copy" },
                                11.,
                                if copied {
                                    self.success_palette().2
                                } else {
                                    theme.body_text()
                                },
                            )),
                    ),
            )
    }

    fn demo_document(&self) -> Div {
        let theme = self.theme;
        self.card()
            .bg(if theme.is_dark() {
                theme.gray_1.into()
            } else {
                gpui::white()
            })
            .flex()
            .flex_col()
            .justify_center()
            .gap(px(6.))
            .p(px(12.))
            .child(
                div()
                    .w(relative(0.75))
                    .h(px(6.))
                    .rounded_full()
                    .bg(theme.gray_5)
                    .opacity(0.5),
            )
            .child(
                div()
                    .w(relative(0.5))
                    .h(px(6.))
                    .rounded_full()
                    .bg(theme.gray_5)
                    .opacity(0.3),
            )
            .child(
                div()
                    .w_full()
                    .h(px(20.))
                    .mt(px(4.))
                    .rounded(px(3.))
                    .bg(theme.gray_5)
                    .opacity(0.2),
            )
    }

    fn demo_editor(&self) -> Div {
        let theme = self.theme;
        let phase = self.demo_phase;
        let progress = if phase >= 11 {
            100
        } else if phase >= 10 {
            75
        } else {
            25
        };
        self.card()
            .bg(if theme.is_dark() {
                theme.gray_1.into()
            } else {
                gpui::white()
            })
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .overflow_hidden()
            .child(
                div()
                    .flex()
                    .h(px(36.))
                    .flex_shrink_0()
                    .items_center()
                    .justify_between()
                    .px(px(12.))
                    .border_b_1()
                    .border_color(theme.gray_3)
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .child(self.demo_window_dots())
                            .child(copy("Cap Editor", 10., theme.gray_11)),
                    )
                    .child(
                        copy("Export", 9., gpui::white())
                            .px(px(10.))
                            .py(px(4.))
                            .rounded(px(6.))
                            .bg(theme.blue_9)
                            .when(phase >= 8, |el| el.border_2().border_color(theme.blue_5)),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .relative()
                    .child(
                        div().flex_1().min_w_0().p(px(12.)).child(
                            div()
                                .size_full()
                                .p(px(10.))
                                .rounded(px(8.))
                                .bg(linear_gradient(
                                    135.,
                                    linear_color_stop(rgb(0x667eea), 0.),
                                    linear_color_stop(rgb(0x764ba2), 1.),
                                ))
                                .child(self.demo_document().w_full().h(px(80.))),
                        ),
                    )
                    .child(
                        div()
                            .w(px(90.))
                            .flex_shrink_0()
                            .border_l_1()
                            .border_color(theme.gray_3)
                            .p(px(8.))
                            .flex()
                            .flex_col()
                            .gap(px(6.))
                            .child(copy("STYLE", 8., theme.gray_9))
                            .child(
                                div()
                                    .h(px(20.))
                                    .rounded(px(3.))
                                    .border_1()
                                    .border_color(theme.gray_3)
                                    .bg(theme.body_fill(2)),
                            )
                            .child(copy("BACKGROUND", 8., theme.gray_9).mt(px(4.)))
                            .child(div().flex().gap(px(4.)).children(
                                [0x667eea, 0xf78c88, 0xcccccc].map(|color| {
                                    div()
                                        .size(px(16.))
                                        .rounded_full()
                                        .border_1()
                                        .border_color(theme.gray_3)
                                        .bg(rgb(color))
                                }),
                            )),
                    )
                    .when(phase >= 9, |el| {
                        el.child(
                            div()
                                .absolute()
                                .inset_0()
                                .bg(rgba(0x00000040))
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(
                                    self.card()
                                        .min_w(px(200.))
                                        .px(px(24.))
                                        .py(px(20.))
                                        .flex()
                                        .flex_col()
                                        .items_center()
                                        .gap(px(12.))
                                        .child(
                                            div()
                                                .flex()
                                                .items_center()
                                                .gap(px(8.))
                                                .when(phase >= 11, |el| {
                                                    el.child(glyph(
                                                        "icons/check.svg",
                                                        18.,
                                                        self.success_palette().2,
                                                    ))
                                                })
                                                .child(copy(
                                                    if phase >= 11 {
                                                        "Export complete!"
                                                    } else {
                                                        "Exporting..."
                                                    },
                                                    14.,
                                                    theme.gray_12,
                                                )),
                                        )
                                        .child(
                                            div()
                                                .w_full()
                                                .h(px(8.))
                                                .rounded_full()
                                                .bg(theme.gray_4)
                                                .overflow_hidden()
                                                .child(
                                                    div()
                                                        .h_full()
                                                        .w(relative(progress as f32 / 100.))
                                                        .rounded_full()
                                                        .bg(theme.blue_9),
                                                ),
                                        )
                                        .child(copy(format!("{progress}%"), 12., theme.gray_10)),
                                ),
                        )
                    }),
            )
            .child(
                div()
                    .flex_shrink_0()
                    .border_t_1()
                    .border_color(theme.gray_3)
                    .px(px(12.))
                    .py(px(8.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .h(px(24.))
                            .px(px(8.))
                            .rounded(px(8.))
                            .border_1()
                            .border_color(theme.gray_3)
                            .child(
                                div()
                                    .flex_1()
                                    .h(px(3.))
                                    .rounded_full()
                                    .bg(theme.gray_4)
                                    .child(
                                        div()
                                            .w(relative(0.42))
                                            .h_full()
                                            .rounded_full()
                                            .bg(theme.gray_8),
                                    ),
                            )
                            .child(copy("0:12", 8., theme.gray_10)),
                    ),
            )
    }

    fn demo_window_dots(&self) -> Div {
        div()
            .flex()
            .gap(px(4.))
            .children((0..3).map(|_| div().size(px(8.)).rounded_full().bg(self.theme.gray_6)))
    }

    fn demo_screenshot(&self) -> AnyElement {
        let theme = self.theme;
        let phase = self.demo_phase;
        if phase <= 5 {
            let selection = div()
                .absolute()
                .left(relative(0.06))
                .top(relative(0.1))
                .w(relative(0.84))
                .h(relative(0.78))
                .border_2()
                .border_color(theme.blue_9)
                .bg(rgba(0xffffff12))
                .when(phase >= 4, |el| {
                    el.children(
                        [(false, false), (false, true), (true, false), (true, true)].map(
                            |(right, bottom)| {
                                div()
                                    .absolute()
                                    .size(px(6.))
                                    .rounded(px(1.))
                                    .bg(gpui::white())
                                    .border_1()
                                    .border_color(theme.blue_9)
                                    .when(right, |el| el.right(px(-3.)))
                                    .when(!right, |el| el.left(px(-3.)))
                                    .when(bottom, |el| el.bottom(px(-3.)))
                                    .when(!bottom, |el| el.top(px(-3.)))
                            },
                        ),
                    )
                })
                .child(
                    copy("640 × 480", 10., gpui::white())
                        .absolute()
                        .bottom(px(-26.))
                        .left(relative(0.35))
                        .rounded(px(4.))
                        .px(px(8.))
                        .py(px(3.))
                        .bg(rgba(0x000000b3)),
                );
            let selection = if phase == 3 && self.animated {
                selection
                    .with_animation(
                        ("screenshot-selection", self.demo_cycle),
                        Animation::new(Duration::from_millis(1200)).with_easing(ease),
                        |el, t| el.w(relative(0.84 * t)).h(relative(0.78 * t)),
                    )
                    .into_any_element()
            } else {
                selection.into_any_element()
            };
            return self
                .demo_document()
                .relative()
                .w_full()
                .max_w(px(380.))
                .h(px(200.))
                .overflow_hidden()
                .opacity(if phase == 0 { 0. } else { 1. })
                .when(phase >= 2, |el| {
                    el.child(div().absolute().inset_0().bg(rgba(0x00000073)))
                })
                .when(phase >= 3, |el| el.child(selection))
                .when(phase == 2, |el| {
                    el.child(
                        self.demo_cursor()
                            .absolute()
                            .left(relative(0.06))
                            .top(relative(0.1)),
                    )
                })
                .when(phase == 5, |el| {
                    el.child(div().absolute().inset_0().bg(rgba(0xffffff4d)))
                })
                .into_any_element();
        }
        self.card()
            .w_full()
            .max_w(px(420.))
            .overflow_hidden()
            .child(
                div()
                    .h(px(40.))
                    .flex()
                    .items_center()
                    .justify_between()
                    .px(px(12.))
                    .border_b_1()
                    .border_color(theme.gray_3)
                    .child(self.demo_window_dots())
                    .child(
                        div().flex().gap(px(4.)).children(
                            [
                                "icons/cursor.svg",
                                "icons/square.svg",
                                "icons/circle.svg",
                                "icons/move-right.svg",
                                "icons/type.svg",
                            ]
                            .map(|path| {
                                div()
                                    .size(px(20.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(4.))
                                    .bg(theme.body_fill(3))
                                    .child(glyph(path, 12., theme.gray_11))
                            }),
                        ),
                    )
                    .child(
                        div()
                            .flex()
                            .gap(px(4.))
                            .child(
                                copy("Copy", 9., theme.gray_12)
                                    .px(px(6.))
                                    .py(px(4.))
                                    .rounded(px(4.))
                                    .bg(theme.body_fill(3)),
                            )
                            .child(
                                copy("Save", 9., gpui::white())
                                    .px(px(6.))
                                    .py(px(4.))
                                    .rounded(px(4.))
                                    .bg(theme.blue_9),
                            ),
                    ),
            )
            .child(
                div().p(px(12.)).child(
                    div()
                        .relative()
                        .h(px(140.))
                        .w_full()
                        .overflow_hidden()
                        .rounded(px(4.))
                        .when(phase >= 7, |el| {
                            el.bg(linear_gradient(
                                135.,
                                linear_color_stop(rgb(0x667eea), 0.),
                                linear_color_stop(rgb(0x764ba2), 1.),
                            ))
                        })
                        .child(
                            self.demo_document()
                                .absolute()
                                .inset(px(if phase >= 8 { 12. } else { 0. }))
                                .rounded(px(if phase >= 8 { 8. } else { 0. })),
                        )
                        .when(phase >= 9, |el| {
                            el.child(
                                div()
                                    .absolute()
                                    .bottom(px(8.))
                                    .left_0()
                                    .right_0()
                                    .flex()
                                    .justify_center()
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .gap(px(6.))
                                            .px(px(12.))
                                            .py(px(6.))
                                            .rounded_full()
                                            .bg(theme.body_fill(1))
                                            .child(glyph(
                                                "icons/check.svg",
                                                12.,
                                                self.success_palette().2,
                                            ))
                                            .child(copy("Copied to clipboard", 11., theme.gray_12)),
                                    ),
                            )
                        }),
                ),
            )
            .into_any_element()
    }

    fn render_demo(&self, index: usize) -> AnyElement {
        let phase = self.demo_phase;
        let (labels, active) = match index {
            0 => (
                ["Record", "Stop", "Share link"],
                if phase <= 5 {
                    0
                } else if phase == 6 {
                    1
                } else {
                    2
                },
            ),
            1 => (
                ["Record", "Edit", "Export"],
                if phase < 7 {
                    0
                } else if phase < 9 {
                    1
                } else {
                    2
                },
            ),
            _ => (
                ["Select area", "Beautify", "Copy"],
                if phase <= 5 {
                    0
                } else if phase <= 8 {
                    1
                } else {
                    2
                },
            ),
        };
        let content = if index == 2 {
            self.demo_screenshot()
        } else if phase <= 1 {
            div()
                .w_full()
                .flex()
                .justify_center()
                .opacity(if phase == 0 { 0. } else { 1. })
                .child(self.demo_start(index))
                .into_any_element()
        } else if phase <= 6 {
            self.demo_recording().into_any_element()
        } else if index == 0 {
            self.demo_link().into_any_element()
        } else {
            self.demo_editor().into_any_element()
        };
        div()
            .size_full()
            .flex()
            .flex_col()
            .child(self.demo_steps(labels, active))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(content),
            )
            .into_any_element()
    }
}

impl Render for OnboardingWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.theme = Theme::for_window(window, cx, true);
        let theme = self.theme;
        let viewport = window.viewport_size();
        let width = f32::from(viewport.width);
        let height = (f32::from(viewport.height) - ONBOARDING_HEADER_HEIGHT).max(0.);
        let content = match self.step {
            Step::Permissions => self.render_permissions(cx),
            Step::Overview => self.render_overview(),
            Step::Instant => self.render_detail(0),
            Step::Studio => self.render_detail(1),
            Step::Screenshot => self.render_detail(2),
            Step::Toggle => self.render_toggle(cx),
            Step::Shortcuts => self.render_shortcuts(),
            Step::Faq => self.render_faq(cx),
        };
        let content = div().relative().min_h_full().w_full().child(content);
        let content = if self.animated && !self.welcome {
            let direction = self.transition_direction;
            content
                .with_animation(
                    ("onboarding-step", self.step_revision),
                    Animation::new(Duration::from_millis(500)).with_easing(ease),
                    move |el, t| el.left(px(direction * 24. * (1. - t))).opacity(t),
                )
                .into_any_element()
        } else {
            content.into_any_element()
        };
        let header = div()
            .id("onboarding-header")
            .h(px(ONBOARDING_HEADER_HEIGHT))
            .flex_shrink_0()
            .w_full()
            .flex()
            .items_center()
            .justify_between()
            .bg(theme.header_bg())
            .border_b_1()
            .border_color(theme.header_border())
            .window_control_area(gpui::WindowControlArea::Drag);
        #[cfg(target_os = "windows")]
        let header = header.justify_end().child(ui::windows_caption_controls(
            theme,
            window.is_window_active(),
            window.is_maximized(),
            true,
            false,
        ));
        #[cfg(not(target_os = "windows"))]
        let header = header
            .on_mouse_down(gpui::MouseButton::Left, |_, window, _| {
                window.start_window_move()
            })
            .child(
                div()
                    .id("onboarding-close")
                    .group("onboarding-close")
                    .tab_index(0)
                    .size(px(14.))
                    .ml(px(12.))
                    .rounded_full()
                    .bg(rgb(Theme::TRAFFIC_CLOSE))
                    .hover(|el| el.bg(rgb(0xf25a53)))
                    .active(|el| el.bg(rgb(0xe6564e)))
                    .cursor_default()
                    .flex()
                    .items_center()
                    .justify_center()
                    .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(
                        cx.listener(|_, _, _, cx| cx.defer(crate::app_windows::close_onboarding)),
                    )
                    .child(
                        glyph("icons/traffic-close.svg", 10., rgba(0x00000080))
                            .invisible()
                            .group_hover("onboarding-close", |el| el.visible()),
                    ),
            );
        div()
            .id("onboarding")
            .track_focus(&self.focus)
            .key_context("OnboardingWindow")
            .capture_key_down(cx.listener(Self::on_key))
            .size_full()
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(px(16.))
            .bg(theme.shell_bg())
            .font_family("Geist")
            .font_weight(FontWeight::MEDIUM)
            .text_color(theme.body_text())
            .child(header)
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .overflow_hidden()
                    .when(!self.welcome, |el| {
                        el.child(self.ambient(width, height, false))
                    })
                    .when(!self.welcome, |el| {
                        el.child(
                            div()
                                .relative()
                                .size_full()
                                .flex()
                                .flex_col()
                                .child(
                                    div()
                                        .id("onboarding-scroll")
                                        .flex_1()
                                        .min_h_0()
                                        .w_full()
                                        .overflow_y_scroll()
                                        .child(content),
                                )
                                .child(self.render_navigation(cx)),
                        )
                    })
                    .when(self.welcome, |el| {
                        el.child(self.render_welcome(width, height, cx))
                    }),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::{MediaAuthorization, RawPermissions};

    #[test]
    fn first_run_visits_every_platform_stage_and_back_never_opens_an_omitted_step() {
        for (macos, expected) in [(true, 8), (false, 7)] {
            let first = Step::first(macos, false);
            let mut visited = vec![first];
            while let Some(next) = visited.last().unwrap().next(false, true) {
                visited.push(next);
            }
            assert_eq!(visited.len(), expected);
            assert_eq!(visited.last(), Some(&Step::Faq));
            for pair in visited.windows(2).rev() {
                assert_eq!(pair[1].previous(first), Some(pair[0]));
            }
            assert_eq!(first.previous(first), None);
            assert_eq!(visited.contains(&Step::Permissions), macos);
        }
    }

    #[test]
    fn permissions_revisit_stays_on_required_permissions_on_every_platform() {
        for macos in [false, true] {
            let first = Step::first(macos, true);
            assert_eq!(first, Step::Permissions);
            assert_eq!(first.next(true, false), None);
            assert_eq!(first.next(true, true), None);
            assert_eq!(first.previous(first), None);
        }
    }

    #[test]
    fn denied_optional_devices_do_not_block_the_tour_but_either_required_permission_does() {
        for (screen, accessibility) in [(false, false), (false, true), (true, false), (true, true)]
        {
            let state = PermissionsState::from_raw(Some(RawPermissions {
                screen_granted: screen,
                accessibility_granted: accessibility,
                microphone: MediaAuthorization::Denied,
                camera: MediaAuthorization::Restricted,
            }));
            assert_eq!(
                Step::Permissions.next(false, state.necessary_granted()),
                (screen && accessibility).then_some(Step::Overview)
            );
            assert!(!state.all_shown_granted());
        }
    }

    #[test]
    fn a_revoked_required_permission_blocks_continuing_after_a_refresh() {
        let mut raw = RawPermissions {
            screen_granted: true,
            accessibility_granted: true,
            microphone: MediaAuthorization::Authorized,
            camera: MediaAuthorization::Authorized,
        };
        let mut state = PermissionsState::from_raw(Some(raw));
        assert_eq!(
            Step::Permissions.next(false, state.necessary_granted()),
            Some(Step::Overview)
        );
        raw.screen_granted = false;
        assert!(state.apply_raw(Some(raw)));
        assert_eq!(
            Step::Permissions.next(false, state.necessary_granted()),
            None
        );
    }
}
