use std::time::{Duration, Instant};

use cap_notes::{Block, BlockId, BlockKind, Change, Document, Mark, Pos, Selection, Span};
use cap_notes_ui::{NotesEditor, NotesLabels, NotesTheme, bind_keys};
use gpui::{
    App, AppContext, AsyncApp, Bounds, Context, Entity, EntityInputHandler, Focusable, IntoElement,
    Render, Window, WindowBounds, WindowHandle, WindowOptions, div, prelude::*, px, size,
};
use gpui_platform::application;

const WORDS: &[&str] = &[
    "the",
    "quiet",
    "notes",
    "editor",
    "keeps",
    "every",
    "block",
    "in",
    "its",
    "own",
    "layout",
    "so",
    "typing",
    "stays",
    "instant",
    "while",
    "scrolling",
    "through",
    "ten",
    "thousand",
    "lines",
    "of",
    "meeting",
    "minutes",
    "and",
    "decisions",
];

struct Root {
    editor: Entity<NotesEditor>,
}

impl Render for Root {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(self.editor.clone())
    }
}

fn sentence(seed: &mut u64, words: usize) -> String {
    let mut out = String::new();
    for i in 0..words {
        *seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let word = WORDS[(*seed >> 33) as usize % WORDS.len()];
        if i > 0 {
            out.push(' ');
        }
        out.push_str(word);
    }
    out
}

fn generate(count: usize) -> Document {
    let mut seed = 7u64;
    let blocks = (0..count)
        .map(|i| {
            let id = BlockId(i as u64 + 1);
            let kind = match i % 40 {
                0 => BlockKind::Heading(1 + (i / 40 % 3) as u8),
                5..=8 => BlockKind::Bullet,
                12..=14 => BlockKind::Ordered,
                20 | 21 => BlockKind::Task {
                    checked: i % 2 == 0,
                },
                27 => BlockKind::Quote,
                33 => BlockKind::Code {
                    language: "rust".into(),
                },
                38 => BlockKind::Rule,
                _ => BlockKind::Paragraph,
            };
            let text = match kind {
                BlockKind::Rule => String::new(),
                BlockKind::Code { .. } => format!(
                    "fn block_{i}() {{\n    let value = {i};\n    println!(\"{{value}}\");\n}}"
                ),
                BlockKind::Heading(_) => sentence(&mut seed, 4),
                _ => sentence(&mut seed, 8 + (i * 7) % 40),
            };
            let mut block = Block::new(id, kind, text);
            if block.kind.takes_marks() && block.text.len() > 20 && i % 3 == 0 {
                block = block.with_spans(vec![
                    Span {
                        range: 0..5,
                        mark: Mark::Bold,
                    },
                    Span {
                        range: 10..18,
                        mark: Mark::Italic,
                    },
                ]);
            }
            block
        })
        .collect();
    Document::from_blocks(blocks)
}

fn rss_kb() -> u64 {
    std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.;
    }
    let index = ((sorted.len() as f64 - 1.) * p).round() as usize;
    sorted[index.min(sorted.len() - 1)]
}

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        0.
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    }
}

async fn next_paint(editor: &Entity<NotesEditor>, after: u64, cx: &mut AsyncApp) -> bool {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let frames = cx.read_entity(editor, |e, _| e.debug_stats().frame.frames);
        if frames > after {
            return true;
        }
        if Instant::now() > deadline {
            return false;
        }
        cx.background_executor()
            .timer(Duration::from_micros(250))
            .await;
    }
}

