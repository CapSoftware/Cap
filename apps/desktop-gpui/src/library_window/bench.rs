//! `CAP_GPUI_LIBRARY_BENCH=window|panel`: timed draws for the perf gate, then
//! quit. `window` drives the Library window; `panel` drives today's Library
//! panel in the main window on the same data. Each step is one synchronous
//! draw (`draw_bench::timed_draw`), the same measure the notes window's
//! benches use, so numbers compare across them.

use std::time::{Duration, Instant};

use gpui::{AnyWindowHandle, App, AsyncApp, px};

use super::{KindView, Layout, LibraryWindow, LibraryWindowSlot, Section, text};
use crate::draw_bench::{report, timed_draw};

const PREFIX: &str = "library-bench";

async fn sleep(cx: &mut AsyncApp, ms: u64) {
    cx.background_executor()
        .timer(Duration::from_millis(ms))
        .await;
}

fn window(cx: &App) -> Option<AnyWindowHandle> {
    cx.try_global::<LibraryWindowSlot>().and_then(|s| s.0)
}

fn with_view<R>(
    cx: &mut AsyncApp,
    f: impl FnOnce(&mut LibraryWindow, &mut gpui::Context<LibraryWindow>) -> R,
) -> Option<R> {
    cx.update(|cx| {
        let handle = window(cx)?;
        handle
            .update(cx, |root, _, cx| {
                root.downcast::<LibraryWindow>()
                    .ok()
                    .map(|view| view.update(cx, f))
            })
            .ok()
            .flatten()
    })
}

fn draw(cx: &mut AsyncApp) -> Option<f64> {
    cx.update(|cx| {
        let handle = window(cx)?;
        timed_draw(handle, cx).map(|d| d.as_secs_f64() * 1e6)
    })
}

/// The bench saves smart folders into the Library it opens, so it runs only
/// on a profile given with `CAP_GPUI_APP_DATA_DIR`, never the person's own.
fn runs_on(app_data_dir: Option<&str>) -> bool {
    app_data_dir.is_some_and(|dir| !dir.trim().is_empty())
}

pub fn run_from_env(cx: &mut App) {
    let Ok(kind) = std::env::var("CAP_GPUI_LIBRARY_BENCH") else {
        return;
    };
    if !runs_on(std::env::var("CAP_GPUI_APP_DATA_DIR").ok().as_deref()) {
        eprintln!("{PREFIX}: skipped, CAP_GPUI_APP_DATA_DIR must name a scratch profile");
        return;
    }
    cx.spawn(async move |cx| {
        match kind.as_str() {
            "panel" => panel(cx).await,
            "switch" => switching(cx).await,
            "toggle-loop" => toggle_loop(cx).await,
            "scroll-all" => scroll_all(cx).await,
            "rescan" => rescan(cx).await,
            _ => library(cx).await,
        }
        sleep(cx, 200).await;
        println!("{PREFIX}: done");
        cx.update(|cx| cx.quit());
    })
    .detach();
}

async fn wait_for_items(cx: &mut AsyncApp) -> Option<f64> {
    let started = Instant::now();
    for _ in 0..2000 {
        let ready = with_view(cx, |view, _| {
            !view.scan.items.is_empty() && view.load_task.is_none()
        })
        .unwrap_or(false);
        if ready {
            return Some(started.elapsed().as_secs_f64() * 1e3);
        }
        sleep(cx, 10).await;
    }
    None
}

