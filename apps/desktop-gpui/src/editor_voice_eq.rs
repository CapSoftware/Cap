//! Each edit writes the whole [`VoiceEq`] to every target clip, so the curve
//! drawn here is always exactly what each of them plays and exports.

use cap_project::{
    ProjectConfiguration, TimelineSegment, VoiceDeclick, VoiceEq, VoiceEqBandKind, VoiceEqPreset,
};
use gpui::{
    AnyElement, Bounds, Context, CursorStyle, FontWeight, Hsla, InteractiveElement, IntoElement,
    MouseButton, MouseDownEvent, MouseMoveEvent, ParentElement, PathBuilder, PathStyle, Pixels,
    Point, ScrollWheelEvent, SharedString, StatefulInteractiveElement, Styled, Window, canvas, div,
    linear_color_stop, linear_gradient, point, prelude::FluentBuilder, px, svg,
};
use lyon_tessellation::{LineCap, LineJoin, StrokeOptions};

use crate::{
    editor_edits::set_clip_voice_eq,
    editor_sidebar::SliderKey,
    editor_timeline::TrackKind,
    editor_window::EditorWindow,
    i18n::{self, tr},
    theme::Theme,
    ui,
};

const MIN_HZ: f32 = 20.;
const MAX_HZ: f32 = 20_000.;
const PLOT_DB: f32 = 15.;
const GRAPH_HEIGHT: f32 = 168.;
const LABEL_STRIP: f32 = 18.;
const HANDLE: f32 = 14.;
const HIT_RADIUS: f32 = 18.;
const CURVE_POINTS: usize = 192;
const MAJOR_HZ: [f32; 3] = [100., 1_000., 10_000.];
const MINOR_HZ: [f32; 6] = [50., 200., 500., 2_000., 5_000., 20.];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum VoiceEqHandle {
    HighPass,
    Band(VoiceEqBandKind),
}

impl VoiceEqHandle {
    pub const ALL: [Self; 5] = [
        Self::HighPass,
        Self::Band(VoiceEqBandKind::Low),
        Self::Band(VoiceEqBandKind::LowMid),
        Self::Band(VoiceEqBandKind::HighMid),
        Self::Band(VoiceEqBandKind::High),
    ];

    fn label(self) -> &'static str {
        match self {
            Self::HighPass => tr::editor::tabs::audio::voice_eq::band_low_cut(),
            Self::Band(VoiceEqBandKind::Low) => tr::editor::tabs::audio::voice_eq::band_low(),
            Self::Band(VoiceEqBandKind::LowMid) => {
                tr::editor::tabs::audio::voice_eq::band_low_mid()
            }
            Self::Band(VoiceEqBandKind::HighMid) => {
                tr::editor::tabs::audio::voice_eq::band_high_mid()
            }
            Self::Band(VoiceEqBandKind::High) => tr::editor::tabs::audio::voice_eq::band_high(),
        }
    }

    fn color(self) -> Hsla {
        let (hue, saturation, lightness) = match self {
            Self::HighPass => (350., 0.72, 0.60),
            Self::Band(VoiceEqBandKind::Low) => (26., 0.86, 0.56),
            Self::Band(VoiceEqBandKind::LowMid) => (44., 0.90, 0.50),
            Self::Band(VoiceEqBandKind::HighMid) => (164., 0.62, 0.42),
            Self::Band(VoiceEqBandKind::High) => (214., 0.84, 0.58),
        };
        gpui::hsla(hue / 360., saturation, lightness, 1.)
    }

    fn key(self) -> &'static str {
        match self {
            Self::HighPass => "low-cut",
            Self::Band(VoiceEqBandKind::Low) => "low",
            Self::Band(VoiceEqBandKind::LowMid) => "low-mid",
            Self::Band(VoiceEqBandKind::HighMid) => "high-mid",
            Self::Band(VoiceEqBandKind::High) => "high",
        }
    }

    fn hz_range(self) -> (f32, f32) {
        match self {
            Self::HighPass => VoiceEq::HIGH_PASS_RANGE,
            Self::Band(kind) => kind.hz_range(),
        }
    }

    fn hz(self, voice_eq: &VoiceEq) -> f32 {
        match self {
            Self::HighPass => voice_eq.high_pass_hz,
            Self::Band(kind) => voice_eq.band(kind).hz,
        }
    }
}

/// Frequencies move on a log2 scale so a slider spends as much travel on
/// 100-200 Hz as on 5-10 kHz.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum VoiceEqSlider {
    HighPassHz,
    Hz(VoiceEqBandKind),
    Gain(VoiceEqBandKind),
    Q(VoiceEqBandKind),
}

impl VoiceEqSlider {
    pub fn limits(self) -> (f32, f32, f32) {
        match self {
            Self::HighPassHz => {
                let (min, max) = VoiceEq::HIGH_PASS_RANGE;
                (min.log2(), max.log2(), 0.01)
            }
            Self::Hz(kind) => {
                let (min, max) = kind.hz_range();
                (min.log2(), max.log2(), 0.01)
            }
            Self::Gain(_) => (VoiceEq::GAIN_RANGE.0, VoiceEq::GAIN_RANGE.1, 0.1),
            Self::Q(_) => (VoiceEq::Q_RANGE.0, VoiceEq::Q_RANGE.1, 0.05),
        }
    }

    pub fn unit(self) -> &'static str {
        match self {
            Self::HighPassHz | Self::Hz(_) => "log2hz",
            Self::Gain(_) => "sdb",
            Self::Q(_) => "q",
        }
    }

    pub fn read(self, voice_eq: &VoiceEq) -> f32 {
        match self {
            Self::HighPassHz => voice_eq.high_pass_hz.log2(),
            Self::Hz(kind) => voice_eq.band(kind).hz.log2(),
            Self::Gain(kind) => voice_eq.band(kind).gain_db,
            Self::Q(kind) => voice_eq.band(kind).q,
        }
    }

    pub fn write(self, voice_eq: &mut VoiceEq, value: f32) {
        match self {
            Self::HighPassHz => {
                voice_eq.high_pass = true;
                voice_eq.high_pass_hz = value.exp2();
            }
            Self::Hz(kind) => voice_eq.band_mut(kind).hz = value.exp2(),
            Self::Gain(kind) => voice_eq.band_mut(kind).gain_db = value,
            Self::Q(kind) => voice_eq.band_mut(kind).q = value,
        }
    }
}

