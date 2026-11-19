use std::sync::Arc;

use cap_project::{
    AnimatedGradientConfig, AudioVisualizerStyle, AudioVisualsConfiguration, BackgroundSource,
};
use cap_rendering::AudioLevels;
use gpui::{
    AnyElement, Context, FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement,
    StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder, px,
};

use crate::editor_sidebar::SelectionRing as _;
use crate::editor_window::EditorWindow;
use crate::i18n::tr;
use crate::ui;

const CARD_BARS: usize = 120;

const VISUALIZER_COLORS: [&str; 6] = [
    "#FFFFFF", "#111111", "#4785FF", "#F5A524", "#34C759", "#FF4F8B",
];

const VISUALIZER_SIZES: [f32; 3] = [0.4, 0.6, 0.85];

impl EditorWindow {
    pub(crate) fn is_audio_only(&self) -> bool {
        self.instance
            .as_ref()
            .is_some_and(|instance| instance.render_constants.is_audio_only())
    }

    pub(crate) fn audio_visuals_enabled(&self) -> bool {
        self.project
            .audio_visuals
            .as_ref()
            .is_some_and(|visuals| visuals.enabled)
    }

    pub(crate) fn refresh_audio_levels(&mut self) {
        if !self.is_audio_only() {
            return;
        }
        let levels = Arc::new(AudioLevels::from_waveform_peaks(
            &peak_slices(&self.timeline.mic_waveforms),
            &peak_slices(&self.timeline.system_waveforms),
        ));
        if let Some(instance) = &self.instance {
            instance
                .render_constants
                .set_audio_levels(Some(levels.clone()));
        }
        self.audio_levels = Some(levels);
        if self.audio_visuals_enabled() {
            self.publish_project();
        }
    }

    fn edit_audio_visuals(
        &mut self,
        reason: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
        change: impl FnOnce(&mut AudioVisualsConfiguration),
    ) {
        self.edit_project_without_timeline(reason, window, cx, move |project| {
            let before = project.audio_visuals.clone();
            let background = &project.background.source;
            let visuals = project.audio_visuals.get_or_insert_with(|| {
                Box::new(AudioVisualsConfiguration::for_background(background))
            });
            change(&mut **visuals);
            project.audio_visuals != before
        });
    }

    /// `CAP_GPUI_AUTO_AUDIO_VISUALS=bars|wave|circle`: turn visuals on the way
    /// a visualiser tile does, for the automated export checks.
    pub(crate) fn enable_audio_visuals_for_automation(
        &mut self,
        style: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let style = match style {
            "wave" => AudioVisualizerStyle::Wave,
            "circle" => AudioVisualizerStyle::Circle,
            _ => AudioVisualizerStyle::Bars,
        };
        tracing::info!(?style, "auto audio visuals");
        self.edit_audio_visuals("audio-visuals-auto", window, cx, move |visuals| {
            visuals.enabled = true;
            visuals.style = style;
        });
    }

    /// Turns visuals on in `style` in one step. A project still on the plain
    /// background a recording starts with gets the animated one, so the
    /// first look is already a video worth exporting.
    fn show_visuals(
        &mut self,
        style: AudioVisualizerStyle,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let plain = matches!(
            self.project.background.source,
            BackgroundSource::Color {
                value: [255, 255, 255],
                alpha: 255
            }
        );
        self.edit_project_without_timeline("audio-visuals-style", window, cx, move |project| {
            let before = project.audio_visuals.clone();
            if plain {
                project.background.source = BackgroundSource::AnimatedGradient {
                    config: AnimatedGradientConfig::default(),
                };
            }
            let background = &project.background.source;
            let visuals = project.audio_visuals.get_or_insert_with(|| {
                Box::new(AudioVisualsConfiguration::for_background(background))
            });
            visuals.enabled = true;
            visuals.style = style;
            plain || project.audio_visuals != before
        });
        if plain {
            self.sidebar.source_tab = crate::editor_sidebar::SourceTab::AnimatedGradient;
        }
    }

