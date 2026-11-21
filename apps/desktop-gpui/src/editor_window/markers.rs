//! Markers are anchored to source time, so their output positions come from
//! `TimelineConfiguration::place_markers` and follow every cut, split, speed
//! change and clip reorder. A marker in footage that was cut out is hidden
//! rather than deleted.

use super::*;
use cap_project::{PlacedMarker, TimelineMarker};

/// The swatches, default first. Red is left out: it is the playhead's colour.
pub(super) const MARKER_COLORS: [&str; 6] = [
    "#ff9f0a", "#ffcc00", "#34c759", "#0a84ff", "#af52de", "#ff2d55",
];

const MARKER_STACK_PX: f32 = 14.;
const MARKER_DRAG_PX: f32 = 3.;
const MARKER_SNAP_PX: f64 = 6.;
const MARKER_SPREAD_PX: f64 = 24.;
const FLAG_ICON: f32 = 12.;
/// Where the pole sits inside the flag glyph (x = 4.17 of 20).
const FLAG_POLE: f32 = FLAG_ICON * 4.166_67 / 20.;
const FLAG_PAD: f32 = 3.;
const MARKER_LIST_WIDTH: f32 = 300.;
const MARKER_EDITOR_WIDTH: f32 = 252.;
const MARKER_POPOVER_MARGIN: f32 = 12.;

pub(super) struct MarkersState {
    pub(super) placed: Vec<PlacedMarker>,
    pub(super) selected: Option<String>,
    pub(super) drag: Option<MarkerDrag>,
    list: Option<Point<Pixels>>,
    editor: Option<MarkerEditor>,
    label_input: Entity<ui::TextInputState>,
    list_scroll: gpui::ScrollHandle,
}

#[derive(Clone, Debug)]
pub(super) struct MarkerDrag {
    id: String,
    press_x: f32,
    time: f64,
    moved: bool,
}

struct MarkerEditor {
    id: String,
    anchor: Point<Pixels>,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct MarkerStack {
    pub(super) start: usize,
    pub(super) len: usize,
    pub(super) x: f32,
}

pub(super) fn marker_stacks(
    placed: &[PlacedMarker],
    position: f64,
    secs_per_pixel: f64,
    width: f32,
) -> Vec<MarkerStack> {
    let mut stacks: Vec<MarkerStack> = Vec::new();
    for (index, marker) in placed.iter().enumerate() {
        let x = ((marker.time - position) / secs_per_pixel) as f32;
        if !x.is_finite() {
            continue;
        }
        match stacks.last_mut() {
            Some(stack) if x - stack.x < MARKER_STACK_PX => stack.len += 1,
            _ => stacks.push(MarkerStack {
                start: index,
                len: 1,
                x,
            }),
        }
    }
    stacks.retain(|stack| stack.x >= -MARKER_STACK_PX && stack.x <= width);
    stacks
}

pub(super) fn spread_zoom(times: &[f64], content_width: f32) -> Option<f64> {
    let gap = times
        .windows(2)
        .map(|pair| pair[1] - pair[0])
        .filter(|gap| *gap > 1e-9)
        .fold(f64::INFINITY, f64::min);
    gap.is_finite()
        .then(|| gap / MARKER_SPREAD_PX * content_width.max(1.) as f64)
}

/// The marker at or past `time` in `direction`, half a frame either side of
/// the playhead counting as "on" it, so repeated presses walk the list.
pub(super) fn neighbour_marker(placed: &[PlacedMarker], time: f64, forward: bool) -> Option<f64> {
    let epsilon = 0.5 / EDITOR_PREVIEW_FPS as f64;
    if forward {
        placed
            .iter()
            .map(|marker| marker.time)
            .find(|marker| *marker > time + epsilon)
    } else {
        placed
            .iter()
            .rev()
            .map(|marker| marker.time)
            .find(|marker| *marker < time - epsilon)
    }
}

pub(super) enum MarkerPress {
    Select(usize),
    Add(TimelineMarker),
}

/// A new marker is for the source instant playing at `time`, drawn where that
/// instant plays. That is `time` itself except on a fullscreen text hold,
/// which plays one source frame for its whole length and draws that frame's
/// marker at the hold's end, so the duplicate check has to look there.
pub(super) fn marker_press(
    timeline: &TimelineConfiguration,
    placed: &[PlacedMarker],
    time: f64,
) -> Option<MarkerPress> {
    let (recording_clip, source) = timeline.source_for_output_time(time)?;
    let drawn_at = timeline
        .output_time_for_source(recording_clip, source)
        .unwrap_or(time);
    let epsilon = 0.5 / EDITOR_PREVIEW_FPS as f64;
    Some(
        match placed
            .iter()
            .find(|placed| (placed.time - drawn_at).abs() < epsilon)
        {
            Some(existing) => MarkerPress::Select(existing.index),
            None => MarkerPress::Add(TimelineMarker::new(recording_clip, source)),
        },
    )
}

/// Splits the clip under each output time. Splits never move footage, so
/// the times stay valid as the clips are cut one after another.
pub(super) fn split_clips_at(timeline: &mut TimelineConfiguration, times: &[f64]) -> bool {
    let mut changed = false;
    for time in times {
        changed |= edits::split_clip_segment(timeline, *time, None);
    }
    changed
}

fn parse_marker_color(value: Option<&str>) -> Hsla {
    let value = value.unwrap_or(MARKER_COLORS[0]);
    let hex = value.trim_start_matches('#');
    let rgb = if hex.len() == 6 {
        u32::from_str_radix(hex, 16).ok()
    } else {
        None
    };
    gpui::Rgba::from(gpui::rgb(rgb.unwrap_or(0xff9f0a))).into()
}

fn marker_name(marker: &TimelineMarker, ordinal: usize) -> SharedString {
    let label = marker.label.trim();
    if label.is_empty() {
        SharedString::from(tr::editor::markers::default_name(ordinal + 1))
    } else {
        SharedString::from(label.to_string())
    }
}

impl MarkersState {
    pub(super) fn new(
        window: &mut Window,
        cx: &mut Context<EditorWindow>,
        subscriptions: &mut Vec<Subscription>,
    ) -> Self {
        let label_input = cx.new(|cx| ui::TextInputState::single_line(window, cx));
        subscriptions.push(cx.subscribe_in(
            &label_input,
            window,
            |this: &mut EditorWindow, _input, event: &ui::TextInputEvent, window, cx| match event {
                ui::TextInputEvent::Confirmed => this.close_marker_editor(true, window, cx),
                ui::TextInputEvent::Cancelled => this.close_marker_editor(false, window, cx),
                _ => {}
            },
        ));
        Self {
            placed: Vec::new(),
            selected: None,
            drag: None,
            list: None,
            editor: None,
            label_input,
            list_scroll: gpui::ScrollHandle::new(),
        }
    }

