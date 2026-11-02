use cap_project::ChromaKey;

use super::*;
use crate::editor_tabs::{CameraSlider, Label};

const KEY_PRESETS: [(Color, Label); 2] = [
    (
        ChromaKey::GREEN,
        tr::editor::tabs::camera::green_screen::green,
    ),
    (
        ChromaKey::BLUE,
        tr::editor::tabs::camera::green_screen::blue,
    ),
];

impl EditorWindow {
    pub(crate) fn prepare_green_screen_fields(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.sidebar.tab != SidebarTab::Camera {
            return;
        }
        let enabled = self
            .style_control_project()
            .camera
            .active_chroma_key()
            .is_some();
        if self.sidebar.green_screen_open.is_open() != enabled {
            self.sidebar.green_screen_open.set_open(enabled);
            self.animate_collapsibles(window, cx);
        }
        self.ensure_hex_input(ColorTarget::ChromaKey, window, cx);
    }

    pub(crate) fn render_green_screen(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let project = self.style_control_project();
        let key = project.camera.chroma_key.unwrap_or_default();
        let enabled = project.camera.chroma_key.is_some_and(|key| key.enabled);

        div()
            .flex()
            .flex_col()
            .child(
                ui::Field::inline(&theme, tr::editor::tabs::camera::green_screen::title()).value(
                    ui::Toggle::plain(&theme, "camera-green-screen", enabled)
                        .on_click(cx.listener(move |this, _, window, cx| {
                            let project = this.style_control_project();
                            let next = !project.camera.chroma_key.is_some_and(|key| key.enabled);
                            this.sidebar.key_color_not_found = false;
                            this.edit_project_without_timeline(
                                "camera-green-screen",
                                window,
                                cx,
                                move |project| {
                                    project
                                        .camera
                                        .chroma_key
                                        .get_or_insert_with(ChromaKey::default)
                                        .enabled = next;
                                    true
                                },
                            );
                        }))
                        .into_any_element(),
                ),
            )
            .child(collapsible(
                &self.sidebar.green_screen_open,
                div()
                    .flex()
                    .flex_col()
                    .pt(px(4.))
                    .pb(px(8.))
                    .child(
                        div()
                            .pb(px(8.))
                            .text_size(px(12.))
                            .line_height(px(16.))
                            .text_color(Hsla::from(theme.editor.text_3))
                            .child(tr::editor::tabs::camera::green_screen::description()),
                    )
                    .child(
                        ui::Subfield::plain(
                            &theme,
                            tr::editor::tabs::camera::green_screen::key_color(),
                        )
                        .gap(px(12.))
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(px(12.))
                                .child(
                                    ui::SegmentedControl::editor(
                                        &theme,
                                        "camera-green-screen-preset",
                                        KEY_PRESETS
                                            .iter()
                                            .map(|(color, label)| {
                                                ui::SegmentOption::new(label(), key.color == *color)
                                            })
                                            .collect(),
                                    )
                                    .on_select(cx.listener(
                                        |this, index: &usize, window, cx| {
                                            if let Some((color, _)) = KEY_PRESETS.get(*index) {
                                                this.set_key_color(*color, window, cx);
                                            }
                                        },
                                    )),
                                )
                                .child(self.render_rgb_input(
                                    "camera-green-screen-color",
                                    ColorTarget::ChromaKey,
                                    key.color,
                                    cx,
                                )),
                        ),
                    )
                    .child(
                        div().flex().justify_end().child(
                            ui::EditorButton::plain(&theme, "camera-green-screen-pick")
                                .label(tr::editor::tabs::camera::green_screen::pick_from_camera())
                                .disabled(self.instance.is_none())
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.pick_key_color_from_camera(window, cx);
                                })),
                        ),
                    )
                    .children(self.sidebar.key_color_not_found.then(|| {
                        div()
                            .pb(px(4.))
                            .text_size(px(12.))
                            .line_height(px(16.))
                            .text_color(Hsla::from(theme.editor.text_3))
                            .child(tr::editor::tabs::camera::green_screen::no_backdrop())
                    }))
                    .child(self.slider_field(
                        tr::editor::tabs::camera::green_screen::tolerance(),
                        SliderKey::Camera(CameraSlider::KeyTolerance),
                        "%",
                        cx,
                    ))
                    .child(self.slider_field(
                        tr::editor::tabs::camera::green_screen::softness(),
                        SliderKey::Camera(CameraSlider::KeySoftness),
                        "%",
                        cx,
                    ))
                    .child(self.slider_field(
                        tr::editor::tabs::camera::green_screen::spill(),
                        SliderKey::Camera(CameraSlider::KeySpill),
                        "%",
                        cx,
                    ))
                    .into_any_element(),
            ))
            .into_any_element()
    }

    pub(super) fn set_key_color(
        &mut self,
        color: Color,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.sidebar.key_color_not_found = false;
        self.edit_project_without_timeline(
            "camera-green-screen-color",
            window,
            cx,
            move |project| {
                let Some(key) = project.camera.chroma_key.as_mut() else {
                    return false;
                };
                if key.color == color {
                    return false;
                }
                key.color = color;
                true
            },
        );
    }

    fn pick_key_color_from_camera(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(instance) = self.instance.clone() else {
            return;
        };
        let fps = f64::from(crate::editor_window::EDITOR_PREVIEW_FPS);
        let time_secs = (self.preview_or_playhead() * fps).floor().max(0.) / fps;
        let project = self.project.clone();

        cx.spawn_in(window, async move |this, cx| {
            let sampled = cx
                .update(|_, cx| {
                    gpui_tokio::Tokio::spawn(cx, async move {
                        crate::editor_crop::decode_frame_rgba(&instance, &project, time_secs, true)
                            .await
                            .and_then(|frame| backdrop_color(&frame))
                    })
                })
                .ok();
            let color = match sampled {
                Some(task) => task.await.ok().flatten(),
                None => None,
            };
            this.update_in(cx, |this: &mut Self, window, cx| match color {
                Some(color) => this.set_key_color(color, window, cx),
                None => {
                    this.sidebar.key_color_not_found = true;
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }
}

/// The colour of the backdrop along the frame's left, top and right edges,
/// which a framed presenter almost never covers. `None` unless most of that
/// border is one clearly coloured surface.
fn backdrop_color(frame: &image::RgbaImage) -> Option<Color> {
    let (width, height) = frame.dimensions();
    let band = (width.min(height) / 20).max(1);
    let mut samples = Vec::new();
    for y in (0..height).step_by(2) {
        for x in (0..width).step_by(2) {
            if x < band || x >= width.saturating_sub(band) || y < band {
                let [r, g, b, _] = frame.get_pixel(x, y).0;
                samples.push([r, g, b]);
            }
        }
    }
    if samples.is_empty() {
        return None;
    }

    let median: [u8; 3] = std::array::from_fn(|channel| {
        let mut values: Vec<u8> = samples.iter().map(|sample| sample[channel]).collect();
        let middle = values.len() / 2;
        *values.select_nth_unstable(middle).1
    });
    let spread = median.iter().max()? - median.iter().min()?;
    let matching = samples
        .iter()
        .filter(|sample| {
            sample
                .iter()
                .zip(median)
                .all(|(&value, middle)| value.abs_diff(middle) <= 40)
        })
        .count();
    (spread >= 48 && matching * 2 >= samples.len()).then(|| median.map(u16::from))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(color_at: impl Fn(u32, u32) -> [u8; 3]) -> image::RgbaImage {
        image::RgbaImage::from_fn(320, 180, |x, y| {
            let [r, g, b] = color_at(x, y);
            image::Rgba([r, g, b, 255])
        })
    }

    fn presenter(backdrop: impl Fn(u32, u32) -> [u8; 3]) -> image::RgbaImage {
        frame(|x, y| {
            if (100..220).contains(&x) && y >= 40 {
                [224, 172, 138]
            } else {
                backdrop(x, y)
            }
        })
    }

    fn near(color: Color, expected: [u8; 3], tolerance: u16) -> bool {
        color
            .iter()
            .zip(expected)
            .all(|(&value, expected)| value.abs_diff(u16::from(expected)) <= tolerance)
    }

    fn editor_with_camera_style(
        cx: &mut gpui::TestAppContext,
    ) -> (gpui::Entity<EditorWindow>, &mut gpui::VisualTestContext) {
        let project = tempfile::tempdir().unwrap();
        let project_path = project.path().to_path_buf();
        let (editor, cx) = cx
            .add_window_view(move |window, cx| EditorWindow::new(project_path.clone(), window, cx));
        editor.update(cx, |editor, _| {
            editor.project.timeline = Some(
                serde_json::from_value(serde_json::json!({
                    "segments": [],
                    "zoomSegments": [],
                    "styleSegments": [{ "overrides": { "camera": {} } }],
                }))
                .unwrap(),
            );
        });
        (editor, cx)
    }

    // gpui's test windows have no platform window handle on macOS or Windows, which the editor needs.
    #[cfg(target_os = "linux")]
    #[gpui::test]
    fn settings_follow_the_key_through_undo_and_style_changes(cx: &mut gpui::TestAppContext) {
        let (editor, cx) = editor_with_camera_style(cx);
        editor.update_in(cx, |editor, window, cx| {
            editor.sidebar.tab = SidebarTab::Camera;
            editor.prepare_green_screen_fields(window, cx);
            assert!(!editor.sidebar.green_screen_open.is_open());

            editor.project.camera.chroma_key = Some(ChromaKey::default());
            editor.prepare_green_screen_fields(window, cx);
            assert!(editor.sidebar.green_screen_open.is_open());

            editor.open_style_group(0, StyleGroup::Camera, window, cx);
            editor.prepare_green_screen_fields(window, cx);
            assert!(!editor.sidebar.green_screen_open.is_open());

            editor.sidebar.style_target = None;
            editor.prepare_green_screen_fields(window, cx);
            assert!(editor.sidebar.green_screen_open.is_open());
        });
    }

    #[test]
    fn finds_an_evenly_lit_screen_behind_a_presenter() {
        let green = backdrop_color(&presenter(|_, _| [30, 170, 70])).unwrap();
        assert_eq!(green, [30, 170, 70]);
        let blue = backdrop_color(&presenter(|_, _| [20, 80, 190])).unwrap();
        assert_eq!(blue, [20, 80, 190]);
    }

    #[test]
    fn takes_the_middle_of_an_unevenly_lit_screen() {
        let lit = |x: u32, _| {
            let light = 0.75 + 0.5 * x as f32 / 320.;
            [30, 170, 70].map(|channel: u8| (f32::from(channel) * light).min(255.) as u8)
        };
        let color = backdrop_color(&presenter(lit)).unwrap();
        assert!(near(color, [30, 170, 70], 12), "{color:?}");
    }

    #[test]
    fn a_presenter_reaching_the_bottom_edge_does_not_count() {
        let color = backdrop_color(&frame(|x, y| {
            if (60..260).contains(&x) && y >= 20 {
                [235, 235, 235]
            } else {
                [30, 170, 70]
            }
        }))
        .unwrap();
        assert_eq!(color, [30, 170, 70]);
    }

    #[test]
    fn a_room_without_a_screen_finds_nothing() {
        assert_eq!(backdrop_color(&presenter(|_, _| [128, 120, 110])), None);
        let cluttered = presenter(|x, y| match (x / 16 + y / 16) % 3 {
            0 => [200, 40, 40],
            1 => [40, 200, 40],
            _ => [40, 40, 200],
        });
        assert_eq!(backdrop_color(&cluttered), None);
    }
}