    /// One tile per visualiser, each drawing its look in small so the choice
    /// is seen before it is made. `selected` rings the one showing.
    fn render_visualizer_tiles(
        &self,
        selected: Option<AudioVisualizerStyle>,
        tile_height: f32,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let editor = theme.editor;
        div()
            .flex()
            .flex_row()
            .gap(px(8.))
            .w_full()
            .children(AudioVisualizerStyle::ALL.iter().map(|&style| {
                let chosen = selected == Some(style);
                div()
                    .id(gpui::SharedString::from(format!(
                        "audio-visualizer-{style:?}"
                    )))
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .p(px(6.))
                    .pb(px(10.))
                    .rounded(px(12.))
                    .map(|this| {
                        if chosen {
                            this.bg(editor.pill_fill())
                                .shadow(editor.choice_selected_shadow())
                        } else {
                            this.bg(Hsla::from(editor.ctl))
                                .shadow(editor.trough_ring())
                                .cursor_pointer()
                                .hover(move |this| this.bg(Hsla::from(editor.ctl_hover)))
                        }
                    })
                    .child(visualizer_preview(style, tile_height))
                    .child(
                        div()
                            .w_full()
                            .text_center()
                            .text_size(px(12.))
                            .text_color(Hsla::from(if chosen {
                                editor.text_1
                            } else {
                                editor.text_2
                            }))
                            .child(style_label(style)),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.show_visuals(style, window, cx);
                    }))
            }))
            .into_any_element()
    }

    /// Shown in place of the preview while an audio-only project has no
    /// visuals: its sound, a way out as audio, and the visualisers it can
    /// become, each one click away.
    pub(crate) fn render_audio_card(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let editor = theme.editor;
        let duration = self.total_duration();
        let progress = if duration > 0.0 {
            (self.playhead / duration).clamp(0.0, 1.0) as f32
        } else {
            0.0
        };
        let bars = card_bars(self.audio_levels.as_deref(), &self.project, CARD_BARS);
        let played = Hsla::from(editor.text_1);
        let unplayed = Hsla::from(editor.text_3);

        let waveform = div()
            .h(px(88.))
            .w_full()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .children(bars.into_iter().enumerate().map(move |(index, level)| {
                let position = (index as f32 + 0.5) / CARD_BARS as f32;
                div().w(px(2.5)).h(px(3. + 82. * level)).rounded_full().bg(
                    if position <= progress {
                        played
                    } else {
                        unplayed
                    },
                )
            }));

        div()
            .debug_selector(|| "editor-audio-card".into())
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .p(px(32.))
            .child(
                div()
                    .w_full()
                    .max_w(px(560.))
                    .flex()
                    .flex_col()
                    .gap(px(28.))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_end()
                            .justify_between()
                            .gap(px(16.))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(4.))
                                    .min_w_0()
                                    .child(
                                        div()
                                            .text_size(px(17.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(Hsla::from(editor.text_1))
                                            .child(tr::editor::audio_only::title()),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(13.))
                                            .text_color(Hsla::from(editor.text_2))
                                            .child(tr::editor::audio_only::body()),
                                    ),
                            )
                            .child(
                                ui::Button::plain(
                                    &theme,
                                    "audio-only-export",
                                    ui::ButtonVariant::Blue,
                                    ui::ButtonSize::Md,
                                )
                                .icon("icons/music.svg")
                                .label(tr::editor::audio_only::export_audio())
                                .on_click(cx.listener(
                                    |this, _, window, cx| {
                                        this.open_export(window, cx);
                                    },
                                )),
                            ),
                    )
                    .child(waveform)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(10.))
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(Hsla::from(editor.text_1))
                                    .child(tr::editor::audio_only::make_video()),
                            )
                            .child(self.render_visualizer_tiles(None, 64., cx)),
                    ),
            )
            .into_any_element()
    }

    /// The visualiser, at the top of the Background tab so the background it
    /// stands on is right below: a switch in the header, the looks as tiles,
    /// then its size and colour once it shows.
    pub(crate) fn render_audio_visuals_card(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.is_audio_only() {
            return None;
        }
        let theme = self.theme;
        let editor = theme.editor;
        let visuals = self.project.audio_visuals.clone().unwrap_or_default();
        let enabled = visuals.enabled;
        let size_index = VISUALIZER_SIZES
            .iter()
            .enumerate()
            .min_by(|(_, a), (_, b)| {
                (*a - visuals.size)
                    .abs()
                    .total_cmp(&(*b - visuals.size).abs())
            })
            .map_or(1, |(index, _)| index);

        let swatches = VISUALIZER_COLORS.iter().map(|color| {
            let selected = visuals.color.eq_ignore_ascii_case(color);
            let fill = u32::from_str_radix(color.trim_start_matches('#'), 16)
                .map_or(gpui::white(), |value| Hsla::from(gpui::rgb(value)));
            div()
                .id(gpui::SharedString::from(format!(
                    "audio-visualizer-color-{color}"
                )))
                .rounded_full()
                .selection_ring(Hsla::from(editor.card), editor.accent, selected)
                .cursor_pointer()
                .child(
                    div()
                        .size(px(20.))
                        .rounded_full()
                        .bg(fill)
                        .border_1()
                        .border_color(Hsla::from(editor.line)),
                )
                .on_click(cx.listener({
                    let color = color.to_string();
                    move |this, _, window, cx| {
                        let color = color.clone();
                        this.edit_audio_visuals(
                            "audio-visuals-color",
                            window,
                            cx,
                            move |visuals| {
                                visuals.color = color;
                            },
                        );
                    }
                }))
                .into_any_element()
        });
        let swatches: Vec<AnyElement> = swatches.collect();
        let tiles = self.render_visualizer_tiles(enabled.then_some(visuals.style), 48., cx);

        Some(
            ui::Field::section(&theme, tr::editor::audio_only::visuals())
                .value(
                    ui::Toggle::plain(&theme, "audio-visuals-enabled", enabled)
                        .label(tr::editor::audio_only::show_visuals())
                        .on_click(cx.listener(move |this, _, window, cx| {
                            if enabled {
                                this.edit_audio_visuals(
                                    "audio-visuals-enabled",
                                    window,
                                    cx,
                                    |visuals| visuals.enabled = false,
                                );
                            } else {
                                let style = this
                                    .project
                                    .audio_visuals
                                    .as_ref()
                                    .map_or(AudioVisualizerStyle::Bars, |visuals| visuals.style);
                                this.show_visuals(style, window, cx);
                            }
                        }))
                        .into_any_element(),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(12.))
                        .child(tiles)
                        .when(enabled, |this| {
                            this.child(
                                ui::SegmentedControl::editor(
                                    &theme,
                                    "audio-visualizer-size",
                                    [
                                        tr::editor::audio_only::size_small(),
                                        tr::editor::audio_only::size_medium(),
                                        tr::editor::audio_only::size_large(),
                                    ]
                                    .into_iter()
                                    .enumerate()
                                    .map(|(index, label)| {
                                        ui::SegmentOption::new(label, index == size_index)
                                    })
                                    .collect(),
                                )
                                .stretch()
                                .on_select(cx.listener(
                                    |this, index: &usize, window, cx| {
                                        let Some(size) = VISUALIZER_SIZES.get(*index).copied()
                                        else {
                                            return;
                                        };
                                        this.edit_audio_visuals(
                                            "audio-visuals-size",
                                            window,
                                            cx,
                                            move |visuals| visuals.size = size,
                                        );
                                    },
                                )),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_row()
                                    .items_center()
                                    .gap(px(10.))
                                    .px(px(2.))
                                    .children(swatches),
                            )
                        }),
                )
                .into_any_element(),
        )
    }
}

