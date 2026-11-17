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
///
/// With `CAP_GLASS_PROBE_REFERENCE=<dir>` it replays a corpus from
/// `scripts/glass-reference` instead: every case's backdrop, panes and tint,
/// scored against Apple's capture of the same case, so captures from each
/// OS line up with Apple's and with each other. `CAP_GLASS_PROBE_CASES`
/// limits it to cases whose names start with one of its comma-separated
/// prefixes.
pub fn run(cx: &mut App) {
    let Some(output) = std::env::var_os("CAP_GLASS_PROBE_OUTPUT").map(PathBuf::from) else {
        return;
    };
    let reference = match std::env::var_os("CAP_GLASS_PROBE_REFERENCE").map(PathBuf::from) {
        Some(dir) => match Reference::load(&dir) {
            Ok(reference) => Some(Arc::new(reference)),
            Err(error) => {
                tracing::error!(%error, "glass probe: cannot read the reference corpus");
                return;
            }
        },
        None => None,
    };
    if let Err(error) = std::fs::create_dir_all(&output) {
        tracing::error!(%error, "glass probe: cannot create its output directory");
        return;
    }
    // An area capture reads whatever is on screen over the window.
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
        let report = match reference {
            Some(reference) => probe_reference(handle, &reference, &output, cx).await,
            None => probe(handle, &output, cx).await,
        };
        if let Err(error) = std::fs::write(output.join("report.json"), report.to_string()) {
            tracing::error!(%error, "glass probe: could not write its report");
        }
        cx.update(|cx| cx.quit());
    })
    .detach();
}

struct ProbeView {
    scene: Option<Arc<RenderImage>>,
    preset: Option<(GlassKind, bool)>,
    shapes: Vec<Shape>,
    tint: Option<glass::Tint>,
}

impl Default for ProbeView {
    fn default() -> Self {
        Self {
            scene: None,
            preset: None,
            shapes: scenes::SHAPES.to_vec(),
            tint: None,
        }
    }
}

