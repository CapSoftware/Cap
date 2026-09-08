use super::*;
use crate::editor_panels::{
    CAMERA3D_SCENES, MOTION_TEMPLATES, apply_motion_template, apply_scene_to_range,
};
use cap_project::{Camera3DProperties, Camera3DSegment};

const STARTERS: &[(&str, &str)] = &[
    ("glide-across", "Move smoothly across the details"),
    ("unfold", "Reveal your screen with a gentle tilt"),
    ("pull-back", "Pull out to show the bigger picture"),
];
const SEQUENCES: &[(&str, &str)] = &[
    ("showcase", "Close-up, overhead sweep, then zoom in"),
    ("product-tour", "Reveal, orbit, then settle on your screen"),
    ("punch-in", "Zoom into a detail, then pull back"),
];

fn scene_range(
    segments: &[(f64, f64)],
    time: f64,
    duration: f64,
    total: f64,
) -> Option<(f64, f64)> {
    if ![time, duration, total]
        .iter()
        .all(|value| value.is_finite())
        || duration <= 0.0
        || total <= 0.0
    {
        return None;
    }
    let start = time.clamp(0.0, total);
    let mut gap_start: f64 = 0.0;
    let mut gap_end = total;
    for &(existing_start, existing_end) in segments {
        if existing_start <= start && start < existing_end {
            return None;
        }
        if existing_end <= start {
            gap_start = gap_start.max(existing_end);
        } else {
            gap_end = gap_end.min(existing_start);
        }
    }
    let length = duration.min(gap_end - gap_start);
    if length < 0.5_f64.min(total) {
        return None;
    }
    let fitted_start = start.min(gap_end - length).max(gap_start);
    Some((fitted_start, fitted_start + length))
}

fn scene_details(id: &str) -> Option<(&'static str, Camera3DProperties)> {
    MOTION_TEMPLATES
        .iter()
        .find(|item| item.id == id)
        .map(|item| (item.name, item.from))
        .or_else(|| {
            CAMERA3D_SCENES
                .iter()
                .find(|item| item.id == id)
                .map(|item| (item.name, item.shots[0].from))
        })
}

fn scene_segments(id: &str, start: f64, end: f64, cuts: &[f64]) -> Vec<Camera3DSegment> {
    if let Some(template) = MOTION_TEMPLATES.iter().find(|item| item.id == id) {
        let mut segment = edits::default_camera3d_segment(start, end);
        apply_motion_template(&mut segment, template);
        vec![segment]
    } else if let Some(scene) = CAMERA3D_SCENES.iter().find(|item| item.id == id) {
        apply_scene_to_range(scene, start, end, cuts)
    } else {
        Vec::new()
    }
}

fn projected_point(pose: &Camera3DProperties, x: f32, y: f32) -> Option<(f32, f32)> {
    let projection = cap_rendering::camera3d::camera3d_inverse_homography(pose, 16.0 / 9.0, None)?;
    let [[a, b, c], [d, e, f], [g, h, i]] = projection.inverse_rows;
    let x = x * projection.half_extents.0;
    let y = y * projection.half_extents.1;
    let w = (d * h - e * g) * x + (b * g - a * h) * y + a * e - b * d;
    if w.abs() < 0.00001 {
        return None;
    }
    let px = ((e * i - f * h) * x + (c * h - b * i) * y + b * f - c * e) / w;
    let py = ((f * g - d * i) * x + (a * i - c * g) * y + c * d - a * f) / w;
    (px.is_finite() && py.is_finite()).then_some(((px + 1.0) / 2.0, (1.0 - py) / 2.0))
}

impl EditorWindow {
    pub(super) fn close_camera3d_setup(&mut self, cx: &mut Context<Self>) {
        self.camera3d_setup = None;
        self.rebuild_timeline();
        cx.notify();
    }

    pub(super) fn start_camera3d_setup(&mut self, cx: &mut Context<Self>) {
        self.start_camera3d_setup_at(self.view.playhead, cx);
    }

