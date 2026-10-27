use std::{path::PathBuf, sync::Arc, time::Duration};

use cap_glass::{Rgba, Shape, metrics, model, scenes};
use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use gpui::{
    App, AppContext as _, AsyncApp, Context, IntoElement, ParentElement, Render, RenderImage,
    Styled, Window, WindowBackgroundAppearance, WindowBounds, WindowHandle, WindowKind,
    WindowOptions, div, img, point, px, size,
};

use crate::ui::glass::{self, GlassKind};

const PRESETS: [(&str, GlassKind, bool); 4] = [
    ("regular-light", GlassKind::Regular, false),
    ("regular-dark", GlassKind::Regular, true),
    ("clear-light", GlassKind::Clear, false),
    ("clear-dark", GlassKind::Clear, true),
];

/// `CAP_GLASS_PROBE_OUTPUT=<dir>`: draw every scene in `cap_glass::scenes`
/// with glass panes in each preset, capture the window, and score it against
/// the CPU model of the same material. Writes the captures, the model's
/// renders and `report.json`, whose `passed` is the CI verdict.
pub fn run(cx: &mut App) {
    let Some(output) = std::env::var_os("CAP_GLASS_PROBE_OUTPUT").map(PathBuf::from) else {
        return;
    };
    if let Err(error) = std::fs::create_dir_all(&output) {
        tracing::error!(%error, "glass probe: cannot create its output directory");
        return;
    }
    // An X11 window capture reads whatever is on screen over the window.
    crate::app_windows::hide_main_window(cx);
    let handle = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(gpui::Bounds {
                origin: point(px(120.), px(120.)),
                size: size(px(scenes::CANVAS.0), px(scenes::CANVAS.1)),
            })),
            titlebar: None,
            kind: WindowKind::Normal,
            focus: false,
            show: true,
            is_resizable: false,
            window_background: WindowBackgroundAppearance::Opaque,
            ..Default::default()
        },
        |_, cx| cx.new(|_| ProbeView::default()),
    );
    let handle = match handle {
        Ok(handle) => handle,
        Err(error) => {
            tracing::error!("glass probe: window failed to open: {error:#}");
            return;
        }
    };
    cx.spawn(async move |cx| {
        let report = probe(handle, &output, cx).await;
        if let Err(error) = std::fs::write(output.join("report.json"), report.to_string()) {
            tracing::error!(%error, "glass probe: could not write its report");
        }
        cx.update(|cx| cx.quit());
    })
    .detach();
}

#[derive(Default)]
struct ProbeView {
    scene: Option<Arc<RenderImage>>,
    preset: Option<(GlassKind, bool)>,
}

impl Render for ProbeView {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let mut root = div()
            .size_full()
            .relative()
            .bg(gpui::white())
            .children(self.scene.clone().map(|scene| img(scene).absolute().size_full()));
        if let Some((kind, dark)) = self.preset {
            for shape in scenes::SHAPES {
                root = root.child(
                    glass::pane(kind, dark, shape.radius)
                        .absolute()
                        .left(px(shape.x))
                        .top(px(shape.y))
                        .w(px(shape.width))
                        .h(px(shape.height)),
                );
            }
        }
        root
    }
}

async fn sleep(cx: &mut AsyncApp, millis: u64) {
    cx.background_executor()
        .timer(Duration::from_millis(millis))
        .await;
}

