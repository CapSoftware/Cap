//! The teleprompter -- `routes/teleprompter.tsx`, natively.
//!
//! 560x320 by default, freely resizable down to 420x220, always over the app
//! being read from (native window level 101, all Spaces), on the
//! `"teleprompter"` material at radius 22. A header note, a centre script area
//! with a vertical vignette and cue markers, and a footer of pills: play/pause,
//! words-per-minute, window opacity, font size, and a settings popover.
//!
//! The Tauri window is the odd one out architecturally -- it is built straight
//! from JS with `new WebviewWindow(...)` rather than through the
//! `ShowCapWindow` builder -- but from over here it is just another window, so
//! `app_windows::open_teleprompter` opens it the way everything else opens.
//!
//! The playback maths is a straight port of
//! `apps/desktop/src/routes/teleprompter-utils.ts`, with that file's own unit
//! tests translated at the bottom.

use std::{
    cell::{Cell, RefCell},
    collections::BTreeSet,
    rc::Rc,
    time::{Duration, Instant},
};

use gpui::{
    AppContext as _, Bounds, Context, Entity, FocusHandle, FontWeight, Hsla, InteractiveElement,
    IntoElement, ParentElement,
    Pixels, Point, Render, ScrollHandle, SharedString, StatefulInteractiveElement, Styled, Window,
    div, linear_color_stop, linear_gradient, point, prelude::FluentBuilder, px, svg,
};

use crate::{
    platform,
    store::{self, TeleprompterState},
    theme::{Appearance, Theme},
    ui,
};

/// `getTeleprompterWindowOptions`: `width: 560, height: 320`, `minWidth: 420`,
/// `minHeight: 220`, `resizable: true`, `center: true`.
pub const TELEPROMPTER_WIDTH: f32 = 560.;
pub const TELEPROMPTER_HEIGHT: f32 = 320.;
pub const TELEPROMPTER_MIN_WIDTH: f32 = 420.;
pub const TELEPROMPTER_MIN_HEIGHT: f32 = 220.;

/// `trafficLightPosition: new LogicalPosition(14, 14)`, which
/// `CapWindowId::Teleprompter::traffic_lights_position` repeats on the Rust
/// side. Real AppKit buttons, moved -- like the settings window's (22, 22) and
/// unlike the main window's hand-drawn pair.
pub const TRAFFIC_LIGHTS: Point<Pixels> = Point {
    x: px(14.),
    y: px(14.),
};

/// `applyMacOSWindowMaterial("teleprompter")` -> radius 22 under liquid glass
/// (16 under vibrancy, which the content-view clip re-applies anyway).
pub const TELEPROMPTER_MATERIAL_RADIUS: f64 = 22.;

/// `h-9` header + `h-11` footer -- the `5rem` in the spacer's `calc`.
const HEADER_HEIGHT: f32 = 36.;
const FOOTER_HEIGHT: f32 = 44.;

/// `min="60" max="350" step="5"` on the scroll-speed range.
const WPM_MIN: f32 = 60.;
const WPM_MAX: f32 = 350.;
const WPM_STEP: f32 = 5.;

/// `min="45" max="100" step="5"` on the opacity range. The floor is the same
/// 0.45 `set_window_opacity` clamps to.
const OPACITY_MIN: f32 = 45.;
const OPACITY_MAX: f32 = 100.;
const OPACITY_STEP: f32 = 5.;

/// `clamp(current.fontSize + delta, 22, 52)` with `delta = ±2`.
const FONT_SIZE_MIN: f32 = 22.;
const FONT_SIZE_MAX: f32 = 52.;
const FONT_SIZE_STEP: f32 = 2.;

/// `setTimeout(..., 250)` in the persistence effect.
const SAVE_DEBOUNCE: Duration = Duration::from_millis(250);

/// One animation frame. The rAF loop the Tauri route runs is display-cadence;
/// this is the nearest fixed tick, and the elapsed clamp below makes the speed
/// independent of it either way.
const PLAYBACK_TICK: Duration = Duration::from_millis(16);

/// `Math.min((timestamp - playbackTimestamp) / 1000, 0.05)` -- a tab (or a
/// window) that stopped getting frames must not jump the script.
const MAX_TICK_SECONDS: f32 = 0.05;

// -- teleprompter-utils.ts --------------------------------------------------

/// `countWords`: whitespace-separated, empty when the script is blank.
pub fn count_words(text: &str) -> usize {
    text.split_whitespace().count()
}

