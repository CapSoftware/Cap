use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use cap_meetings::prompt::{Countdown, Prompt};
use cap_meetings::settings::PromptPosition;
use chrono::Utc;
use gpui::{
    AnyWindowHandle, App, AppContext as _, Bounds, Context, FontWeight, Global, Hsla,
    InteractiveElement, IntoElement, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, Task, Window, WindowBackgroundAppearance, WindowBounds,
    WindowHandle, WindowKind, WindowOptions, div, img, point, prelude::FluentBuilder, px, size,
    svg,
};

use super::model::{self, Glyph, PromptLine, PromptPrimary, PromptTitle, PromptView, Rect};
use super::native::{self, Panel};
use crate::i18n::tr;
use crate::theme::{LocaleFont as _, Theme};

pub const TITLE: &str = "Cap Meeting Prompt";
const MENU_LINGER: Duration = Duration::from_millis(1200);

#[derive(Clone)]
enum MenuAction {
    JoinOnly(String),
    OpenCap,
    Mute(String),
    Settings,
}

struct CountdownAnchor {
    key: Countdown,
    at: Instant,
    total: Duration,
}

pub struct PromptCard {
    prompt: Prompt,
    theme: Theme,
    hovered: bool,
    menu_open: bool,
    menu_close: Option<Task<()>>,
    icon: Option<Arc<gpui::Image>>,
    countdown: Option<CountdownAnchor>,
    tick: Option<Task<()>>,
    tick_fast: bool,
    panel: Option<Panel>,
    /// Keys reach the card only once someone clicks into it: the panel
    /// never takes focus from the call by itself.
    focus: gpui::FocusHandle,
}

impl PromptCard {
    fn new(prompt: Prompt, window: &mut Window, cx: &mut Context<Self>) -> Self {
        crate::theme::bind_window(window, cx);
        let mut this = Self {
            icon: None,
            theme: Theme::for_window(window, cx, cfg!(target_os = "macos")),
            hovered: false,
            menu_open: false,
            menu_close: None,
            countdown: None,
            tick: None,
            tick_fast: false,
            panel: None,
            focus: cx.focus_handle(),
            prompt,
        };
        this.anchor_countdown();
        this
    }

    fn set_prompt(&mut self, prompt: Prompt, cx: &mut Context<Self>) {
        if self.prompt != prompt {
            self.prompt = prompt;
            self.anchor_countdown();
            cx.notify();
        }
    }

    fn anchor_countdown(&mut self) {
        match self.prompt.countdown {
            Some(countdown) if self.countdown.as_ref().is_none_or(|a| a.key != countdown) => {
                self.countdown = Some(CountdownAnchor {
                    key: countdown,
                    at: Instant::now(),
                    total: Duration::from_millis(countdown.ends_at.since(countdown.started_at)),
                });
            }
            Some(_) => {}
            None => self.countdown = None,
        }
    }

    fn countdown_progress(&self) -> Option<(u64, f32)> {
        let anchor = self.countdown.as_ref()?;
        let elapsed = anchor.at.elapsed().min(anchor.total);
        let left = anchor.total.saturating_sub(elapsed);
        let fraction = if anchor.total.is_zero() {
            1.
        } else {
            elapsed.as_secs_f32() / anchor.total.as_secs_f32()
        };
        Some((left.as_millis().div_ceil(1000) as u64, fraction))
    }

