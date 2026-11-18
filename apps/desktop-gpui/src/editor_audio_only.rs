use std::sync::Arc;

use cap_project::{AudioVisualizerStyle, AudioVisualsConfiguration};
use cap_rendering::AudioLevels;
use gpui::{
    AnyElement, Context, FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement,
    StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder, px, svg,
};

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
    /// Add Visuals does, for the automated export checks.
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
        let played = Hsla::from(editor.accent);
        let unplayed = Hsla::from(editor.text_3);

        let waveform =
            div()
                .h(px(96.))
                .w_full()
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .children(bars.into_iter().enumerate().map(move |(index, level)| {
                    let position = (index as f32 + 0.5) / CARD_BARS as f32;
                    div().w(px(3.)).h(px(4. + 88. * level)).rounded_full().bg(
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
                    .max_w(px(640.))
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(22.))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .items_center()
                            .gap(px(6.))
                            .child(
                                div()
                                    .size(px(44.))
                                    .rounded(px(14.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .bg(Hsla::from(editor.seg_fill(gpui::rgb(
                                        crate::editor_timeline::track_color::AUDIO,
                                    ))))
                                    .child(
                                        svg()
                                            .path("icons/microphone.svg")
                                            .size(px(20.))
                                            .text_color(Hsla::from(editor.text_1)),
                                    ),
                            )
                            .child(
                                div()
                                    .text_size(px(17.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(Hsla::from(editor.text_1))
                                    .child(tr::editor::audio_only::title()),
                            )
                            .child(
                                div()
                                    .max_w(px(420.))
                                    .text_center()
                                    .text_size(px(13.))
                                    .text_color(Hsla::from(editor.text_2))
                                    .child(tr::editor::audio_only::body()),
                            ),
                    )
                    .child(waveform)
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .gap(px(10.))
                            .child(
                                ui::Button::plain(
                                    &theme,
                                    "audio-only-export",
                                    ui::ButtonVariant::Blue,
                                    ui::ButtonSize::Lg,
                                )
                                .icon("icons/music.svg")
                                .label(tr::editor::audio_only::export_audio())
                                .on_click(cx.listener(
                                    |this, _, window, cx| {
                                        this.open_export(window, cx);
                                    },
                                )),
                            )
                            .child(
                                ui::Button::plain(
                                    &theme,
                                    "audio-only-add-visuals",
                                    ui::ButtonVariant::Outline,
                                    ui::ButtonSize::Lg,
                                )
                                .icon("icons/image.svg")
                                .label(tr::editor::audio_only::add_visuals())
                                .on_click(cx.listener(
                                    |this, _, window, cx| {
                                        this.edit_audio_visuals(
                                            "audio-visuals-on",
                                            window,
                                            cx,
                                            |visuals| visuals.enabled = true,
                                        );
                                    },
                                )),
                            ),
                    ),
            )
            .into_any_element()
    }

    pub(crate) fn render_audio_visuals_card(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.is_audio_only() {
            return None;
        }
        let theme = self.theme;
        let editor = theme.editor;
        let visuals = self.project.audio_visuals.clone().unwrap_or_default();
        let enabled = visuals.enabled;
        let styles = AudioVisualizerStyle::ALL;
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
                .size(px(24.))
                .rounded_full()
                .border_2()
                .border_color(if selected {
                    Hsla::from(editor.accent)
                } else {
                    Hsla::from(editor.line)
                })
                .bg(fill)
                .cursor_pointer()
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

        Some(
            ui::Field::section(&theme, tr::editor::audio_only::visuals())
                .child(
                    ui::Subfield::plain(&theme, tr::editor::audio_only::show_visuals()).child(
                        ui::Toggle::plain(&theme, "audio-visuals-enabled", enabled).on_click(
                            cx.listener(move |this, _, window, cx| {
                                this.edit_audio_visuals(
                                    "audio-visuals-enabled",
                                    window,
                                    cx,
                                    move |visuals| visuals.enabled = !enabled,
                                );
                            }),
                        ),
                    ),
                )
                .when(enabled, |field| {
                    field
                        .child(
                            ui::SegmentedControl::editor(
                                &theme,
                                "audio-visualizer-style",
                                styles
                                    .iter()
                                    .map(|style| {
                                        ui::SegmentOption::new(
                                            style_label(*style),
                                            *style == visuals.style,
                                        )
                                    })
                                    .collect(),
                            )
                            .stretch()
                            .on_select(cx.listener(
                                move |this, index: &usize, window, cx| {
                                    let Some(style) = styles.get(*index).copied() else {
                                        return;
                                    };
                                    this.edit_audio_visuals(
                                        "audio-visuals-style",
                                        window,
                                        cx,
                                        move |visuals| visuals.style = style,
                                    );
                                },
                            )),
                        )
                        .child(
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
                                    let Some(size) = VISUALIZER_SIZES.get(*index).copied() else {
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
                        .child(div().flex().flex_row().gap(px(8.)).children(swatches))
                })
                .into_any_element(),
        )
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
