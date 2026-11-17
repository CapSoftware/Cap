//! The editor's right-hand panel: Style, Transcript and Clips behind one
//! switcher, in one card, at one width.
//!
//! The panel never leaves the editor. Switching tabs swaps the card's body and
//! nothing else, so the player keeps its size; the width is shared by all three
//! tabs and dragged from the gap beside the player.
//!
//! `transcript.open` and `clips.open` stay the source of truth (the transcript
//! only re-derives its models while it is open, and the clips mode cancels a
//! pending editor recording when it closes), so the active tab is read from
//! them and every switch goes through [`EditorWindow::set_panel_tab`].

use gpui::{
    AnyElement, AnyWindowHandle, Context, CursorStyle, Div, FontWeight, Hsla, InteractiveElement,
    IntoElement, MouseButton, MouseDownEvent, ParentElement, SharedString, StyleRefinement, Styled,
    Window, div, prelude::FluentBuilder, px, svg,
};

use crate::editor_edits::Selection;
use crate::editor_timeline::TrackKind;
use crate::editor_window::{EditorWindow, SIDEBAR_TAB_BAR_HEIGHT, SIDEBAR_WIDTH};
use crate::i18n::tr;
use crate::theme::Theme;
use crate::ui;

const STORE_SECTION: &str = "editorPanel";
const WIDTH_KEY: &str = "width";

/// The gap between the player card and the panel. The resize grip lives in it.
pub(crate) const PANEL_GAP: f32 = 8.;
/// The widest the panel goes: a transcript line stays readable and the Style
/// controls do not stretch into a second column of empty space.
pub(crate) const MAX_PANEL_WIDTH: f32 = 720.;
/// What a widened panel always leaves the player.
const MIN_PLAYER_WIDTH: f32 = 480.;
/// The switcher row, matched to the player's own toolbar row so the two card
/// tops line up.
pub(crate) const SWITCHER_HEIGHT: f32 = 44.;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PanelTab {
    Style,
    Transcript,
    Clips,
}

impl PanelTab {
    pub(crate) const ALL: [PanelTab; 3] = [PanelTab::Style, PanelTab::Transcript, PanelTab::Clips];

    fn label(self) -> &'static str {
        match self {
            PanelTab::Style => tr::editor::side_panel::style(),
            PanelTab::Transcript => tr::editor::transcript::title(),
            PanelTab::Clips => tr::editor::clips::title(),
        }
    }

    /// The `CAP_GPUI_AUTO_PANEL` spelling.
    pub(crate) fn from_name(name: &str) -> Option<Self> {
        match name.trim().to_ascii_lowercase().as_str() {
            "style" => Some(PanelTab::Style),
            "transcript" => Some(PanelTab::Transcript),
            "clips" => Some(PanelTab::Clips),
            _ => None,
        }
    }

    /// Which tab the two mode flags describe. Clips wins a tie only because
    /// it is checked first; [`EditorWindow::set_panel_tab`] never lets both be
    /// set.
    pub(crate) fn from_flags(transcript_open: bool, clips_open: bool) -> Self {
        if clips_open {
            PanelTab::Clips
        } else if transcript_open {
            PanelTab::Transcript
        } else {
            PanelTab::Style
        }
    }

    /// Where Escape goes once nothing else wants it.
    pub(crate) fn escape_target(self) -> Option<Self> {
        (self != PanelTab::Style).then_some(PanelTab::Style)
    }
}

/// The shared width and the live drag. The width is persisted; the tab is not,
/// so the editor always opens on Style.
pub(crate) struct PanelState {
    pub(crate) width: f32,
    /// `(pointer x, width)` when the drag started.
    pub(crate) resize: Option<(f32, f32)>,
    /// The editor's own window, for the tab switch a selection asks for from
    /// a path that was handed no window.
    window: AnyWindowHandle,
}

impl PanelState {
    pub(crate) fn load(window: AnyWindowHandle) -> Self {
        let width = crate::store::store_section(STORE_SECTION)
            .get(WIDTH_KEY)
            .and_then(serde_json::Value::as_f64)
            .map(|width| width as f32)
            .filter(|width| width.is_finite())
            .map_or(SIDEBAR_WIDTH, |width| {
                width.clamp(SIDEBAR_WIDTH, MAX_PANEL_WIDTH)
            });
        Self {
            width,
            resize: None,
            window,
        }
    }