/// `clamp(value, minimum, maximum)`.
pub fn clamp(value: f32, minimum: f32, maximum: f32) -> f32 {
    value.max(minimum).min(maximum)
}

/// `calculatePlaybackSpeed`: pixels per second, from how long the script takes
/// to read at the chosen words-per-minute.
pub fn calculate_playback_speed(
    maximum_scroll: f32,
    word_count: usize,
    words_per_minute: u32,
) -> f32 {
    let duration_seconds = (word_count.max(1) as f32 / words_per_minute.max(1) as f32) * 60.;
    maximum_scroll.max(0.) / duration_seconds.max(1.)
}

/// `advancePlaybackPosition`: the position never runs past the bottom, and
/// sub-pixel movement accumulates rather than being rounded away each frame.
pub fn advance_playback_position(
    position: f32,
    maximum_scroll: f32,
    pixels_per_second: f32,
    elapsed_seconds: f32,
) -> f32 {
    (position.max(0.) + pixels_per_second.max(0.) * elapsed_seconds.max(0.))
        .min(maximum_scroll.max(0.))
}

// ---------------------------------------------------------------------------

/// Which range is being dragged, so one drag layer serves both pills.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Slider {
    Speed,
    Opacity,
}

/// The debounced store write, shared with the close handler.
///
/// `onCloseRequested` in the Tauri route cancels the debounce timer and saves
/// synchronously before letting the window go, so a script typed in the last
/// 250ms is never lost. That handler runs with only an `&mut App` in hand, so
/// the pending write lives here rather than on the view.
#[derive(Default)]
struct PendingSave {
    state: TeleprompterState,
    /// Exactly the keys that changed. The Tauri store writes the whole object;
    /// `set_store_setting` is per-key, and writing only what moved is what
    /// keeps a key a newer build added to the section alive.
    keys: BTreeSet<&'static str>,
}

impl PendingSave {
    fn flush(&mut self) {
        if self.keys.is_empty() {
            return;
        }
        for key in std::mem::take(&mut self.keys) {
            if !store::set_store_setting(store::TELEPROMPTER, key, self.state.value_for(key)) {
                tracing::warn!(key, "the store refused the teleprompter write");
            } else {
                tracing::debug!(key, "persisted teleprompter setting");
            }
        }
    }
}

pub struct TeleprompterWindow {
    theme: Theme,
    state: TeleprompterState,
    settings_open: bool,
    playing: bool,
    /// Scroll offset in pixels from the top, positive. gpui's own offset is the
    /// negative of it.
    position: f32,
    scroll: ScrollHandle,
    focus: FocusHandle,
    /// The script editor. `ui::TextInputState` in its multi-line shape: the
    /// text wraps to the window, the element measures its own height so the
    /// scroller and the auto-scroll maths keep working unchanged, and Return
    /// inserts a newline instead of committing. `state.script` stays the
    /// mirror because the word count, the playback maths and the debounced
    /// store write all read it from `&self`.
    script_input: Entity<ui::TextInputState>,
    _script_events: gpui::Subscription,
    /// Track rects, captured in prepaint: the window is resizable, so neither
    /// pill's width is known here.
    speed_track: Rc<Cell<Option<Bounds<Pixels>>>>,
    opacity_track: Rc<Cell<Option<Bounds<Pixels>>>>,
    dragging: Option<Slider>,
    save: Rc<RefCell<PendingSave>>,
    /// Dropping this cancels an in-flight debounce, which is what makes a burst
    /// of keystrokes one write.
    save_task: Option<gpui::Task<()>>,
    playback: Option<gpui::Task<()>>,
}

impl TeleprompterWindow {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let state = TeleprompterState::load();
        let save = Rc::new(RefCell::new(PendingSave {
            state: state.clone(),
            keys: BTreeSet::new(),
        }));

        // `onCloseRequested`: cancel the debounce, force-save, then let the
        // close through. `cx.defer` for the registry half -- the callback fires
        // with the App borrowed.
        let closing = save.clone();
        window.on_window_should_close(cx, move |_window, cx| {
            closing.borrow_mut().flush();
            cx.defer(crate::app_windows::teleprompter_closed);
            true
        });

