//! Whole-frame benchmarks for Cap's GPUI fork.
//!
//! Every benchmark drives real frames through `Window::draw` (render, layout,
//! prepaint, paint, scene finish) on the platform's own text system; on macOS
//! the frame is also submitted to Metal through the headless renderer. The
//! workloads mirror the shapes Cap's windows draw: cards with borders and
//! shadows, label-heavy rows, a recordings list that scrolls, a timer whose
//! text changes every frame, hover over many hitboxes, and cached panels where
//! only one view changes per frame.
//!
//! With `GPUI_SCENE_DIGEST=<file>` set, every frame a benchmark submits is
//! also hashed (every primitive, in the order the renderer receives them) and
//! one line per frame is appended to `<file>`. Two builds that produce the same
//! digests drew the same scenes, so they render the same pixels.

use std::{
    borrow::Cow,
    collections::hash_map::DefaultHasher,
    fs::OpenOptions,
    hash::{Hash, Hasher},
    io::Write,
    path::PathBuf,
    sync::Arc,
};

use criterion::Criterion;
use gpui::{
    AnyView, BenchAppContext, BenchReport, BorderStyle, Bounds, BoxShadow, Corners, DevicePixels,
    Entity, MouseMoveEvent, PathBuilder, PlatformAtlas, PlatformHeadlessRenderer, PlatformInput,
    Scene, SharedString, StyleRefinement, UniformListScrollHandle, Window, canvas, div, point,
    prelude::*, px, quad, rgb, size, uniform_list,
};

const IBM_PLEX: &[u8] =
    include_bytes!("../../../assets/fonts/ibm-plex-sans/IBMPlexSans-Regular.ttf");
const FONT: &str = "IBM Plex Sans";

const TITLES: &[&str] = &[
    "Product demo",
    "Bug report: export stalls at 99%",
    "Weekly sync",
    "Onboarding walkthrough",
    "Design review — timeline",
    "Customer call",
    "Quick note",
    "Release checklist",
];

const DETAILS: &[&str] = &[
    "2 minutes ago · 1920×1080 · 60 fps",
    "Yesterday · 3840×2160 · 30 fps",
    "Mon 14:02 · Studio mode",
    "Shared with 4 people · 12 views",
    "Uploading… 48%",
    "Last edited by you",
];

const PARAGRAPH: &str = "Cap records your screen, camera and microphone, then lets you trim, \
zoom, add captions and share a link in seconds. The editor keeps every clip, segment and \
caption in sync with the timeline so that a scrub, a cut or a zoom lands exactly where you \
expect it to, on every platform, at every frame rate.";

const PALETTE: [u32; 4] = [0x4785ff, 0xff6b6b, 0x2ecc71, 0xf5a623];

fn load_fonts(cx: &mut BenchAppContext) {
    cx.update(|cx| {
        cx.text_system()
            .add_fonts(vec![Cow::Borrowed(IBM_PLEX)])
            .expect("failed to load benchmark font");
    });
}

fn card(ix: usize) -> impl IntoElement {
    div()
        .id(ix)
        .w(px(180.))
        .h(px(64.))
        .flex()
        .flex_col()
        .gap_1()
        .p_2()
        .rounded_md()
        .border_1()
        .border_color(rgb(0x2a2a33))
        .bg(rgb(0x1b1b22))
        .shadow_sm()
        .hover(|style| style.bg(rgb(0x24242e)))
        .child(
            div()
                .flex()
                .items_center()
                .gap_2()
                .child(
                    div()
                        .size(px(10.))
                        .rounded_full()
                        .bg(rgb(PALETTE[ix % PALETTE.len()])),
                )
                .child(TITLES[ix % TITLES.len()]),
        )
        .child(
            div()
                .text_color(rgb(0x8a8a99))
                .text_size(px(11.))
                .child(DETAILS[ix % DETAILS.len()]),
        )
}

struct Cards {
    count: usize,
}

impl Render for Cards {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .flex_wrap()
            .gap_2()
            .p_4()
            .bg(rgb(0x101014))
            .text_color(rgb(0xf0f0f5))
            .font_family(FONT)
            .text_size(px(13.))
            .children((0..self.count).map(card))
    }
}