pub struct VoiceEqView {
    pub selected: VoiceEqHandle,
    pub hover: Option<VoiceEqHandle>,
    pub drag: Option<(VoiceEqHandle, Bounds<Pixels>)>,
    plot: ui::SliderTrack,
}

impl Default for VoiceEqView {
    fn default() -> Self {
        Self {
            selected: VoiceEqHandle::Band(VoiceEqBandKind::HighMid),
            hover: None,
            drag: None,
            plot: ui::SliderTrack::default(),
        }
    }
}

pub fn hz_to_fraction(hz: f32) -> f32 {
    ((hz.max(MIN_HZ) / MIN_HZ).log10() / (MAX_HZ / MIN_HZ).log10()).clamp(0., 1.)
}

pub fn fraction_to_hz(fraction: f32) -> f32 {
    MIN_HZ * (MAX_HZ / MIN_HZ).powf(fraction.clamp(0., 1.))
}

pub fn db_to_fraction(db: f32) -> f32 {
    (0.5 - db / (2. * PLOT_DB)).clamp(0., 1.)
}

pub fn fraction_to_db(fraction: f32) -> f32 {
    (0.5 - fraction) * 2. * PLOT_DB
}

pub fn format_hz(hz: f32) -> String {
    if hz.round() >= 1_000. {
        let khz = (hz / 100.).round() / 10.;
        if khz.fract() == 0. {
            format!("{khz:.0} kHz")
        } else {
            i18n::decimal(format!("{khz:.1} kHz"))
        }
    } else {
        format!("{:.0} Hz", hz.round())
    }
}

pub fn format_gain(db: f32) -> String {
    let db = (db * 10.).round() / 10.;
    if db == 0. {
        i18n::decimal("0.0 dB")
    } else {
        i18n::decimal(format!(
            "{}{:.1} dB",
            if db > 0. { "+" } else { "\u{2212}" },
            db.abs()
        ))
    }
}

fn preset_label(preset: VoiceEqPreset) -> &'static str {
    match preset {
        VoiceEqPreset::Natural => tr::editor::tabs::audio::voice_eq::preset_natural(),
        VoiceEqPreset::Clear => tr::editor::tabs::audio::voice_eq::preset_clear(),
        VoiceEqPreset::Warm => tr::editor::tabs::audio::voice_eq::preset_warm(),
        VoiceEqPreset::Bright => tr::editor::tabs::audio::voice_eq::preset_bright(),
        VoiceEqPreset::Broadcast => tr::editor::tabs::audio::voice_eq::preset_broadcast(),
        VoiceEqPreset::Custom => tr::editor::tabs::audio::voice_eq::preset_custom(),
    }
}

pub fn voice_eq_summary(segment: &TimelineSegment) -> String {
    let Some(voice_eq) = segment.voice_eq else {
        return tr::editor::tabs::audio::voice_eq::off().to_string();
    };
    let tone = voice_eq
        .shapes_tone()
        .then(|| preset_label(voice_eq.preset));
    let declick =
        (voice_eq.declick != VoiceDeclick::Off).then(tr::editor::tabs::audio::voice_eq::declick);
    match (tone, declick) {
        (Some(tone), Some(declick)) => format!("{tone} \u{b7} {declick}"),
        (Some(tone), None) => tone.to_string(),
        (None, Some(declick)) => declick.to_string(),
        (None, None) => tr::editor::tabs::audio::voice_eq::off().to_string(),
    }
}

fn response(voice_eq: &VoiceEq, filters: &[usize]) -> cap_audio::ToneResponse {
    let all = cap_editor::voice_eq_filters(voice_eq);
    let mut chosen = [None; 5];
    for index in filters {
        chosen[*index] = all[*index];
    }
    cap_audio::VoiceToneSettings {
        filters: chosen,
        declick: None,
    }
    .response()
}

fn handle_filters(handle: VoiceEqHandle) -> &'static [usize] {
    match handle {
        VoiceEqHandle::HighPass => &[0],
        VoiceEqHandle::Band(VoiceEqBandKind::Low) => &[1],
        VoiceEqHandle::Band(VoiceEqBandKind::LowMid) => &[2],
        VoiceEqHandle::Band(VoiceEqBandKind::HighMid) => &[3],
        VoiceEqHandle::Band(VoiceEqBandKind::High) => &[4],
    }
}

const ALL_FILTERS: [usize; 5] = [0, 1, 2, 3, 4];

pub fn handle_position(voice_eq: &VoiceEq, handle: VoiceEqHandle) -> (f32, f32) {
    let x = hz_to_fraction(handle.hz(voice_eq));
    let db = match handle {
        VoiceEqHandle::HighPass if voice_eq.high_pass => {
            response(voice_eq, &ALL_FILTERS).db(voice_eq.high_pass_hz)
        }
        VoiceEqHandle::HighPass => 0.,
        VoiceEqHandle::Band(kind) => voice_eq.band(kind).gain_db,
    };
    (x, db_to_fraction(db))
}

pub fn hit_test(
    voice_eq: &VoiceEq,
    bounds: Bounds<Pixels>,
    position: Point<Pixels>,
    selected: VoiceEqHandle,
) -> Option<VoiceEqHandle> {
    let width = f32::from(bounds.size.width);
    let height = f32::from(bounds.size.height);
    if width <= 0. || height <= 0. {
        return None;
    }
    let local_x = f32::from(position.x - bounds.origin.x);
    let local_y = f32::from(position.y - bounds.origin.y);
    VoiceEqHandle::ALL
        .into_iter()
        .map(|handle| {
            let (x, y) = handle_position(voice_eq, handle);
            let distance = (x * width - local_x).hypot(y * height - local_y);
            let bias = if handle == selected { -0.5 } else { 0. };
            (handle, distance + bias)
        })
        .filter(|(_, distance)| *distance <= HIT_RADIUS)
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(handle, _)| handle)
}