async fn library(cx: &mut AsyncApp) {
    if wait_for_items(cx).await.is_none() {
        println!("{PREFIX}: no items, giving up");
        return;
    }
    // Cold open: process start to the first frame drawn with items in it.
    if let Some(opened) = with_view(cx, |view, _| view.opened_at) {
        draw(cx);
        println!(
            "{PREFIX}: open-to-content {:.1} ms (items {})",
            opened.elapsed().as_secs_f64() * 1e3,
            with_view(cx, |v, _| v.scan.items.len()).unwrap_or(0)
        );
    }
    sleep(cx, 300).await;

    for layout in [Layout::List, Layout::Grid] {
        let name = layout.slug();
        for (label, section) in [
            ("home", Section::Home),
            ("screenshots", Section::Kind(KindView::Screenshots)),
            ("notes", Section::Kind(KindView::Notes)),
        ] {
            with_view(cx, |view, cx| {
                view.set_layout(layout, cx);
                view.show(section.clone(), cx);
            });
            draw(cx);
            sleep(cx, 150).await;
            let mut samples = Vec::new();
            for i in 0..240 {
                let step = if (i / 60) % 2 == 0 { 40. } else { -40. };
                with_view(cx, |view, cx| {
                    let handle = match (&view.section, view.layout) {
                        (Section::Home, Layout::Grid) => view.home_scroll[0].clone(),
                        (Section::Home, Layout::List) => view.home_scroll[1].clone(),
                        (_, Layout::List) => view.list_scroll.0.borrow().base_handle.clone(),
                        (_, Layout::Grid) => view.grid_scroll.0.borrow().base_handle.clone(),
                    };
                    let offset = handle.offset();
                    let max = handle.max_offset();
                    let y = (offset.y - px(step)).min(px(0.)).max(-max.y);
                    handle.set_offset(gpui::point(offset.x, y));
                    cx.notify();
                });
                if let Some(us) = draw(cx)
                    && i >= 20
                {
                    samples.push(us);
                }
                sleep(cx, 4).await;
            }
            report(PREFIX, &format!("scroll-{label}-{name}"), &mut samples);
        }
    }

    // Each direction on its own too: the two pages cost differently, so the
    // mixed p50 sits between two clusters.
    let mut samples = Vec::new();
    let mut to = [Vec::new(), Vec::new()];
    for i in 0..40 {
        let started = Instant::now();
        with_view(cx, |view, cx| {
            view.set_layout(
                if i % 2 == 0 {
                    Layout::Grid
                } else {
                    Layout::List
                },
                cx,
            )
        });
        draw(cx);
        let us = started.elapsed().as_secs_f64() * 1e6;
        samples.push(us);
        to[i % 2].push(us);
        sleep(cx, 20).await;
    }
    report(PREFIX, "layout-switch", &mut samples);
    report(PREFIX, "layout-to-magazine", &mut to[0]);
    report(PREFIX, "layout-to-list", &mut to[1]);

    let sections: Vec<Section> = with_view(cx, |view, _| {
        let mut out = vec![
            Section::Home,
            Section::Kind(KindView::Recordings),
            Section::Kind(KindView::Screenshots),
            Section::Kind(KindView::Notes),
            Section::Pinned,
        ];
        out.extend(
            view.file
                .smart_folders
                .iter()
                .map(|f| Section::Smart(f.id.clone())),
        );
        out.extend(
            view.scan
                .folders
                .iter()
                .map(|f| Section::Folder(f.id.clone())),
        );
        out
    })
    .unwrap_or_default();
    let mut samples = Vec::new();
    for i in 0..40 {
        let section = sections[i % sections.len().max(1)].clone();
        let started = Instant::now();
        with_view(cx, |view, cx| view.show(section, cx));
        draw(cx);
        samples.push(started.elapsed().as_secs_f64() * 1e6);
        sleep(cx, 20).await;
    }
    report(PREFIX, "section-switch", &mut samples);

    // Search as typed: each key folds the query, filters every item and draws.
    with_view(cx, |view, cx| view.show(Section::Home, cx));
    let mut samples = Vec::new();
    for round in 0..4 {
        let word = ["settings dark", "roadmap planning", "ana", "pricing page"][round];
        for end in 1..=word.len() {
            let typed = &word[..end];
            let started = Instant::now();
            with_view(cx, |view, cx| {
                view.search
                    .update(cx, |input, cx| input.set_text(typed.to_string(), cx));
                view.query = text::fold(typed);
                view.refilter(cx);
            });
            draw(cx);
            samples.push(started.elapsed().as_secs_f64() * 1e6);
            sleep(cx, 30).await;
        }
        with_view(cx, |view, cx| {
            view.search
                .update(cx, |input, cx| input.set_text(String::new(), cx));
            view.query.clear();
            view.refilter(cx);
        });
        draw(cx);
    }
    report(PREFIX, "search-key", &mut samples);

    // Saving a smart folder: write the file, evaluate every item, draw.
    let mut samples = Vec::new();
    for i in 0..12 {
        let started = Instant::now();
        with_view(cx, |view, cx| {
            view.editor = None;
            view.bench_save_rule(&format!("bench {i}"), cx);
        });
        draw(cx);
        samples.push(started.elapsed().as_secs_f64() * 1e6);
        sleep(cx, 30).await;
    }
    report(PREFIX, "smart-save", &mut samples);

    // A full redraw at rest, for reference.
    let mut samples = Vec::new();
    for _ in 0..60 {
        cx.update(|cx| {
            if let Some(handle) = window(cx) {
                handle.update(cx, |_, window, _| window.refresh()).ok();
            }
        });
        if let Some(us) = draw(cx) {
            samples.push(us);
        }
        sleep(cx, 10).await;
    }
    report(PREFIX, "full-redraw", &mut samples);
}