    /// A clock while a meeting is coming up; ten times a second while the
    /// countdown line drains, instead of every frame.
    fn ensure_tick(&mut self, needed: bool, fast: bool, cx: &mut Context<Self>) {
        if !needed {
            self.tick = None;
            return;
        }
        if self.tick.is_some() && self.tick_fast == fast {
            return;
        }
        self.tick_fast = fast;
        let every = Duration::from_millis(if fast { 100 } else { 1000 });
        self.tick = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(every).await;
                if this.update(cx, |_, cx| cx.notify()).is_err() {
                    return;
                }
            }
        }));
    }

    fn view(&self, cx: &App) -> PromptView {
        let settings = super::settings(cx).unwrap_or_default();
        model::prompt_view(
            &self.prompt,
            &super::calls(cx),
            &super::events(cx),
            settings.notifications.show_join,
            self.countdown_progress().map(|(left, _)| left),
            Utc::now(),
        )
    }

    fn menu_items(&self, view: &PromptView) -> Vec<(String, MenuAction)> {
        let mut items = Vec::new();
        if let Some(url) = &view.join_url {
            items.push((
                tr::meeting::prompt::join_only().to_string(),
                MenuAction::JoinOnly(url.clone()),
            ));
        }
        items.push((
            tr::meeting::prompt::open_cap().to_string(),
            MenuAction::OpenCap,
        ));
        if let Some((app_id, app_name)) = &view.mutable_app {
            items.push((
                tr::meeting::prompt::mute_app(app_name),
                MenuAction::Mute(app_id.clone()),
            ));
        }
        items.push((
            tr::meeting::prompt::notification_settings().to_string(),
            MenuAction::Settings,
        ));
        items
    }

    fn run_menu_action(&mut self, action: MenuAction, window: &mut Window, cx: &mut Context<Self>) {
        let id = self.prompt.id;
        self.set_menu(false, 0, window, cx);
        cx.defer(move |cx| match action {
            MenuAction::JoinOnly(url) => {
                cx.open_url(&url);
                super::dismiss_prompt(id, cx);
            }
            MenuAction::OpenCap => {
                crate::app_windows::show_main_window(cx);
                cx.activate(true);
            }
            MenuAction::Mute(app_id) => super::mute_app(id, &app_id, cx),
            MenuAction::Settings => crate::meetings_ui::settings::open(cx),
        });
    }

    fn toggle_menu(&mut self, view: &PromptView, window: &mut Window, cx: &mut Context<Self>) {
        self.set_menu(!self.menu_open, self.menu_items(view).len(), window, cx);
    }

    fn set_menu(&mut self, open: bool, items: usize, window: &mut Window, cx: &mut Context<Self>) {
        if self.menu_open == open {
            return;
        }
        self.menu_open = open;
        self.menu_close = None;
        let height = if open {
            model::prompt_menu_height(items)
        } else {
            model::PROMPT_HEIGHT
        };
        if !native::can_move_windows() {
            window.resize(size(px(model::PROMPT_WIDTH as f32), px(height as f32)));
        }
        let id = self.prompt.id;
        cx.defer(move |cx| set_height(id, height, cx));
        cx.notify();
    }

    fn surface(&self) -> (Hsla, Option<Hsla>) {
        let theme = &self.theme;
        if theme.material.is_some() {
            return (theme.shell_bg(), theme.shell_border());
        }
        if theme.is_dark() {
            (theme.gray_2.into(), Some(super::indicator::hairline(theme)))
        } else {
            (gpui::white(), Some(super::indicator::hairline(theme)))
        }
    }

    fn render_icon(&self, glyph: Glyph) -> gpui::AnyElement {
        let theme = self.theme;
        if let Some(icon) = &self.icon {
            return img(icon.clone())
                .size(px(32.))
                .flex_shrink_0()
                .into_any_element();
        }
        div()
            .flex()
            .items_center()
            .justify_center()
            .flex_shrink_0()
            .size(px(32.))
            .rounded(px(9.))
            .bg(tint(theme, 0.06, 0.1))
            .child(
                svg()
                    .path(match glyph {
                        Glyph::Calendar => "icons/calendar.svg",
                        Glyph::Waveform => "icons/audio-lines.svg",
                    })
                    .size(px(16.))
                    .text_color(theme.gray_11),
            )
            .into_any_element()
    }

    fn render_menu(&self, view: &PromptView, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = self.theme;
        div()
            .flex()
            .flex_col()
            .w_full()
            .child(div().h(px(1.)).mx(px(16.)).bg(tint(theme, 0.08, 0.1)))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .px(px(8.))
                    .pt(px(6.))
                    .pb(px(8.))
                    .children(self.menu_items(view).into_iter().enumerate().map(
                        |(index, (label, action))| {
                            div()
                                .id(("prompt-menu-item", index))
                                .role(gpui::Role::MenuItem)
                                .aria_label(SharedString::from(label.clone()))
                                .h(px(30.))
                                .px(px(10.))
                                .flex()
                                .items_center()
                                .rounded(px(8.))
                                .text_size(px(13.))
                                .font_weight(FontWeight::NORMAL)
                                .text_color(theme.gray_12)
                                .hover(move |style| style.bg(tint(theme, 0.06, 0.08)))
                                .child(div().truncate().child(label))
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.run_menu_action(action.clone(), window, cx)
                                }))
                        },
                    )),
            )
            .into_any_element()
    }
}