pub fn drag_to(
    voice_eq: &mut VoiceEq,
    handle: VoiceEqHandle,
    bounds: Bounds<Pixels>,
    position: Point<Pixels>,
) -> bool {
    let Some((x, y)) = ui::pad_position(position, bounds) else {
        return false;
    };
    let (min, max) = handle.hz_range();
    let hz = fraction_to_hz(x as f32).clamp(min, max);
    let hz = if hz >= 1_000. {
        (hz / 10.).round() * 10.
    } else {
        hz.round()
    };
    let gain = (fraction_to_db(y as f32).clamp(VoiceEq::GAIN_RANGE.0, VoiceEq::GAIN_RANGE.1) * 10.)
        .round()
        / 10.;
    let before = *voice_eq;
    match handle {
        VoiceEqHandle::HighPass => {
            voice_eq.high_pass = true;
            voice_eq.high_pass_hz = hz;
        }
        VoiceEqHandle::Band(kind) => {
            let band = voice_eq.band_mut(kind);
            band.hz = hz;
            band.gain_db = gain;
        }
    }
    *voice_eq != before
}

fn segment_count(project: &ProjectConfiguration) -> usize {
    project
        .timeline
        .as_ref()
        .map_or(0, |timeline| timeline.segments.len())
}

impl EditorWindow {
    pub(crate) fn voice_eq_targets(&self) -> Vec<usize> {
        let count = segment_count(&self.project);
        let mut selected = self
            .selection
            .as_ref()
            .filter(|selection| selection.track == TrackKind::Clip)
            .map(|selection| {
                selection
                    .indices
                    .iter()
                    .copied()
                    .filter(|index| *index < count)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        selected.sort_unstable();
        selected.dedup();
        if selected.is_empty() {
            (0..count).collect()
        } else {
            selected
        }
    }

    fn voice_eq_selection_scoped(&self) -> bool {
        self.voice_eq_targets().len() < segment_count(&self.project)
    }

    pub(crate) fn shown_voice_eq(&self) -> Option<VoiceEq> {
        let timeline = self.project.timeline.as_ref()?;
        let first = *self.voice_eq_targets().first()?;
        timeline.segments.get(first)?.voice_eq
    }

    fn voice_eq_mixed(&self) -> bool {
        let Some(timeline) = self.project.timeline.as_ref() else {
            return false;
        };
        let mut settings = self
            .voice_eq_targets()
            .into_iter()
            .filter_map(|index| timeline.segments.get(index))
            .map(|segment| segment.voice_eq);
        let Some(first) = settings.next() else {
            return false;
        };
        settings.any(|other| other != first)
    }

    pub(crate) fn edit_voice_eq(
        &mut self,
        reason: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
        change: impl FnOnce(&mut VoiceEq),
    ) {
        let targets = self.voice_eq_targets();
        let mut next = self.shown_voice_eq().unwrap_or_default();
        change(&mut next);
        self.edit_project(reason, window, cx, move |project| {
            project
                .timeline
                .as_mut()
                .is_some_and(|timeline| set_clip_voice_eq(timeline, &targets, Some(next)))
        });
    }

    fn edit_voice_eq_tone(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        change: impl FnOnce(&mut VoiceEq),
    ) {
        self.edit_voice_eq("voice-eq", window, cx, |voice_eq| {
            change(voice_eq);
            voice_eq.enabled = true;
            voice_eq.preset = VoiceEqPreset::Custom;
        });
    }

    pub(crate) fn apply_voice_eq_slider(
        &mut self,
        slider: VoiceEqSlider,
        value: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.edit_voice_eq_tone(window, cx, |voice_eq| slider.write(voice_eq, value));
    }

    pub(crate) fn voice_eq_slider_value(&self, slider: VoiceEqSlider) -> f32 {
        slider.read(&self.shown_voice_eq().unwrap_or_default().sanitized())
    }

    fn apply_voice_eq_to_all(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let shown = self.shown_voice_eq();
        let count = segment_count(&self.project);
        self.edit_project("voice-eq-all", window, cx, move |project| {
            project.timeline.as_mut().is_some_and(|timeline| {
                set_clip_voice_eq(timeline, &(0..count).collect::<Vec<_>>(), shown)
            })
        });
    }

    pub(crate) fn voice_eq_dragging(&self) -> bool {
        self.sidebar.voice_eq.drag.is_some()
    }

    fn voice_eq_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(bounds) = self.sidebar.voice_eq.plot.get() else {
            return;
        };
        let voice_eq = self.shown_voice_eq().unwrap_or_default().sanitized();
        let Some(handle) = hit_test(
            &voice_eq,
            bounds,
            event.position,
            self.sidebar.voice_eq.selected,
        ) else {
            return;
        };
        cx.stop_propagation();
        self.sidebar.voice_eq.selected = handle;
        if event.click_count >= 2 {
            self.edit_voice_eq_tone(window, cx, |voice_eq| match handle {
                VoiceEqHandle::HighPass => voice_eq.high_pass = !voice_eq.high_pass,
                VoiceEqHandle::Band(kind) => voice_eq.band_mut(kind).gain_db = 0.,
            });
            return;
        }
        self.history.pause();
        self.sidebar.voice_eq.drag = Some((handle, bounds));
        cx.notify();
    }

    pub(crate) fn voice_eq_mouse_move(
        &mut self,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((handle, bounds)) = self.sidebar.voice_eq.drag else {
            return;
        };
        let mut next = self.shown_voice_eq().unwrap_or_default().sanitized();
        if !drag_to(&mut next, handle, bounds, position) {
            return;
        }
        self.edit_voice_eq_tone(window, cx, move |voice_eq| *voice_eq = next);
    }

    pub(crate) fn voice_eq_mouse_up(&mut self, cx: &mut Context<Self>) {
        if self.sidebar.voice_eq.drag.take().is_some() {
            let config = self.project.clone();
            self.history.resume(&config);
            cx.notify();
        }
    }

    fn voice_eq_hover_at(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let hover = self.sidebar.voice_eq.plot.get().and_then(|bounds| {
            let voice_eq = self.shown_voice_eq().unwrap_or_default().sanitized();
            hit_test(&voice_eq, bounds, position, self.sidebar.voice_eq.selected)
        });
        if hover != self.sidebar.voice_eq.hover {
            self.sidebar.voice_eq.hover = hover;
            cx.notify();
        }
    }

    fn voice_eq_scroll(
        &mut self,
        event: &ScrollWheelEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(VoiceEqHandle::Band(kind)) = self.sidebar.voice_eq.hover else {
            return;
        };
        if kind.is_shelf() {
            return;
        }
        let delta = f32::from(event.delta.pixel_delta(window.line_height()).y);
        if delta == 0. {
            return;
        }
        cx.stop_propagation();
        self.sidebar.voice_eq.selected = VoiceEqHandle::Band(kind);
        self.edit_voice_eq_tone(window, cx, |voice_eq| {
            let band = voice_eq.band_mut(kind);
            let next = band.q * (1.0 + delta / 400.).clamp(0.8, 1.25);
            band.q = (next.clamp(VoiceEq::Q_RANGE.0, VoiceEq::Q_RANGE.1) * 100.).round() / 100.;
        });
    }

    pub(crate) fn render_voice_eq_card(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let shown = self.shown_voice_eq();
        let voice_eq = shown.unwrap_or_default().sanitized();
        let enabled = shown.is_some_and(|voice_eq| voice_eq.enabled);
        let accent = Hsla::from(theme.editor.accent);
        let line = Hsla::from(theme.editor.line);
        let clip_count = segment_count(&self.project);

        div()
            .id("voice-eq-card")
            .flex()
            .flex_col()
            .rounded(px(12.))
            .bg(Hsla::from(theme.editor.card_2))
            .p(px(14.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(10.))
                    .child(
                        div()
                            .flex()
                            .flex_shrink_0()
                            .items_center()
                            .justify_center()
                            .size(px(30.))
                            .rounded(px(9.))
                            .bg(if enabled {
                                Theme::with_alpha(theme.editor.accent, 0.12)
                            } else {
                                Hsla::from(theme.editor.ctl)
                            })
                            .child(
                                svg()
                                    .path("icons/sliders-horizontal.svg")
                                    .size(px(16.))
                                    .text_color(if enabled {
                                        accent
                                    } else {
                                        Hsla::from(theme.editor.text_2)
                                    }),
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
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(Hsla::from(theme.editor.text_1))
                                    .child(tr::editor::tabs::audio::voice_eq::title()),
                            )
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .line_height(px(16.))
                                    .text_color(Hsla::from(theme.editor.text_3))
                                    .child(tr::editor::tabs::audio::voice_eq::description()),
                            ),
                    )
                    .child(
                        ui::Toggle::plain(&theme, "voice-eq-enabled", enabled).on_click(
                            cx.listener(move |this, _, window, cx| {
                                this.edit_voice_eq("voice-eq-enabled", window, cx, |voice_eq| {
                                    voice_eq.enabled = !enabled;
                                });
                            }),
                        ),
                    ),
            )
            .when(clip_count > 1, |card| {
                card.child(self.render_voice_eq_scope(cx))
            })
            .when(shown.is_some(), |card| {
                card.child(self.render_voice_eq_presets(&voice_eq, enabled, cx))
                    .child(self.render_voice_eq_graph(&voice_eq, enabled, cx))
                    .child(
                        div()
                            .mt(px(6.))
                            .text_size(px(11.))
                            .line_height(px(14.))
                            .text_color(Hsla::from(theme.editor.text_3))
                            .child(tr::editor::tabs::audio::voice_eq::graph_hint()),
                    )
                    .child(self.render_voice_eq_bands(&voice_eq, cx))
            })
            .child(
                div()
                    .mt(px(14.))
                    .pt(px(12.))
                    .border_t_1()
                    .border_color(line)
                    .child(self.render_voice_eq_declick(shown, cx)),
            )
            .into_any_element()
    }