    pub(super) fn start_camera3d_setup_at(&mut self, time: f64, cx: &mut Context<Self>) {
        let previous = self.camera3d_setup;
        self.set_selection(None, cx);
        self.sidebar.style_target = None;
        self.audio_picker = None;
        self.tracks.three_d = true;
        self.camera3d_setup = Some(Camera3DSetup {
            start: time,
            ..previous.unwrap_or(Camera3DSetup {
                scene_id: "glide-across",
                start: time,
                duration: 6.0,
                sequences_open: false,
            })
        });
        self.rebuild_timeline();
        cx.notify();
    }

    fn planned_camera3d_scene(&self) -> Vec<Camera3DSegment> {
        let Some(setup) = self.camera3d_setup else {
            return Vec::new();
        };
        let existing = self
            .project
            .timeline
            .as_ref()
            .map(|timeline| {
                timeline
                    .camera3d_segments
                    .iter()
                    .map(|segment| (segment.start, segment.end))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let Some((start, end)) = scene_range(
            &existing,
            setup.start,
            setup.duration,
            self.total_duration(),
        ) else {
            return Vec::new();
        };
        let cuts = self
            .project
            .timeline
            .as_ref()
            .map(|timeline| {
                let offsets = crate::editor_timeline::clip_timeline_offsets(timeline);
                timeline
                    .segments
                    .iter()
                    .zip(offsets)
                    .flat_map(|(segment, offset)| [offset, offset + segment.duration()])
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        scene_segments(setup.scene_id, start, end, &cuts)
    }

    pub(super) fn camera3d_setup_preview(&self) -> Vec<(f64, f64, String)> {
        let segments = self.planned_camera3d_scene();
        let Some((first, last)) = segments.first().zip(segments.last()) else {
            return Vec::new();
        };
        let name = self
            .camera3d_setup
            .and_then(|setup| scene_details(setup.scene_id))
            .map(|(name, _)| name)
            .unwrap_or("3D scene");
        vec![(
            first.start,
            last.end,
            format!("{name} · {:.1}s", last.end - first.start),
        )]
    }

    pub(crate) fn confirm_camera3d_setup(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !edits::ensure_timeline(&mut self.project, &self.clip_display_durations) {
            return;
        }
        let generated = self.planned_camera3d_scene();
        let Some(first) = generated.first() else {
            return;
        };
        let start = first.start;
        let index = self
            .project
            .timeline
            .as_ref()
            .map(|timeline| {
                timeline
                    .camera3d_segments
                    .iter()
                    .filter(|segment| segment.start < start)
                    .count()
            })
            .unwrap_or(0);
        if !self.edit(
            |timeline| {
                timeline.camera3d_segments.extend(generated);
                timeline
                    .camera3d_segments
                    .sort_by(|a, b| a.start.total_cmp(&b.start));
                true
            },
            window,
            cx,
        ) {
            return;
        }
        self.camera3d_setup = None;
        self.tracks.three_d = true;
        self.set_selection(Some(Selection::single(TrackKind::ThreeD, index)), cx);
        self.rebuild_timeline();
        self.seek_to_time(start, cx);
        self.view.preview_time = None;
        self.note_edit("add-track", Some(TrackKind::ThreeD));
    }

    fn select_camera3d_scene(&mut self, id: &'static str, cx: &mut Context<Self>) {
        if let Some(setup) = self.camera3d_setup.as_mut() {
            setup.scene_id = id;
        }
        self.rebuild_timeline();
        cx.notify();
    }

    fn render_scene_card(
        &self,
        id: &'static str,
        description: &'static str,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = self.theme;
        let Some((name, pose)) = scene_details(id) else {
            return div().into_any_element();
        };
        let selected = self
            .camera3d_setup
            .is_some_and(|setup| setup.scene_id == id);
        div()
            .id(SharedString::from(format!("camera3d-setup-{id}")))
            .flex()
            .items_center()
            .gap(px(12.))
            .p(px(8.))
            .rounded(px(8.))
            .border_1()
            .border_color(Hsla::from(if selected {
                theme.blue_9
            } else {
                theme.gray_4
            }))
            .bg(Hsla::from(theme.gray_2))
            .cursor_pointer()
            .tab_index(0)
            .hover(|style| style.border_color(theme.blue_9))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.select_camera3d_scene(id, cx);
            }))
            .on_key_down(cx.listener(move |this, event: &gpui::KeyDownEvent, _, cx| {
                if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    cx.stop_propagation();
                    this.select_camera3d_scene(id, cx);
                }
            }))
            .child(
                div()
                    .w(px(86.))
                    .h(px(56.))
                    .flex_none()
                    .rounded(px(6.))
                    .overflow_hidden()
                    .bg(Hsla::from(theme.gray_3))
                    .child(
                        gpui::canvas(
                            |bounds, _, _| bounds,
                            move |_, bounds, window, _| {
                                let shapes: &[(&[(f32, f32)], bool)] = &[
                                    (&[(-1., 1.), (1., 1.), (1., -1.), (-1., -1.)], true),
                                    (&[(-0.8, 0.65), (0.3, 0.65)], false),
                                    (&[(-0.8, 0.25), (0.8, 0.25)], false),
                                    (&[(-0.8, -0.1), (0.65, -0.1)], false),
                                    (&[(-0.8, -0.45), (0.3, -0.45)], false),
                                ];
                                for &(points, fill) in shapes {
                                    let mut path = if fill {
                                        gpui::PathBuilder::fill()
                                    } else {
                                        gpui::PathBuilder::stroke(px(2.))
                                    };
                                    let mut valid = true;
                                    for (index, &(x, y)) in points.iter().enumerate() {
                                        let Some((x, y)) = projected_point(&pose, x, y) else {
                                            valid = false;
                                            break;
                                        };
                                        let point = gpui::point(
                                            bounds.origin.x + bounds.size.width * x,
                                            bounds.origin.y + bounds.size.height * y,
                                        );
                                        if index == 0 {
                                            path.move_to(point);
                                        } else {
                                            path.line_to(point);
                                        }
                                    }
                                    if fill {
                                        path.close();
                                    }
                                    if valid && let Ok(path) = path.build() {
                                        window.paint_path(
                                            path,
                                            Hsla::from(if fill {
                                                theme.blue_9
                                            } else {
                                                theme.gray_1
                                            }),
                                        );
                                    }
                                }
                            },
                        )
                        .size_full(),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(
                        div()
                            .text_size(px(12.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(theme.gray_12))
                            .child(name),
                    )
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(Hsla::from(theme.gray_10))
                            .child(description),
                    ),
            )
            .into_any_element()
    }

    pub(crate) fn render_camera3d_setup(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = self.theme;
        let Some(setup) = self.camera3d_setup else {
            return div().into_any_element();
        };
        let range = self.camera3d_setup_preview().first().cloned();
        let name = scene_details(setup.scene_id)
            .map(|(name, _)| name)
            .unwrap_or("scene");
        let content = div()
            .id("camera3d-setup-scroll")
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .p(px(16.))
            .gap(px(16.))
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .child(
                        div()
                            .text_size(px(14.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(theme.gray_12))
                            .child("Add a 3D scene"),
                    )
                    .child(
                        ui::EditorButton::plain(&theme, "camera3d-setup-close")
                            .left_icon("icons/x-mark.svg")
                            .icon_size(px(16.))
                            .tooltip(&theme, "Close")
                            .on_click(cx.listener(|this, _, _, cx| this.close_camera3d_setup(cx))),
                    ),
            )
            .child(
                div()
                    .flex_none()
                    .text_size(px(12.))
                    .text_color(Hsla::from(theme.gray_10))
                    .child("Choose a camera move. Cap takes care of the animation."),
            )
            .child(
                div().flex().flex_col().flex_none().gap(px(8.)).children(
                    STARTERS
                        .iter()
                        .map(|&(id, description)| self.render_scene_card(id, description, cx)),
                ),
            )
            .child(
                ui::EditorButton::plain(&theme, "camera3d-sequences")
                    .label("Multi-shot sequences")
                    .left_icon(if setup.sequences_open {
                        "icons/chevron-up.svg"
                    } else {
                        "icons/chevron-down.svg"
                    })
                    .on_click(cx.listener(|this, _, _, cx| {
                        if let Some(setup) = this.camera3d_setup.as_mut() {
                            setup.sequences_open = !setup.sequences_open;
                        }
                        cx.notify();
                    })),
            )
            .when(setup.sequences_open, |panel| {
                panel.child(
                    div().flex().flex_col().flex_none().gap(px(8.)).children(
                        SEQUENCES
                            .iter()
                            .map(|&(id, description)| self.render_scene_card(id, description, cx)),
                    ),
                )
            });
        let durations = div()
            .flex()
            .gap(px(4.))
            .children([3, 6, 10].into_iter().map(|duration| {
                let variant = if setup.duration == f64::from(duration) {
                    ui::ButtonVariant::Primary
                } else {
                    ui::ButtonVariant::Gray
                };
                ui::Button::plain(
                    &theme,
                    SharedString::from(format!("camera3d-duration-{duration}")),
                    variant,
                    ui::ButtonSize::Md,
                )
                .label(format!("{duration}s"))
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(setup) = this.camera3d_setup.as_mut() {
                        setup.duration = f64::from(duration);
                    }
                    this.rebuild_timeline();
                    cx.notify();
                }))
            }));
        let summary = range.as_ref().map(|(start, end, _)| format!("{start:.1}s – {end:.1}s · {:.1}s. Drag the edges after adding to change the length.", end - start))
            .unwrap_or_else(|| "Click an empty part of the 3D track to choose where to add your scene.".into());
        let footer = div()
            .flex()
            .flex_col()
            .flex_none()
            .p(px(16.))
            .gap(px(12.))
            .border_t_1()
            .border_color(Hsla::from(theme.gray_3))
            .child(ui::Field::plain(&theme, "Duration").child(durations))
            .child(
                div()
                    .text_size(px(12.))
                    .text_color(Hsla::from(theme.gray_10))
                    .child(summary),
            )
            .child(
                ui::Button::plain(
                    &theme,
                    "camera3d-setup-add",
                    ui::ButtonVariant::Primary,
                    ui::ButtonSize::Md,
                )
                .label(format!("Add {}", name.to_lowercase()))
                .disabled(range.is_none())
                .on_click(
                    cx.listener(|this, _, window, cx| this.confirm_camera3d_setup(window, cx)),
                ),
            );
        div()
            .id("camera3d-setup")
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .overflow_hidden()
            .child(content)
            .child(footer)
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scenes_start_at_the_playhead_and_fit_short_recordings() {
        assert_eq!(scene_range(&[], 4., 6., 30.), Some((4., 10.)));
        assert_eq!(scene_range(&[], 9., 6., 10.), Some((4., 10.)));
        assert_eq!(scene_range(&[], 0., 6., 0.3), Some((0., 0.3)));
    }

    #[test]
    fn insertion_preserves_existing_scenes_and_shortens_to_the_gap() {
        let existing = [(8., 12.), (0., 3.)];
        assert_eq!(scene_range(&existing, 3., 6., 20.), Some((3., 8.)));
        assert_eq!(scene_range(&existing, 12., 6., 20.), Some((12., 18.)));
        assert_eq!(scene_range(&existing, 9., 6., 20.), None);
        assert_eq!(scene_range(&[(0., 20.)], 20., 6., 20.), None);
    }

    #[test]
    fn invalid_ranges_cannot_create_scenes() {
        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(scene_range(&[], value, 6., 20.).is_none());
            assert!(scene_range(&[], 0., value, 20.).is_none());
            assert!(scene_range(&[], 0., 6., value).is_none());
        }
        assert!(scene_range(&[], 0., 0., 20.).is_none());
        assert!(scene_range(&[], 0., 6., 0.).is_none());
        assert!(scene_range(&[(0., 3.), (3.2, 6.)], 3., 6., 20.).is_none());
    }

    #[test]
    fn starter_presets_create_one_animated_segment() {
        for &(id, _) in STARTERS {
            let generated = scene_segments(id, 4., 10., &[]);
            assert_eq!(generated.len(), 1);
            assert_eq!((generated[0].start, generated[0].end), (4., 10.));
            assert_ne!(
                crate::editor_panels::start_pose(&generated[0]),
                crate::editor_panels::end_pose(&generated[0])
            );
            let (_, pose) = scene_details(id).unwrap();
            assert!(projected_point(&pose, 0., 0.).is_some());
        }
        assert_eq!(scene_segments("showcase", 4., 10., &[]).len(), 3);
        assert!(scene_segments("unknown", 0., 6., &[]).is_empty());
    }
}