fn tint(theme: Theme, light: f32, dark: f32) -> Hsla {
    if theme.is_dark() {
        gpui::hsla(0., 0., 1., dark)
    } else {
        gpui::hsla(0., 0., 0., light)
    }
}

pub fn title_text(title: &PromptTitle) -> String {
    match title {
        PromptTitle::Event(title) => title.clone(),
        PromptTitle::Upcoming => tr::meeting::prompt::upcoming().to_string(),
        PromptTitle::Detected(noun) => match noun {
            cap_meetings::apps::CallNoun::Meeting => tr::meeting::prompt::meeting_detected(),
            cap_meetings::apps::CallNoun::Call => tr::meeting::prompt::call_detected(),
            cap_meetings::apps::CallNoun::Huddle => tr::meeting::prompt::huddle_detected(),
        }
        .to_string(),
    }
}

pub fn starts_in(secs: u64) -> String {
    if secs < 60 {
        tr::meeting::time::starts_in_seconds(secs.max(1))
    } else {
        tr::meeting::time::starts_in_minutes(secs.div_ceil(60))
    }
}

pub fn line_text(line: &PromptLine) -> String {
    match line {
        PromptLine::App(name) => name.clone(),
        PromptLine::StartsIn(secs) => starts_in(*secs),
        PromptLine::Range(start, end) => {
            tr::meeting::time::range(model::clock(*start), model::clock(*end))
        }
    }
}

pub fn primary_text(primary: PromptPrimary) -> String {
    match primary {
        PromptPrimary::TakeNotes => tr::meeting::prompt::take_notes().to_string(),
        PromptPrimary::JoinAndTakeNotes => tr::meeting::prompt::join_and_take_notes().to_string(),
        PromptPrimary::RecordingIn(left) => tr::meeting::prompt::recording_in(left),
    }
}

impl Render for PromptCard {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.theme.refresh(
            window,
            cx,
            cfg!(target_os = "macos") && self.panel.is_some(),
        );
        let theme = self.theme;
        let view = self.view(cx);
        let progress = self.countdown_progress();
        let starts_in = matches!(view.line, PromptLine::StartsIn(_));
        self.ensure_tick(
            starts_in || progress.is_some(),
            progress.is_some_and(|(left, _)| left > 0) && !cx.reduce_motion(),
            cx,
        );
        let hovered = self.hovered || super::debug_hovered(self.prompt.id, cx);
        let (bg, border) = self.surface();
        let id = self.prompt.id;
        let join = view.join_url.clone();
        let primary = primary_text(view.primary);
        let auto = view.auto;
        let menu_view = view.clone();
        let ink = crate::onboarding_window::Paper::new(&theme).ink;
        let on_ink = super::indicator::surface_ink(&theme);