    pub(super) fn popover_open(&self) -> bool {
        self.list.is_some() || self.editor.is_some()
    }
}

impl EditorWindow {
    pub(super) fn refresh_markers(&mut self) {
        self.markers.placed = self
            .project
            .timeline
            .as_ref()
            .map(|timeline| timeline.place_markers(&self.project.markers))
            .unwrap_or_default();
        if let Some(selected) = &self.markers.selected
            && !self
                .project
                .markers
                .iter()
                .any(|marker| &marker.id == selected)
        {
            self.markers.selected = None;
        }
    }

    fn marker_index(&self, id: &str) -> Option<usize> {
        self.project
            .markers
            .iter()
            .position(|marker| marker.id == id)
    }

    fn marker_ordinal(&self, index: usize) -> usize {
        self.markers
            .placed
            .iter()
            .position(|placed| placed.index == index)
            .unwrap_or(index)
    }

    fn marker_time(&self, id: &str) -> Option<f64> {
        let index = self.marker_index(id)?;
        self.markers
            .placed
            .iter()
            .find(|placed| placed.index == index)
            .map(|placed| placed.time)
    }

    /// The renderer is not told: nothing it draws depends on markers.
    fn markers_changed(
        &mut self,
        reason: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.history.record(&self.project);
        self.refresh_markers();
        self.schedule_save(window, cx);
        tracing::info!(
            reason,
            markers = self.project.markers.len(),
            shown = self.markers.placed.len(),
            "marker edit"
        );
        cx.notify();
    }

    fn select_marker(&mut self, id: Option<String>, cx: &mut Context<Self>) {
        if id.is_some() && self.selection.is_some() {
            self.set_selection(None, cx);
        }
        self.markers.selected = id;
        cx.notify();
    }

    pub(super) fn clear_marker_selection(&mut self) {
        self.markers.selected = None;
    }

    /// A second press on the same frame selects the marker already there
    /// instead of stacking a duplicate.
    pub(super) fn add_marker_at_playhead(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.project_ready() {
            return;
        }
        let time = self.playhead.clamp(0.0, self.total_duration());
        let Some(press) = self
            .project
            .timeline
            .as_ref()
            .and_then(|timeline| marker_press(timeline, &self.markers.placed, time))
        else {
            return;
        };
        match press {
            MarkerPress::Select(index) => {
                let id = self.project.markers[index].id.clone();
                self.select_marker(Some(id), cx);
            }
            MarkerPress::Add(marker) => {
                let id = marker.id.clone();
                self.project.markers.push(marker);
                self.markers_changed("marker-add", window, cx);
                self.select_marker(Some(id), cx);
            }
        }
    }

    pub(super) fn jump_to_marker(&mut self, forward: bool, cx: &mut Context<Self>) {
        let Some(time) = neighbour_marker(&self.markers.placed, self.playhead, forward) else {
            return;
        };
        if let Some(placed) = self
            .markers
            .placed
            .iter()
            .find(|placed| placed.time == time)
        {
            let id = self.project.markers[placed.index].id.clone();
            self.select_marker(Some(id), cx);
        }
        self.seek_to_marker_time(time, cx);
    }

    fn seek_to_marker_time(&mut self, time: f64, cx: &mut Context<Self>) {
        let transform = self.view.transform;
        if time < transform.position || time > transform.position + transform.zoom {
            let total = self.total_duration();
            self.view
                .transform
                .set_position(time - transform.zoom / 2., total);
        }
        self.seek_to_time(time, cx);
        cx.notify();
    }

    fn delete_marker(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(index) = self.marker_index(id) else {
            return;
        };
        self.project.markers.remove(index);
        if self.markers.selected.as_deref() == Some(id) {
            self.markers.selected = None;
        }
        if self
            .markers
            .editor
            .as_ref()
            .is_some_and(|editor| editor.id == id)
        {
            self.markers.editor = None;
        }
        self.markers_changed("marker-delete", window, cx);
    }

    pub(super) fn delete_selected_marker(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(id) = self.markers.selected.clone() else {
            return false;
        };
        self.delete_marker(&id, window, cx);
        true
    }