        let script_input = cx.new(|cx| {
            let mut input = ui::TextInputState::multi_line(window, cx);
            input.set_text(state.script.clone(), cx);
            input.set_placeholder("Paste or type your script\u{2026}");
            input
        });
        let script_events = cx.subscribe_in(
            &script_input,
            window,
            |this: &mut Self, input, event: &ui::TextInputEvent, window, cx| match event {
                ui::TextInputEvent::Changed => {
                    let script = input.read(cx).text().to_string();
                    this.edit_script(move |value| *value = script, window, cx);
                }
                // Escape closes the popover and nothing else, whether or not
                // the script has focus.
                ui::TextInputEvent::Cancelled => {
                    if this.settings_open {
                        this.settings_open = false;
                        cx.notify();
                    }
                }
                _ => {}
            },
        );

        Self {
            theme: Theme::new(Appearance::from_window(window.appearance())),
            state,
            settings_open: false,
            playing: false,
            position: 0.,
            scroll: ScrollHandle::new(),
            focus: cx.focus_handle(),
            script_input,
            _script_events: script_events,
            speed_track: Rc::new(Cell::new(None)),
            opacity_track: Rc::new(Cell::new(None)),
            dragging: None,
            save,
            save_task: None,
            playback: None,
        }
    }

    pub fn focus_root(&self, window: &mut Window, cx: &mut Context<Self>) {
        // `onMount` focuses the script editor itself, not the shell.
        let focus = self.script_input.read(cx).focus_handle();
        window.focus(&focus, cx);
    }

    /// `clamp(state().windowOpacityPercent, 45, 100) / 100`, for the initial
    /// `setTeleprompterWindowOpacity` the load effect fires.
    pub fn window_alpha(&self) -> f64 {
        f64::from(clamp(
            self.state.window_opacity_percent as f32,
            OPACITY_MIN,
            OPACITY_MAX,
        )) / 100.
    }

    fn sync_appearance(&mut self, window: &Window, cx: &gpui::App) {
        let appearance = Appearance::from_window(window.appearance());
        let material = platform::active_material(cx);
        if appearance != self.theme.appearance || material != self.theme.material_kind() {
            self.theme = Theme::new(appearance).with_material(material);
        }
    }

    // -- Persistence -------------------------------------------------------

    /// Queue one key for the debounced write. A second edit inside 250ms drops
    /// the previous task, so the timer restarts -- `clearTimeout(saveTimer)`
    /// followed by a fresh `setTimeout`.
    fn touch(&mut self, key: &'static str, window: &mut Window, cx: &mut Context<Self>) {
        {
            let mut save = self.save.borrow_mut();
            save.state = self.state.clone();
            save.keys.insert(key);
        }
        let save = self.save.clone();
        self.save_task = Some(cx.spawn_in(window, async move |_, cx| {
            cx.background_executor().timer(SAVE_DEBOUNCE).await;
            save.borrow_mut().flush();
        }));
    }

    // -- Editing -----------------------------------------------------------

    fn has_script(&self) -> bool {
        !self.state.script.trim().is_empty()
    }

    /// `updateScript`: an empty script stops playback.
    fn edit_script(
        &mut self,
        edit: impl FnOnce(&mut String),
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        edit(&mut self.state.script);
        if !self.has_script() {
            self.stop_playback();
        }
        self.touch(TeleprompterState::SCRIPT, window, cx);
        cx.notify();
    }

    /// Type into the script the way a keystroke does (harness path -- the real
    /// one is `on_key`, and unprivileged synthetic key events are dropped).
    pub fn type_script(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        let mut next = self.state.script.clone();
        next.push_str(text);
        self.script_input
            .update(cx, |input, cx| input.set_text(next.clone(), cx));
        self.edit_script(move |script| *script = next, window, cx);
    }

    /// `changeFontSize(delta)`, clamped 22-52.
    fn change_font_size(&mut self, delta: f32, window: &mut Window, cx: &mut Context<Self>) {
        let next = clamp(self.state.font_size + delta, FONT_SIZE_MIN, FONT_SIZE_MAX);
        if next == self.state.font_size {
            return;
        }
        self.state.font_size = next;
        self.touch(TeleprompterState::FONT_SIZE, window, cx);
        cx.notify();
    }

    // -- Playback ----------------------------------------------------------

    fn maximum_scroll(&self) -> f32 {
        f32::from(self.scroll.max_offset().y).max(0.)
    }

    fn stop_playback(&mut self) {
        self.playing = false;
        self.playback = None;
    }

    pub fn is_playing(&self) -> bool {
        self.playing
    }

    /// `togglePlayback`.
    pub fn toggle_playback(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.playing {
            self.stop_playback();
            cx.notify();
            return;
        }

        let maximum = self.maximum_scroll();
        if !self.has_script() || maximum <= 1. {
            return;
        }
        // `playbackPosition = element.scrollTop`: a wheel scroll between two
        // plays moves gpui's offset, not ours, so playback resumes from where
        // the script actually is.
        self.position = (-f32::from(self.scroll.offset().y)).clamp(0., maximum);
        // `if (element.scrollTop >= maximumScroll - 1) element.scrollTop = 0`
        if self.position >= maximum - 1. {
            self.position = 0.;
        }
        self.settings_open = false;
        self.playing = true;

        // An inactive window only repaints when asked, so the tick both
        // notifies and calls `refresh` -- the same rule the recording bar's
        // timer runs under.
        self.playback = Some(cx.spawn_in(window, async move |this, cx| {
            let mut last = Instant::now();
            loop {
                cx.background_executor().timer(PLAYBACK_TICK).await;
                let now = Instant::now();
                let elapsed = (now - last).as_secs_f32().min(MAX_TICK_SECONDS);
                last = now;
                let running = this
                    .update_in(cx, |this, window, cx| {
                        let running = this.advance(elapsed);
                        cx.notify();
                        window.refresh();
                        running
                    })
                    .unwrap_or(false);
                if !running {
                    return;
                }
            }
        }));
        cx.notify();
    }

    /// One frame of `animatePlayback`. Returns false when the loop should stop
    /// -- bottom reached, or nothing left to scroll.
    fn advance(&mut self, elapsed: f32) -> bool {
        let maximum = self.maximum_scroll();
        if maximum <= 1. {
            self.playing = false;
            return false;
        }

        let speed = calculate_playback_speed(
            maximum,
            count_words(&self.state.script),
            self.state.words_per_minute,
        );
        self.position = advance_playback_position(self.position, maximum, speed, elapsed);
        self.apply_scroll();

        if self.position >= maximum - 0.5 {
            self.playing = false;
            return false;
        }
        true
    }

    /// gpui's scroll offset is the distance the content has moved *up*, so it
    /// is the negative of the playback position.
    fn apply_scroll(&self) {
        self.scroll.set_offset(point(px(0.), px(-self.position)));
    }

    // -- Ranges ------------------------------------------------------------

    fn set_slider_from(
        &mut self,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(slider) = self.dragging else {
            return;
        };
        let track = match slider {
            Slider::Speed => self.speed_track.get(),
            Slider::Opacity => self.opacity_track.get(),
        };
        let Some(track) = track else {
            return;
        };
        let width = f32::from(track.size.width);
        if width <= 0. {
            return;
        }
        let fraction = ((f32::from(position.x) - f32::from(track.origin.x)) / width).clamp(0., 1.);

        match slider {
            Slider::Speed => {
                let value = stepped(fraction, WPM_MIN, WPM_MAX, WPM_STEP) as u32;
                if value != self.state.words_per_minute {
                    self.state.words_per_minute = value;
                    self.touch(TeleprompterState::WORDS_PER_MINUTE, window, cx);
                    cx.notify();
                }
            }
            Slider::Opacity => {
                let value = stepped(fraction, OPACITY_MIN, OPACITY_MAX, OPACITY_STEP) as u32;
                if value != self.state.window_opacity_percent {
                    self.state.window_opacity_percent = value;
                    self.touch(TeleprompterState::WINDOW_OPACITY_PERCENT, window, cx);
                    self.apply_window_alpha(window, cx);
                    cx.notify();
                }
            }
        }
    }

    /// The macOS path of the opacity effect: `set_teleprompter_window_opacity`
    /// -> `setAlphaValue:`. Read the native handle inside the update, act on it
    /// from a task -- changing a window's alpha re-enters gpui's own window
    /// callbacks.
    fn apply_window_alpha(&self, window: &Window, cx: &mut Context<Self>) {
        let Some(native) = platform::native_window(window) else {
            return;
        };
        let alpha = self.window_alpha();
        cx.spawn(async move |_, _| {
            let applied = platform::set_window_alpha(&native, alpha);
            tracing::debug!(requested = alpha, applied, "teleprompter window alpha");
        })
        .detach();
    }
}