/// Full re-render of a wrapping grid of styled cards (borders, rounded corners,
/// shadows, two labels each): layout-, style- and scene-heavy.
fn cards(count: usize, cx: &mut BenchAppContext) {
    load_fonts(cx);
    let mut window = cx.add_empty_window();
    let view = window
        .replace_root_view(|_, _| Cards { count })
        .expect("root view");
    window.run_until_idle();
    window
        .app_context()
        .bench_renderer(view, |_, _, cx| cx.notify());
}

struct TextRows {
    rows: usize,
    changing: bool,
    frame: u64,
}

impl Render for TextRows {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let frame = self.frame;
        let changing = self.changing;
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(0x101014))
            .text_color(rgb(0xf0f0f5))
            .font_family(FONT)
            .text_size(px(13.))
            .children((0..self.rows).map(move |ix| {
                let stamp: SharedString = if changing {
                    let ms = frame * 16 + ix as u64 * 37;
                    format!(
                        "{:02}:{:02}.{:03}",
                        ms / 60_000,
                        (ms / 1000) % 60,
                        ms % 1000
                    )
                    .into()
                } else {
                    SharedString::new_static("00:42.016")
                };
                div()
                    .flex()
                    .flex_row()
                    .gap_4()
                    .h(px(20.))
                    .px_2()
                    .child(div().w(px(72.)).child(stamp))
                    .child(div().w(px(260.)).child(TITLES[ix % TITLES.len()]))
                    .child(
                        div()
                            .flex_1()
                            .text_color(rgb(0x8a8a99))
                            .child(DETAILS[ix % DETAILS.len()]),
                    )
            }))
    }
}

/// Label-heavy rows whose text is identical every frame: exercises the line
/// layout cache hit path and glyph painting.
fn text_rows_static(rows: usize, cx: &mut BenchAppContext) {
    load_fonts(cx);
    let mut window = cx.add_empty_window();
    let view = window
        .replace_root_view(|_, _| TextRows {
            rows,
            changing: false,
            frame: 0,
        })
        .expect("root view");
    window.run_until_idle();
    window
        .app_context()
        .bench_renderer(view, |_, _, cx| cx.notify());
}

/// The same rows with a timestamp column that changes every frame, like a
/// recording timer or a timeline ruler: one fresh shaping per row per frame.
fn text_rows_changing(rows: usize, cx: &mut BenchAppContext) {
    load_fonts(cx);
    let mut window = cx.add_empty_window();
    let view = window
        .replace_root_view(|_, _| TextRows {
            rows,
            changing: true,
            frame: 0,
        })
        .expect("root view");
    window.run_until_idle();
    window.app_context().bench_renderer(view, |view, _, cx| {
        view.frame += 1;
        cx.notify();
    });
}

struct Paragraphs {
    count: usize,
}

impl Render for Paragraphs {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .flex_wrap()
            .gap_4()
            .p_4()
            .bg(rgb(0x101014))
            .text_color(rgb(0xf0f0f5))
            .font_family(FONT)
            .text_size(px(14.))
            .children((0..self.count).map(|ix| {
                div()
                    .w(px(300. + (ix % 5) as f32 * 20.))
                    .child(SharedString::new_static(PARAGRAPH))
            }))
    }
}

/// Wrapped paragraphs in columns of several widths: line wrapping and
/// multi-line text layout.
fn paragraphs(count: usize, cx: &mut BenchAppContext) {
    load_fonts(cx);
    let mut window = cx.add_empty_window();
    let view = window
        .replace_root_view(|_, _| Paragraphs { count })
        .expect("root view");
    window.run_until_idle();
    window
        .app_context()
        .bench_renderer(view, |_, _, cx| cx.notify());
}

struct Recordings {
    scroll: UniformListScrollHandle,
    frame: u64,
}