    fn set_marker_color(
        &mut self,
        id: &str,
        color: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(index) = self.marker_index(id) else {
            return;
        };
        if self.project.markers[index].color == color {
            return;
        }
        self.project.markers[index].color = color;
        self.markers_changed("marker-color", window, cx);
    }

    fn move_marker(&mut self, id: &str, time: f64, window: &mut Window, cx: &mut Context<Self>) {
        let Some(index) = self.marker_index(id) else {
            return;
        };
        let Some((recording_clip, source)) = self
            .project
            .timeline
            .as_ref()
            .and_then(|timeline| timeline.source_for_output_time(time))
        else {
            return;
        };
        let marker = &mut self.project.markers[index];
        if marker.recording_clip == recording_clip && (marker.time - source).abs() < 1e-9 {
            return;
        }
        marker.recording_clip = recording_clip;
        marker.time = source;
        self.markers_changed("marker-move", window, cx);
    }

    /// Markers on a clip edge or too close to a crossfade are skipped, as a
    /// split there would be.
    fn split_at_markers(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let times: Vec<f64> = self
            .markers
            .placed
            .iter()
            .map(|placed| placed.time)
            .collect();
        if times.is_empty() {
            return;
        }
        let split = self.edit(|timeline| split_clips_at(timeline, &times), window, cx);
        self.focus_root(window, cx);
        if split {
            self.markers.list = None;
            self.note_edit("split-at-markers", Some(TrackKind::Clip));
        }
    }

    fn marker_flag_down(
        &mut self,
        stack: MarkerStack,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        cx.stop_propagation();
        if !self.project_ready() {
            return;
        }
        self.focus_root(window, cx);
        let markers: Vec<PlacedMarker> = self
            .markers
            .placed
            .get(stack.start..stack.start + stack.len)
            .map(<[PlacedMarker]>::to_vec)
            .unwrap_or_default();
        let Some(first) = markers.first().copied() else {
            return;
        };
        if markers.len() > 1 {
            let viewport_width: f32 = window.viewport_size().width.into();
            let times: Vec<f64> = markers.iter().map(|marker| marker.time).collect();
            let id = self.project.markers[first.index].id.clone();
            self.select_marker(Some(id), cx);
            match spread_zoom(&times, timeline::content_width(viewport_width))
                .filter(|zoom| *zoom >= timeline::MAX_ZOOM_IN)
            {
                Some(zoom) => {
                    let total = self.total_duration();
                    self.view.transform.update_zoom(zoom, first.time, total);
                    self.note_transform("marker-stack", Some(first.time));
                }
                None => {
                    self.markers.editor = None;
                    self.markers.list = Some(event.position);
                }
            }
            self.seek_to_time(first.time, cx);
            cx.notify();
            return;
        }
        let id = self.project.markers[first.index].id.clone();
        if event.click_count >= 2 {
            self.open_marker_editor(id, event.position, window, cx);
            return;
        }
        self.select_marker(Some(id.clone()), cx);
        self.markers.drag = Some(MarkerDrag {
            id,
            press_x: f32::from(event.position.x),
            time: first.time,
            moved: false,
        });
    }

    fn marker_flag_right_down(
        &mut self,
        stack: MarkerStack,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        cx.stop_propagation();
        if stack.len != 1 || !self.project_ready() {
            return;
        }
        let Some(placed) = self.markers.placed.get(stack.start).copied() else {
            return;
        };
        let id = self.project.markers[placed.index].id.clone();
        self.open_marker_editor(id, event.position, window, cx);
    }

    pub(super) fn marker_drag_move(&mut self, x: f32, window: &mut Window, cx: &mut Context<Self>) {
        let Some(drag) = self.markers.drag.as_ref() else {
            return;
        };
        if !drag.moved && (x - drag.press_x).abs() < MARKER_DRAG_PX {
            return;
        }
        let viewport_width: f32 = window.viewport_size().width.into();
        let total = self.total_duration();
        let secs_per_pixel = self
            .view
            .transform
            .secs_per_pixel(timeline::content_width(viewport_width));
        let mut time = timeline::time_from_x(x, viewport_width, self.view.transform, total);
        if ((time - self.playhead) / secs_per_pixel).abs() <= MARKER_SNAP_PX {
            time = self.playhead;
        }
        if let Some(drag) = self.markers.drag.as_mut() {
            drag.moved = true;
            drag.time = time.clamp(0.0, total);
        }
        self.invalidate_hover_chrome(cx);
    }

    pub(super) fn marker_drag_up(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(drag) = self.markers.drag.take() else {
            return;
        };
        if drag.moved {
            self.move_marker(&drag.id, drag.time, window, cx);
        } else {
            self.seek_to_marker_time(drag.time, cx);
        }
        cx.notify();
    }

    pub(super) fn marker_key(
        &mut self,
        keystroke: &gpui::Keystroke,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if !self.project_ready() {
            return false;
        }
        let modifiers = keystroke.modifiers;
        let bare = !modifiers.platform && !modifiers.control && !modifiers.alt && !modifiers.shift;
        let alt_only =
            modifiers.alt && !modifiers.platform && !modifiers.control && !modifiers.shift;
        match keystroke.key.as_str() {
            "m" if bare => {
                self.add_marker_at_playhead(window, cx);
                true
            }
            "left" if alt_only => {
                self.jump_to_marker(false, cx);
                true
            }
            "right" if alt_only => {
                self.jump_to_marker(true, cx);
                true
            }
            "backspace" | "delete" if bare && self.selection.is_none() => {
                self.delete_selected_marker(window, cx)
            }
            _ => false,
        }
    }

