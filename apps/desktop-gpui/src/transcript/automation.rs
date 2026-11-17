//! `CAP_GPUI_AUTO_TRANSCRIPT=<action>,...` drives the transcript panel for
//! screenshots, perf runs and export checks. Actions: `open`, `seed:<words>`,
//! `transcribe`, `select:<a>-<b>`, `delete`, `cleanup[:pauses]`, `fillers`,
//! `pauses`, `cuts:<n>`, `search:<query>`, `seek:<seconds>`, `play`, `stop`,
//! `wait:<ms>`, `scroll:<frames>`, `follow:<seconds>`, `undo`, `redo`,
//! `hover-cut`, `restore`, `dump:<path>`.

use std::time::{Duration, Instant};

use gpui::{AsyncApp, WindowHandle, px};

use super::WordSelection;
use crate::editor_window::EditorWindow;

const READY_TIMEOUT: Duration = Duration::from_secs(60);
const TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(1800);
const FRAME: Duration = Duration::from_millis(16);

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

async fn sleep(cx: &AsyncApp, duration: Duration) {
    cx.background_executor().timer(duration).await;
}

fn draw(handle: WindowHandle<EditorWindow>, cx: &mut AsyncApp) -> f64 {
    cx.update(|cx| crate::draw_bench::timed_draw(handle.into(), cx))
        .map_or(f64::NAN, ms)
}

