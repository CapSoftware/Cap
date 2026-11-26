use super::*;
use gpui::{AppContext, Context, HeadlessAppContext, Render, Scene, size};
use std::{
    borrow::Cow,
    sync::{Arc, Mutex},
};

struct Ring(f32);

impl Render for Ring {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        CircularProgress::new(px(80.), px(6.), gpui::black(), gpui::white()).progress(self.0)
    }
}

type RecordedPaths = Arc<Mutex<Vec<Vec<(f32, f32)>>>>;
struct SceneRecorder(RecordedPaths);

impl gpui::PlatformHeadlessRenderer for SceneRecorder {
    fn render_scene_to_image(
        &mut self,
        scene: &Scene,
        size: gpui::Size<gpui::DevicePixels>,
    ) -> anyhow::Result<image::RgbaImage> {
        self.render_scene(scene, size)?;
        Ok(image::RgbaImage::new(0, 0))
    }
    fn render_scene(
        &mut self,
        scene: &Scene,
        _: gpui::Size<gpui::DevicePixels>,
    ) -> anyhow::Result<()> {
        *self.0.lock().unwrap() = scene
            .paths
            .iter()
            .map(|path| {
                path.vertices
                    .iter()
                    .map(|vertex| (vertex.xy_position.x.as_f32(), vertex.xy_position.y.as_f32()))
                    .collect()
            })
            .collect();
        Ok(())
    }
    fn sprite_atlas(&self) -> Arc<dyn gpui::PlatformAtlas> {
        Arc::new(EmptyAtlas)
    }
}

struct EmptyAtlas;

impl gpui::PlatformAtlas for EmptyAtlas {
    fn get_or_insert_with<'a>(
        &self,
        _: &gpui::AtlasKey,
        _: &mut dyn FnMut() -> anyhow::Result<
            Option<(gpui::Size<gpui::DevicePixels>, Cow<'a, [u8]>)>,
        >,
    ) -> anyhow::Result<Option<gpui::AtlasTile>> {
        Ok(None)
    }
    fn remove(&self, _: &gpui::AtlasKey) {}
    fn get_or_update_stream(
        &self,
        _: gpui::StreamingImageId,
        _: &gpui::StreamFrame,
    ) -> anyhow::Result<Option<gpui::AtlasTile>> {
        Ok(None)
    }
    fn remove_stream(&self, _: gpui::StreamingImageId) {}
}

#[test]
fn measured_progress_sweeps_inside_each_quarter() {
    let paths = Arc::new(Mutex::new(Vec::new()));
    let recorded = paths.clone();
    let mut cx = HeadlessAppContext::with_platform(
        Arc::new(gpui::NoopTextSystem),
        Arc::new(()),
        move || Some(Box::new(SceneRecorder(recorded.clone()))),
    );
    let window = cx
        .open_window(size(px(80.), px(80.)), |_, cx| cx.new(|_| Ring(0.)))
        .unwrap();
    for fraction in [0_f32, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1.] {
        let scale = cx
            .update_window(window.into(), |view, window, cx| {
                view.downcast::<Ring>().unwrap().update(cx, |ring, cx| {
                    ring.0 = fraction;
                    cx.notify();
                });
                window.refresh();
                window.draw(cx).clear();
                window.scale_factor()
            })
            .unwrap();
        cx.capture_screenshot(window.into()).unwrap();
        let paths = paths.lock().unwrap();
        if fraction == 0. {
            assert!(paths.is_empty());
            continue;
        }
        assert_eq!(
            paths.len(),
            1,
            "{fraction}: measured progress must paint an arc"
        );
        let vertices = &paths[0];
        let angle = fraction * std::f32::consts::TAU - std::f32::consts::FRAC_PI_2;
        let endpoint = (
            (40. + 37. * angle.cos()) * scale,
            (40. + 37. * angle.sin()) * scale,
        );
        assert!(
            vertices
                .iter()
                .any(|&(x, y)| (x - endpoint.0).hypot(y - endpoint.1) <= 3.2 * scale),
            "{fraction}: arc must reach the measured endpoint"
        );
        if fraction == 0.125 {
            assert!(
                vertices.iter().all(|&(_, y)| y < 20. * scale),
                "an eighth must not paint the entire first quarter"
            );
        }
    }
}