        let card = div()
            .id("prompt-card")
            .relative()
            .flex_shrink_0()
            .w_full()
            .h(px(model::PROMPT_HEIGHT as f32))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(12.))
            .pl(px(16.))
            .pr(px(14.))
            .child(self.render_icon(view.glyph))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .gap(px(2.))
                    .child(
                        // Long titles (German, a long meeting name) wrap
                        // to a second line instead of being cut.
                        div()
                            .line_clamp(2)
                            .text_ellipsis()
                            .text_size(px(13.5))
                            .line_height(px(18.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.gray_12)
                            .child(title_text(&view.title)),
                    )
                    .child(
                        div()
                            .truncate()
                            .text_size(px(12.))
                            .line_height(px(16.))
                            .font_weight(FontWeight::NORMAL)
                            .text_color(theme.gray_11)
                            .child(line_text(&view.line)),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .flex_shrink_0()
                    .child(
                        div()
                            .id("prompt-primary")
                            .role(gpui::Role::Button)
                            .aria_label(SharedString::from(primary.clone()))
                            .flex()
                            .items_center()
                            .justify_center()
                            .h(px(30.))
                            .px(px(13.))
                            .rounded_full()
                            .bg(ink)
                            .hover(move |style| style.bg(ink.opacity(0.88)))
                            .text_size(px(12.5))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(on_ink)
                            .whitespace_nowrap()
                            .child(primary)
                            .on_click(move |_, _, cx| {
                                let join = join.clone();
                                cx.defer(move |cx| super::accept_prompt(id, join, cx));
                            }),
                    )
                    .when(auto, |this| {
                        this.child(
                            div()
                                .id("prompt-cancel")
                                .role(gpui::Role::Button)
                                .aria_label(tr::meeting::prompt::cancel())
                                .flex()
                                .items_center()
                                .h(px(30.))
                                .px(px(10.))
                                .rounded_full()
                                .text_size(px(12.5))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.gray_11)
                                .hover(move |style| {
                                    style.bg(tint(theme, 0.06, 0.08)).text_color(theme.gray_12)
                                })
                                .child(tr::meeting::prompt::cancel())
                                .on_click(move |_, _, cx| {
                                    cx.defer(move |cx| super::cancel_prompt(id, cx));
                                }),
                        )
                    })
                    .when(!auto, |this| {
                        this.child(
                            div()
                                .id("prompt-more")
                                .role(gpui::Role::Button)
                                .aria_label(tr::meeting::prompt::more())
                                .flex()
                                .items_center()
                                .justify_center()
                                .size(px(30.))
                                .rounded_full()
                                .bg(tint(theme, 0.05, 0.09))
                                .hover(move |style| style.bg(tint(theme, 0.1, 0.14)))
                                .child(
                                    svg()
                                        .path("icons/chevron-down.svg")
                                        .size(px(13.))
                                        .text_color(theme.gray_12),
                                )
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.toggle_menu(&menu_view, window, cx);
                                })),
                        )
                    }),
            )
            .when(hovered && !auto, |this| {
                this.child(
                    div()
                        .id("prompt-dismiss")
                        .role(gpui::Role::Button)
                        .aria_label(tr::meeting::prompt::dismiss())
                        .absolute()
                        .top(px(6.))
                        .right(px(6.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .size(px(20.))
                        .rounded_full()
                        .hover(move |style| style.bg(tint(theme, 0.06, 0.1)))
                        .child(
                            svg()
                                .path("icons/x.svg")
                                .size(px(10.))
                                .text_color(theme.gray_11),
                        )
                        .on_click(move |_, _, cx| {
                            cx.defer(move |cx| super::dismiss_prompt(id, cx));
                        }),
                )
            })
            .when_some(progress, |this, (_, fraction)| {
                this.child(super::indicator::countdown_line(&theme, 1. - fraction))
            });

        let key_join = view.join_url.clone();
        div()
            .id("prompt-root")
            .track_focus(&self.focus)
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(|this, _, window, cx| window.focus(&this.focus, cx)),
            )
            .on_key_down(move |event: &gpui::KeyDownEvent, _, cx| {
                match event.keystroke.key.as_str() {
                    "enter" => {
                        let join = key_join.clone();
                        cx.defer(move |cx| super::accept_prompt(id, join, cx));
                    }
                    "escape" if auto => cx.defer(move |cx| super::cancel_prompt(id, cx)),
                    "escape" => cx.defer(move |cx| super::dismiss_prompt(id, cx)),
                    _ => {}
                }
            })
            .size_full()
            .relative()
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(px(model::PROMPT_RADIUS as f32))
            .bg(bg)
            .when_some(border, |this, border| this.border_1().border_color(border))
            .font_family(crate::theme::UI_FONT)
            .locale_font()
            .font_weight(FontWeight::MEDIUM)
            .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                if this.hovered == *hovered {
                    return;
                }
                this.hovered = *hovered;
                let hovered = *hovered;
                cx.defer(move |cx| super::hover_prompt(id, hovered, cx));
                if hovered {
                    this.menu_close = None;
                } else if this.menu_open {
                    this.menu_close = Some(cx.spawn(async move |this, cx| {
                        cx.background_executor().timer(MENU_LINGER).await;
                        this.update(cx, |this, cx| {
                            this.menu_close = None;
                            if !this.hovered && this.menu_open {
                                this.menu_open = false;
                                cx.defer(move |cx| set_height(id, model::PROMPT_HEIGHT, cx));
                                cx.notify();
                            }
                        })
                        .ok();
                    }));
                }
                cx.notify();
            }))
            .child(card)
            .when(self.menu_open, |this| {
                this.child(self.render_menu(&view, cx))
            })
    }
}