/// A visualiser's look in small, white over the animated background's own
/// palette, so a tile reads as the video it makes.
fn visualizer_preview(style: AudioVisualizerStyle, height: f32) -> gpui::Div {
    let surface = div()
        .relative()
        .w_full()
        .h(px(height))
        .rounded(px(8.))
        .overflow_hidden()
        .bg(gpui::linear_gradient(
            135.,
            gpui::linear_color_stop(gpui::rgb(0x6f9bf5), 0.),
            gpui::linear_color_stop(gpui::rgb(0x9a7ff5), 1.),
        ));
    let ink = gpui::hsla(0., 0., 1., 0.95);
    match style {
        AudioVisualizerStyle::Bars => surface.flex().items_center().justify_center().child(
            div().flex().flex_row().items_center().gap(px(3.)).children(
                [0.35, 0.6, 0.9, 0.55, 1.0, 0.7, 0.45, 0.8, 0.5, 0.3]
                    .into_iter()
                    .map(move |level: f32| {
                        div()
                            .w(px(3.))
                            .h(px(4. + (height * 0.55) * level))
                            .rounded_full()
                            .bg(ink)
                    }),
            ),
        ),
        AudioVisualizerStyle::Wave => surface.children((0..22).map(move |index| {
            let t = index as f32 / 21.;
            let y = height * 0.5 + (t * std::f32::consts::TAU * 1.5).sin() * height * 0.22;
            div()
                .absolute()
                .left(gpui::relative(0.08 + t * 0.84))
                .top(px(y - 1.5))
                .size(px(3.))
                .rounded_full()
                .bg(ink)
        })),
        AudioVisualizerStyle::Circle => surface.children((0..18).map(move |index| {
            let angle = index as f32 / 18. * std::f32::consts::TAU;
            let radius = height * (0.26 + 0.05 * ((index * 5 % 7) as f32 / 6.));
            div()
                .absolute()
                .left(gpui::relative(0.5))
                .ml(px(angle.cos() * radius - 1.5))
                .top(px(height * 0.5 + angle.sin() * radius - 1.5))
                .size(px(3.))
                .rounded_full()
                .bg(ink)
        })),
    }
}