async fn probe(
    handle: WindowHandle<ProbeView>,
    output: &std::path::Path,
    cx: &mut AsyncApp,
) -> serde_json::Value {
    sleep(cx, 1500).await;
    let scale = handle
        .update(cx, |_, window, _| window.scale_factor())
        .unwrap_or(1.);
    let Some(target) = handle
        .update(cx, |_, window, _| window_target(window))
        .ok()
        .flatten()
    else {
        return serde_json::json!({ "passed": false, "error": "no window id to capture" });
    };

    let mut cases = Vec::new();
    for scene_name in scenes::NAMES {
        let Some(scene) = scenes::render(scene_name, scale) else {
            continue;
        };
        let image = to_rgba_image(&scene);
        let render_image = crate::library::rgba_to_render_image(image);
        for (preset_name, kind, dark) in PRESETS {
            handle
                .update(cx, |view, window, cx| {
                    view.scene = Some(render_image.clone());
                    view.preset = Some((kind, dark));
                    cx.notify();
                    window.refresh();
                })
                .ok();
            sleep(cx, 400).await;
            let name = format!("{scene_name}-{preset_name}");
            let captured = {
                let target = target.clone();
                gpui_tokio::Tokio::spawn(cx, async move {
                    cap_recording::screenshot::capture_screenshot(target).await
                })
                .await
            };
            let captured = match captured {
                Ok(Ok(image)) => image.to_rgba8(),
                Ok(Err(error)) => {
                    cases.push(serde_json::json!({ "name": name, "error": format!("{error:#}") }));
                    continue;
                }
                Err(error) => {
                    cases.push(serde_json::json!({ "name": name, "error": error.to_string() }));
                    continue;
                }
            };
            let captured = crop_to(&captured, scene.width as u32, scene.height as u32);
            let captured = Rgba {
                width: captured.width() as usize,
                height: captured.height() as usize,
                pixels: captured.as_raw().iter().map(|value| *value as f32).collect(),
            };
            let expected = expected_render(&scene, glass::material(kind, dark), scale);
            let mask = glass_mask(scale, captured.width, captured.height);
            let ssim = metrics::ssim(&captured, &expected, &mask);
            let (delta_e, delta_e95) = metrics::delta_e(&captured, &expected, &mask);
            let _ = captured.save(&output.join(format!("{name}.png")));
            let _ = expected.save(&output.join(format!("{name}-model.png")));
            cases.push(serde_json::json!({
                "name": name,
                "ssim": ssim,
                "deltaE": delta_e,
                "deltaE95": delta_e95,
                "passed": ssim >= 0.97 && delta_e <= 2.0,
            }));
        }
    }
    let passed = !cases.is_empty()
        && cases
            .iter()
            .all(|case| case["passed"].as_bool() == Some(true));
    serde_json::json!({ "passed": passed, "scale": scale, "cases": cases })
}

fn to_rgba_image(image: &Rgba) -> image::RgbaImage {
    let bytes = image
        .pixels
        .iter()
        .map(|value| value.round().clamp(0., 255.) as u8)
        .collect();
    image::RgbaImage::from_raw(image.width as u32, image.height as u32, bytes)
        .expect("scene buffer matches its size")
}

/// A window capture can carry a frame or shadow around the content; the
/// content is the centred `width` x `height`.
fn crop_to(image: &image::RgbaImage, width: u32, height: u32) -> image::RgbaImage {
    if image.width() == width && image.height() == height {
        return image.clone();
    }
    let x = image.width().saturating_sub(width) / 2;
    let y = image.height().saturating_sub(height) / 2;
    image::imageops::crop_imm(image, x, y, width.min(image.width()), height.min(image.height()))
        .to_image()
}

fn scaled(shape: &Shape, scale: f32) -> Shape {
    Shape {
        x: shape.x * scale,
        y: shape.y * scale,
        width: shape.width * scale,
        height: shape.height * scale,
        radius: shape.radius * scale,
    }
}

fn expected_render(scene: &Rgba, material: &model::GlassMaterial, scale: f32) -> Rgba {
    let mut out = scene.clone();
    for shape in scenes::SHAPES {
        let style = material.resolve(shape.width, shape.height).scaled(scale);
        let device = scaled(&shape, scale);
        model::composite(&style, &device, &scene.blurred(style.blur), &mut out);
    }
    out
}

fn glass_mask(scale: f32, width: usize, height: usize) -> Vec<bool> {
    (0..width * height)
        .map(|index| {
            let (x, y) = ((index % width) as f32 + 0.5, (index / width) as f32 + 0.5);
            scenes::SHAPES
                .iter()
                .any(|shape| scaled(shape, scale).sdf(x, y) < 1.5)
        })
        .collect()
}

#[cfg(not(target_os = "linux"))]
fn window_target(window: &Window) -> Option<ScreenCaptureTarget> {
    let number = crate::platform::window_number(window)?;
    Some(ScreenCaptureTarget::Window {
        id: number.to_string().parse().ok()?,
    })
}

#[cfg(target_os = "linux")]
fn window_target(window: &Window) -> Option<ScreenCaptureTarget> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let number = match HasWindowHandle::window_handle(window).ok()?.as_raw() {
        RawWindowHandle::Xlib(handle) => handle.window as u64,
        RawWindowHandle::Xcb(handle) => u64::from(handle.window.get()),
        _ => return None,
    };
    Some(ScreenCaptureTarget::Window {
        id: number.to_string().parse().ok()?,
    })
}