    pub(super) fn marker_escape(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.markers.editor.is_some() {
            self.close_marker_editor(false, window, cx);
            return true;
        }
        if self.markers.list.take().is_some() {
            cx.notify();
            return true;
        }
        if self.markers.drag.take().is_some() || self.markers.selected.take().is_some() {
            cx.notify();
            return true;
        }
        false
    }

    fn toggle_marker_list(&mut self, anchor: Point<Pixels>, cx: &mut Context<Self>) {
        if self.markers.list.take().is_some() {
            cx.notify();
            return;
        }
        self.markers.editor = None;
        self.markers.list = Some(anchor);
        cx.notify();
    }

    fn open_marker_editor(
        &mut self,
        id: String,
        anchor: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(index) = self.marker_index(&id) else {
            return;
        };
        let ordinal = self.marker_ordinal(index);
        let label = self.project.markers[index].label.clone();
        let placeholder = tr::editor::markers::default_name(ordinal + 1);
        self.markers.list = None;
        self.select_marker(Some(id.clone()), cx);
        self.markers.editor = Some(MarkerEditor { id, anchor });
        self.markers.label_input.update(cx, |input, cx| {
            input.set_placeholder(placeholder);
            input.set_text(label, cx);
            input.focus_and_select_all(window, cx);
        });
        cx.notify();
    }

    fn close_marker_editor(&mut self, commit: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = self.markers.editor.take() else {
            return;
        };
        if commit && let Some(index) = self.marker_index(&editor.id) {
            let label = self.markers.label_input.read(cx).text().trim().to_string();
            if self.project.markers[index].label != label {
                self.project.markers[index].label = label;
                self.markers_changed("marker-label", window, cx);
            }
        }
        self.focus_root(window, cx);
        cx.notify();
    }

    /// The markers as drawn: the live drag moves its marker without touching
    /// the project until release.
    fn drawn_markers(&self) -> std::borrow::Cow<'_, [PlacedMarker]> {
        let Some(drag) = self.markers.drag.as_ref().filter(|drag| drag.moved) else {
            return std::borrow::Cow::Borrowed(&self.markers.placed);
        };
        let Some(index) = self.marker_index(&drag.id) else {
            return std::borrow::Cow::Borrowed(&self.markers.placed);
        };
        let mut drawn = self.markers.placed.clone();
        if let Some(placed) = drawn.iter_mut().find(|placed| placed.index == index) {
            placed.time = drag.time;
        } else {
            drawn.push(PlacedMarker {
                index,
                time: drag.time,
            });
        }
        drawn.sort_by(|a, b| a.time.total_cmp(&b.time).then(a.index.cmp(&b.index)));
        std::borrow::Cow::Owned(drawn)
    }