/// Today's Library panel in the main window: tab switches, search keys and a
/// full redraw, on the same data.
async fn panel(cx: &mut AsyncApp) {
    use crate::main_window::{LibraryKind, Panel};
    let main = cx.update(|cx| cx.global::<crate::app_windows::AppWindows>().main);
    sleep(cx, 1500).await;
    let kinds = [
        LibraryKind::Recordings,
        LibraryKind::Screenshots,
        LibraryKind::Notes,
    ];
    let mut samples = Vec::new();
    for i in 0..30 {
        let started = Instant::now();
        cx.update(|cx| {
            main.update(cx, |view, window, cx| {
                view.open_panel(Panel::Library(kinds[i % 3]), window, cx)
            })
            .ok();
            timed_draw(main.into(), cx);
        });
        samples.push(started.elapsed().as_secs_f64() * 1e6);
        sleep(cx, 120).await;
    }
    report(PREFIX, "panel-tab-switch", &mut samples);

    cx.update(|cx| {
        main.update(cx, |view, window, cx| {
            view.open_panel(Panel::Library(LibraryKind::Screenshots), window, cx)
        })
        .ok();
    });
    sleep(cx, 1500).await;
    let mut samples = Vec::new();
    for round in 0..4 {
        let word = ["settings dark", "roadmap planning", "ana", "pricing page"][round];
        for end in 1..=word.len() {
            let typed = word[..end].to_string();
            let started = Instant::now();
            cx.update(|cx| {
                main.update(cx, |view, _, cx| view.bench_set_search(&typed, cx))
                    .ok();
                timed_draw(main.into(), cx);
            });
            samples.push(started.elapsed().as_secs_f64() * 1e6);
            sleep(cx, 30).await;
        }
        cx.update(|cx| {
            main.update(cx, |view, _, cx| view.bench_set_search("", cx))
                .ok();
        });
    }
    report(PREFIX, "panel-search-key", &mut samples);

    let mut samples = Vec::new();
    for _ in 0..60 {
        cx.update(|cx| {
            main.update(cx, |_, window, _| window.refresh()).ok();
            if let Some(d) = timed_draw(main.into(), cx) {
                samples.push(d.as_secs_f64() * 1e6);
            }
        });
        sleep(cx, 10).await;
    }
    report(PREFIX, "panel-full-redraw", &mut samples);
}

/// Section and layout switches only, many samples each, on fixed pages.
async fn switching(cx: &mut AsyncApp) {
    if wait_for_items(cx).await.is_none() {
        println!("{PREFIX}: no items, giving up");
        return;
    }
    sleep(cx, 500).await;
    let sections: Vec<Section> = with_view(cx, |view, _| {
        let mut out = vec![
            Section::Home,
            Section::Kind(KindView::Recordings),
            Section::Kind(KindView::Screenshots),
            Section::Kind(KindView::Notes),
            Section::Pinned,
        ];
        out.extend(
            view.file
                .smart_folders
                .iter()
                .map(|f| Section::Smart(f.id.clone())),
        );
        out.extend(
            view.scan
                .folders
                .iter()
                .map(|f| Section::Folder(f.id.clone())),
        );
        out
    })
    .unwrap_or_default();
    for layout in [Layout::List, Layout::Grid] {
        with_view(cx, |view, cx| view.set_layout(layout, cx));
        draw(cx);
        let mut samples = Vec::new();
        for i in 0..200 {
            let section = sections[i % sections.len().max(1)].clone();
            let started = Instant::now();
            with_view(cx, |view, cx| view.show(section, cx));
            draw(cx);
            samples.push(started.elapsed().as_secs_f64() * 1e6);
            sleep(cx, 15).await;
        }
        report(
            PREFIX,
            &format!("section-switch-{}", layout.slug()),
            &mut samples,
        );
    }
    for (label, section) in [
        ("home", Section::Home),
        ("screenshots", Section::Kind(KindView::Screenshots)),
        ("notes", Section::Kind(KindView::Notes)),
    ] {
        with_view(cx, |view, cx| {
            view.set_layout(Layout::List, cx);
            view.show(section.clone(), cx);
        });
        draw(cx);
        let mut to = [Vec::new(), Vec::new()];
        for i in 0..200 {
            let started = Instant::now();
            with_view(cx, |view, cx| {
                view.set_layout(
                    if i % 2 == 0 {
                        Layout::Grid
                    } else {
                        Layout::List
                    },
                    cx,
                )
            });
            draw(cx);
            to[i % 2].push(started.elapsed().as_secs_f64() * 1e6);
            sleep(cx, 15).await;
        }
        report(PREFIX, &format!("to-magazine-{label}"), &mut to[0]);
        report(PREFIX, &format!("to-list-{label}"), &mut to[1]);
    }
}