impl Render for Recordings {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .bg(rgb(0x101014))
            .text_color(rgb(0xf0f0f5))
            .font_family(FONT)
            .text_size(px(13.))
            .child(
                uniform_list("recordings", 10_000, |range, _, _| {
                    range
                        .map(|ix| {
                            div()
                                .id(ix)
                                .h(px(28.))
                                .px_2()
                                .flex()
                                .items_center()
                                .gap_2()
                                .hover(|style| style.bg(rgb(0x1b1b22)))
                                .child(
                                    div()
                                        .size(px(16.))
                                        .rounded_sm()
                                        .bg(rgb(PALETTE[ix % PALETTE.len()])),
                                )
                                .child(SharedString::from(format!("Recording {ix:05}.cap")))
                                .child(
                                    div()
                                        .text_color(rgb(0x8a8a99))
                                        .child(DETAILS[ix % DETAILS.len()]),
                                )
                        })
                        .collect::<Vec<_>>()
                })
                .track_scroll(&self.scroll)
                .size_full(),
            )
    }
}

/// A 10 000-row virtualized list scrolled a few pixels every frame.
fn recordings_scroll(cx: &mut BenchAppContext) {
    load_fonts(cx);
    let mut window = cx.add_empty_window();
    let view = window
        .replace_root_view(|_, _| Recordings {
            scroll: UniformListScrollHandle::new(),
            frame: 0,
        })
        .expect("root view");
    window.run_until_idle();
    window.app_context().bench_renderer(view, |view, _, cx| {
        view.frame += 1;
        let y = (view.frame * 7 % 200_000) as f32;
        view.scroll
            .0
            .borrow()
            .base_handle
            .set_offset(point(px(0.), px(-y)));
        cx.notify();
    });
}

/// Pointer moves across a grid of hoverable cards; every move changes the
/// hovered card, so each one dispatches through every mouse listener, hit
/// tests every hitbox and redraws.
fn hover_cards(cx: &mut BenchAppContext) {
    load_fonts(cx);
    let mut window = cx.add_empty_window();
    window
        .replace_root_view(|_, _| Cards { count: 256 })
        .expect("root view");
    window.run_until_idle();
    let handle = window.window_handle();
    let mut step = 0usize;
    window.app_context().bench_iter(move |cx| {
        step += 1;
        // Alternate between the centres of the first cards of two rows.
        let x = 16. + 90. + (step % 8) as f32 * 188.;
        let y = 16. + 32. + (step % 2) as f32 * 72.;
        cx.update(|cx| {
            handle
                .update(cx, |_, window, cx| {
                    window.dispatch_event(
                        PlatformInput::MouseMove(MouseMoveEvent {
                            position: point(px(x), px(y)),
                            pressed_button: None,
                            modifiers: Default::default(),
                        }),
                        cx,
                    );
                })
                .ok();
        });
        cx.update(|cx| {
            handle
                .update(cx, |_, window, _| window.present_if_needed())
                .ok();
        });
    });
}

struct Panel {
    ix: usize,
    value: u64,
}

impl Render for Panel {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .p_2()
            .flex()
            .flex_col()
            .gap_1()
            .rounded_md()
            .border_1()
            .border_color(rgb(0x2a2a33))
            .bg(rgb(0x1b1b22))
            .child(TITLES[self.ix % TITLES.len()])
            .children((0..5).map(|row| {
                div()
                    .flex()
                    .gap_2()
                    .child(
                        div()
                            .w(px(80.))
                            .child(DETAILS[(self.ix + row) % DETAILS.len()]),
                    )
                    .child(SharedString::from(format!("{}", self.value + row as u64)))
            }))
    }
}

struct Panels {
    panels: Vec<Entity<Panel>>,
}

impl Render for Panels {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .flex_wrap()
            .gap_2()
            .p_4()
            .bg(rgb(0x101014))
            .text_color(rgb(0xf0f0f5))
            .font_family(FONT)
            .text_size(px(12.))
            .children(self.panels.iter().map(|panel| {
                AnyView::from(panel.clone())
                    .cached(StyleRefinement::default().w(px(220.)).h(px(140.)))
            }))
    }
}

