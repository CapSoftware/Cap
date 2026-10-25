use super::*;

pub(super) fn rows(count: usize) -> Vec<RecordingRow> {
    (0..count)
        .map(|index| RecordingRow {
            item: RecordingItem {
                path: PathBuf::from(format!("/library/recording-{index}.cap")),
                mode: if index % 3 == 0 {
                    RecordingMode::Instant
                } else {
                    RecordingMode::Studio
                },
                status: library::RecordingStatus::Complete,
                upload: None,
                clip_count: (index % 4 + 1) as u32,
                pretty_name: format!("Recording {index}: weekly product walkthrough"),
                sharing: Some(format!("https://cap.so/s/recording-{index}")),
                sort_time_millis: index as f64 * 60_000.,
                thumbnail: None,
                thumbnail_version: None,
            },
            thumbnail: (index % 5 != 0).then(|| {
                Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(
                    image::RgbaImage::from_pixel(256, 144, image::Rgba([80, 110, 150, 255])),
                )]))
            }),
            thumbnail_stale: false,
        })
        .collect()
}

#[cfg(test)]
#[gpui::test]
#[ignore = "manual library frame benchmark"]
fn benchmark_library_frames(cx: &mut gpui::TestAppContext) {
    cx.update(|cx| {
        SignIn::init(cx);
        crate::theme::init(AppTheme::Light, cx);
    });
    let handle = cx.open_window(
        gpui::size(px(SETTINGS_WIDTH), px(SETTINGS_HEIGHT)),
        |window, cx| SettingsWindow::new(Page::Recordings, window, cx),
    );
    for count in [20, 200, 500, 1000] {
        handle
            .update(cx, |view, _, cx| {
                view.recordings.items = Some(rows(count));
                view.recordings.search = "Recording".into();
                cx.notify();
            })
            .unwrap();
        for scrolling in [false, true] {
            let mut samples = Vec::new();
            for iteration in 0..120 {
                let elapsed = cx.update(|cx| frame(handle, iteration, scrolling, cx));
                if iteration >= 20 {
                    samples.push(elapsed.as_secs_f64() * 1e6);
                }
            }
            crate::draw_bench::report(
                "library-bench",
                &format!(
                    "{count} recordings {}",
                    if scrolling { "scroll" } else { "hover" }
                ),
                &mut samples,
            );
        }
    }
}

fn frame(
    handle: gpui::WindowHandle<SettingsWindow>,
    iteration: usize,
    scrolling: bool,
    cx: &mut gpui::App,
) -> Duration {
    handle
        .update(cx, |_, window, cx| {
            let position = gpui::point(px(400. + (iteration % 90) as f32), px(400.));
            window.dispatch_event(
                gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                    position,
                    ..Default::default()
                }),
                cx,
            );
            if scrolling || iteration == 0 {
                window.dispatch_event(
                    gpui::PlatformInput::ScrollWheel(gpui::ScrollWheelEvent {
                        position,
                        delta: gpui::ScrollDelta::Pixels(gpui::point(
                            px(0.),
                            px(if iteration == 0 { 1_000_000. } else { -43. }),
                        )),
                        ..Default::default()
                    }),
                    cx,
                );
            }
            window.refresh();
        })
        .unwrap();
    crate::draw_bench::timed_draw(handle.into(), cx).unwrap()
}

pub(crate) fn run(handle: gpui::WindowHandle<SettingsWindow>, cx: &mut gpui::App) {
    if !std::env::var("CAP_GPUI_AUTO_LIBRARY_BENCH").is_ok_and(|value| value == "1") {
        return;
    }
    cx.spawn(async move |cx| {
        cx.background_executor().timer(Duration::from_secs(3)).await;
        for count in [20, 200, 500, 1000] {
            handle
                .update(cx, |view, window, cx| {
                    for row in view.recordings.items.take().into_iter().flatten() {
                        if let Some(image) = row.thumbnail {
                            let _ = window.drop_image(image);
                        }
                    }
                    view.recordings.items = Some(rows(count));
                    view.recordings.search = "Recording".into();
                    cx.notify();
                })
                .unwrap();
            for scrolling in [false, true] {
                let mut samples = Vec::new();
                for iteration in 0..120 {
                    cx.background_executor()
                        .timer(Duration::from_millis(16))
                        .await;
                    let elapsed = cx.update(|cx| frame(handle, iteration, scrolling, cx));
                    if iteration >= 20 {
                        samples.push(elapsed.as_secs_f64() * 1e6);
                    }
                }
                crate::draw_bench::report(
                    "library-bench",
                    &format!(
                        "{count} recordings {}",
                        if scrolling { "scroll" } else { "hover" }
                    ),
                    &mut samples,
                );
            }
        }
        cx.update(|cx| cx.quit());
    })
    .detach();
}