    fn render_voice_eq_scope(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let scoped = self.voice_eq_selection_scoped();
        let many = self.voice_eq_targets().len() > 1;
        let (title, hint) = if scoped {
            (
                if many {
                    tr::editor::tabs::audio::voice_eq::scope_selected_many()
                } else {
                    tr::editor::tabs::audio::voice_eq::scope_selected()
                },
                None,
            )
        } else if self.voice_eq_mixed() {
            (
                tr::editor::tabs::audio::voice_eq::scope_all(),
                Some(tr::editor::tabs::audio::voice_eq::scope_mixed()),
            )
        } else {
            (
                tr::editor::tabs::audio::voice_eq::scope_all(),
                Some(tr::editor::tabs::audio::voice_eq::scope_all_hint()),
            )
        };
        div()
            .mt(px(12.))
            .px(px(10.))
            .py(px(8.))
            .rounded(px(8.))
            .bg(Hsla::from(theme.editor.ctl))
            .flex()
            .flex_col()
            .gap(px(2.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.))
                            .min_w_0()
                            .child(div().size(px(6.)).flex_none().rounded_full().bg(if scoped {
                                Hsla::from(theme.editor.accent)
                            } else {
                                Hsla::from(theme.editor.text_3)
                            }))
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(Hsla::from(theme.editor.text_1))
                                    .child(title),
                            ),
                    )
                    .when(scoped, |row| {
                        row.child(
                            div()
                                .id("voice-eq-apply-all")
                                .flex_none()
                                .px(px(8.))
                                .py(px(3.))
                                .rounded(px(6.))
                                .cursor_pointer()
                                .text_size(px(11.5))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(Hsla::from(theme.editor.accent))
                                .hover(|this| this.bg(Hsla::from(theme.editor.ctl_hover)))
                                .child(tr::editor::tabs::audio::voice_eq::apply_all())
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.apply_voice_eq_to_all(window, cx);
                                })),
                        )
                    }),
            )
            .children(hint.map(|hint| {
                div()
                    .pl(px(12.))
                    .text_size(px(11.))
                    .line_height(px(14.))
                    .text_color(Hsla::from(theme.editor.text_3))
                    .child(hint)
            }))
            .into_any_element()
    }

    fn render_voice_eq_presets(
        &self,
        voice_eq: &VoiceEq,
        enabled: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let current = voice_eq.preset;
        let chips = VoiceEqPreset::ALL.into_iter().map(|preset| {
            let selected = preset == current && enabled;
            div()
                .id(SharedString::from(format!("voice-eq-preset-{preset:?}")))
                .h(px(26.))
                .px(px(10.))
                .flex()
                .items_center()
                .rounded(px(7.))
                .text_size(px(12.))
                .font_weight(if selected {
                    FontWeight::MEDIUM
                } else {
                    FontWeight::NORMAL
                })
                .bg(if selected {
                    Hsla::from(theme.editor.card)
                } else {
                    gpui::transparent_black()
                })
                .when(selected, |chip| chip.shadow_sm())
                .text_color(Hsla::from(if selected {
                    theme.editor.text_1
                } else {
                    theme.editor.text_2
                }))
                .cursor_pointer()
                .hover(|this| this.text_color(Hsla::from(theme.editor.text_1)))
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.edit_voice_eq("voice-eq-preset", window, cx, |voice_eq| {
                        *voice_eq = voice_eq.with_preset(preset);
                        voice_eq.enabled = true;
                    });
                }))
                .child(preset_label(preset))
        });
        div()
            .mt(px(12.))
            .flex()
            .flex_row()
            .flex_wrap()
            .gap(px(2.))
            .p(px(2.))
            .rounded(px(9.))
            .bg(Hsla::from(theme.editor.ctl))
            .children(chips)
            .into_any_element()
    }

    fn render_voice_eq_graph(
        &self,
        voice_eq: &VoiceEq,
        enabled: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let view = &self.sidebar.voice_eq;
        let plot_cell = view.plot.clone();
        let selected = view.selected;
        let active = view.drag.map(|(handle, _)| handle).or(view.hover);
        let accent = Hsla::from(theme.editor.accent);
        let curve_color = if enabled {
            accent
        } else {
            Hsla::from(theme.editor.text_3)
        };
        let grid = Theme::with_alpha(theme.editor.text_3, 0.16);
        let zero = Theme::with_alpha(theme.editor.text_3, 0.38);
        let fill = Theme::with_alpha(theme.editor.accent, if enabled { 0.16 } else { 0.0 });
        let band_fill = Hsla {
            a: if enabled { 0.16 } else { 0.08 },
            ..selected.color()
        };
        let total_response = response(voice_eq, &ALL_FILTERS);
        let handle_response = response(voice_eq, handle_filters(selected));
        let curve = (0..CURVE_POINTS)
            .map(|index| {
                let fraction = index as f32 / (CURVE_POINTS - 1) as f32;
                let hz = fraction_to_hz(fraction);
                (
                    fraction,
                    db_to_fraction(total_response.db(hz)),
                    db_to_fraction(handle_response.db(hz)),
                )
            })
            .collect::<Vec<_>>();

        let handles = VoiceEqHandle::ALL.into_iter().map(|handle| {
            let (x, y) = handle_position(voice_eq, handle);
            let is_selected = handle == selected;
            let is_active = active == Some(handle);
            let size = if is_selected || is_active {
                HANDLE + 2.
            } else {
                HANDLE
            };
            let color = handle.color();
            let off = handle == VoiceEqHandle::HighPass && !voice_eq.high_pass;
            div()
                .absolute()
                .left(gpui::relative(x))
                .top(gpui::relative(y))
                .ml(px(-13.))
                .mt(px(-13.))
                .size(px(26.))
                .flex()
                .items_center()
                .justify_center()
                .rounded_full()
                .when(is_selected || is_active, |ring| {
                    ring.bg(Hsla {
                        a: if enabled { 0.2 } else { 0.12 },
                        ..color
                    })
                })
                .child(
                    div()
                        .size(px(size))
                        .rounded_full()
                        .border_2()
                        .border_color(if off {
                            Hsla { a: 0.9, ..color }
                        } else {
                            Hsla::from(theme.editor.card)
                        })
                        .bg(if off {
                            Hsla::from(theme.editor.card)
                        } else if enabled {
                            color
                        } else {
                            Hsla { a: 0.55, ..color }
                        })
                        .shadow_sm(),
                )
        });

        let readout = active.map(|handle| {
            let (x, y) = handle_position(voice_eq, handle);
            let text = match handle {
                VoiceEqHandle::HighPass if voice_eq.high_pass => {
                    format!(
                        "{} \u{b7} {}",
                        handle.label(),
                        format_hz(voice_eq.high_pass_hz)
                    )
                }
                VoiceEqHandle::HighPass => format!(
                    "{} \u{b7} {}",
                    handle.label(),
                    tr::editor::tabs::audio::voice_eq::off()
                ),
                VoiceEqHandle::Band(kind) => {
                    let band = voice_eq.band(kind);
                    format!(
                        "{} \u{b7} {} \u{b7} {}",
                        handle.label(),
                        format_hz(band.hz),
                        format_gain(band.gain_db)
                    )
                }
            };
            let above = y > 0.32;
            let leftward = x > 0.5;
            div()
                .absolute()
                .top(gpui::relative(y))
                .mt(px(if above { -38. } else { 16. }))
                .when(leftward, |pill| {
                    pill.right(gpui::relative(1. - x)).mr(px(-12.))
                })
                .when(!leftward, |pill| pill.left(gpui::relative(x)).ml(px(-12.)))
                .flex()
                .child(
                    div()
                        .px(px(8.))
                        .py(px(4.))
                        .rounded(px(6.))
                        .bg(Hsla::from(theme.editor.text_1))
                        .text_color(Hsla::from(theme.editor.card))
                        .text_size(px(11.))
                        .font_weight(FontWeight::MEDIUM)
                        .whitespace_nowrap()
                        .child(text),
                )
        });

        let labels = MAJOR_HZ.into_iter().map(|hz| {
            div()
                .absolute()
                .bottom(px(3.))
                .left(gpui::relative(hz_to_fraction(hz)))
                .ml(px(-20.))
                .w(px(40.))
                .flex()
                .justify_center()
                .text_size(px(10.))
                .text_color(Hsla::from(theme.editor.text_3))
                .child(if hz >= 1_000. {
                    format!("{}k", hz / 1_000.)
                } else {
                    format!("{hz}")
                })
        });
        let db_labels = [(12., "+12"), (-12., "\u{2212}12")]
            .into_iter()
            .map(|(db, text)| {
                div()
                    .absolute()
                    .left(px(6.))
                    .top(gpui::relative(db_to_fraction(db)))
                    .mt(px(-7.))
                    .text_size(px(9.5))
                    .text_color(Theme::with_alpha(theme.editor.text_3, 0.8))
                    .child(text)
            });

        let plot = div()
            .id("voice-eq-plot")
            .absolute()
            .top_0()
            .left_0()
            .right_0()
            .bottom(px(LABEL_STRIP))
            .cursor(if self.sidebar.voice_eq.drag.is_some() {
                CursorStyle::ClosedHand
            } else if self.sidebar.voice_eq.hover.is_some() {
                CursorStyle::OpenHand
            } else {
                CursorStyle::Arrow
            })
            .child(
                canvas(
                    move |bounds, _, _| {
                        plot_cell.set(Some(bounds));
                        bounds
                    },
                    move |_, bounds, window, _| {
                        paint_plot(
                            window,
                            bounds,
                            &curve,
                            PlotColors {
                                grid,
                                zero,
                                fill,
                                band_fill,
                                curve: curve_color,
                            },
                        );
                    },
                )
                .absolute()
                .inset_0(),
            )
            .children(db_labels)
            .children(handles)
            .children(readout)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &MouseDownEvent, window, cx| {
                    this.voice_eq_mouse_down(event, window, cx);
                }),
            )
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _, cx| {
                if !this.voice_eq_dragging() {
                    this.voice_eq_hover_at(event.position, cx);
                }
            }))
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                if !*hovered && this.sidebar.voice_eq.hover.take().is_some() {
                    cx.notify();
                }
            }))
            .on_scroll_wheel(cx.listener(|this, event: &ScrollWheelEvent, window, cx| {
                this.voice_eq_scroll(event, window, cx);
            }));

        div()
            .mt(px(10.))
            .relative()
            .w_full()
            .h(px(GRAPH_HEIGHT))
            .rounded(px(10.))
            .border_1()
            .border_color(Hsla::from(theme.editor.line))
            .bg(Hsla::from(theme.editor.card))
            .overflow_hidden()
            .child(plot)
            .children(labels)
            .into_any_element()
    }

    fn render_voice_eq_bands(&self, voice_eq: &VoiceEq, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let selected = self.sidebar.voice_eq.selected;
        let chips = VoiceEqHandle::ALL
            .into_iter()
            .map(|handle| {
                let is_selected = handle == selected;
                div()
                    .id(SharedString::from(format!(
                        "voice-eq-band-{}",
                        handle.key()
                    )))
                    .h(px(26.))
                    .px(px(8.))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .rounded(px(7.))
                    .cursor_pointer()
                    .text_size(px(11.5))
                    .bg(if is_selected {
                        Hsla::from(theme.editor.card)
                    } else {
                        gpui::transparent_black()
                    })
                    .when(is_selected, |chip| chip.shadow_sm())
                    .text_color(Hsla::from(if is_selected {
                        theme.editor.text_1
                    } else {
                        theme.editor.text_2
                    }))
                    .hover(|this| this.text_color(Hsla::from(theme.editor.text_1)))
                    .child(
                        div()
                            .size(px(7.))
                            .flex_none()
                            .rounded_full()
                            .bg(handle.color()),
                    )
                    .child(handle.label())
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.sidebar.voice_eq.selected = handle;
                        cx.notify();
                    }))
            })
            .collect::<Vec<_>>();

        let controls: Vec<AnyElement> = match selected {
            VoiceEqHandle::HighPass => {
                let on = voice_eq.high_pass;
                vec![
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .justify_between()
                        .gap(px(10.))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .text_size(px(12.))
                                .line_height(px(16.))
                                .text_color(Hsla::from(theme.editor.text_2))
                                .child(tr::editor::tabs::audio::voice_eq::low_cut_description()),
                        )
                        .child(ui::Toggle::plain(&theme, "voice-eq-low-cut", on).on_click(
                            cx.listener(move |this, _, window, cx| {
                                this.edit_voice_eq_tone(window, cx, |voice_eq| {
                                    voice_eq.high_pass = !on;
                                });
                            }),
                        ))
                        .into_any_element(),
                    self.slider_field_disabled(
                        tr::editor::tabs::audio::voice_eq::frequency(),
                        SliderKey::VoiceEq(VoiceEqSlider::HighPassHz),
                        VoiceEqSlider::HighPassHz.unit(),
                        !on,
                        cx,
                    )
                    .into_any_element(),
                ]
            }
            VoiceEqHandle::Band(kind) => {
                let mut rows = vec![
                    self.slider_field(
                        tr::editor::tabs::audio::voice_eq::frequency(),
                        SliderKey::VoiceEq(VoiceEqSlider::Hz(kind)),
                        VoiceEqSlider::Hz(kind).unit(),
                        cx,
                    )
                    .into_any_element(),
                    self.slider_field(
                        tr::editor::tabs::audio::voice_eq::gain(),
                        SliderKey::VoiceEq(VoiceEqSlider::Gain(kind)),
                        VoiceEqSlider::Gain(kind).unit(),
                        cx,
                    )
                    .into_any_element(),
                ];
                if !kind.is_shelf() {
                    rows.push(
                        self.slider_field(
                            tr::editor::tabs::audio::voice_eq::q(),
                            SliderKey::VoiceEq(VoiceEqSlider::Q(kind)),
                            VoiceEqSlider::Q(kind).unit(),
                            cx,
                        )
                        .into_any_element(),
                    );
                }
                rows
            }
        };

        div()
            .mt(px(12.))
            .flex()
            .flex_col()
            .gap(px(10.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .flex_wrap()
                    .gap(px(2.))
                    .p(px(2.))
                    .rounded(px(9.))
                    .bg(Hsla::from(theme.editor.ctl))
                    .children(chips),
            )
            .child(div().flex().flex_col().gap(px(2.)).children(controls))
            .into_any_element()
    }

    fn render_voice_eq_declick(
        &self,
        shown: Option<VoiceEq>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let current = shown.map_or(VoiceDeclick::Off, |voice_eq| voice_eq.declick);
        let options = [
            (
                VoiceDeclick::Off,
                tr::editor::tabs::audio::voice_eq::declick_off(),
            ),
            (
                VoiceDeclick::Light,
                tr::editor::tabs::audio::voice_eq::declick_light(),
            ),
            (
                VoiceDeclick::Strong,
                tr::editor::tabs::audio::voice_eq::declick_strong(),
            ),
        ];
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap(px(10.))
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(theme.editor.text_1))
                            .child(tr::editor::tabs::audio::voice_eq::declick()),
                    )
                    .child(
                        div().w(px(200.)).child(
                            ui::SegmentedControl::editor(
                                &theme,
                                "voice-eq-declick",
                                options
                                    .iter()
                                    .map(|(value, label)| {
                                        ui::SegmentOption::new(*label, current == *value)
                                    })
                                    .collect(),
                            )
                            .stretch()
                            .on_select(cx.listener(
                                move |this, index: &usize, window, cx| {
                                    let Some(&(declick, _)) = options.get(*index) else {
                                        return;
                                    };
                                    if declick == current {
                                        return;
                                    }
                                    let fresh = this.shown_voice_eq().is_none();
                                    this.edit_voice_eq(
                                        "voice-eq-declick",
                                        window,
                                        cx,
                                        |voice_eq| {
                                            if fresh {
                                                voice_eq.enabled = false;
                                            }
                                            voice_eq.declick = declick;
                                        },
                                    );
                                },
                            )),
                        ),
                    ),
            )
            .child(
                div()
                    .text_size(px(12.))
                    .line_height(px(16.))
                    .text_color(Hsla::from(theme.editor.text_3))
                    .child(tr::editor::tabs::audio::voice_eq::declick_description()),
            )
            .into_any_element()
    }
}