/// Layout toggling for 15 s on Screenshots, untimed, for a profiler.
async fn toggle_loop(cx: &mut AsyncApp) {
    if wait_for_items(cx).await.is_none() {
        return;
    }
    with_view(cx, |view, cx| {
        view.show(Section::Kind(KindView::Screenshots), cx)
    });
    println!("{PREFIX}: toggle loop start");
    let started = Instant::now();
    let mut switches = 0usize;
    for i in 0..100_000usize {
        if started.elapsed() >= Duration::from_secs(15) {
            break;
        }
        with_view(cx, |view, cx| {
            view.set_layout(
                if i % 2 == 0 {
                    Layout::Grid
                } else {
                    Layout::List
                },
                cx,
            )
        });
        draw(cx);
        switches += 1;
        sleep(cx, 5).await;
    }
    println!("{PREFIX}: toggle loop end ({switches} switches)");
}

/// Memory: every item drawn once in both layouts (Screenshots and Notes, down
/// and back up), then a quiet pause marked `settled` for an outside RSS read.
/// Coming back to the window (or a meeting changing the library) when
/// nothing on disk changed: main-thread time to take in the scan and its
/// visuals, then the next frame.
async fn rescan(cx: &mut AsyncApp) {
    if wait_for_items(cx).await.is_none() {
        println!("{PREFIX}: no items, giving up");
        return;
    }
    sleep(cx, 1500).await;
    let mut main = Vec::new();
    let mut frames = Vec::new();
    for _ in 0..24 {
        with_view(cx, |view, cx| {
            view.bench_main_us = 0.;
            view.reload(cx);
        });
        for _ in 0..500 {
            if with_view(cx, |view, _| view.load_task.is_none()).unwrap_or(true) {
                break;
            }
            sleep(cx, 5).await;
        }
        // Visuals from the cache land a moment after the scan.
        sleep(cx, 400).await;
        if let Some(us) = draw(cx) {
            frames.push(us);
        }
        if let Some(us) = with_view(cx, |view, _| view.bench_main_us) {
            main.push(us);
        }
    }
    report(PREFIX, "rescan-main", &mut main);
    report(PREFIX, "rescan-frame", &mut frames);
}

async fn scroll_all(cx: &mut AsyncApp) {
    if wait_for_items(cx).await.is_none() {
        println!("{PREFIX}: no items, giving up");
        return;
    }
    sleep(cx, 500).await;
    let mut samples = Vec::new();
    for layout in [Layout::List, Layout::Grid] {
        for section in [
            Section::Kind(KindView::Screenshots),
            Section::Kind(KindView::Notes),
        ] {
            with_view(cx, |view, cx| {
                view.set_layout(layout, cx);
                view.show(section.clone(), cx);
            });
            draw(cx);
            for down in [true, false] {
                for _ in 0..5000 {
                    let at_end = with_view(cx, |view, cx| {
                        let handle = match view.layout {
                            Layout::List => view.list_scroll.0.borrow().base_handle.clone(),
                            Layout::Grid => view.grid_scroll.0.borrow().base_handle.clone(),
                        };
                        let offset = handle.offset();
                        let max = handle.max_offset();
                        let step = if down { -px(240.) } else { px(240.) };
                        let y = (offset.y + step).min(px(0.)).max(-max.y);
                        handle.set_offset(gpui::point(offset.x, y));
                        cx.notify();
                        if down { y <= -max.y } else { y >= px(0.) }
                    })
                    .unwrap_or(true);
                    if let Some(us) = draw(cx) {
                        samples.push(us);
                    }
                    if at_end {
                        break;
                    }
                    sleep(cx, 2).await;
                }
            }
        }
    }
    report(PREFIX, "scroll-all", &mut samples);
    println!("{PREFIX}: settled");
    sleep(cx, 4000).await;
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_bench_never_runs_on_the_default_profile() {
        assert!(!super::runs_on(None));
        assert!(!super::runs_on(Some("  ")));
        assert!(super::runs_on(Some("/tmp/library-bench")));
    }
}