    /// The flags along the ruler. Drawn over the ruler's scrub surface so a
    /// press on a flag selects, seeks or drags it instead of scrubbing.
    pub(super) fn render_marker_flags(
        &self,
        viewport_width: f32,
        cx: &mut Context<Self>,
    ) -> Option<gpui::AnyElement> {
        if !self.project_ready() || self.project.markers.is_empty() {
            return None;
        }
        let theme = self.theme;
        let drawn = self.drawn_markers();
        let content = timeline::content_width(viewport_width);
        let secs_per_pixel = self.view.transform.secs_per_pixel(content);
        let strip = timeline::ruler_width(viewport_width) - TRACK_GUTTER;
        let stacks = marker_stacks(&drawn, self.view.transform.position, secs_per_pixel, strip);
        let card = theme.editor.card;
        let dragging = self
            .markers
            .drag
            .as_ref()
            .filter(|drag| drag.moved)
            .map(|drag| drag.id.as_str());

        let mut layer = div()
            .absolute()
            .top_0()
            .bottom_0()
            .left(px(TRACK_GUTTER))
            .right_0()
            .overflow_hidden();
        for (position, stack) in stacks.iter().enumerate() {
            let Some(first) = drawn.get(stack.start).copied() else {
                continue;
            };
            let Some(marker) = self.project.markers.get(first.index) else {
                continue;
            };
            let color = parse_marker_color(marker.color.as_deref());
            let single = stack.len == 1;
            let selected = single && self.markers.selected.as_deref() == Some(marker.id.as_str());
            let held = single && dragging == Some(marker.id.as_str());
            let room = stacks
                .get(position + 1)
                .map_or(strip - stack.x, |next| next.x - stack.x)
                - FLAG_ICON
                - FLAG_PAD * 3.;
            let label = marker.label.trim();
            let show_label = single && !label.is_empty() && room >= 28.;
            let ordinal = self.marker_ordinal(first.index);
            let tooltip_text: SharedString = if single {
                SharedString::from(format!(
                    "{}  {}",
                    marker_name(marker, ordinal),
                    timeline::format_time(first.time)
                ))
            } else {
                SharedString::from(tr::editor::markers::stack(stack.len))
            };
            let stack_for_down = stack.clone();
            let stack_for_right = stack.clone();
            layer = layer.child(
                div()
                    .id(("marker-flag", position))
                    .absolute()
                    .left(px(stack.x - FLAG_POLE - FLAG_PAD))
                    .top(px(1.))
                    .h(px(FLAG_ICON + 4.))
                    .max_w(px(
                        (room + FLAG_ICON + FLAG_PAD * 2.).max(FLAG_ICON + FLAG_PAD * 2.)
                    ))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(2.))
                    .px(px(FLAG_PAD))
                    .rounded(px(5.))
                    .bg(if selected || held {
                        crate::theme::mix(card, gpui::Rgba::from(color), 0.22)
                    } else {
                        card
                    })
                    .cursor(if held {
                        gpui::CursorStyle::ResizeLeftRight
                    } else {
                        gpui::CursorStyle::PointingHand
                    })
                    .child(
                        svg()
                            .path("icons/flag-filled.svg")
                            .size(px(FLAG_ICON))
                            .flex_none()
                            .text_color(color),
                    )
                    .when(!single, |flag| {
                        flag.child(
                            div()
                                .flex_none()
                                .text_size(px(10.))
                                .line_height(px(12.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .font_features(crate::editor_timeline::tabular_numerals())
                                .text_color(Hsla::from(theme.editor.text_2))
                                .child(SharedString::from(stack.len.to_string())),
                        )
                    })
                    .when(show_label, |flag| {
                        flag.child(
                            div()
                                .min_w_0()
                                .truncate()
                                .text_size(px(10.))
                                .line_height(px(12.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(Hsla::from(theme.editor.text_2))
                                .child(SharedString::from(label.to_string())),
                        )
                    })
                    .tooltip_show_delay(ui::TOOLTIP_SHOW_DELAY)
                    .tooltip(move |_, cx| ui::Tooltip::new(&theme, tooltip_text.clone()).view(cx))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                            this.marker_flag_down(stack_for_down.clone(), event, window, cx);
                        }),
                    )
                    .on_mouse_down(
                        MouseButton::Right,
                        cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                            this.marker_flag_right_down(stack_for_right.clone(), event, window, cx);
                        }),
                    ),
            );
        }
        Some(layer.into_any_element())
    }

    pub(super) fn render_marker_lines(&self, viewport_width: f32) -> Vec<gpui::AnyElement> {
        if !self.project_ready() || (self.markers.placed.is_empty() && self.markers.drag.is_none())
        {
            return Vec::new();
        }
        let drawn = self.drawn_markers();
        let content = timeline::content_width(viewport_width);
        let secs_per_pixel = self.view.transform.secs_per_pixel(content);
        marker_stacks(
            &drawn,
            self.view.transform.position,
            secs_per_pixel,
            content,
        )
        .into_iter()
        .filter(|stack| stack.x >= 0. && stack.x <= content)
        .filter_map(|stack| {
            let first = drawn.get(stack.start)?;
            let marker = self.project.markers.get(first.index)?;
            let emphasised = stack.len == 1
                && (self.markers.selected.as_deref() == Some(marker.id.as_str())
                    || self
                        .markers
                        .drag
                        .as_ref()
                        .is_some_and(|drag| drag.moved && drag.id == marker.id));
            let color = parse_marker_color(marker.color.as_deref());
            Some(
                div()
                    .absolute()
                    .left(px(TIMELINE_PADDING + TRACK_GUTTER + stack.x))
                    .top(px(TIMELINE_TOP_PADDING + TIMELINE_HEADER_HEIGHT))
                    .bottom(px(TIMELINE_BOTTOM_PADDING))
                    .w(px(1.))
                    .bg(color.opacity(if emphasised { 0.9 } else { 0.35 }))
                    .into_any_element(),
            )
        })
        .collect()
    }

    pub(super) fn render_markers_button(
        &self,
        compact: bool,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = self.theme;
        let count = self.markers.placed.len();
        let label: SharedString = match (compact, count) {
            (true, _) => SharedString::from(count.to_string()),
            (false, 0) => SharedString::new_static(tr::editor::markers::title()),
            (false, _) => SharedString::from(tr::editor::markers::button(count)),
        };
        div()
            .id("transport-markers-tooltip")
            .tooltip_show_delay(ui::TOOLTIP_SHOW_DELAY)
            .tooltip(move |_, cx| ui::Tooltip::new(&theme, tr::editor::markers::title()).view(cx))
            .child(
                ui::Button::plain(
                    &theme,
                    "transport-markers",
                    if self.markers.list.is_some() {
                        ui::ButtonVariant::Primary
                    } else {
                        ui::ButtonVariant::Gray
                    },
                    ui::ButtonSize::Sm,
                )
                .icon("icons/flag.svg")
                .label(label)
                .radius(px(7.))
                .disabled(!self.project_ready())
                .on_click(cx.listener(
                    |this, event: &gpui::ClickEvent, _window, cx| {
                        this.toggle_marker_list(event.position(), cx);
                    },
                )),
            )
            .into_any_element()
    }

    pub(super) fn render_marker_overlays(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Vec<gpui::AnyElement> {
        let mut overlays = Vec::new();
        if let Some(anchor) = self.markers.list {
            overlays.push(self.render_marker_list(anchor, window, cx));
        }
        if let Some(editor) = &self.markers.editor
            && let Some(index) = self.marker_index(&editor.id)
        {
            overlays.push(self.render_marker_editor(index, editor.anchor, window, cx));
        }
        overlays
    }

    fn popover_shell(&self, id: &'static str, cx: &mut Context<Self>) -> gpui::Stateful<gpui::Div> {
        div()
            .id(id)
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .occlude()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    if this.markers.editor.is_some() {
                        this.close_marker_editor(true, window, cx);
                    }
                    this.markers.list = None;
                    cx.notify();
                }),
            )
    }

    fn popover_card(&self, width: f32) -> gpui::Div {
        let theme = self.theme;
        div()
            .absolute()
            .w(px(width))
            .occlude()
            .flex()
            .flex_col()
            .rounded(px(12.))
            .border_1()
            .border_color(Hsla::from(theme.editor.line))
            .bg(Hsla::from(theme.editor.card))
            .shadow(theme.editor.pop_shadow())
            .overflow_hidden()
    }

    fn marker_icon_button(
        &self,
        id: impl Into<gpui::ElementId>,
        icon: &'static str,
        tooltip: &'static str,
        keys: &'static [&'static str],
        enabled: bool,
    ) -> gpui::Stateful<gpui::Div> {
        let theme = self.theme;
        div()
            .id(id)
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(px(26.))
            .rounded(px(7.))
            .when(enabled, |this| {
                this.cursor_pointer()
                    .hover(|style| style.bg(Hsla::from(theme.editor.ctl_hover)))
            })
            .when(!enabled, |this| this.opacity(0.4))
            .child(
                svg()
                    .path(icon)
                    .size(px(14.))
                    .text_color(Hsla::from(theme.editor.text_2)),
            )
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .tooltip_show_delay(ui::TOOLTIP_SHOW_DELAY)
            .tooltip(move |_, cx| {
                ui::Tooltip::new(&theme, tooltip)
                    .keys(keys.iter().copied())
                    .view(cx)
            })
    }

    fn render_marker_list(
        &self,
        anchor: Point<Pixels>,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = self.theme;
        let viewport = window.viewport_size();
        let left = (f32::from(anchor.x) - MARKER_LIST_WIDTH / 2.)
            .min(f32::from(viewport.width) - MARKER_LIST_WIDTH - MARKER_POPOVER_MARGIN)
            .max(MARKER_POPOVER_MARGIN);
        let bottom =
            (f32::from(viewport.height) - f32::from(anchor.y) + 18.).max(MARKER_POPOVER_MARGIN);
        let placed = &self.markers.placed;
        let hidden = self.project.markers.len().saturating_sub(placed.len());
        let playhead = self.playhead;
        let has_previous = neighbour_marker(placed, playhead, false).is_some();
        let has_next = neighbour_marker(placed, playhead, true).is_some();
        let previous_keys: &'static [&'static str] = &["alt", "←"];
        let next_keys: &'static [&'static str] = &["alt", "→"];

        let header = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(4.))
            .h(px(40.))
            .pl(px(12.))
            .pr(px(6.))
            .border_b_1()
            .border_color(Hsla::from(theme.editor.line))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(13.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(Hsla::from(theme.editor.text_1))
                    .child(tr::editor::markers::title()),
            )
            .child(
                self.marker_icon_button(
                    "marker-list-previous",
                    "icons/chevron-left.svg",
                    tr::editor::markers::previous(),
                    previous_keys,
                    has_previous,
                )
                .when(has_previous, |this| {
                    this.on_click(cx.listener(|this, _, _, cx| this.jump_to_marker(false, cx)))
                }),
            )
            .child(
                self.marker_icon_button(
                    "marker-list-next",
                    "icons/chevron-right.svg",
                    tr::editor::markers::next(),
                    next_keys,
                    has_next,
                )
                .when(has_next, |this| {
                    this.on_click(cx.listener(|this, _, _, cx| this.jump_to_marker(true, cx)))
                }),
            )
            .child(
                self.marker_icon_button(
                    "marker-list-add",
                    "icons/circle-plus.svg",
                    tr::editor::markers::add(),
                    &["M"],
                    true,
                )
                .on_click(
                    cx.listener(|this, _, window, cx| this.add_marker_at_playhead(window, cx)),
                ),
            );

        let rows: Vec<gpui::AnyElement> = placed
            .iter()
            .enumerate()
            .filter_map(|(ordinal, placed)| {
                let marker = self.project.markers.get(placed.index)?;
                let id = marker.id.clone();
                let selected = self.markers.selected.as_deref() == Some(marker.id.as_str());
                let time = placed.time;
                let edit_id = id.clone();
                let delete_id = id.clone();
                Some(
                    div()
                        .id(SharedString::from(format!("marker-row-{}", marker.id)))
                        .flex()
                        .flex_row()
                        .flex_none()
                        .items_center()
                        .gap(px(8.))
                        .h(px(34.))
                        .pl(px(10.))
                        .pr(px(4.))
                        .rounded(px(8.))
                        .cursor_pointer()
                        .when(selected, |row| row.bg(Hsla::from(theme.editor.ctl)))
                        .hover(|row| row.bg(Hsla::from(theme.editor.ctl_hover)))
                        .child(
                            div()
                                .flex_none()
                                .size(px(8.))
                                .rounded_full()
                                .bg(parse_marker_color(marker.color.as_deref())),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_size(px(13.))
                                .text_color(Hsla::from(theme.editor.text_1))
                                .child(marker_name(marker, ordinal)),
                        )
                        .child(
                            div()
                                .flex_none()
                                .text_size(px(12.))
                                .font_features(crate::editor_timeline::tabular_numerals())
                                .text_color(Hsla::from(theme.editor.text_3))
                                .child(timeline::format_time(time)),
                        )
                        .child(
                            self.marker_icon_button(
                                SharedString::from(format!("marker-edit-{}", marker.id)),
                                "icons/edit.svg",
                                tr::editor::markers::edit(),
                                &[],
                                true,
                            )
                            .on_click(cx.listener(
                                move |this, event: &gpui::ClickEvent, window, cx| {
                                    this.open_marker_editor(
                                        edit_id.clone(),
                                        event.position(),
                                        window,
                                        cx,
                                    );
                                },
                            )),
                        )
                        .child(
                            self.marker_icon_button(
                                SharedString::from(format!("marker-delete-{}", marker.id)),
                                "icons/trash.svg",
                                tr::editor::markers::delete(),
                                &[],
                                true,
                            )
                            .on_click(cx.listener(
                                move |this, _, window, cx| {
                                    this.delete_marker(&delete_id, window, cx);
                                },
                            )),
                        )
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.select_marker(Some(id.clone()), cx);
                            this.seek_to_marker_time(time, cx);
                        }))
                        .into_any_element(),
                )
            })
            .collect();

        let body = if rows.is_empty() {
            div()
                .px(px(14.))
                .py(px(16.))
                .text_size(px(12.))
                .line_height(px(17.))
                .text_color(Hsla::from(theme.editor.text_3))
                .child(tr::editor::markers::empty())
                .into_any_element()
        } else {
            div()
                .id("marker-list-rows")
                .flex()
                .flex_col()
                .min_h_0()
                .max_h(px(264.))
                .p(px(6.))
                .gap(px(2.))
                .overflow_y_scroll()
                .track_scroll(&self.markers.list_scroll)
                .children(rows)
                .into_any_element()
        };

        let can_split = !placed.is_empty();
        let footer = div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .p(px(8.))
            .border_t_1()
            .border_color(Hsla::from(theme.editor.line))
            .when(hidden > 0, |footer| {
                footer.child(
                    div()
                        .px(px(4.))
                        .text_size(px(11.))
                        .line_height(px(15.))
                        .text_color(Hsla::from(theme.editor.text_3))
                        .child(SharedString::from(tr::editor::markers::hidden(hidden))),
                )
            })
            .child(
                ui::Button::plain(
                    &theme,
                    "marker-split",
                    ui::ButtonVariant::Gray,
                    ui::ButtonSize::Sm,
                )
                .icon("icons/scissors.svg")
                .label(tr::editor::markers::split())
                .radius(px(7.))
                .full_width()
                .disabled(!can_split)
                .on_click(cx.listener(|this, _, window, cx| this.split_at_markers(window, cx))),
            );

        self.popover_shell("marker-list-backdrop", cx)
            .child(
                self.popover_card(MARKER_LIST_WIDTH)
                    .left(px(left))
                    .bottom(px(bottom))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(header)
                    .child(body)
                    .child(footer),
            )
            .into_any_element()
    }

    fn render_marker_editor(
        &self,
        index: usize,
        anchor: Point<Pixels>,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = self.theme;
        let marker = &self.project.markers[index];
        let id = marker.id.clone();
        let viewport = window.viewport_size();
        let left = (f32::from(anchor.x) - 24.)
            .min(f32::from(viewport.width) - MARKER_EDITOR_WIDTH - MARKER_POPOVER_MARGIN)
            .max(MARKER_POPOVER_MARGIN);
        let opens_up = f32::from(anchor.y) > f32::from(viewport.height) / 2.;
        let time = self.marker_time(&id);
        let current = marker.color.clone();

        let swatches = MARKER_COLORS.iter().enumerate().map(|(position, color)| {
            let chosen = match &current {
                Some(current) => current.eq_ignore_ascii_case(color),
                None => position == 0,
            };
            let value = (position > 0).then(|| (*color).to_string());
            let swatch_id = id.clone();
            div()
                .id(("marker-swatch", position))
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(px(24.))
                .rounded_full()
                .cursor_pointer()
                .border_2()
                .border_color(if chosen {
                    Hsla::from(theme.editor.text_1)
                } else {
                    gpui::transparent_black()
                })
                .child(
                    div()
                        .size(px(16.))
                        .rounded_full()
                        .bg(parse_marker_color(Some(color))),
                )
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.set_marker_color(&swatch_id, value.clone(), window, cx);
                }))
        });

        let delete_id = id.clone();
        let card = self
            .popover_card(MARKER_EDITOR_WIDTH)
            .left(px(left))
            .when(opens_up, |card| {
                card.bottom(px(f32::from(viewport.height) - f32::from(anchor.y) + 12.))
            })
            .when(!opens_up, |card| card.top(px(f32::from(anchor.y) + 14.)))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .p(px(10.))
            .gap(px(10.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex_1()
                            .text_size(px(12.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(theme.editor.text_2))
                            .child(tr::editor::markers::edit()),
                    )
                    .children(time.map(|time| {
                        div()
                            .flex_none()
                            .text_size(px(12.))
                            .font_features(crate::editor_timeline::tabular_numerals())
                            .text_color(Hsla::from(theme.editor.text_3))
                            .child(timeline::format_time(time))
                    })),
            )
            .child(ui::TextInput::plain(
                &theme,
                "marker-label",
                &self.markers.label_input,
            ))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .children(swatches),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .child(
                        ui::Button::plain(
                            &theme,
                            "marker-delete",
                            ui::ButtonVariant::Gray,
                            ui::ButtonSize::Sm,
                        )
                        .icon("icons/trash.svg")
                        .label(tr::editor::markers::delete())
                        .radius(px(7.))
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.delete_marker(&delete_id, window, cx);
                                this.focus_root(window, cx);
                            },
                        )),
                    )
                    .child(div().flex_1())
                    .child(
                        ui::Button::plain(
                            &theme,
                            "marker-done",
                            ui::ButtonVariant::Primary,
                            ui::ButtonSize::Sm,
                        )
                        .label(tr::editor::markers::done())
                        .radius(px(7.))
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.close_marker_editor(true, window, cx);
                        })),
                    ),
            );

        self.popover_shell("marker-editor-backdrop", cx)
            .child(card)
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn placed(times: &[f64]) -> Vec<PlacedMarker> {
        times
            .iter()
            .enumerate()
            .map(|(index, time)| PlacedMarker { index, time: *time })
            .collect()
    }

    #[test]
    fn close_flags_share_a_stack_and_far_ones_do_not() {
        let markers = placed(&[1.0, 1.05, 1.2, 3.0, 10.0]);
        let stacks = marker_stacks(&markers, 0.0, 0.01, 2000.);
        assert_eq!(
            stacks
                .iter()
                .map(|stack| (stack.start, stack.len))
                .collect::<Vec<_>>(),
            vec![(0, 2), (2, 1), (3, 1), (4, 1)]
        );
        let zoomed_out = marker_stacks(&markers, 0.0, 0.1, 2000.);
        assert_eq!(
            zoomed_out
                .iter()
                .map(|stack| (stack.start, stack.len))
                .collect::<Vec<_>>(),
            vec![(0, 3), (3, 1), (4, 1)]
        );
    }

    #[test]
    fn flags_outside_the_strip_are_not_drawn() {
        let markers = placed(&[0.0, 5.0, 50.0]);
        let stacks = marker_stacks(&markers, 4.0, 0.01, 300.);
        assert_eq!(
            stacks.iter().map(|stack| stack.start).collect::<Vec<_>>(),
            vec![1]
        );
        assert!((stacks[0].x - 100.).abs() < 1e-3);
    }

    #[test]
    fn hundreds_of_markers_on_an_hour_stay_bounded_by_pixels() {
        let times: Vec<f64> = (0..600).map(|second| second as f64 * 6.0).collect();
        let markers = placed(&times);
        let content = 1200.;
        let stacks = marker_stacks(&markers, 0.0, 3600.0 / content as f64, content);
        assert!(stacks.len() <= (content / MARKER_STACK_PX) as usize + 1);
        assert_eq!(stacks.iter().map(|stack| stack.len).sum::<usize>(), 600);
    }

    #[test]
    fn a_stack_click_zooms_until_its_markers_separate() {
        let zoom = spread_zoom(&[10.0, 10.02, 10.5], 1000.).unwrap();
        assert!((0.02 / (zoom / 1000.) - MARKER_SPREAD_PX).abs() < 1e-6);
        assert_eq!(spread_zoom(&[4.0, 4.0], 1000.), None);
    }

    #[test]
    fn next_and_previous_step_past_the_marker_under_the_playhead() {
        let markers = placed(&[1.0, 2.0, 3.0]);
        assert_eq!(neighbour_marker(&markers, 2.0, true), Some(3.0));
        assert_eq!(neighbour_marker(&markers, 2.0, false), Some(1.0));
        assert_eq!(neighbour_marker(&markers, 2.001, false), Some(1.0));
        assert_eq!(neighbour_marker(&markers, 3.0, true), None);
        assert_eq!(neighbour_marker(&markers, 0.0, false), None);
        assert_eq!(neighbour_marker(&[], 0.0, true), None);
    }

    #[test]
    fn splitting_at_markers_keeps_every_marker_in_place() {
        let mut timeline: TimelineConfiguration = serde_json::from_value(serde_json::json!({
            "segments": [
                { "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 10.0 },
                { "recordingSegment": 1, "timescale": 2.0, "start": 0.0, "end": 8.0 },
            ],
            "zoomSegments": [],
        }))
        .unwrap();
        let markers = vec![
            TimelineMarker::new(0, 2.5),
            TimelineMarker::new(0, 10.0),
            TimelineMarker::new(1, 3.0),
            TimelineMarker::new(1, 9.0),
        ];
        let before = timeline.place_markers(&markers);
        assert_eq!(before.len(), 3);
        let times: Vec<f64> = before.iter().map(|placed| placed.time).collect();
        assert!(split_clips_at(&mut timeline, &times));
        assert_eq!(timeline.segments.len(), 4);
        assert_eq!(timeline.place_markers(&markers), before);
        assert!(!split_clips_at(&mut timeline, &times));
    }

    #[test]
    fn a_second_press_selects_the_marker_instead_of_adding_another() {
        let mut timeline: TimelineConfiguration = serde_json::from_value(serde_json::json!({
            "segments": [
                { "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 10.0 },
            ],
            "zoomSegments": [],
            "textSegments": [{ "start": 2.0, "end": 5.0, "layout": "fullscreen" }],
        }))
        .unwrap();
        for expected_time in [2.0, 3.0] {
            let Some(MarkerPress::Add(marker)) = marker_press(&timeline, &[], 3.0) else {
                panic!("the first press adds a marker");
            };
            assert_eq!((marker.recording_clip, marker.time), (0, expected_time));
            let placed = timeline.place_markers(&[marker]);
            assert!(matches!(
                marker_press(&timeline, &placed, 3.0),
                Some(MarkerPress::Select(0))
            ));
            timeline.text_segments.clear();
        }
    }

    #[test]
    fn marker_colours_fall_back_to_the_default() {
        assert_eq!(
            parse_marker_color(None),
            parse_marker_color(Some(MARKER_COLORS[0]))
        );
        assert_eq!(
            parse_marker_color(Some("nonsense")),
            parse_marker_color(Some(MARKER_COLORS[0]))
        );
        assert_ne!(
            parse_marker_color(Some(MARKER_COLORS[3])),
            parse_marker_color(None)
        );
    }
}