#[derive(Clone, Copy)]
struct PlotColors {
    grid: Hsla,
    zero: Hsla,
    fill: Hsla,
    band_fill: Hsla,
    curve: Hsla,
}

fn paint_plot(
    window: &mut Window,
    bounds: Bounds<Pixels>,
    curve: &[(f32, f32, f32)],
    colors: PlotColors,
) {
    let width = f32::from(bounds.size.width);
    let height = f32::from(bounds.size.height);
    if width <= 0. || height <= 0. || curve.len() < 2 {
        return;
    }
    let at = |x: f32, y: f32| {
        point(
            bounds.origin.x + px(x * width),
            bounds.origin.y + px(y * height),
        )
    };

    let mut minor = PathBuilder::stroke(px(1.));
    for hz in MINOR_HZ.into_iter().chain(MAJOR_HZ) {
        let x = hz_to_fraction(hz);
        minor.move_to(at(x, 0.));
        minor.line_to(at(x, 1.));
    }
    for db in [-12., -6., 6., 12.] {
        let y = db_to_fraction(db);
        minor.move_to(at(0., y));
        minor.line_to(at(1., y));
    }
    if let Ok(path) = minor.build() {
        window.paint_path(path, colors.grid);
    }
    let mut zero = PathBuilder::stroke(px(1.));
    zero.move_to(at(0., db_to_fraction(0.)));
    zero.line_to(at(1., db_to_fraction(0.)));
    if let Ok(path) = zero.build() {
        window.paint_path(path, colors.zero);
    }

    let baseline = db_to_fraction(0.);
    if colors.band_fill.a > 0. {
        let mut band = PathBuilder::fill();
        band.move_to(at(0., baseline));
        for (x, _, y) in curve {
            band.line_to(at(*x, *y));
        }
        band.line_to(at(1., baseline));
        band.close();
        if let Ok(path) = band.build() {
            window.paint_path(path, colors.band_fill);
        }
    }
    if colors.fill.a > 0. {
        let mut under = PathBuilder::fill();
        under.move_to(at(0., 1.));
        for (x, y, _) in curve {
            under.line_to(at(*x, *y));
        }
        under.line_to(at(1., 1.));
        under.close();
        if let Ok(path) = under.build() {
            window.paint_path(
                path,
                linear_gradient(
                    180.,
                    linear_color_stop(colors.fill, 0.),
                    linear_color_stop(
                        Hsla {
                            a: 0.,
                            ..colors.fill
                        },
                        1.,
                    ),
                ),
            );
        }
    }

    let mut stroke = PathBuilder::stroke(px(2.)).with_style(PathStyle::Stroke(
        StrokeOptions::default()
            .with_line_width(2.)
            .with_line_cap(LineCap::Round)
            .with_line_join(LineJoin::Round),
    ));
    stroke.move_to(at(curve[0].0, curve[0].1));
    for (x, y, _) in &curve[1..] {
        stroke.line_to(at(*x, *y));
    }
    if let Ok(path) = stroke.build() {
        window.paint_path(path, colors.curve);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::size;

    fn plot() -> Bounds<Pixels> {
        Bounds {
            origin: point(px(40.), px(300.)),
            size: size(px(356.), px(GRAPH_HEIGHT - LABEL_STRIP)),
        }
    }

    fn at(fraction: (f32, f32)) -> Point<Pixels> {
        let bounds = plot();
        point(
            bounds.origin.x + bounds.size.width * fraction.0,
            bounds.origin.y + bounds.size.height * fraction.1,
        )
    }

    #[test]
    fn plot_axes_round_trip_and_clamp() {
        for hz in [20., 80., 1_000., 3_500., 20_000.] {
            assert!((fraction_to_hz(hz_to_fraction(hz)) - hz).abs() / hz < 1e-4);
        }
        assert_eq!(hz_to_fraction(5.), 0.);
        assert_eq!(hz_to_fraction(40_000.), 1.);
        for db in [-12., -3.5, 0., 6., 12.] {
            assert!((fraction_to_db(db_to_fraction(db)) - db).abs() < 1e-4);
        }
        assert_eq!(db_to_fraction(0.), 0.5);
    }

    #[test]
    fn readouts_are_compact() {
        assert_eq!(format_hz(80.), "80 Hz");
        assert_eq!(format_hz(999.6), "1 kHz");
        assert_eq!(format_hz(3_500.), "3.5 kHz");
        assert_eq!(format_hz(10_000.), "10 kHz");
        assert_eq!(format_gain(1.5), "+1.5 dB");
        assert_eq!(format_gain(-3.04), "\u{2212}3.0 dB");
        assert_eq!(format_gain(-0.04), "0.0 dB");
    }

    #[test]
    fn dragging_a_point_moves_it_under_the_pointer_within_its_band() {
        let bounds = plot();
        let mut voice_eq = VoiceEq::default();
        let handle = VoiceEqHandle::Band(VoiceEqBandKind::HighMid);
        assert!(drag_to(
            &mut voice_eq,
            handle,
            bounds,
            at((hz_to_fraction(4_000.), db_to_fraction(6.)))
        ));
        assert_eq!(voice_eq.high_mid.hz, 4_000.);
        assert_eq!(voice_eq.high_mid.gain_db, 6.);
        let landed = handle_position(&voice_eq, handle);
        assert!((landed.0 - hz_to_fraction(4_000.)).abs() < 1e-4);

        drag_to(&mut voice_eq, handle, bounds, at((0., 0.)));
        assert_eq!(voice_eq.high_mid.hz, VoiceEqBandKind::HighMid.hz_range().0);
        assert_eq!(voice_eq.high_mid.gain_db, VoiceEq::GAIN_RANGE.1);

        let before = voice_eq.high_pass_hz;
        voice_eq.high_pass = false;
        drag_to(
            &mut voice_eq,
            VoiceEqHandle::HighPass,
            bounds,
            at((hz_to_fraction(150.), 0.95)),
        );
        assert!(voice_eq.high_pass);
        assert_eq!(voice_eq.high_pass_hz, 150.);
        assert_ne!(before, 150.);
        assert_eq!(voice_eq.sanitized(), voice_eq);
    }

    #[test]
    fn hit_testing_finds_the_nearest_point_and_ignores_empty_space() {
        let bounds = plot();
        let voice_eq = VoiceEq::default();
        for handle in VoiceEqHandle::ALL {
            let position = at(handle_position(&voice_eq, handle));
            assert_eq!(
                hit_test(&voice_eq, bounds, position, VoiceEqHandle::HighPass),
                Some(handle),
                "{handle:?}"
            );
        }
        assert_eq!(
            hit_test(&voice_eq, bounds, at((0.5, 0.02)), VoiceEqHandle::HighPass),
            None
        );
        let empty = Bounds::default();
        assert_eq!(
            hit_test(
                &voice_eq,
                empty,
                point(px(0.), px(0.)),
                VoiceEqHandle::HighPass
            ),
            None
        );
    }

    #[test]
    fn band_sliders_round_trip_through_the_project_model() {
        let mut voice_eq = VoiceEq::default();
        for kind in VoiceEqBandKind::ALL {
            let sliders = [
                VoiceEqSlider::Hz(kind),
                VoiceEqSlider::Gain(kind),
                VoiceEqSlider::Q(kind),
            ];
            for slider in sliders {
                let (min, max, _) = slider.limits();
                for value in [min, (min + max) / 2., max] {
                    slider.write(&mut voice_eq, value);
                    assert!((slider.read(&voice_eq.sanitized()) - value).abs() < 1e-3);
                }
            }
        }
        voice_eq.high_pass = false;
        VoiceEqSlider::HighPassHz.write(&mut voice_eq, 100f32.log2());
        assert!(voice_eq.high_pass);
        assert!((voice_eq.high_pass_hz - 100.).abs() < 1e-3);
    }

    #[test]
    fn the_reported_curve_is_the_rendered_one() {
        let voice_eq = VoiceEq::from_preset(VoiceEqPreset::Broadcast);
        let settings = cap_audio::VoiceToneSettings {
            filters: cap_editor::voice_eq_filters(&voice_eq),
            declick: None,
        };
        for hz in [30., 110., 380., 2_800., 9_000.] {
            assert_eq!(
                response(&voice_eq, &ALL_FILTERS).db(hz),
                settings.response_db(hz)
            );
        }
        let (_, y) = handle_position(&voice_eq, VoiceEqHandle::Band(VoiceEqBandKind::LowMid));
        assert_eq!(y, db_to_fraction(-3.5));
    }

    #[test]
    fn clip_menu_summary_names_the_preset_and_de_click() {
        let mut segment = TimelineSegment::default();
        assert_eq!(voice_eq_summary(&segment), "Off");
        segment.voice_eq = Some(VoiceEq::from_preset(VoiceEqPreset::Clear));
        assert_eq!(voice_eq_summary(&segment), "Clear");
        segment.voice_eq = Some(VoiceEq {
            declick: VoiceDeclick::Light,
            ..VoiceEq::from_preset(VoiceEqPreset::Warm)
        });
        assert_eq!(voice_eq_summary(&segment), "Warm \u{b7} De-click");
        segment.voice_eq = Some(VoiceEq {
            enabled: false,
            declick: VoiceDeclick::Strong,
            ..VoiceEq::default()
        });
        assert_eq!(voice_eq_summary(&segment), "De-click");
        segment.voice_eq = Some(VoiceEq {
            enabled: false,
            ..VoiceEq::default()
        });
        assert_eq!(voice_eq_summary(&segment), "Off");
    }
}