/// A range's value snapped to its step -- [`ui::snap_to_step`] over
/// [`ui::value_from_fraction`], which reproduces this window's own formula
/// exactly (`ui::slider::tests::slider_snapping_matches_the_formulas_it_replaced`).
fn stepped(fraction: f32, minimum: f32, maximum: f32, step: f32) -> f32 {
    ui::snap_to_step(
        ui::value_from_fraction(fraction, minimum, maximum),
        minimum,
        maximum,
        step,
    )
}

impl Render for TeleprompterWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_appearance(window, cx);
        let theme = self.theme;

        div()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key))
            // `cap-window-shell relative flex h-screen w-screen flex-col
            //  overflow-hidden text-gray-12`
            .size_full()
            .relative()
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(px(theme.teleprompter_window_radius()))
            .bg(theme.teleprompter_shell_bg())
            .when_some(theme.teleprompter_shell_border(), |this, color| {
                this.border_1().border_color(color)
            })
            .font_family("Geist")
            .text_color(Hsla::from(theme.gray_12))
            .child(self.render_header())
            .child(self.render_body(window, cx))
            .child(self.render_footer(cx))
            // `z-30` on the popover, over a footer that makes no stacking
            // context of its own -- so it paints last.
            .children(self.render_settings_popover(cx))
            .children(self.render_slider_drag_layer(cx))
    }
}