/// Forty cached panels where one changes per frame: the view-cache reuse path
/// (`reuse_prepaint` / `reuse_paint`) that most interactive frames take.
fn cached_panels(cx: &mut BenchAppContext) {
    load_fonts(cx);
    let mut window = cx.add_empty_window();
    let panels: Vec<Entity<Panel>> = (0..40)
        .map(|ix| window.new(|_| Panel { ix, value: 0 }))
        .collect();
    window
        .replace_root_view({
            let panels = panels.clone();
            move |_, _| Panels { panels }
        })
        .expect("root view");
    window.run_until_idle();
    let mut step = 0usize;
    let handle = window.window_handle();
    window.app_context().bench_iter(move |cx| {
        step += 1;
        let panel = panels[step % panels.len()].clone();
        cx.update(|cx| {
            panel.update(cx, |panel, cx| {
                panel.value += 1;
                cx.notify();
            });
        });
        cx.update(|cx| {
            handle
                .update(cx, |_, window, _| window.present_if_needed())
                .ok();
        });
    });
}

struct Primitives {
    quads: usize,
}

impl Render for Primitives {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let quads = self.quads;
        canvas(
            |_, _, _| (),
            move |bounds, _, window, _| {
                let columns = 64usize;
                let cell = size(
                    bounds.size.width / columns as f32,
                    bounds.size.height / (quads / columns).max(1) as f32,
                );
                let shadow = [BoxShadow {
                    color: gpui::hsla(0., 0., 0., 0.3),
                    offset: point(px(0.), px(1.)),
                    blur_radius: px(3.),
                    spread_radius: px(0.),
                    inset: false,
                }];
                for ix in 0..quads {
                    let origin = point(
                        bounds.origin.x + cell.width * (ix % columns) as f32,
                        bounds.origin.y + cell.height * (ix / columns) as f32,
                    );
                    let cell_bounds = Bounds::new(origin, cell);
                    if ix % 8 == 0 {
                        window.paint_drop_shadows(cell_bounds, Corners::all(px(4.)), &shadow);
                    }
                    window.paint_quad(quad(
                        cell_bounds,
                        px(4.),
                        rgb(PALETTE[ix % PALETTE.len()]),
                        px(1.),
                        rgb(0x2a2a33),
                        BorderStyle::Solid,
                    ));
                    if ix % 16 == 0 {
                        let mut path = PathBuilder::fill();
                        path.move_to(origin);
                        path.line_to(point(origin.x + cell.width, origin.y));
                        path.line_to(point(origin.x, origin.y + cell.height));
                        path.close();
                        if let Ok(path) = path.build() {
                            window.paint_path(path, rgb(0xffffff));
                        }
                    }
                }
            },
        )
        .size_full()
    }
}

/// Thousands of quads, shadows and paths painted straight from a canvas:
/// scene insertion, sorting, batching and (on macOS) GPU submission.
fn primitives(quads: usize, cx: &mut BenchAppContext) {
    let mut window = cx.add_empty_window();
    let view = window
        .replace_root_view(|_, _| Primitives { quads })
        .expect("root view");
    window.run_until_idle();
    window
        .app_context()
        .bench_renderer(view, |_, _, cx| cx.notify());
}

// One benchmark per size: GPUI's frame report (the `Window::draw` histogram)
// covers one benchmark function, so separate functions keep each size's frame
// cost apart.

fn cards_64(cx: &mut BenchAppContext) {
    cards(64, cx);
}

fn cards_256(cx: &mut BenchAppContext) {
    cards(256, cx);
}

fn cards_1024(cx: &mut BenchAppContext) {
    cards(1024, cx);
}

fn text_rows_static_50(cx: &mut BenchAppContext) {
    text_rows_static(50, cx);
}

fn text_rows_static_200(cx: &mut BenchAppContext) {
    text_rows_static(200, cx);
}

fn text_rows_changing_50(cx: &mut BenchAppContext) {
    text_rows_changing(50, cx);
}

fn text_rows_changing_200(cx: &mut BenchAppContext) {
    text_rows_changing(200, cx);
}

fn paragraphs_12(cx: &mut BenchAppContext) {
    paragraphs(12, cx);
}

fn paragraphs_48(cx: &mut BenchAppContext) {
    paragraphs(48, cx);
}

fn primitives_1024(cx: &mut BenchAppContext) {
    primitives(1024, cx);
}

fn primitives_8192(cx: &mut BenchAppContext) {
    primitives(8192, cx);
}

/// Frames hashed per benchmark when `GPUI_SCENE_DIGEST` is set; enough to
/// cover the warm-up frames every run draws, whatever Criterion's timing.
const DIGEST_FRAMES: usize = 64;