struct PromptWindow {
    id: u64,
    handle: WindowHandle<PromptCard>,
    panel: Option<Panel>,
    frame: Option<Rect>,
    slot: usize,
    height: f64,
}

#[derive(Default)]
struct PromptStack {
    windows: Vec<PromptWindow>,
    screen: Option<String>,
    observer: Option<native::Observer>,
    observer_task: Option<Task<()>>,
}

impl Global for PromptStack {}

#[derive(Default)]
struct AppIcons(HashMap<String, Option<Arc<gpui::Image>>>);

impl Global for AppIcons {}

fn app_icon(app_id: &str, cx: &mut App) -> Option<Arc<gpui::Image>> {
    let bundle = model::macos_bundle_id(app_id)?;
    let icons = cx.default_global::<AppIcons>();
    if let Some(icon) = icons.0.get(bundle) {
        return icon.clone();
    }
    let icon = native::app_icon_png(bundle)
        .map(|png| Arc::new(gpui::Image::from_bytes(gpui::ImageFormat::Png, png)));
    cx.default_global::<AppIcons>()
        .0
        .insert(bundle.to_string(), icon.clone());
    icon
}

pub fn sync(cx: &mut App) {
    let prompts = super::prompts(cx);
    let position = super::settings(cx)
        .map(|settings| settings.notifications.position)
        .unwrap_or_default();
    let stack = cx.default_global::<PromptStack>();
    let leaving: Vec<PromptWindow> = {
        let (keep, leave): (Vec<_>, Vec<_>) = std::mem::take(&mut stack.windows)
            .into_iter()
            .partition(|window| prompts.iter().any(|prompt| prompt.id == window.id));
        stack.windows = keep;
        leave
    };
    for window in leaving {
        leave(window, cx);
    }
    let existing: Vec<(u64, WindowHandle<PromptCard>)> = cx
        .global::<PromptStack>()
        .windows
        .iter()
        .map(|window| (window.id, window.handle))
        .collect();
    for (id, handle) in existing {
        if let Some(prompt) = prompts.iter().find(|prompt| prompt.id == id).cloned() {
            handle
                .update(cx, |card, _, cx| card.set_prompt(prompt, cx))
                .ok();
        }
    }
    for prompt in &prompts {
        if !cx
            .global::<PromptStack>()
            .windows
            .iter()
            .any(|window| window.id == prompt.id)
        {
            open(prompt.clone(), cx);
        }
    }
    let order: Vec<u64> = prompts.iter().map(|prompt| prompt.id).collect();
    cx.global_mut::<PromptStack>()
        .windows
        .sort_by_key(|window| order.iter().position(|id| *id == window.id));
    layout(position, false, cx);
    watch_screens(cx);
    let handles: Vec<AnyWindowHandle> = cx
        .global::<PromptStack>()
        .windows
        .iter()
        .map(|window| window.handle.into())
        .collect();
    crate::meetings_ui::MeetingWindows::get(cx).prompts = handles;
}

fn free_slot(cx: &App) -> usize {
    let used: Vec<usize> = cx
        .try_global::<PromptStack>()
        .map(|stack| stack.windows.iter().map(|window| window.slot).collect())
        .unwrap_or_default();
    (0..).find(|slot| !used.contains(slot)).unwrap_or(0)
}