fn peak_slices(waveforms: &[Arc<Vec<f32>>]) -> Vec<&[f32]> {
    waveforms.iter().map(|peaks| peaks.as_slice()).collect()
}

fn style_label(style: AudioVisualizerStyle) -> &'static str {
    match style {
        AudioVisualizerStyle::Bars => tr::editor::audio_only::style_bars(),
        AudioVisualizerStyle::Wave => tr::editor::audio_only::style_wave(),
        AudioVisualizerStyle::Circle => tr::editor::audio_only::style_circle(),
    }
}

fn card_bars(
    levels: Option<&AudioLevels>,
    project: &cap_project::ProjectConfiguration,
    count: usize,
) -> Vec<f32> {
    let Some(levels) = levels else {
        return vec![0.0; count];
    };
    let duration = project
        .timeline
        .as_ref()
        .map(|timeline| timeline.duration())
        .filter(|duration| duration.is_finite() && *duration > 0.0);
    let Some(duration) = duration else {
        let clip = levels.clips.first().map(Vec::as_slice).unwrap_or(&[]);
        return resample_peaks(clip, count);
    };
    let samples_per_bar = 4;
    (0..count)
        .map(|bar| {
            (0..samples_per_bar)
                .map(|step| {
                    let time = duration * (bar * samples_per_bar + step) as f64
                        / (count * samples_per_bar) as f64;
                    project
                        .get_segment_time(time)
                        .map_or(0.0, |(source_time, segment)| {
                            levels.level_at(segment.recording_clip as usize, source_time)
                        })
                })
                .fold(0.0, f32::max)
        })
        .collect()
}

fn resample_peaks(levels: &[f32], count: usize) -> Vec<f32> {
    if levels.is_empty() || count == 0 {
        return vec![0.0; count];
    }
    (0..count)
        .map(|bar| {
            let start = bar * levels.len() / count;
            let end = ((bar + 1) * levels.len() / count).max(start + 1);
            levels[start..end.min(levels.len())]
                .iter()
                .copied()
                .fold(0.0, f32::max)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_bars_are_silent_until_levels_arrive() {
        let project = cap_project::ProjectConfiguration::default();
        assert_eq!(card_bars(None, &project, 8), vec![0.0; 8]);
    }

    #[test]
    fn card_bars_keep_the_loudest_moment_of_each_slice() {
        let levels = AudioLevels {
            clips: vec![vec![0.1, 0.9, 0.2, 0.3]],
        };
        let project = cap_project::ProjectConfiguration::default();
        assert_eq!(card_bars(Some(&levels), &project, 2), vec![0.9, 0.3]);
    }

    #[test]
    fn resampling_more_bars_than_levels_repeats_values() {
        assert_eq!(resample_peaks(&[0.5], 3), vec![0.5, 0.5, 0.5]);
        assert!(resample_peaks(&[], 2).iter().all(|value| *value == 0.0));
    }
}