/// Wraps the platform's headless renderer and hashes each scene it submits.
struct SceneDigestRenderer {
    inner: Box<dyn PlatformHeadlessRenderer>,
    benchmark: &'static str,
    path: PathBuf,
    frames: usize,
}

impl SceneDigestRenderer {
    fn digest(scene: &Scene) -> u64 {
        let mut hasher = DefaultHasher::new();
        for list in [
            format!("{:?}", scene.shadows),
            format!("{:?}", scene.quads),
            format!("{:?}", scene.paths),
            format!("{:?}", scene.underlines),
            format!("{:?}", scene.monochrome_sprites),
            format!("{:?}", scene.subpixel_sprites),
            format!("{:?}", scene.polychrome_sprites),
            format!("{:?}", scene.surfaces),
            format!("{:?}", scene.backdrop_blurs),
        ] {
            list.hash(&mut hasher);
        }
        hasher.finish()
    }
}

impl PlatformHeadlessRenderer for SceneDigestRenderer {
    fn render_scene_to_image(
        &mut self,
        scene: &Scene,
        size: gpui::Size<DevicePixels>,
    ) -> anyhow::Result<image::RgbaImage> {
        self.inner.render_scene_to_image(scene, size)
    }

    fn render_scene(
        &mut self,
        scene: &Scene,
        size: gpui::Size<DevicePixels>,
    ) -> anyhow::Result<()> {
        if self.frames < DIGEST_FRAMES {
            let line = format!(
                "{} {:>3} {:016x}\n",
                self.benchmark,
                self.frames,
                Self::digest(scene)
            );
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)
                .and_then(|mut file| file.write_all(line.as_bytes()))
                .expect("failed to append to GPUI_SCENE_DIGEST");
        }
        self.frames += 1;
        self.inner.render_scene(scene, size)
    }

    fn sprite_atlas(&self) -> Arc<dyn PlatformAtlas> {
        self.inner.sprite_atlas()
    }
}

/// What `#[gpui::bench]` generates, plus the optional scene digest.
fn run(criterion: &mut Criterion, name: &'static str, benchmark: fn(&mut BenchAppContext)) {
    let report = BenchReport::default();
    let digest = std::env::var_os("GPUI_SCENE_DIGEST").map(PathBuf::from);
    criterion.bench_function(name, |bencher| {
        let digest = digest.clone();
        let factory: Box<dyn Fn() -> Option<Box<dyn PlatformHeadlessRenderer>>> =
            Box::new(move || {
                let inner = gpui_platform::current_headless_renderer()?;
                Some(match &digest {
                    Some(path) => Box::new(SceneDigestRenderer {
                        inner,
                        benchmark: name,
                        path: path.clone(),
                        frames: 0,
                    }) as Box<dyn PlatformHeadlessRenderer>,
                    None => inner,
                })
            });
        let mut cx = BenchAppContext::new_with_platform_and_report(
            gpui::bench_platform(
                Some(factory),
                gpui_platform::current_platform(true).text_system(),
            ),
            Some(name),
            bencher,
            report.clone(),
        );
        benchmark(&mut cx);
        cx.teardown();
    });
    report.print(Some(name));
}

fn benches(criterion: &mut Criterion) {
    run(criterion, "cards_64", cards_64);
    run(criterion, "cards_256", cards_256);
    run(criterion, "cards_1024", cards_1024);
    run(criterion, "text_rows_static_50", text_rows_static_50);
    run(criterion, "text_rows_static_200", text_rows_static_200);
    run(criterion, "text_rows_changing_50", text_rows_changing_50);
    run(criterion, "text_rows_changing_200", text_rows_changing_200);
    run(criterion, "paragraphs_12", paragraphs_12);
    run(criterion, "paragraphs_48", paragraphs_48);
    run(criterion, "recordings_scroll", recordings_scroll);
    run(criterion, "hover_cards", hover_cards);
    run(criterion, "cached_panels", cached_panels);
    run(criterion, "primitives_1024", primitives_1024);
    run(criterion, "primitives_8192", primitives_8192);
}

criterion::criterion_group!(frame_benches, benches);
criterion::criterion_main!(frame_benches);
