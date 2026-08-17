//! The standalone mode picker -- `routes/mode-select.tsx` plus the
//! `components/ModeSelect.tsx` it renders, natively.
//!
//! 580x340, fixed, opaque. Unlike the main and settings windows this route is
//! *not* in the `(window-chrome)` group, so it gets no shared header, no
//! `applyMacOSWindowMaterial` and no Cmd-W binding: it rolls a `bg-gray-1` slab
//! with the native traffic lights sitting over it, and the only way out is the
//! close button.

use gpui::{
    Context, FocusHandle, FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement, Pixels,
    Point, Render, SharedString, StatefulInteractiveElement, Styled, Window, div,
    prelude::FluentBuilder, px, svg,
};

use crate::{
    main_window::Mode,
    theme::{Appearance, Theme},
};

/// `.inner_size(580.0, 340.0)` / `.min_inner_size(580.0, 340.0)` /
/// `.resizable(false)` on the `ShowCapWindow::ModeSelect` arm in `windows.rs`,
/// and the same pair again from `CapWindowId::ModeSelect::min_size`.
pub const MODE_SELECT_WIDTH: f32 = 580.;
pub const MODE_SELECT_HEIGHT: f32 = 340.;

/// `max-w-lg` on the wrapper around `<ModeSelect />`: 32rem.
const CONTENT_MAX_WIDTH: f32 = 512.;

impl Mode {
    /// `modeOptions` in `ModeSelect.tsx` -- a third set of strings, shorter
    /// than both `MODE_BUTTONS`' hover cards and `ModeInfoPanel`'s rows. The
    /// app carries all three; so do we.
    fn card_description(self) -> &'static str {
        match self {
            Self::Instant => "Share instantly with a link. Uploads as you record.",
            Self::Studio => "Highest quality local recording for editing later.",
            Self::Screenshot => "Capture and annotate screenshots instantly.",
        }
    }
}

pub struct ModeSelectWindow {
    theme: Theme,
    /// Seeded from the main window at open, which is where this app keeps the
    /// recording mode (`rawOptions.mode` from `createOptionsQuery` over
    /// there). The main window is hidden while this one is up, so the two
    /// cannot drift.
    mode: Mode,
    focus: FocusHandle,
}

impl ModeSelectWindow {
    pub fn new(mode: Mode, window: &mut Window, cx: &mut Context<Self>) -> Self {
        // `CapWindowId::Upgrade | CapWindowId::ModeSelect` in the `Destroyed`
        // arm calls `restore_main_and_target_select_windows`: however this
        // window goes away, the main window comes back. Deferred out of the
        // callback -- it fires with the App borrowed.
        window.on_window_should_close(cx, |_window, cx| {
            cx.defer(crate::app_windows::mode_select_closed);
            true
        });

        Self {
            // No material: `applyMacOSWindowMaterial` runs in the
            // `(window-chrome)` layout, and this route is not in it. The window
            // is `bg-gray-1` and opaque (`is_transparent()` is false for
            // ModeSelect).
            theme: Theme::new(Appearance::from_window(window.appearance())),
            mode,
            focus: cx.focus_handle(),
        }
    }

    pub fn focus_root(&self, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
    }

    /// Re-target an already-open window, the way `showWindow("ModeSelect")`
    /// reuses a live one.
    pub fn set_mode(&mut self, mode: Mode, cx: &mut Context<Self>) {
        self.mode = mode;
        cx.notify();
    }

    /// A card's click: the local selection, then `handleModeChange` --
    /// `setOptions({ mode })` plus `commands.setRecordingMode(mode)`, both of
    /// which live in `app_windows::set_recording_mode`. Deferred because it
    /// reaches another window, and reaching one inside this update would
    /// double-lease the view.
    pub fn choose(&mut self, mode: Mode, cx: &mut Context<Self>) {
        self.mode = mode;
        cx.notify();
        cx.defer(move |cx: &mut gpui::App| crate::app_windows::set_recording_mode(mode, cx));
    }

    fn sync_appearance(&mut self, window: &Window) {
        let appearance = Appearance::from_window(window.appearance());
        if appearance != self.theme.appearance {
            self.theme = Theme::new(appearance);
        }
    }