fn current_screen(cx: &App) -> Option<native::Screen> {
    let screens = native::screens(cx);
    let pinned = cx
        .try_global::<PromptStack>()
        .and_then(|stack| stack.screen.clone());
    if let Some(screen) = pinned.and_then(|id| screens.iter().find(|screen| screen.id == id)) {
        return Some(screen.clone());
    }
    model::screen_for_point(&screens, native::cursor(cx)).cloned()
}

fn open(prompt: Prompt, cx: &mut App) {
    let id = prompt.id;
    let slot = free_slot(cx);
    let position = super::settings(cx)
        .map(|settings| settings.notifications.position)
        .unwrap_or_default();
    let screen = current_screen(cx);
    let initial = screen
        .as_ref()
        .map(|screen| {
            model::prompt_frame(
                screen.visible,
                position,
                slot as f64 * (model::PROMPT_HEIGHT + model::PROMPT_GAP),
                model::PROMPT_HEIGHT,
            )
        })
        .unwrap_or(Rect::new(0., 0., model::PROMPT_WIDTH, model::PROMPT_HEIGHT));
    let app_id = prompt.app_id.clone();
    let opened = cx.open_window(
        WindowOptions {
            #[cfg(target_os = "linux")]
            app_id: Some(crate::app_windows::app_id().into()),
            window_bounds: Some(WindowBounds::Windowed(Bounds {
                origin: point(px(initial.x as f32), px(initial.y as f32)),
                size: size(px(initial.w as f32), px(initial.h as f32)),
            })),
            titlebar: None,
            kind: WindowKind::PopUp,
            focus: false,
            show: !native::can_move_windows(),
            is_movable: false,
            is_resizable: false,
            is_minimizable: false,
            window_background: WindowBackgroundAppearance::Transparent,
            ..Default::default()
        },
        move |window, cx| {
            native::window_title(window, TITLE);
            cx.new(|cx| PromptCard::new(prompt, window, cx))
        },
    );
    let handle = match opened {
        Ok(handle) => handle,
        Err(error) => {
            tracing::warn!("meeting prompt failed to open: {error:#}");
            return;
        }
    };
    let icon = app_id.as_deref().and_then(|app_id| app_icon(app_id, cx));
    let (panel, native_window) = handle
        .update(cx, |card, window, cx| {
            card.icon = icon;
            crate::platform::apply_panel_behavior(
                window,
                crate::platform::PanelBehavior {
                    level: crate::platform::recording_controls_level(),
                    join_all_spaces: true,
                    shadow: true,
                },
            );
            card.panel = Panel::of(window);
            cx.notify();
            (Panel::of(window), crate::platform::native_window(window))
        })
        .unwrap_or((None, None));
    if screen.is_some() && cx.global::<PromptStack>().windows.is_empty() {
        cx.global_mut::<PromptStack>().screen = screen.map(|screen| screen.id);
    }
    cx.global_mut::<PromptStack>().windows.push(PromptWindow {
        id,
        handle,
        panel,
        frame: None,
        slot,
        height: model::PROMPT_HEIGHT,
    });
    if let Some(native_window) = native_window {
        cx.spawn(async move |cx| {
            crate::platform::remove_popup_window_chrome(&native_window);
            native::install_glass(&native_window, model::PROMPT_RADIUS);
            cx.update(|cx| {
                handle
                    .update(cx, |_, window, cx| {
                        crate::platform::kick_display_link(window);
                        cx.notify();
                        window.refresh();
                    })
                    .ok();
            });
        })
        .detach();
    }
    tracing::info!(id, slot, "meeting prompt opened");
}