impl TeleprompterWindow {
    /// Escape closes the popover. Everything else is the script field's --
    /// see `script_input`. This handler only runs when the field does *not*
    /// have focus, because Escape is bound as an action in the `TextInput` key
    /// context and a matched binding consumes the keystroke.
    fn on_key(&mut self, event: &gpui::KeyDownEvent, _window: &mut Window, cx: &mut Context<Self>) {
        if event.keystroke.key.as_str() == "escape" && self.settings_open {
            self.settings_open = false;
            cx.notify();
        }
    }

    /// `cap-window-header flex h-9 shrink-0 items-center` with the note pushed
    /// to the trailing edge. The traffic lights are AppKit's, at (14, 14).
    fn render_header(&self) -> impl IntoElement {
        let theme = self.theme;

        div()
            .flex()
            .flex_row()
            .items_center()
            .w_full()
            .h(px(HEADER_HEIGHT))
            .flex_shrink_0()
            .bg(theme.header_bg())
            .child(
                // `pointer-events-none ml-auto flex items-center gap-1.5
                //  text-[10px] text-gray-9`, `mr-3`.
                div()
                    .ml_auto()
                    .mr(px(12.))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .text_size(px(10.))
                    .text_color(Hsla::from(theme.gray_9))
                    .child(
                        svg()
                            .path("icons/eye-off.svg")
                            .size(px(12.))
                            .flex_shrink_0()
                            .text_color(Hsla::from(theme.gray_9)),
                    )
                    .child("This window is hidden from Cap recordings"),
            )
    }