    fn persist(&self) {
        crate::store::set_store_setting(STORE_SECTION, WIDTH_KEY, serde_json::json!(self.width));
    }
}

/// The panel width the window can actually give: never under the Style
/// sidebar's own width, never so wide the player drops under
/// [`MIN_PLAYER_WIDTH`], never past [`MAX_PANEL_WIDTH`].
pub(crate) fn clamp_panel_width(width: f32, viewport_width: f32) -> f32 {
    // The 8px window gutters either side and the gap beside the player.
    let row = (viewport_width - 16. - PANEL_GAP).max(0.);
    let max = (row - MIN_PLAYER_WIDTH).clamp(SIDEBAR_WIDTH, MAX_PANEL_WIDTH);
    width.clamp(SIDEBAR_WIDTH, max)
}

pub(crate) fn dragged_panel_width(start_width: f32, start_x: f32, x: f32) -> f32 {
    start_width + (start_x - x)
}

/// The row under the switcher on the Transcript and Clips tabs: the tab's name
/// set like a Style section heading, a quiet count beside it, its actions on
/// the right. The same height as the Style tab's icon rail, so every tab's
/// body starts at the same line.
pub(crate) fn panel_header(
    theme: &Theme,
    title: &'static str,
    count: Option<SharedString>,
    actions: impl IntoElement,
) -> Div {
    let editor = theme.editor;
    div()
        .flex()
        .flex_row()
        .items_center()
        .justify_between()
        .flex_none()
        .gap(px(8.))
        .h(px(SIDEBAR_TAB_BAR_HEIGHT))
        .pl(px(16.))
        .pr(px(10.))
        .border_b_1()
        .border_color(Hsla::from(editor.line))
        .child(
            div()
                .flex()
                .flex_row()
                .items_baseline()
                .gap(px(6.))
                .min_w_0()
                .child(
                    div()
                        .flex_none()
                        .text_size(px(12.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(Hsla::from(editor.text_2))
                        .child(title),
                )
                .children(count.map(|count| {
                    div()
                        .min_w_0()
                        .truncate()
                        .text_size(px(12.))
                        .text_color(Hsla::from(editor.text_3))
                        .child(count)
                })),
        )
        .child(
            div()
                .flex()
                .flex_row()
                .flex_none()
                .items_center()
                .gap(px(2.))
                .child(actions),
        )
}

/// The one empty state the panel's tabs share: a quiet icon, a title, a line
/// of help (left out when empty). The caller adds whatever action belongs
/// under it.
pub(crate) fn panel_empty_state(
    theme: &Theme,
    icon: &'static str,
    title: impl Into<SharedString>,
    description: impl Into<SharedString>,
) -> Div {
    let editor = theme.editor;
    let description = description.into();
    div()
        .flex_1()
        .min_h_0()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(8.))
        .px(px(32.))
        .pb(px(SIDEBAR_TAB_BAR_HEIGHT))
        .child(
            svg()
                .path(icon)
                .size(px(22.))
                .mb(px(2.))
                .text_color(Hsla::from(editor.text_3)),
        )
        .child(
            div()
                .text_size(px(13.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(Hsla::from(editor.text_1))
                .child(title.into()),
        )
        .when(!description.is_empty(), |empty| {
            empty.child(
                div()
                    .max_w(px(280.))
                    .text_size(px(12.))
                    .line_height(px(18.))
                    .text_center()
                    .text_color(Hsla::from(editor.text_2))
                    .child(description),
            )
        })
}

impl EditorWindow {
    pub(crate) fn panel_tab(&self) -> PanelTab {
        PanelTab::from_flags(self.transcript.open, self.clips.open)
    }

    /// The one way between tabs. Style is always reachable; Transcript and
    /// Clips wait for the project, as their header pills used to.
    pub(crate) fn set_panel_tab(
        &mut self,
        tab: PanelTab,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if tab != PanelTab::Style && !self.project_ready() {
            return;
        }
        self.switch_panel_tab(tab, window, cx);
    }

    /// [`Self::set_panel_tab`] without the readiness gate. Leaving Clips runs
    /// its own close (a rename commits, a pending editor recording is
    /// cancelled) and clears the clip selection, as its toggle always did, but
    /// keeps a segment whose settings Style is about to show; leaving
    /// Transcript hands focus back to the window.
    pub(crate) fn switch_panel_tab(
        &mut self,
        tab: PanelTab,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let current = self.panel_tab();
        if current == tab {
            return;
        }
        match current {
            PanelTab::Clips => {
                if self.sidebar_selection().is_none() {
                    self.set_selection(None, cx);
                }
                self.close_clips(window, cx);
            }
            PanelTab::Transcript => self.close_transcript_panel(window, cx),
            PanelTab::Style => {}
        }
        match tab {
            PanelTab::Clips => {
                self.set_selection(None, cx);
                self.clips.open = true;
            }
            PanelTab::Transcript => self.open_transcript_panel(window, cx),
            PanelTab::Style => {}
        }
        tracing::debug!(from = ?current, to = ?tab, "editor panel tab");
        cx.notify();
    }

    /// A segment's settings live on the Style tab and nowhere else, so a
    /// segment arriving in the selection brings Style forward. It runs on
    /// every such selection, changed or not, so clicking a segment that is
    /// already selected still reveals its settings. Clips are left where they
    /// are, as [`EditorWindow::sidebar_selection`] leaves them out of the
    /// sidebar.
    ///
    /// `set_selection` is handed no window and the switch moves focus, so it
    /// runs as the current update unwinds, ahead of the next frame.
    pub(crate) fn follow_selection_to_style(
        &mut self,
        selection: Option<&Selection>,
        cx: &mut Context<Self>,
    ) {
        let segment = selection.is_some_and(|selection| selection.track != TrackKind::Clip);
        if !segment || self.panel_tab() == PanelTab::Style {
            return;
        }
        let handle = self.panel.window;
        let editor = cx.entity().downgrade();
        cx.defer(move |cx| {
            handle
                .update(cx, |_, window, cx| {
                    if let Some(editor) = editor.upgrade() {
                        editor.update(cx, |this, cx| {
                            if this.sidebar_selection().is_some() {
                                this.set_panel_tab(PanelTab::Style, window, cx);
                            }
                        });
                    }
                })
                .ok();
        });
    }

    /// Escape with nothing else to dismiss: back to Style.
    pub(crate) fn panel_escape(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(target) = self.panel_tab().escape_target() else {
            return false;
        };
        self.set_panel_tab(target, window, cx);
        true
    }

    pub(crate) fn panel_width(&self, viewport_width: f32) -> f32 {
        clamp_panel_width(self.panel.width, viewport_width)
    }

    pub(crate) fn panel_resize_move(
        &mut self,
        x: f32,
        viewport_width: f32,
        cx: &mut Context<Self>,
    ) {
        let Some((start_x, start_width)) = self.panel.resize else {
            return;
        };
        let width = clamp_panel_width(dragged_panel_width(start_width, start_x, x), viewport_width);
        if (width - self.panel.width).abs() > f32::EPSILON {
            self.panel.width = width;
            cx.notify();
        }
    }

    pub(crate) fn panel_resize_end(&mut self, cx: &mut Context<Self>) {
        if self.panel.resize.take().is_some() {
            self.panel.persist();
            cx.notify();
        }
    }

    /// `CAP_GPUI_AUTO_PANEL=style|transcript|clips`.
    pub(crate) fn auto_select_panel(
        &mut self,
        name: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(tab) = PanelTab::from_name(name) else {
            tracing::warn!(name, "unknown editor panel tab");
            return;
        };
        self.set_panel_tab(tab, window, cx);
        tracing::info!(tab = ?self.panel_tab(), "auto editor panel tab");
        window.refresh();
    }

    fn render_panel_switcher(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let active = self.panel_tab();
        let ready = self.project_ready();
        let options = PanelTab::ALL
            .into_iter()
            .map(|tab| ui::SegmentOption::new(tab.label(), tab == active).disabled(!ready))
            .collect();
        div()
            .flex()
            .flex_row()
            .items_center()
            .flex_none()
            .h(px(SWITCHER_HEIGHT))
            .px(px(10.))
            .child(
                div().flex_1().min_w_0().child(
                    ui::SegmentedControl::editor(&theme, "editor-panel-tabs", options)
                        .stretch()
                        .tab_stops()
                        .on_select(cx.listener(|this, index: &usize, window, cx| {
                            if let Some(tab) = ui::option_at(&PanelTab::ALL, *index) {
                                this.set_panel_tab(tab, window, cx);
                            }
                        })),
                ),
            )
    }

    /// The grip in the gap beside the player: invisible until hovered, so the
    /// default layout carries no extra chrome. Double-click puts the panel back
    /// to its standard width.
    pub(crate) fn render_panel_grip(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let dragging = self.panel.resize.is_some();
        div()
            .id("editor-panel-resize-handle")
            .group("editor-panel-grip")
            .flex_none()
            .w(px(PANEL_GAP))
            .h_full()
            .flex()
            .items_center()
            .justify_center()
            .cursor(CursorStyle::ResizeLeftRight)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &MouseDownEvent, window, cx| {
                    if event.click_count >= 2 {
                        this.panel.resize = None;
                        this.panel.width = SIDEBAR_WIDTH;
                        this.panel.persist();
                    } else {
                        let viewport_width = f32::from(window.viewport_size().width);
                        this.panel.resize = Some((
                            f32::from(event.position.x),
                            this.panel_width(viewport_width),
                        ));
                    }
                    cx.notify();
                }),
            )
            .child(
                div()
                    .w(px(4.))
                    .h(px(40.))
                    .rounded(px(2.))
                    .when(dragging, |pill| pill.bg(Hsla::from(theme.editor.text_3)))
                    .group_hover("editor-panel-grip", |pill| {
                        pill.bg(Hsla::from(theme.editor.text_3))
                    }),
            )
    }

    /// The panel card: the switcher, then whichever body the active tab owns.
    /// Style and Clips draw through the sidebar's cached section view, the
    /// transcript through its own, so playback repaints only the transcript.
    pub(crate) fn render_side_panel(
        &self,
        viewport_width: f32,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let tab = self.panel_tab();
        let focused = tab == PanelTab::Transcript && self.transcript.focus.is_focused(window);
        div()
            .id("editor-panel")
            .flex()
            .flex_col()
            .flex_none()
            .h_full()
            .min_h_0()
            .w(px(self.panel_width(viewport_width)))
            .rounded(px(12.))
            .border_1()
            .border_color(if focused {
                Hsla::from(theme.editor.line_strong)
            } else {
                self.card_line()
            })
            .bg(self.panel_bg())
            .shadow(theme.editor.card_shadow())
            .overflow_hidden()
            .child(self.render_panel_switcher(cx))
            .child(self.cached_panel_body(
                tab == PanelTab::Transcript,
                StyleRefinement::default().w_full().flex_1().min_h_0(),
            ))
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tab_follows_the_mode_flags() {
        assert_eq!(PanelTab::from_flags(false, false), PanelTab::Style);
        assert_eq!(PanelTab::from_flags(true, false), PanelTab::Transcript);
        assert_eq!(PanelTab::from_flags(false, true), PanelTab::Clips);
    }

    #[test]
    fn escape_returns_to_style_and_stops_there() {
        assert_eq!(PanelTab::Transcript.escape_target(), Some(PanelTab::Style));
        assert_eq!(PanelTab::Clips.escape_target(), Some(PanelTab::Style));
        assert_eq!(PanelTab::Style.escape_target(), None);
    }

    #[test]
    fn auto_panel_names_parse() {
        assert_eq!(PanelTab::from_name("style"), Some(PanelTab::Style));
        assert_eq!(
            PanelTab::from_name(" Transcript "),
            Some(PanelTab::Transcript)
        );
        assert_eq!(PanelTab::from_name("CLIPS"), Some(PanelTab::Clips));
        assert_eq!(PanelTab::from_name("captions"), None);
    }

    #[test]
    fn the_panel_width_stays_between_the_sidebar_and_a_usable_player() {
        // Wide window: the cap wins.
        assert_eq!(clamp_panel_width(2000., 1920.), MAX_PANEL_WIDTH);
        assert_eq!(clamp_panel_width(100., 1920.), SIDEBAR_WIDTH);
        assert_eq!(clamp_panel_width(560., 1920.), 560.);
        // Medium window: the player keeps its floor.
        let viewport = 1100.;
        let widest = clamp_panel_width(MAX_PANEL_WIDTH, viewport);
        assert_eq!(widest, viewport - 16. - PANEL_GAP - MIN_PLAYER_WIDTH);
        // Narrow window: never under the Style sidebar's own width.
        assert_eq!(clamp_panel_width(MAX_PANEL_WIDTH, 800.), SIDEBAR_WIDTH);
    }

    #[test]
    fn dragging_the_grip_left_widens_the_panel() {
        assert_eq!(dragged_panel_width(416., 900., 800.), 516.);
        assert_eq!(dragged_panel_width(516., 800., 900.), 416.);
    }
}