    /// `ModeOption`: one card per mode, the whole card a button.
    fn render_card(&self, mode: Mode, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let selected = mode == self.mode;
        let dark = theme.is_dark();

        div()
            .id(SharedString::from(mode.panel_title()))
            .relative()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .items_center()
            // `rounded-xl border-2 overflow-hidden`
            .rounded(px(12.))
            .border_2()
            .overflow_hidden()
            .border_color(if selected {
                Hsla::from(theme.blue_9)
            } else if dark {
                // `border-gray-4 dark:border-gray-5`
                Hsla::from(theme.gray_5)
            } else {
                Hsla::from(theme.gray_4)
            })
            .bg(if selected {
                // `bg-blue-3 dark:bg-blue-3/30`
                theme.tile_selected_bg()
            } else if dark {
                // `bg-gray-2 dark:bg-gray-3`
                Hsla::from(theme.gray_3)
            } else {
                Hsla::from(theme.gray_2)
            })
            .when(selected, |this| {
                // `shadow-lg shadow-blue-9/10`
                this.shadow(vec![gpui::BoxShadow {
                    color: Theme::with_alpha(theme.blue_9, 0.1),
                    offset: gpui::point(px(0.), px(10.)),
                    blur_radius: px(15.),
                    spread_radius: px(-3.),
                    inset: false,
                }])
            })
            .when(!selected, |this| {
                // `hover:border-gray-6 dark:hover:border-gray-6
                //  hover:bg-gray-3 dark:hover:bg-gray-4`
                this.hover(move |style| {
                    style.border_color(Hsla::from(theme.gray_6)).bg(if dark {
                        Hsla::from(theme.gray_4)
                    } else {
                        Hsla::from(theme.gray_3)
                    })
                })
            })
            .when(selected, |this| {
                // `absolute top-2.5 right-2.5 size-5 rounded-full bg-blue-9`
                // with a `size-3` white check.
                this.child(
                    div()
                        .absolute()
                        .top(px(10.))
                        .right(px(10.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .size(px(20.))
                        .rounded_full()
                        .bg(Hsla::from(theme.blue_9))
                        .child(
                            svg()
                                .path("icons/check.svg")
                                .size(px(12.))
                                .text_color(gpui::white()),
                        ),
                )
            })
            .child(
                // `flex items-center justify-center w-full pt-5 pb-3`,
                // `size-6` glyph.
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .w_full()
                    .pt(px(20.))
                    .pb(px(12.))
                    .child(
                        svg()
                            .path(mode.icon())
                            .size(px(24.))
                            // `invert dark:invert-0`: a monochrome glyph in the
                            // foreground colour. gpui tints the alpha mask, so
                            // the filter trick is just the text colour here.
                            .text_color(theme.gray_12),
                    ),
            )
            .child(
                // `flex flex-col items-center px-4 pb-4 text-center`
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .px(px(16.))
                    .pb(px(16.))
                    .text_center()
                    .child(
                        // `text-base font-semibold mb-1.5`
                        div()
                            .mb(px(6.))
                            .text_size(px(16.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(if selected {
                                Hsla::from(theme.blue_11)
                            } else {
                                Hsla::from(theme.gray_12)
                            })
                            .child(mode.panel_title()),
                    )
                    .child(
                        // `text-xs leading-relaxed text-gray-11 line-clamp-3`
                        div()
                            .text_size(px(12.))
                            .line_height(px(12. * 1.625))
                            .line_clamp(3)
                            .text_color(Hsla::from(theme.gray_11))
                            .child(mode.card_description()),
                    ),
            )
            .on_click(cx.listener(move |this, _, _window, cx| this.choose(mode, cx)))
    }
}

impl Render for ModeSelectWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_appearance(window);
        let theme = self.theme;

        div()
            .track_focus(&self.focus)
            // `flex flex-col relative justify-center items-center min-h-screen
            //  bg-gray-1`
            .size_full()
            .relative()
            .flex()
            .flex_col()
            .justify_center()
            .items_center()
            .bg(Hsla::from(theme.gray_1))
            .font_family("Geist")
            .text_color(theme.text_primary)
            .child(
                // `flex flex-col items-center w-full px-6 py-5`
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .w_full()
                    .px(px(24.))
                    .py(px(20.))
                    .child(
                        // `mb-5 text-center`
                        div()
                            .mb(px(20.))
                            .flex()
                            .flex_col()
                            .items_center()
                            .text_center()
                            .child(
                                // `text-xl font-semibold text-gray-12 mb-1`
                                div()
                                    .mb(px(4.))
                                    .text_size(px(20.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(Hsla::from(theme.gray_12))
                                    .child("Choose Recording Mode"),
                            )
                            .child(
                                // `text-sm text-gray-11`
                                div()
                                    .text_size(px(14.))
                                    .text_color(Hsla::from(theme.gray_11))
                                    .child("Select how you want to capture your screen"),
                            ),
                    )
                    .child(
                        // `w-full max-w-lg` around `grid grid-cols-3 gap-4`.
                        div()
                            .w_full()
                            .max_w(px(CONTENT_MAX_WIDTH))
                            .flex()
                            .flex_row()
                            .items_stretch()
                            .gap(px(16.))
                            .child(self.render_card(Mode::Instant, cx))
                            .child(self.render_card(Mode::Studio, cx))
                            .child(self.render_card(Mode::Screenshot, cx)),
                    ),
            )
    }
}

/// The traffic lights stay where AppKit puts them: `ModeSelect` has no arm in
/// `traffic_lights_position()` and falls into the `_ => Some(None)` catch-all,
/// which keeps the native buttons at the default inset and only hides the
/// title (`hidden_title(true)` + `TitleBarStyle::Overlay`).
pub const TRAFFIC_LIGHTS: Option<Point<Pixels>> = None;