impl Render for ProbeView {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let mut root = div().size_full().relative().bg(gpui::white()).children(
            self.scene
                .clone()
                .map(|scene| img(scene).absolute().size_full()),
        );
        if let Some((kind, dark)) = self.preset {
            for shape in &self.shapes {
                let pane = match self.tint {
                    Some(tint) => glass::pane_tinted(kind, dark, shape.radius, tint),
                    None => glass::pane(kind, dark, shape.radius),
                };
                root = root.child(
                    pane.absolute()
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
                pixels: captured
                    .as_raw()
                    .iter()
                    .map(|value| *value as f32)
                    .collect(),
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

/// A corpus written by `scripts/glass-reference` (`reference` or `sweep`).
struct Reference {
    dir: PathBuf,
    shapes: Vec<Shape>,
    cases: Vec<ReferenceCase>,
    tints: std::collections::HashMap<String, [f32; 4]>,
}

#[derive(serde::Deserialize)]
struct ReferenceManifest {
    shapes: Vec<ReferenceShape>,
    cases: Vec<ReferenceCase>,
    #[serde(default)]
    tints: std::collections::HashMap<String, [f32; 4]>,
}

#[derive(serde::Deserialize)]
struct ReferenceShape {
    rect: [f32; 4],
    radius: f32,
}

#[derive(serde::Deserialize, Clone)]
struct ReferenceCase {
    name: String,
    scene: String,
    style: String,
    appearance: String,
    tint: String,
    #[serde(default)]
    pass: String,
}

impl Reference {
    fn load(dir: &std::path::Path) -> anyhow::Result<Self> {
        let manifest: ReferenceManifest =
            serde_json::from_slice(&std::fs::read(dir.join("manifest.json"))?)?;
        let prefixes: Vec<String> = std::env::var("CAP_GLASS_PROBE_CASES")
            .map(|list| list.split(',').map(str::to_owned).collect())
            .unwrap_or_default();
        Ok(Self {
            dir: dir.to_owned(),
            shapes: manifest
                .shapes
                .iter()
                .map(|shape| Shape {
                    x: shape.rect[0],
                    y: shape.rect[1],
                    width: shape.rect[2],
                    height: shape.rect[3],
                    radius: shape.radius,
                })
                .collect(),
            cases: manifest
                .cases
                .into_iter()
                // The sweep's falling pass repeats its rising one.
                .filter(|case| case.pass != "down")
                .filter(|case| {
                    prefixes.is_empty()
                        || prefixes.iter().any(|prefix| case.name.starts_with(prefix))
                })
                .collect(),
            tints: manifest.tints,
        })
    }

    /// `name` from the corpus at `width` x `height` device pixels.
    fn image(&self, folder: &str, name: &str, width: u32, height: u32) -> Option<image::RgbaImage> {
        let image = image::open(self.dir.join(folder).join(format!("{name}.png")))
            .ok()?
            .to_rgba8();
        Some(if image.width() == width && image.height() == height {
            image
        } else {
            image::imageops::resize(&image, width, height, image::imageops::FilterType::Triangle)
        })
    }
}

async fn probe_reference(
    handle: WindowHandle<ProbeView>,
    reference: &Reference,
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
    let shapes = reference.shapes.clone();
    handle
        .update(cx, |view, _, _| view.shapes = shapes.clone())
        .ok();
    let (width, height) = (
        (scenes::CANVAS.0 * scale).round() as u32,
        (scenes::CANVAS.1 * scale).round() as u32,
    );
    let mask: Vec<bool> = (0..(width * height) as usize)
        .map(|index| {
            let x = (index % width as usize) as f32 + 0.5;
            let y = (index / width as usize) as f32 + 0.5;
            shapes
                .iter()
                .any(|shape| scaled(shape, scale).sdf(x, y) < 1.5)
        })
        .collect();
    let mut scene_cache: std::collections::HashMap<String, Arc<RenderImage>> = Default::default();
    let mut cases = Vec::new();
    for case in &reference.cases {
        let kind = match case.style.as_str() {
            "clear" => GlassKind::Clear,
            _ => GlassKind::Regular,
        };
        let dark = case.appearance == "dark";
        let tint = reference
            .tints
            .get(&case.tint)
            .map(|[r, g, b, a]| gpui::Rgba {
                r: *r,
                g: *g,
                b: *b,
                a: *a,
            });
        let scene = match scene_cache.get(&case.scene) {
            Some(scene) => scene.clone(),
            None => {
                let Some(image) = reference.image("scenes", &case.scene, width, height) else {
                    cases.push(serde_json::json!({ "name": case.name, "error": "missing scene" }));
                    continue;
                };
                let scene = crate::library::rgba_to_render_image(image);
                scene_cache.insert(case.scene.clone(), scene.clone());
                scene
            }
        };
        handle
            .update(cx, |view, window, cx| {
                view.scene = Some(scene);
                view.preset = Some((kind, dark));
                view.tint = tint;
                cx.notify();
                window.refresh();
            })
            .ok();
        sleep(cx, 400).await;
        let captured = {
            let target = target.clone();
            gpui_tokio::Tokio::spawn(cx, async move {
                cap_recording::screenshot::capture_screenshot(target).await
            })
            .await
        };
        let captured = match captured {
            Ok(Ok(image)) => crop_to(&image.to_rgba8(), width, height),
            Ok(Err(error)) => {
                cases.push(serde_json::json!({ "name": case.name, "error": format!("{error:#}") }));
                continue;
            }
            Err(error) => {
                cases.push(serde_json::json!({ "name": case.name, "error": error.to_string() }));
                continue;
            }
        };
        let _ = captured.save(output.join(format!("{}.png", case.name)));
        let Some(apple) = reference.image("apple", &case.name, width, height) else {
            cases.push(serde_json::json!({ "name": case.name, "error": "missing Apple capture" }));
            continue;
        };
        let to_rgba = |image: &image::RgbaImage| Rgba {
            width: image.width() as usize,
            height: image.height() as usize,
            pixels: image.as_raw().iter().map(|value| *value as f32).collect(),
        };
        let (ours, apple) = (to_rgba(&captured), to_rgba(&apple));
        let ssim = metrics::ssim(&ours, &apple, &mask);
        let (delta_e, delta_e95) = metrics::delta_e(&ours, &apple, &mask);
        cases.push(serde_json::json!({
            "name": case.name,
            "ssim": ssim,
            "deltaE": delta_e,
            "deltaE95": delta_e95,
            "passed": ssim >= 0.98 && delta_e <= 1.0 && delta_e95 <= 3.0,
        }));
    }
    let passed = !cases.is_empty()
        && cases
            .iter()
            .all(|case| case["passed"].as_bool() == Some(true));
    serde_json::json!({
        "passed": passed,
        "scale": scale,
        "os": std::env::consts::OS,
        "cases": cases,
    })
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
    image::imageops::crop_imm(
        image,
        x,
        y,
        width.min(image.width()),
        height.min(image.height()),
    )
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

#[cfg(target_os = "macos")]
fn window_target(window: &Window) -> Option<ScreenCaptureTarget> {
    let number = crate::platform::window_number(window)?;
    Some(ScreenCaptureTarget::Window {
        id: number.to_string().parse().ok()?,
    })
}

/// Cap's own windows are not in its X11 window list, and hosted Windows
/// runners have no window capture, so the probe captures the window's area
/// of the display; it hides every other Cap window first.
#[cfg(not(target_os = "macos"))]
fn window_target(window: &Window) -> Option<ScreenCaptureTarget> {
    use scap_targets::bounds::{LogicalBounds, LogicalPosition, LogicalSize};

    let display = scap_targets::Display::primary();
    let bounds = window.bounds();
    let origin = display.raw_handle().logical_bounds()?.position();
    Some(ScreenCaptureTarget::Area {
        screen: display.id(),
        bounds: LogicalBounds::new(
            LogicalPosition::new(
                f64::from(f32::from(bounds.origin.x)) - origin.x(),
                f64::from(f32::from(bounds.origin.y)) - origin.y(),
            ),
            LogicalSize::new(
                f64::from(f32::from(bounds.size.width)),
                f64::from(f32::from(bounds.size.height)),
            ),
        ),
    })
}