    /// `cap-window-body relative min-h-0 flex-1 overflow-hidden`: the script
    /// scroller, the vignette over it, and the cue markers over that.
    fn render_body(&self, window: &Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let state = &self.state;

        // `calc((100vh - 5rem) / 2 - fontSize * lineHeight * 0.5px)` -- 5rem is
        // the header plus the footer, so the first line lands in the middle of
        // the visible area.
        let viewport = f32::from(window.viewport_size().height);
        let spacer = ((viewport - HEADER_HEIGHT - FOOTER_HEIGHT) / 2.
            - state.font_size * state.line_height * 0.5)
            .max(0.);

        div()
            .relative()
            .flex_1()
            .min_h_0()
            .overflow_hidden()
            .child(
                div()
                    .id("script")
                    .track_scroll(&self.scroll)
                    .size_full()
                    .overflow_y_scroll()
                    .child(div().h(px(spacer)).flex_shrink_0())
                    .child(
                        // `block w-full px-8 text-center font-medium
                        //  tracking-[-0.025em] text-gray-12`, at the state's
                        // font size and line height. (`tracking` has no hook in
                        // this gpui rev.) The wrapping field paints into this
                        // box and measures its own height from the row count,
                        // so the scroller and the auto-scroll maths see exactly
                        // the content height they did before.
                        div().w_full().px(px(32.)).child(
                            ui::TextInput::bare(&theme, "script", &self.script_input)
                                .align(gpui::TextAlign::Center)
                                .font_weight(FontWeight::MEDIUM)
                                .text_size(px(state.font_size))
                                .line_height(px(state.font_size * state.line_height))
                                .text_color(Hsla::from(theme.gray_12))
                                // `placeholder:text-gray-8/70`
                                .placeholder_color(Theme::with_alpha(theme.gray_8, 0.7))
                                // Bare glass: `gray-12` at 25 %, the same wash
                                // the other teleprompter controls use rather
                                // than the settings accent.
                                .selection_color(Theme::with_alpha(theme.gray_12, 0.25)),
                        ),
                    )
                    .child(div().h(px(spacer)).flex_shrink_0()),
            )
            // The `mask-image` vignette, as two gradient layers: gpui has no
            // mask hook, so instead of fading the glyphs' alpha to 0.4 this
            // fades the window's own colour over them across the same 34% /
            // 66% stops (README deviation -- over Liquid Glass the wash tints
            // the backdrop rather than the text).
            .child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .right_0()
                    .h(gpui::relative(0.34))
                    .bg(linear_gradient(
                        180.,
                        linear_color_stop(Theme::with_alpha(theme.gray_1, 0.6), 0.),
                        linear_color_stop(Theme::with_alpha(theme.gray_1, 0.), 1.),
                    )),
            )
            .child(
                div()
                    .absolute()
                    .bottom_0()
                    .left_0()
                    .right_0()
                    .h(gpui::relative(0.34))
                    .bg(linear_gradient(
                        0.,
                        linear_color_stop(Theme::with_alpha(theme.gray_1, 0.6), 0.),
                        linear_color_stop(Theme::with_alpha(theme.gray_1, 0.), 1.),
                    )),
            )
            .when(state.show_cue_markers, |this| {
                // `pointer-events-none absolute inset-x-3 top-1/2 z-20 flex
                //  -translate-y-1/2 items-center justify-between
                //  text-blue-10/75`, `size-4` chevrons pointing inward.
                this.child(
                    div()
                        .absolute()
                        .left(px(12.))
                        .right(px(12.))
                        .top(gpui::relative(0.5))
                        .mt(px(-8.))
                        .flex()
                        .flex_row()
                        .items_center()
                        .justify_between()
                        .child(
                            svg()
                                .path("icons/chevron-right.svg")
                                .size(px(16.))
                                .text_color(Theme::with_alpha(theme.blue_10, 0.75)),
                        )
                        .child(
                            svg()
                                .path("icons/chevron-left.svg")
                                .size(px(16.))
                                .text_color(Theme::with_alpha(theme.blue_10, 0.75)),
                        ),
                )
            })
    }

    /// `flex h-11 shrink-0 items-center px-3 pb-2`.
    fn render_footer(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let playing = self.playing;
        let enabled = self.has_script();

        div()
            .flex()
            .flex_row()
            .items_center()
            .h(px(FOOTER_HEIGHT))
            .flex_shrink_0()
            .px(px(12.))
            .pb(px(8.))
            .child(
                // `flex size-8 items-center justify-center rounded-full border
                //  border-gray-12/6 bg-gray-12/7 text-gray-12 shadow-sm
                //  disabled:opacity-30`
                div()
                    .id("playback")
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(32.))
                    .flex_shrink_0()
                    .rounded_full()
                    .border_1()
                    .border_color(Theme::with_alpha(theme.gray_12, 0.06))
                    .bg(Theme::with_alpha(theme.gray_12, 0.07))
                    .when(!enabled, |this| this.opacity(0.3))
                    .when(enabled, |this| {
                        this.hover(|style| style.bg(Theme::with_alpha(theme.gray_12, 0.11)))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.toggle_playback(window, cx);
                            }))
                    })
                    .child(
                        svg()
                            .path(if playing {
                                "icons/pause.svg"
                            } else {
                                "icons/play.svg"
                            })
                            .size(px(14.))
                            .text_color(Hsla::from(theme.gray_12)),
                    ),
            )
            .child(
                // The scroll-speed pill: `ml-1.5 h-8 gap-1.5 rounded-full
                //  border border-gray-12/6 bg-gray-12/5 px-2`.
                self.pill()
                    .ml(px(6.))
                    .child(
                        svg()
                            .path("icons/gauge.svg")
                            .size(px(14.))
                            .flex_shrink_0()
                            .text_color(Hsla::from(theme.gray_9)),
                    )
                    .child(self.render_range(
                        "speed",
                        Slider::Speed,
                        (self.state.words_per_minute as f32 - WPM_MIN) / (WPM_MAX - WPM_MIN),
                        Hsla::from(theme.blue_9),
                        cx,
                    ))
                    .child(
                        // `w-12 text-right text-[10px] tabular-nums text-gray-9`
                        div()
                            .w(px(48.))
                            .text_right()
                            .text_size(px(10.))
                            .text_color(Hsla::from(theme.gray_9))
                            .child(format!("{} wpm", self.state.words_per_minute)),
                    ),
            )
            .child(
                // `ml-auto flex items-center gap-1.5`
                div()
                    .ml_auto()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .child(
                        self.pill()
                            .child(
                                svg()
                                    .path("icons/layers.svg")
                                    .size(px(14.))
                                    .flex_shrink_0()
                                    .text_color(Hsla::from(theme.gray_9)),
                            )
                            .child(self.render_range(
                                "opacity",
                                Slider::Opacity,
                                (self.state.window_opacity_percent as f32 - OPACITY_MIN)
                                    / (OPACITY_MAX - OPACITY_MIN),
                                Hsla::from(theme.gray_11),
                                cx,
                            )),
                    )
                    .child(
                        // The font-size stepper: same pill at `px-0.5`.
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .h(px(32.))
                            .rounded_full()
                            .border_1()
                            .border_color(Theme::with_alpha(theme.gray_12, 0.06))
                            .bg(Theme::with_alpha(theme.gray_12, 0.05))
                            .px(px(2.))
                            .child(self.tool_button(
                                "font-smaller",
                                "icons/minus.svg",
                                false,
                                cx.listener(|this, _, window, cx| {
                                    this.change_font_size(-FONT_SIZE_STEP, window, cx);
                                }),
                            ))
                            .child(
                                // `w-6 text-center text-[10px] tabular-nums`
                                div()
                                    .w(px(24.))
                                    .text_center()
                                    .text_size(px(10.))
                                    .text_color(Hsla::from(theme.gray_9))
                                    .child(format!("{}", self.state.font_size as i32)),
                            )
                            .child(self.tool_button(
                                "font-larger",
                                "icons/plus.svg",
                                false,
                                cx.listener(|this, _, window, cx| {
                                    this.change_font_size(FONT_SIZE_STEP, window, cx);
                                }),
                            )),
                    )
                    .child(self.tool_button(
                        "settings",
                        "icons/settings-2.svg",
                        self.settings_open,
                        cx.listener(|this, _, _window, cx| {
                            this.settings_open = !this.settings_open;
                            cx.notify();
                        }),
                    )),
            )
    }

    /// The shared footer pill -- [`ui::Card::glass_pill`].
    fn pill(&self) -> gpui::Div {
        ui::Card::glass_pill(&self.theme)
    }

    /// `ToolButton` -- [`ui::IconButton::glass`].
    fn tool_button(
        &self,
        id: &'static str,
        icon: &'static str,
        active: bool,
        on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
    ) -> ui::IconButton {
        ui::IconButton::glass(&self.theme, id, icon)
            .active(active)
            .on_click(on_click)
    }

    /// `<input type="range">`: a `h-1 w-12` `bg-gray-12/10` track with a
    /// `size-3` thumb -- [`ui::Slider`], whose canvas-prepaint track capture
    /// and drag layer this window and the settings zoom slider now share.
    fn render_range(
        &self,
        id: &'static str,
        slider: Slider,
        fraction: f32,
        thumb: Hsla,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let track = match slider {
            Slider::Speed => self.speed_track.clone(),
            Slider::Opacity => self.opacity_track.clone(),
        };

        ui::Slider::new(id, fraction, track)
            .row_width(px(48.))
            .track(px(4.), Theme::with_alpha(self.theme.gray_12, 0.10))
            .thumb(px(12.), thumb, None)
            .on_drag_start(cx.listener(
                move |this, event: &gpui::MouseDownEvent, window, cx| {
                    this.dragging = Some(slider);
                    this.set_slider_from(event.position, window, cx);
                },
            ))
    }

    /// While a range is held the whole window takes the mouse, so a drag that
    /// leaves the 48px track keeps updating -- pointer capture, by hand.
    fn render_slider_drag_layer(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        self.dragging?;
        Some(
            ui::Slider::drag_layer(
                "slider-drag",
                cx.listener(|this, event: &gpui::MouseMoveEvent, window, cx| {
                    this.set_slider_from(event.position, window, cx);
                }),
                cx.listener(|this, _, _window, cx| {
                    this.dragging = None;
                    cx.notify();
                }),
            )
            .into_any_element(),
        )
    }

    /// `absolute bottom-12 right-2 z-30 w-48 rounded-2xl border
    /// border-gray-12/8 bg-gray-1/80 p-2 shadow-xl`.
    fn render_settings_popover(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        if !self.settings_open {
            return None;
        }
        let theme = self.theme;

        Some(
            ui::Popover::glass(&theme, px(192.))
                .bottom(px(48.))
                .right(px(8.))
                .child(self.render_setting_toggle(
                    "cue-markers",
                    "icons/chevron-right.svg",
                    "Cue markers",
                    self.state.show_cue_markers,
                    cx.listener(|this, _, window, cx| {
                        this.state.show_cue_markers = !this.state.show_cue_markers;
                        this.touch(TeleprompterState::SHOW_CUE_MARKERS, window, cx);
                        cx.notify();
                    }),
                ))
                .child(self.render_setting_toggle(
                    "mirror",
                    "icons/flip-horizontal-2.svg",
                    "Mirror text",
                    self.state.mirror,
                    cx.listener(|this, _, window, cx| {
                        // Persisted, but inert: this gpui rev has no flip
                        // transform (the camera window's mirror button is
                        // disabled for the same reason). README deviation.
                        this.state.mirror = !this.state.mirror;
                        this.touch(TeleprompterState::MIRROR, window, cx);
                        cx.notify();
                    }),
                ))
                .into_any_element(),
        )
    }

    /// `SettingToggle`: `flex items-center justify-between px-2 py-2 text-xs
    /// text-gray-10` with a `size-3.5` glyph and a `<Toggle size="sm">`.
    fn render_setting_toggle(
        &self,
        id: &'static str,
        icon: &'static str,
        label: &'static str,
        checked: bool,
        on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
    ) -> impl IntoElement {
        let theme = self.theme;

        div()
            .id(SharedString::from(id))
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .px(px(8.))
            .py(px(8.))
            .text_size(px(12.))
            .text_color(Hsla::from(theme.gray_10))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        svg()
                            .path(icon)
                            .size(px(14.))
                            .flex_shrink_0()
                            .text_color(Hsla::from(theme.gray_10)),
                    )
                    .child(label),
            )
            // `<Toggle size="sm">` on bare glass.
            .child(ui::Toggle::glass(&theme, SharedString::from(format!("{id}-toggle")), checked))
            .on_click(on_click)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `teleprompter-utils.test.ts`, translated. `countWords` splits on any
    /// whitespace run, so a newline counts as a separator.
    #[test]
    fn counts_words_in_pasted_scripts() {
        assert_eq!(count_words("  One   two\nthree "), 3);
        assert_eq!(count_words(" "), 0);
    }

    #[test]
    fn clamps_a_setting_to_its_supported_range() {
        assert_eq!(clamp(5., 10., 20.), 10.);
        assert_eq!(clamp(25., 10., 20.), 20.);
    }

    #[test]
    fn calculates_a_positive_scroll_speed_from_reading_duration() {
        assert_eq!(calculate_playback_speed(600., 300, 150), 5.);
        assert_eq!(calculate_playback_speed(-10., 300, 150), 0.);
    }

    #[test]
    fn retains_sub_pixel_movement_across_animation_frames() {
        let mut position = 0.;
        for _ in 0..60 {
            position = advance_playback_position(position, 100., 10., 1. / 60.);
        }
        assert!((position - 10.).abs() < 0.01, "position was {position}");
    }

    /// Not in the TS suite, but the two guards the route relies on: a script
    /// shorter than a second of reading still moves (the duration floor), and
    /// the position never runs past the bottom.
    #[test]
    fn playback_is_bounded_at_both_ends() {
        // 3 words at 350wpm is 0.51s of reading, floored to 1s.
        assert_eq!(calculate_playback_speed(120., 3, 350), 120.);
        assert_eq!(advance_playback_position(90., 100., 1000., 1.), 100.);
        assert_eq!(advance_playback_position(-5., 100., 0., 1.), 0.);
    }

    /// The ranges snap to their steps and stay inside their bounds, which is
    /// what an `<input type="range" step="5">` does with a pointer anywhere on
    /// the track.
    #[test]
    fn ranges_snap_to_their_step() {
        assert_eq!(stepped(0., WPM_MIN, WPM_MAX, WPM_STEP), 60.);
        assert_eq!(stepped(1., WPM_MIN, WPM_MAX, WPM_STEP), 350.);
        // 60 + 0.5 * 290 = 205, already on the grid.
        assert_eq!(stepped(0.5, WPM_MIN, WPM_MAX, WPM_STEP), 205.);
        // 60 + 0.51 * 290 = 207.9 -> 210.
        assert_eq!(stepped(0.51, WPM_MIN, WPM_MAX, WPM_STEP), 210.);
        assert_eq!(stepped(0., OPACITY_MIN, OPACITY_MAX, OPACITY_STEP), 45.);
        assert_eq!(stepped(1., OPACITY_MIN, OPACITY_MAX, OPACITY_STEP), 100.);
    }
}