fn leave(window: PromptWindow, cx: &mut App) {
    let handle = window.handle;
    let Some(panel) = window.panel else {
        handle
            .update(cx, |_, window, _| window.remove_window())
            .ok();
        return;
    };
    let fade = native::motion(cx, native::FADE_OUT);
    cx.spawn(async move |cx| {
        if let Some(frame) = window.frame {
            panel.animate(frame, 0., fade);
        }
        cx.background_executor()
            .timer(fade + Duration::from_millis(30))
            .await;
        panel.hide();
        cx.update(|cx| {
            handle
                .update(cx, |_, window, _| window.remove_window())
                .ok();
        });
    })
    .detach();
}

fn layout(position: PromptPosition, screen_changed: bool, cx: &mut App) {
    if !native::can_move_windows() {
        return;
    }
    let Some(screen) = current_screen(cx) else {
        return;
    };
    let slide = native::motion(cx, native::SLIDE_IN);
    let reflow = native::motion(cx, native::REFLOW);
    let mut moves: Vec<(Panel, Option<Rect>, Rect, WindowHandle<PromptCard>, u64)> = Vec::new();
    {
        let stack = cx.global_mut::<PromptStack>();
        stack.screen = Some(screen.id.clone());
        let heights: Vec<f64> = stack.windows.iter().map(|window| window.height).collect();
        let targets = model::prompt_frames(screen.visible, position, &heights);
        for ((index, window), target) in stack.windows.iter_mut().enumerate().zip(targets) {
            if window.frame == Some(target) && !screen_changed {
                continue;
            }
            let Some(panel) = window.panel.clone() else {
                continue;
            };
            moves.push((panel, window.frame, target, window.handle, window.id));
            window.frame = Some(target);
            window.slot = index;
        }
    }
    for (panel, from, target, handle, id) in moves {
        cx.spawn(async move |cx| match from {
            None => {
                panel.place(model::prompt_entry(target, position), 0.);
                panel.show();
                panel.animate(target, 1., slide);
                tracing::info!(
                    id,
                    epoch_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_or(0, |d| d.as_millis() as u64),
                    "meeting prompt shown"
                );
                cx.update(|cx| {
                    handle
                        .update(cx, |_, window, cx| {
                            crate::platform::kick_display_link(window);
                            cx.notify();
                        })
                        .ok();
                });
            }
            Some(_) => panel.animate(target, 1., reflow),
        })
        .detach();
    }
}

fn set_height(id: u64, height: f64, cx: &mut App) {
    let Some(window) = cx
        .try_global::<PromptStack>()
        .and_then(|stack| stack.windows.iter().position(|window| window.id == id))
    else {
        return;
    };
    cx.global_mut::<PromptStack>().windows[window].height = height;
    let position = super::settings(cx)
        .map(|settings| settings.notifications.position)
        .unwrap_or_default();
    layout(position, false, cx);
}

fn watch_screens(cx: &mut App) {
    let stack = cx.global_mut::<PromptStack>();
    if stack.windows.is_empty() {
        stack.observer = None;
        stack.observer_task = None;
        stack.screen = None;
        return;
    }
    if stack.observer.is_some() || !native::can_move_windows() {
        return;
    }
    let (tx, rx) = flume::unbounded::<()>();
    stack.observer = Some(native::observe(&[native::SCREENS_CHANGED], tx));
    let task = cx.spawn(async move |cx| {
        while rx.recv_async().await.is_ok() {
            cx.update(|cx| {
                cx.global_mut::<PromptStack>().screen = None;
                let position = super::settings(cx)
                    .map(|settings| settings.notifications.position)
                    .unwrap_or_default();
                layout(position, true, cx);
            });
        }
    });
    cx.global_mut::<PromptStack>().observer_task = Some(task);
}

pub fn handles(cx: &App) -> Vec<AnyWindowHandle> {
    cx.try_global::<PromptStack>()
        .map(|stack| {
            stack
                .windows
                .iter()
                .map(|window| window.handle.into())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(debug_assertions)]
pub fn debug_open_menu(cx: &mut App) {
    let Some(handle) = cx
        .try_global::<PromptStack>()
        .and_then(|stack| stack.windows.first().map(|window| window.handle))
    else {
        return;
    };
    handle
        .update(cx, |card, window, cx| {
            let view = card.view(cx);
            card.toggle_menu(&view, window, cx);
        })
        .ok();
}