fn seeded_captions(words: usize, duration: f64) -> cap_project::CaptionsData {
    const VOCABULARY: &[&str] = &[
        "today", "we", "are", "going", "to", "look", "at", "how", "the", "export", "settings",
        "work", "and", "why", "this", "timeline", "makes", "editing", "faster", "for", "everyone",
        "on", "team", "when", "you", "record", "a", "quick", "update",
    ];
    let step = ((duration - 1.0) / words.max(1) as f64).max(0.05);
    let mut out = Vec::with_capacity(words);
    let mut time = 0.5;
    for index in 0..words {
        let mut text = if index % 40 == 20 {
            "um,".to_string()
        } else {
            VOCABULARY[(index * 7 + index / 13) % VOCABULARY.len()].to_string()
        };
        if index % 13 == 12 {
            text.push('.');
        }
        let pause = if index % 13 == 12 { step * 0.6 } else { 0.0 };
        out.push(cap_project::CaptionWord {
            text,
            start: time as f32,
            end: (time + step * 0.7) as f32,
        });
        time += step + pause;
        if time > duration - 0.5 {
            break;
        }
    }
    cap_project::CaptionsData {
        segments: out
            .chunks(6)
            .enumerate()
            .map(|(index, chunk)| cap_project::CaptionSegment {
                id: format!("segment-{index}"),
                start: chunk[0].start,
                end: chunk[chunk.len() - 1].end,
                text: chunk
                    .iter()
                    .map(|word| word.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
                words: chunk.to_vec(),
            })
            .collect(),
        settings: Default::default(),
        source_timed: true,
    }
}

pub(crate) async fn run(handle: WindowHandle<EditorWindow>, cx: &mut AsyncApp) {
    let Ok(spec) = std::env::var("CAP_GPUI_AUTO_TRANSCRIPT") else {
        return;
    };
    let started = Instant::now();
    while !handle
        .update(cx, |view, _, _| {
            view.latest_frame.is_some() && view.project_ready()
        })
        .unwrap_or(false)
    {
        if started.elapsed() > READY_TIMEOUT {
            eprintln!("transcript-auto: the editor never became ready");
            return;
        }
        sleep(cx, Duration::from_millis(50)).await;
    }
    sleep(cx, Duration::from_millis(500)).await;

    for action in spec.split(',').map(str::trim).filter(|a| !a.is_empty()) {
        let (name, argument) = action.split_once(':').unwrap_or((action, ""));
        let started = Instant::now();
        let detail = handle.update(cx, |view, window, cx| -> String {
            match name {
                "open" => {
                    view.set_panel_tab(crate::editor_side_panel::PanelTab::Transcript, window, cx);
                    format!(
                        "{} words, {} paragraphs",
                        view.transcript
                            .doc
                            .as_ref()
                            .map_or(0, |doc| doc.words.len()),
                        view.transcript
                            .doc
                            .as_ref()
                            .map_or(0, |doc| doc.paragraphs.len())
                    )
                }
                "seed" => {
                    let words = argument.parse().unwrap_or(20_000);
                    let duration = view.total_duration();
                    let captions = seeded_captions(words, duration);
                    let count: usize = captions.segments.iter().map(|s| s.words.len()).sum();
                    view.edit_timeline_project(
                        |project| {
                            project.captions = Some(captions);
                            true
                        },
                        window,
                        cx,
                    );
                    format!("{count} words over {duration:.1}s")
                }
                "transcribe" => {
                    view.generate_transcript(false, window, cx);
                    String::new()
                }
                "select" => {
                    let (a, b) = argument.split_once('-').unwrap_or((argument, argument));
                    let (a, b) = (a.parse().unwrap_or(0), b.parse().unwrap_or(0));
                    view.transcript.selection = Some(WordSelection {
                        anchor: a,
                        focus: b,
                    });
                    view.transcript_reveal(a, false);
                    view.invalidate_transcript(cx);
                    format!("{a}-{b}")
                }
                "delete" => {
                    view.transcript_delete_selection(window, cx);
                    view.timeline_summary()
                }
                "cleanup" => {
                    view.transcript.cleanup.open = true;
                    view.transcript.cleanup.tab = if argument == "pauses" {
                        super::CleanupTab::Pauses
                    } else {
                        super::CleanupTab::Fillers
                    };
                    view.invalidate_transcript(cx);
                    String::new()
                }
                "fillers" => {
                    view.transcript_remove_fillers(window, cx);
                    view.timeline_summary()
                }
                "pauses" => {
                    view.transcript_shorten_pauses(window, cx);
                    view.timeline_summary()
                }
                "cuts" => {
                    let count = argument.parse().unwrap_or(500);
                    view.transcript_spread_cuts(count, window, cx);
                    view.timeline_summary()
                }
                "search" => {
                    view.transcript_open_search(window, cx);
                    if let Some(search) = &view.transcript.search {
                        let query = argument.to_string();
                        search
                            .input
                            .update(cx, |input, cx| input.set_text(query.clone(), cx));
                    }
                    view.transcript_search_changed(argument.to_string(), cx);
                    String::new()
                }
                "seek" => {
                    view.seek_to_time(argument.parse().unwrap_or(0.0), cx);
                    String::new()
                }
                "play" => {
                    if !view.playing {
                        view.toggle_play(window, cx);
                    }
                    String::new()
                }
                "stop" => {
                    view.stop_for_measurement(cx);
                    String::new()
                }
                "undo" => {
                    view.undo(window, cx);
                    view.timeline_summary()
                }
                "redo" => {
                    view.redo(window, cx);
                    view.timeline_summary()
                }
                "hover-cut" => {
                    view.transcript.hovered_cut = view
                        .transcript
                        .edl
                        .as_ref()
                        .filter(|edl| !edl.cut_runs.is_empty())
                        .map(|_| 0);
                    view.invalidate_transcript(cx);
                    String::new()
                }
                "restore" => {
                    let run = view
                        .transcript
                        .edl
                        .as_ref()
                        .and_then(|edl| edl.cut_runs.first().cloned());
                    if let Some(run) = run {
                        view.transcript_restore(run, window, cx);
                    }
                    view.timeline_summary()
                }
                "dump" => view.transcript_dump(argument),
                _ => String::new(),
            }
        });
        let action_ms = ms(started.elapsed());
        let Ok(detail) = detail else {
            return;
        };
        match name {
            "wait" => {
                sleep(cx, Duration::from_millis(argument.parse().unwrap_or(500))).await;
            }
            "transcribe" => {
                let started = Instant::now();
                while handle
                    .update(cx, |view, _, _| {
                        crate::transcription::ui_snapshot(&view.project_path).generating
                    })
                    .unwrap_or(false)
                {
                    if started.elapsed() > TRANSCRIBE_TIMEOUT {
                        break;
                    }
                    sleep(cx, Duration::from_millis(200)).await;
                }
                println!(
                    "transcript-auto: transcribe finished in {:.1}s",
                    started.elapsed().as_secs_f64()
                );
            }
            "scroll" => {
                let frames: usize = argument.parse().unwrap_or(240);
                let mut samples = Vec::with_capacity(frames);
                for frame in 0..frames {
                    sleep(cx, FRAME).await;
                    handle
                        .update(cx, |view, _, cx| {
                            let delta = if (frame / 120) % 2 == 0 { 60. } else { -60. };
                            view.transcript.list.scroll_by(px(delta));
                            view.invalidate_transcript(cx);
                        })
                        .ok();
                    samples.push(draw(handle, cx) * 1000.0);
                }
                crate::draw_bench::report("transcript-auto", "scroll draw", &mut samples);
                continue;
            }
            "follow" => {
                let seconds: f64 = argument.parse().unwrap_or(10.0);
                let frames = (seconds * 60.0) as usize;
                let mut samples = Vec::with_capacity(frames);
                for _ in 0..frames {
                    sleep(cx, FRAME).await;
                    samples.push(draw(handle, cx) * 1000.0);
                }
                crate::draw_bench::report(
                    "transcript-auto",
                    "playback draw (transcript open)",
                    &mut samples,
                );
                continue;
            }
            _ => {}
        }
        let draw_ms = draw(handle, cx);
        println!("transcript-auto: {action} {action_ms:.2}ms + draw {draw_ms:.2}ms {detail}");
    }
}

impl EditorWindow {
    fn transcript_spread_cuts(
        &mut self,
        count: usize,
        window: &mut gpui::Window,
        cx: &mut gpui::Context<Self>,
    ) {
        let (Some(doc), Some(edl)) = (self.transcript.doc.clone(), self.transcript.edl.clone())
        else {
            return;
        };
        let kept: Vec<usize> = (0..doc.words.len())
            .filter(|word| edl.is_kept(*word))
            .collect();
        if kept.len() < 3 || count == 0 {
            return;
        }
        let stride = (kept.len() / (count + 1)).max(2);
        let runs: Vec<_> = kept
            .iter()
            .skip(stride / 2)
            .step_by(stride)
            .take(count)
            .map(|word| *word..*word + 1)
            .collect();
        self.transcript_cut_runs(&runs, "transcript-spread-cuts", window, cx);
    }

    fn timeline_summary(&self) -> String {
        let clips = self
            .project
            .timeline
            .as_ref()
            .map_or(0, |timeline| timeline.segments.len());
        let kept = self.transcript.edl.as_ref().map_or(0, |edl| edl.kept_count);
        format!(
            "-> {clips} clips, {kept} words kept, {:.2}s",
            self.total_duration()
        )
    }

    fn transcript_dump(&self, path: &str) -> String {
        let (Some(doc), Some(edl)) = (&self.transcript.doc, &self.transcript.edl) else {
            return "no transcript".into();
        };
        let words: Vec<_> = doc
            .words
            .iter()
            .enumerate()
            .map(|(index, word)| {
                serde_json::json!({
                    "text": word.text,
                    "start": word.start,
                    "end": word.end,
                    "voiced_start": doc.voiced[index].start,
                    "voiced_end": doc.voiced[index].end,
                    "kept": edl.is_kept(index),
                    "output_start": edl.source_to_output(word.start),
                    "output_end": edl.source_to_output(word.end),
                })
            })
            .collect();
        let body = serde_json::json!({
            "duration": self.total_duration(),
            "clips": self.project.timeline.as_ref().map(|timeline| {
                timeline
                    .segments
                    .iter()
                    .map(|segment| (segment.recording_clip, segment.start, segment.end))
                    .collect::<Vec<_>>()
            }),
            "words": words,
            "energy": self.transcript.energy.is_some(),
            "silences": self.transcript.energy.as_ref().map(|energy| energy.silences().to_vec()),
            "pauses": self.transcript_pause_plan().iter().map(|pause| {
                serde_json::json!({
                    "after_word": pause.after_word,
                    "next_word": pause.next_word,
                    "length": pause.length,
                    "saves": pause.saves,
                    "cuts": pause.cuts,
                })
            }).collect::<Vec<_>>(),
        });
        match std::fs::write(path, serde_json::to_vec_pretty(&body).unwrap_or_default()) {
            Ok(()) => format!("wrote {path}"),
            Err(error) => format!("failed to write {path}: {error}"),
        }
    }
}