fn main() {
    let mut blocks = 10_000;
    let mut keystrokes = 2_000;
    let mut step = 450.;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--blocks" => blocks = args.next().and_then(|v| v.parse().ok()).unwrap_or(blocks),
            "--keystrokes" => {
                keystrokes = args
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(keystrokes)
            }
            "--scroll-step" => step = args.next().and_then(|v| v.parse().ok()).unwrap_or(step),
            other => eprintln!("unknown flag {other}"),
        }
    }
    application().run(move |cx: &mut App| {
        bind_keys(cx);
        let doc = generate(blocks);
        let rss_before_window = rss_kb();
        let opened = Instant::now();
        let bounds = Bounds::centered(None, size(px(900.), px(800.)), cx);
        let window: WindowHandle<Root> = cx
            .open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    ..Default::default()
                },
                |window, cx| {
                    let editor = cx.new(|cx| {
                        NotesEditor::new(doc, NotesTheme::light(), NotesLabels::default(), window, cx)
                    });
                    cx.new(|_| Root { editor })
                },
            )
            .expect("open window");
        let editor = window
            .update(cx, |root, window, cx| {
                let handle = root.editor.read(cx).focus_handle(cx);
                window.focus(&handle, cx);
                cx.activate(true);
                root.editor.clone()
            })
            .expect("root");
        cx.spawn(async move |cx| {
            if !next_paint(&editor, 0, cx).await {
                eprintln!("no first paint");
            }
            let first_paint = cx
                .read_entity(&editor, |e, _| e.debug_stats().frame.last_paint_end)
                .map(|end| end.saturating_duration_since(opened))
                .unwrap_or_default();
            let rss_start = rss_kb();

            let middle = blocks / 2;
            let target = (middle..blocks)
                .find(|i| {
                    cx.read_entity(&editor, |e, _| {
                        e.document().blocks[*i].kind == BlockKind::Paragraph
                    })
                })
                .unwrap_or(middle);
            editor.update(cx, |e, cx| {
                e.apply(
                    |ed| {
                        ed.set_selection(Selection::caret(Pos::new(target, 12)));
                        Change::default()
                    },
                    cx,
                );
            });
            let frames = cx.read_entity(&editor, |e, _| e.debug_stats().frame.frames);
            next_paint(&editor, frames, cx).await;
            cx.background_executor()
                .timer(Duration::from_millis(200))
                .await;

            let mut latencies = Vec::with_capacity(keystrokes);
            let mut walls = Vec::with_capacity(keystrokes);
            let mut inputs = Vec::with_capacity(keystrokes);
            let mut shaped_per_key = Vec::with_capacity(keystrokes);
            let letters = "abcdefghijklmnopqrstuvwxyz";
            for i in 0..keystrokes {
                let ch = if i % 6 == 5 {
                    " ".to_string()
                } else {
                    letters[i % 26..i % 26 + 1].to_string()
                };
                let before = cx.read_entity(&editor, |e, _| e.debug_stats().frame);
                let t0 = Instant::now();
                let input = window
                    .update(cx, |root, window, cx| {
                        root.editor.update(cx, |e, cx| {
                            let start = Instant::now();
                            e.replace_text_in_range(None, &ch, window, cx);
                            start.elapsed()
                        })
                    })
                    .unwrap_or_default();
                if !next_paint(&editor, before.frames, cx).await {
                    eprintln!("keystroke {i} never painted");
                    continue;
                }
                let after = cx.read_entity(&editor, |e, _| e.debug_stats().frame);
                let frame = after.last_frame;
                let wall = after
                    .last_paint_end
                    .map(|end| end.saturating_duration_since(t0))
                    .unwrap_or_default();
                inputs.push(input.as_secs_f64() * 1000.);
                latencies.push((input + frame).as_secs_f64() * 1000.);
                walls.push(wall.as_secs_f64() * 1000.);
                shaped_per_key.push((after.shaped_blocks - before.shaped_blocks) as f64);
            }
            let rss_after_typing = rss_kb();

            let mut scroll_frames: Vec<Vec<f64>> = Vec::new();
            let mut rss_after_pass = Vec::new();
            for _pass in 0..2 {
                editor.update(cx, |e, cx| e.scroll_to_block(0, cx));
                let frames = cx.read_entity(&editor, |e, _| e.debug_stats().frame.frames);
                next_paint(&editor, frames, cx).await;
                let mut times = Vec::new();
                loop {
                    let before = cx.read_entity(&editor, |e, _| e.debug_stats().frame.frames);
                    let at_end = editor.update(cx, |e, cx| e.debug_scroll_by(step, cx));
                    if !next_paint(&editor, before, cx).await {
                        break;
                    }
                    let frame = cx.read_entity(&editor, |e, _| e.debug_stats().frame.last_frame);
                    times.push(frame.as_secs_f64() * 1000.);
                    if at_end {
                        break;
                    }
                }
                scroll_frames.push(times);
                rss_after_pass.push(rss_kb());
            }

            let live = cx.read_entity(&editor, |e, _| e.debug_stats().frame.live_layouts);
            let mut sorted = latencies.clone();
            sorted.sort_by(f64::total_cmp);
            let mut sorted_walls = walls.clone();
            sorted_walls.sort_by(f64::total_cmp);
            let max_shaped = shaped_per_key.iter().copied().fold(0., f64::max);
            println!("notes_bench: {blocks} blocks, {keystrokes} keystrokes");
            println!("time to first paint: {:.1} ms", first_paint.as_secs_f64() * 1000.);
            println!(
                "keystroke to paint (insert_text + the next frame's render, layout, prepaint and paint): mean {:.3} ms, p50 {:.3} ms, p99 {:.3} ms, max {:.3} ms",
                mean(&latencies),
                percentile(&sorted, 0.5),
                percentile(&sorted, 0.99),
                sorted.last().copied().unwrap_or(0.)
            );
            println!("  of which insert_text alone: mean {:.3} ms", mean(&inputs));
            println!(
                "keystroke wall clock from insert to end of paint: mean {:.3} ms, p99 {:.3} ms",
                mean(&walls),
                percentile(&sorted_walls, 0.99)
            );
            println!(
                "blocks shaped per keystroke: mean {:.2}, max {}",
                mean(&shaped_per_key),
                max_shaped
            );
            for (pass, times) in scroll_frames.iter().enumerate() {
                let mut sorted = times.clone();
                sorted.sort_by(f64::total_cmp);
                println!(
                    "scroll pass {}: {} frames, mean {:.3} ms, p99 {:.3} ms, max {:.3} ms",
                    pass + 1,
                    times.len(),
                    mean(times),
                    percentile(&sorted, 0.99),
                    sorted.last().copied().unwrap_or(0.)
                );
            }
            println!(
                "rss: before window {} MB, after first paint {} MB, after typing {} MB, after scroll 1 {} MB, after scroll 2 {} MB",
                rss_before_window / 1024,
                rss_start / 1024,
                rss_after_typing / 1024,
                rss_after_pass.first().copied().unwrap_or(0) / 1024,
                rss_after_pass.get(1).copied().unwrap_or(0) / 1024,
            );
            println!("live block layouts at end: {live}");
            cx.update(|cx| cx.quit());
        })
        .detach();
    });
}
