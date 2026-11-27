use std::{
    path::Path,
    time::{Duration, Instant},
};

use cap_meetings::{
    library::{
        Attendee, AudioTrack, DOC_FILE, DocKind, DocMeta, ENHANCED_FILE, EventSnapshot, Library,
        MeetingDetails, NOTES_FILE, TRANSCRIPT_FILE, new_id,
    },
    transcript::{LogLine, Source, Utterance},
};
use cap_notes::{Document, Origin};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use gpui::{App, AsyncApp, WindowHandle, px, size};

use super::{pane::View, store::Scope, window::DocumentsWindow};
use crate::{
    meetings::{MeetingEvent, Meetings},
    meetings_ui::MeetingWindows,
};

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }

    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.below(items.len())]
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }
}

const PEOPLE: &[&str] = &[
    "Ana Ruiz",
    "Ben Okafor",
    "Chloé Martin",
    "Dev Patel",
    "Emi Tanaka",
    "Farah Haddad",
    "Gus Lindqvist",
    "Hana Kim",
    "Ivo Novak",
    "Jun Wei",
    "Kofi Mensah",
    "Lena Fischer",
];

const MEETING_TITLES: &[&str] = &[
    "Weekly product sync",
    "Design review: onboarding",
    "Roadmap planning",
    "Hiring debrief",
    "Q3 budget review",
    "Customer interview",
    "Bug triage",
    "Sprint retro",
    "Launch checklist",
    "Pricing discussion",
    "Infra cost review",
    "Partner check in",
    "Research readout",
    "Marketing standup",
    "Support escalation review",
];

const NOTE_TITLES: &[&str] = &[
    "Reading list",
    "Ideas for the landing page",
    "Interview questions",
    "Trip packing list",
    "Release notes draft",
    "Things to try in the editor",
    "Quarterly goals",
    "Recipe: miso soup",
    "Talk outline",
    "Onboarding checklist",
];

const APPS: &[&str] = &["Zoom", "Google Meet", "Microsoft Teams", "Slack"];

const SENTENCES: &[&str] = &[
    "Let's start with the numbers from last week.",
    "I think the onboarding flow is still too long for new teams.",
    "We could ship the smaller version first and learn from it.",
    "The export bug only shows up on older machines.",
    "Can you share the doc after the call?",
    "Support tickets went down after the last release.",
    "I'd like to see the designs before we commit to a date.",
    "Let's keep the scope tight and revisit in two weeks.",
    "The interviews all pointed at the same problem with search.",
    "We need someone to own the migration end to end.",
    "That sounds good to me.",
    "Pricing should stay simple, one plan for teams.",
    "Marketing wants a short video for the launch.",
    "I'll follow up with legal about the contract.",
    "The new hire starts on Monday, I'll pair with them.",
    "Latency is fine in Europe but slower in Asia.",
    "Let's write down the decision so we don't relitigate it.",
    "Agreed, let's move on to the next item.",
    "I can take that one.",
    "Do we have data on how many people use the shortcut?",
];

fn notes_markdown(rng: &mut Rng, title: &str) -> String {
    let mut md = String::new();
    if rng.chance(50) {
        md.push_str(&format!("## {title}\n\n"));
    }
    for _ in 0..(2 + rng.below(4)) {
        md.push_str(&format!("- {}\n", rng.pick(SENTENCES)));
    }
    if rng.chance(60) {
        md.push_str("\n### Follow ups\n\n");
        for _ in 0..(1 + rng.below(3)) {
            let done = if rng.chance(40) { "x" } else { " " };
            md.push_str(&format!("- [{done}] {}\n", rng.pick(SENTENCES)));
        }
    }
    if rng.chance(40) {
        md.push_str(&format!(
            "\n{} {}\n",
            rng.pick(SENTENCES),
            rng.pick(SENTENCES)
        ));
    }
    md
}

fn enhanced_markdown(rng: &mut Rng, people: &[String]) -> String {
    let who = |rng: &mut Rng| {
        people
            .get(rng.below(people.len().max(1)))
            .cloned()
            .unwrap_or_else(|| "You".into())
    };
    let mut md = String::from("### Summary\n\n");
    md.push_str(&format!(
        "{} {}\n\n",
        rng.pick(SENTENCES),
        rng.pick(SENTENCES)
    ));
    md.push_str("### Decisions\n\n");
    for _ in 0..(2 + rng.below(3)) {
        md.push_str(&format!("- {}\n", rng.pick(SENTENCES)));
    }
    md.push_str("\n### Action items\n\n");
    for _ in 0..(2 + rng.below(3)) {
        md.push_str(&format!("- [ ] {}: {}\n", who(rng), rng.pick(SENTENCES)));
    }
    md
}

fn transcript_lines(rng: &mut Rng, minutes: u64, speakers: usize) -> Vec<LogLine> {
    let mut lines = Vec::new();
    let mut t = 1_000u64;
    let end = minutes * 60_000;
    let mut n = 0;
    while t < end {
        let source = if rng.chance(45) {
            Source::Mic
        } else {
            Source::System
        };
        let speaker = (source == Source::System && speakers > 1)
            .then(|| format!("Speaker {}", 1 + rng.below(speakers)));
        let words = 1 + rng.below(3);
        let text: Vec<&str> = (0..words).map(|_| rng.pick(SENTENCES)).collect();
        let duration = 2_500 + rng.below(9_000) as u64;
        lines.push(LogLine::Upsert {
            utterance: Utterance {
                id: format!("u{n}"),
                source,
                speaker,
                speaker_id: None,
                start_ms: t,
                end_ms: t + duration,
                text: text.join(" "),
                is_final: true,
                words: Vec::new(),
            },
        });
        n += 1;
        t += duration + 500 + rng.below(4_000) as u64;
    }
    lines
}

pub fn seed(root: &Path, count: usize, audio: Option<&Path>) -> std::io::Result<usize> {
    let library = Library::open(root).map_err(|e| std::io::Error::other(e.to_string()))?;
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let now = Utc::now();
    let mut folders = Vec::new();
    for name in ["Work", "Hiring", "Personal", "Research"]
        .into_iter()
        .filter(|_| count > 0)
    {
        if let Ok(folder) = library.create_folder(name, None, now, rng.next()) {
            folders.push(folder.id);
        }
    }
    let mut made = 0;
    // CAP_GPUI_DOCS_CORPUS=<transcript.txt>|<notes.md>: one real meeting on
    // top, its lines ("Name: words") and summary from the eval corpus, so
    // linked sources can be seen on real text. CAP_GPUI_TX_REPEAT=<n> repeats
    // the lines n times for a long meeting.
    if let Some(spec) = env("CAP_GPUI_DOCS_CORPUS")
        && let Some((transcript, notes)) = spec.split_once('|')
    {
        let repeat = env("CAP_GPUI_TX_REPEAT")
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(1)
            .max(1);
        seed_corpus(
            &library,
            Path::new(transcript),
            Path::new(notes),
            repeat,
            now,
        )?;
        made += 1;
    }
    // CAP_GPUI_DOCS_LONG=<n>: every summary and set of typed notes repeated n
    // times (an hour-long meeting's worth at about 8), for typing benches.
    let long = env("CAP_GPUI_DOCS_LONG")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(1)
        .max(1);
    let mut at: DateTime<Utc> = now - ChronoDuration::minutes(25);
    for i in 0..count {
        let meeting = rng.chance(62);
        let kind = if meeting {
            DocKind::Meeting
        } else {
            DocKind::Note
        };
        let mut meta = DocMeta::new(new_id(at, rng.next()), kind.clone(), at);
        let Ok(dir) = library.doc_dir(&meta.id) else {
            continue;
        };
        std::fs::create_dir_all(&dir)?;
        let people: Vec<String> = (0..rng.below(5))
            .map(|_| rng.pick(PEOPLE).to_string())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        let title = if meeting {
            if rng.chance(20) && !people.is_empty() {
                format!("1:1 with {}", people[0].split(' ').next().unwrap_or(""))
            } else {
                rng.pick(MEETING_TITLES).to_string()
            }
        } else {
            rng.pick(NOTE_TITLES).to_string()
        };
        meta.title = if rng.chance(4) {
            String::new()
        } else {
            title.clone()
        };
        meta.title_is_auto = meeting && rng.chance(30);
        meta.created_at = at;
        meta.updated_at = at;
        meta.pinned = i < 40 && rng.chance(8);
        if rng.chance(25) {
            meta.folder_id = folders.get(rng.below(folders.len())).cloned();
        }
        if rng.chance(3) {
            meta.trashed_at = Some(at + ChronoDuration::days(1));
        }
        let notes = notes_markdown(&mut rng, &title).repeat(long);
        let mut has_audio = false;
        if meeting {
            let minutes = 20 + rng.below(71) as u64;
            let speakers = 1 + rng.below(3);
            let lines = transcript_lines(&mut rng, minutes, speakers);
            let chars: usize = lines
                .iter()
                .map(|l| match l {
                    LogLine::Upsert { utterance } => utterance.text.chars().count(),
                    _ => 0,
                })
                .sum();
            let mut jsonl = String::new();
            for line in &lines {
                jsonl.push_str(&serde_json::to_string(line).map_err(std::io::Error::other)?);
                jsonl.push('\n');
            }
            std::fs::write(dir.join(TRANSCRIPT_FILE), jsonl)?;
            let enhanced = rng.chance(70);
            has_audio = i == 7;
            let event = rng.chance(35).then(|| EventSnapshot {
                id: format!("event-{i}"),
                title: title.clone(),
                start: Some(at),
                end: Some(at + ChronoDuration::minutes(minutes as i64)),
                link: Some("https://meet.google.com/abc-defg-hij".into()),
                attendees: people
                    .iter()
                    .map(|p| Attendee {
                        name: Some(p.clone()),
                        email: Some(format!(
                            "{}@example.com",
                            p.split(' ').next().unwrap_or("x").to_lowercase()
                        )),
                        is_self: false,
                    })
                    .collect(),
                calendar_name: Some("Work".into()),
            });
            meta.meeting = Some(MeetingDetails {
                started_at: Some(at),
                ended_at: Some(at + ChronoDuration::minutes(minutes as i64)),
                duration_ms: minutes * 60_000,
                app_name: Some(rng.pick(APPS).to_string()),
                participants: if event.is_some() {
                    Vec::new()
                } else {
                    people.clone()
                },
                event,
                engine: Some("local:best".into()),
                language: Some("en".into()),
                transcript_chars: chars as u64,
                has_enhanced: enhanced,
                audio: if has_audio {
                    vec![
                        AudioTrack {
                            source: Source::Mic,
                            file: "audio/mic.ogg".into(),
                            codec: "opus".into(),
                            duration_ms: minutes * 60_000,
                        },
                        AudioTrack {
                            source: Source::System,
                            file: "audio/system.ogg".into(),
                            codec: "opus".into(),
                            duration_ms: minutes * 60_000,
                        },
                    ]
                } else {
                    Vec::new()
                },
                ..MeetingDetails::default()
            });
            meta.template_id = Some(cap_meetings::templates::DEFAULT_TEMPLATE_ID.into());
            if enhanced {
                let mut doc =
                    Document::from_markdown(&enhanced_markdown(&mut rng, &people).repeat(long));
                for block in &mut doc.blocks {
                    block.origin = Origin::Generated;
                }
                std::fs::write(dir.join(ENHANCED_FILE), doc.to_json())?;
            }
        }
        if !meeting || rng.chance(55) {
            let doc = Document::from_markdown(&notes);
            std::fs::write(dir.join(NOTES_FILE), doc.to_json())?;
        }
        std::fs::write(
            dir.join(DOC_FILE),
            serde_json::to_vec_pretty(&meta).map_err(std::io::Error::other)?,
        )?;
        if has_audio && let Some(audio) = audio {
            seed_audio(&library, &meta.id, audio);
        }
        made += 1;
        let gap = if rng.chance(70) {
            30 + rng.below(240)
        } else {
            600 + rng.below(1800)
        };
        at -= ChronoDuration::minutes(gap as i64);
    }
    Ok(made)
}

fn seed_corpus(
    library: &Library,
    transcript: &Path,
    notes: &Path,
    repeat: usize,
    now: DateTime<Utc>,
) -> std::io::Result<()> {
    let lines = std::fs::read_to_string(transcript)?;
    let markdown = std::fs::read_to_string(notes)?;
    let title = markdown
        .lines()
        .find_map(|l| l.strip_prefix("Title:"))
        .map(|t| t.trim().to_string())
        .unwrap_or_else(|| "Meeting".into());
    let summary: String = markdown
        .lines()
        .filter(|l| !l.starts_with("Title:"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut jsonl = String::new();
    let mut t = 1_000u64;
    let mut chars = 0usize;
    let mut n = 0usize;
    for _ in 0..repeat {
        for line in lines.lines() {
            let Some((who, text)) = line.split_once(": ") else {
                continue;
            };
            let words = text.split_whitespace().count() as u64;
            let duration = (words * 330).max(900);
            chars += text.chars().count();
            let entry = LogLine::Upsert {
                utterance: Utterance {
                    id: format!("c{n}"),
                    source: Source::System,
                    speaker: Some(who.trim().to_string()),
                    speaker_id: None,
                    start_ms: t,
                    end_ms: t + duration,
                    text: text.trim().to_string(),
                    is_final: true,
                    words: Vec::new(),
                },
            };
            jsonl.push_str(&serde_json::to_string(&entry).map_err(std::io::Error::other)?);
            jsonl.push('\n');
            t += duration + 400;
            n += 1;
        }
    }
    let at = now - ChronoDuration::minutes(5) - ChronoDuration::milliseconds(t as i64);
    let mut meta = DocMeta::new(new_id(at, 7), DocKind::Meeting, at);
    meta.title = title;
    meta.created_at = at;
    meta.updated_at = at;
    meta.template_id = Some(cap_meetings::templates::DEFAULT_TEMPLATE_ID.into());
    meta.meeting = Some(MeetingDetails {
        started_at: Some(at),
        ended_at: Some(at + ChronoDuration::milliseconds(t as i64)),
        duration_ms: t,
        engine: Some("local:best".into()),
        language: Some("en".into()),
        transcript_chars: chars as u64,
        has_enhanced: true,
        ..MeetingDetails::default()
    });
    let dir = library
        .doc_dir(&meta.id)
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join(TRANSCRIPT_FILE), jsonl)?;
    let mut doc = Document::from_markdown(&summary);
    for block in &mut doc.blocks {
        block.origin = Origin::Generated;
    }
    std::fs::write(dir.join(ENHANCED_FILE), doc.to_json())?;
    std::fs::write(
        dir.join(DOC_FILE),
        serde_json::to_vec_pretty(&meta).map_err(std::io::Error::other)?,
    )?;
    Ok(())
}

fn seed_audio(library: &Library, id: &str, from: &Path) {
    let Ok(dir) = library.audio_dir(id) else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let mut tracks = Vec::new();
    for (source, name) in [(Source::Mic, "mic.ogg"), (Source::System, "system.ogg")] {
        let src = from.join(name);
        if std::fs::copy(&src, dir.join(name)).is_ok() {
            let duration_ms = ffmpeg::format::input(&dir.join(name))
                .ok()
                .map(|input| {
                    (input.duration().max(0) as u64).saturating_mul(1000)
                        / ffmpeg::ffi::AV_TIME_BASE as u64
                })
                .unwrap_or(0);
            tracks.push(AudioTrack {
                source,
                file: format!("audio/{name}"),
                codec: "opus".into(),
                duration_ms,
            });
        }
    }
    if let Ok(mut meta) = library.load(id)
        && let Some(meeting) = meta.meeting.as_mut()
    {
        let longest = tracks.iter().map(|t| t.duration_ms).max().unwrap_or(0);
        meeting.audio = tracks;
        if longest > 0 {
            meeting.duration_ms = longest;
            meeting.ended_at = meeting
                .started_at
                .map(|s| s + ChronoDuration::milliseconds(longest as i64));
        }
        meta.title = "Audio playback demo".into();
        meta.title_is_auto = false;
        meta.pinned = true;
        meta.trashed_at = None;
        let _ = library.save(&meta);
    }
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn window(cx: &App) -> Option<WindowHandle<DocumentsWindow>> {
    cx.try_global::<MeetingWindows>()
        .and_then(|w| w.documents)
        .and_then(|h| h.downcast::<DocumentsWindow>())
}

async fn sleep(cx: &mut AsyncApp, ms: u64) {
    cx.background_executor()
        .timer(Duration::from_millis(ms))
        .await;
}

pub fn run_from_env(cx: &mut App) {
    let open = env("CAP_GPUI_DOCS_OPEN");
    let seed_count = env("CAP_GPUI_DOCS_SEED").and_then(|v| v.parse::<usize>().ok());
    if open.is_none() && seed_count.is_none() {
        return;
    }
    let root = crate::store::app_data_dir().join("documents");
    cx.spawn(async move |cx| {
        if let Some(count) = seed_count {
            let marker = root.join(".seeded");
            if !marker.exists() {
                let started = Instant::now();
                let audio = env("CAP_GPUI_DOCS_AUDIO_DIR");
                let target = root.clone();
                let made = cx
                    .background_executor()
                    .spawn(async move { seed(&target, count, audio.as_deref().map(Path::new)) })
                    .await;
                let _ = std::fs::write(&marker, b"1");
                tracing::info!(
                    ?made,
                    ms = started.elapsed().as_millis() as u64,
                    "documents seeded"
                );
            }
        }
        match open.as_deref() {
            Some("live") => {
                cx.update(open_on_recording);
            }
            Some(_) => {
                cx.update(|cx| super::open(env("CAP_GPUI_DOCS_DOC"), cx));
                drive(cx).await;
            }
            None => {}
        }
    })
    .detach();
}

fn open_on_recording(cx: &mut App) {
    let Some(meetings) = Meetings::try_global(cx) else {
        return;
    };
    cx.subscribe(&meetings, |_, event: &MeetingEvent, cx| {
        if let MeetingEvent::RecordingStarted { doc_id } = event {
            let id = doc_id.clone();
            super::open(Some(id), cx);
            cx.spawn(async move |cx| {
                sleep(cx, 1500).await;
                cx.update(|cx| {
                    if let Some(handle) = window(cx) {
                        handle
                            .update(cx, |root, _, cx| {
                                root.pane.update(cx, |pane, cx| pane.set_panel(true, cx))
                            })
                            .ok();
                    }
                });
            })
            .detach();
        }
    })
    .detach();
}

async fn wait_listed(cx: &mut AsyncApp) -> Option<WindowHandle<DocumentsWindow>> {
    for _ in 0..600 {
        let ready = cx.update(|cx| {
            window(cx).filter(|handle| {
                handle
                    .read(cx)
                    .map(|root| root.store.read(cx).listed)
                    .unwrap_or(false)
            })
        });
        if ready.is_some() {
            return ready;
        }
        sleep(cx, 20).await;
    }
    None
}

async fn drive(cx: &mut AsyncApp) {
    let Some(handle) = wait_listed(cx).await else {
        return;
    };
    sleep(cx, 300).await;
    if let Some(states) = env("CAP_GPUI_DOCS_STATE") {
        for state in states.split(',') {
            apply_state(state.trim(), handle, cx).await;
            sleep(cx, 150).await;
        }
    }
    if let Some(bench) = env("CAP_GPUI_DOCS_BENCH") {
        for kind in bench.split(',') {
            run_bench(kind.trim(), handle, cx).await;
        }
        if env("CAP_GPUI_DOCS_QUIT").is_some() {
            cx.update(|cx| cx.quit());
        }
    }
    println!("DOCS READY");
}

fn doc_id_at(root: &DocumentsWindow, index: usize, cx: &App) -> Option<String> {
    root.store
        .read(cx)
        .snapshot
        .docs
        .get(index)
        .map(|d| d.id.clone())
}

async fn apply_state(state: &str, handle: WindowHandle<DocumentsWindow>, cx: &mut AsyncApp) {
    let (name, arg) = state.split_once(':').unwrap_or((state, ""));
    let arg = arg.to_string();
    // `key:cmd-w` (`comma` for ",") and `click:135x26` (window px): real input
    // through the window's own dispatch, for harnesses where the OS cannot
    // give the window focus.
    if name == "wait" {
        sleep(cx, arg.parse().unwrap_or(1000)).await;
        return;
    }
    if name == "hover"
        && let Some((x, y)) = arg.split_once('x')
        && let (Ok(x), Ok(y)) = (x.parse::<f32>(), y.parse::<f32>())
    {
        let any: gpui::AnyWindowHandle = handle.into();
        cx.update(|cx| {
            any.update(cx, |_, window, cx| {
                window.dispatch_event(
                    gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                        position: gpui::point(gpui::px(x), gpui::px(y)),
                        pressed_button: None,
                        modifiers: gpui::Modifiers::default(),
                    }),
                    cx,
                );
                window.refresh();
            })
            .ok();
        });
        return;
    }
    if name == "key" || name == "click" {
        let any: gpui::AnyWindowHandle = handle.into();
        cx.update(|cx| {
            any.update(cx, |_, window, cx| {
                if name == "key" {
                    match gpui::Keystroke::parse(&arg.replace("comma", ",")) {
                        Ok(keystroke) => {
                            window.dispatch_keystroke(keystroke, cx);
                        }
                        Err(error) => tracing::warn!(%error, "bad key state"),
                    }
                } else if let Some((x, y)) = arg.split_once('x')
                    && let (Ok(x), Ok(y)) = (x.parse::<f32>(), y.parse::<f32>())
                {
                    let position = gpui::point(gpui::px(x), gpui::px(y));
                    window.dispatch_event(
                        gpui::PlatformInput::MouseDown(gpui::MouseDownEvent {
                            button: gpui::MouseButton::Left,
                            position,
                            modifiers: gpui::Modifiers::default(),
                            click_count: 1,
                            first_mouse: false,
                        }),
                        cx,
                    );
                    window.dispatch_event(
                        gpui::PlatformInput::MouseUp(gpui::MouseUpEvent {
                            button: gpui::MouseButton::Left,
                            position,
                            modifiers: gpui::Modifiers::default(),
                            click_count: 1,
                        }),
                        cx,
                    );
                }
            })
            .ok();
        });
        return;
    }
    cx.update(|cx| {
        handle
            .update(cx, |root, window, cx| match name {
                "select" => {
                    let id = arg
                        .parse::<usize>()
                        .ok()
                        .and_then(|i| doc_id_at(root, i, cx))
                        .or_else(|| {
                            let store = root.store.read(cx);
                            if arg == "trashed" {
                                return store.snapshot.trashed.first().map(|d| d.id.clone());
                            }
                            store
                                .snapshot
                                .docs
                                .iter()
                                .find(|d| d.title.contains(&arg) || d.id == arg)
                                .map(|d| d.id.clone())
                        });
                    root.store.update(cx, |s, cx| s.open(id, cx));
                }
                "kind" => {
                    let id = root
                        .store
                        .read(cx)
                        .snapshot
                        .docs
                        .iter()
                        .find(|d| match arg.as_str() {
                            "note" => d.kind == DocKind::Note && !d.title.is_empty(),
                            "meeting" => {
                                d.kind == DocKind::Meeting
                                    && d.meeting
                                        .as_ref()
                                        .is_some_and(|m| m.has_enhanced && m.event.is_some())
                            }
                            "plain-meeting" => {
                                d.kind == DocKind::Meeting
                                    && d.meeting
                                        .as_ref()
                                        .is_some_and(|m| !m.has_enhanced && m.transcript_chars > 0)
                            }
                            "audio" => d.meeting.as_ref().is_some_and(|m| !m.audio.is_empty()),
                            _ => false,
                        })
                        .map(|d| d.id.clone());
                    root.store.update(cx, |s, cx| s.open(id, cx));
                }
                "view" => match arg.as_str() {
                    "transcript" => root.pane.update(cx, |p, cx| p.set_panel(true, cx)),
                    "generated" => root
                        .pane
                        .update(cx, |p, cx| p.show_view(View::Generated, window, cx)),
                    _ => root
                        .pane
                        .update(cx, |p, cx| p.show_view(View::Mine, window, cx)),
                },
                "panel" => root.pane.update(cx, |p, cx| p.set_panel(true, cx)),
                "live" => root.pane.update(cx, |p, cx| p.debug_live(cx)),
                "cue" => root.pane.update(cx, |p, cx| p.debug_cue(cx)),
                "rename" | "renamed" => {
                    let (label, text) = arg.split_once('=').unwrap_or((arg.as_str(), ""));
                    let transcript = root.pane.read(cx).transcript.clone();
                    transcript.update(cx, |t, cx| {
                        t.debug_rename(label, text, name == "renamed", window, cx)
                    });
                }
                "picker" => root.pane.update(cx, |p, cx| p.debug_menu(&arg, cx)),
                "home" => root.show_home(Some(Scope::All), window, cx),
                "new" => root
                    .store
                    .update(cx, |s, cx| s.create(DocKind::Meeting, None, cx)),
                "events" => root.home.update(cx, |h, cx| h.debug_events(&arg, cx)),
                "search" => root
                    .home
                    .update(cx, |h, cx| h.debug_search(&arg, window, cx)),
                "menu" => root.home.update(cx, |h, cx| h.debug_menu(cx)),
                "start_menu" => {
                    if root.sidebar_open() {
                        root.sidebar.update(cx, |s, cx| s.debug_start_menu(cx))
                    } else {
                        root.home.update(cx, |h, cx| h.debug_start_menu(cx))
                    }
                }
                "start_choice" => super::start::remember(
                    if arg == "blank" {
                        super::start::StartChoice::Blank
                    } else {
                        super::start::StartChoice::Record
                    },
                    cx,
                ),
                "trash" => root.show_home(Some(Scope::Trash), window, cx),
                "pinned" => root.show_home(Some(Scope::Pinned), window, cx),
                "folder" => {
                    let folder = root
                        .store
                        .read(cx)
                        .snapshot
                        .folders
                        .first()
                        .map(|f| f.id.clone());
                    if let Some(folder) = folder {
                        root.show_home(Some(Scope::Folder(folder)), window, cx);
                    }
                }
                "multi" => root.home.update(cx, |h, cx| h.debug_multi(cx)),
                "sidebar" => {
                    if arg == "closed" {
                        root.debug_toggle_sidebar(window, cx);
                    }
                }
                "size" => {
                    if let Some((w, h)) = arg.split_once('x')
                        && let (Ok(w), Ok(h)) = (w.parse::<f32>(), h.parse::<f32>())
                    {
                        window.resize(size(px(w), px(h)));
                    }
                }
                "doc_menu" => root.pane.update(cx, |p, cx| p.debug_doc_menu(cx)),
                "participants" => root
                    .pane
                    .update(cx, |p, cx| p.debug_popover("participants", cx)),
                "event" => root.pane.update(cx, |p, cx| p.debug_popover("event", cx)),
                "when" => root.pane.update(cx, |p, cx| p.debug_when(window, cx)),
                "regenerate" => root
                    .pane
                    .update(cx, |p, cx| p.debug_popover("regenerate", cx)),
                "error" => root
                    .pane
                    .update(cx, |p, cx| p.debug_error(&arg, window, cx)),
                "stream" | "writing" => root.pane.update(cx, |p, cx| p.debug_stream(cx)),
                "ask" => root.pane.update(cx, |p, cx| p.debug_ask(cx)),
                "sheet" => root.pane.update(cx, |p, cx| p.debug_sheet(cx)),
                "lit" => root
                    .pane
                    .update(cx, |p, cx| p.debug_lit(arg == "reveal", cx)),
                "page_transcript" => root
                    .pane
                    .update(cx, |p, cx| p.toggle_transcript(window, cx)),
                "bar" => root.pane.update(cx, |p, cx| p.debug_bar(&arg, cx)),
                "find" => root.pane.update(cx, |p, cx| p.debug_find(&arg, window, cx)),
                "fold" => {
                    let transcript = root.pane.read(cx).transcript.clone();
                    transcript.update(cx, |t, cx| t.toggle_collapsed(window, cx));
                }
                "turns" => root.pane.update(cx, |p, cx| p.debug_select_turns(cx)),
                "calendar" => {
                    if let Some(meetings) = Meetings::try_global(cx) {
                        let url = arg.clone();
                        meetings.update(cx, |m, cx| {
                            if let Err(error) = m.add_calendar_feed(&url, Some("Work".into()), cx) {
                                tracing::warn!(?error, "could not add the test calendar");
                            }
                        });
                    }
                }
                "toast" => {
                    root.show_toast(crate::i18n::tr::documents::toast::copied(), None, None, cx)
                }
                "focus_title" => root.pane.update(cx, |p, cx| p.focus_title(window, cx)),
                "ai" => {
                    let access =
                        crate::meetings::AiAccess::parse(&arg).map(|a| (a, arg == "spent"));
                    crate::meetings::access::set_debug_access(access);
                    root.pane.update(cx, |p, cx| p.debug_ai_refresh(cx));
                    root.sidebar.update(cx, |s, cx| s.refresh_pro(cx));
                }
                "ai_trial_written" => {
                    let doc = root.pane.read(cx).doc.as_ref().map(|d| d.id.clone());
                    if let (Some(doc), Some(meetings)) = (doc, Meetings::try_global(cx)) {
                        meetings.update(cx, |m, _| m.debug_mark_trial(&doc));
                    }
                    root.pane.update(cx, |_, cx| cx.notify());
                }
                "ai_sheet" => {
                    let doc = root.pane.read(cx).doc.as_ref().map(|d| d.id.clone());
                    crate::meetings_ui::cap_ai::open_upgrade(
                        doc,
                        crate::meetings_ui::cap_ai::Host::Documents,
                        cx,
                    );
                    if let Some(cap_ai) = crate::meetings_ui::cap_ai::CapAi::global(cx) {
                        cap_ai.update(cx, |c, cx| c.debug_show(&arg, cx));
                    }
                }
                "ai_ask" => root
                    .pane
                    .update(cx, |p, cx| p.debug_ask_locked(arg == "focus", window, cx)),
                "short" => root.pane.update(cx, |p, cx| p.debug_too_short(cx)),
                _ => tracing::warn!(state = name, "unknown CAP_GPUI_DOCS_STATE"),
            })
            .ok();
    });
    if name == "new" {
        sleep(cx, 450).await;
    }
    if name == "stream" {
        for _ in 0..12 {
            sleep(cx, 120).await;
            cx.update(|cx| {
                handle
                    .update(cx, |root, _, cx| {
                        root.pane.update(cx, |p, cx| p.debug_stream_step(cx))
                    })
                    .ok();
            });
        }
    }
}

async fn run_bench(kind: &str, handle: WindowHandle<DocumentsWindow>, cx: &mut AsyncApp) {
    match kind {
        "scroll" => {
            let mut samples = Vec::new();
            cx.update(|cx| {
                handle
                    .update(cx, |root, window, cx| {
                        root.show_home(Some(Scope::All), window, cx)
                    })
                    .ok();
            });
            sleep(cx, 100).await;
            for i in 0..240 {
                let delta = if (i / 60) % 2 == 0 { 36. } else { -36. };
                cx.update(|cx| {
                    handle
                        .update(cx, |root, _, cx| {
                            root.home.update(cx, |h, cx| h.debug_scroll(delta, cx))
                        })
                        .ok();
                });
                if let Some(elapsed) =
                    cx.update(|cx| crate::draw_bench::timed_draw(handle.into(), cx))
                {
                    if i >= 20 {
                        samples.push(elapsed.as_secs_f64() * 1e6);
                    }
                }
                sleep(cx, 4).await;
            }
            if !samples.is_empty() {
                crate::draw_bench::report("documents-bench", "sidebar-scroll", &mut samples);
            }
        }
        "switch" => {
            let mut total = Vec::new();
            let mut load = Vec::new();
            let mut draws = Vec::new();
            for i in 0..30 {
                let id = cx.update(|cx| {
                    handle
                        .read(cx)
                        .ok()
                        .and_then(|root| doc_id_at(root, (i * 37 + 5) % 400, cx))
                });
                let Some(id) = id else {
                    continue;
                };
                let started = Instant::now();
                cx.update(|cx| {
                    handle
                        .update(cx, |root, _, cx| {
                            root.store.update(cx, |s, cx| s.open(Some(id.clone()), cx))
                        })
                        .ok();
                });
                let mut loaded_ms = None;
                for _ in 0..500 {
                    let done = cx.update(|cx| {
                        handle
                            .read(cx)
                            .ok()
                            .map(|root| root.pane.read(cx).debug_loaded(&id))
                            .unwrap_or(false)
                    });
                    if done {
                        loaded_ms = Some(started.elapsed().as_secs_f64() * 1000.);
                        break;
                    }
                    sleep(cx, 1).await;
                }
                if let Some(frame) =
                    cx.update(|cx| crate::draw_bench::timed_draw(handle.into(), cx))
                {
                    draws.push(frame.as_secs_f64() * 1e6);
                }
                total.push(started.elapsed().as_secs_f64() * 1e6);
                if let Some(ms) = loaded_ms {
                    load.push(ms * 1000.);
                }
                sleep(cx, 60).await;
            }
            crate::draw_bench::report("documents-bench", "switch-to-first-paint", &mut total);
            crate::draw_bench::report("documents-bench", "switch-load-only", &mut load);
            crate::draw_bench::report("documents-bench", "switch-draw", &mut draws);
        }
        // The frames the app itself draws for a switch, from GPUI's frame
        // trace: nothing here draws, so every frame between the open and the
        // note settling (its text, then its transcript) is a real one. Reports
        // each switch's worst frame, every frame, and the time to settle,
        // then each switch's worst frame in order. Its notes (from the 400th
        // on) are ones no other bench opens, so every visit is a first one.
        // CAP_GPUI_DOCS_SWITCHES=<n> (default 60); `switch_long` alternates
        // with the meeting with the longest transcript.
        "switch_frames" | "switch_long" => {
            let rounds = env("CAP_GPUI_DOCS_SWITCHES")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(60);
            let long_id = cx.update(|cx| {
                handle.read(cx).ok().and_then(|root| {
                    root.store
                        .read(cx)
                        .snapshot
                        .docs
                        .iter()
                        .filter(|d| !d.is_trashed())
                        .max_by_key(|d| d.meeting.as_ref().map_or(0, |m| m.transcript_chars))
                        .map(|d| d.id.clone())
                })
            });
            let window_id = handle.window_id();
            gpui::profiler::set_frame_trace_enabled(true);
            let mut worst = Vec::new();
            let mut frames = Vec::new();
            let mut settle = Vec::new();
            let mut counts = Vec::new();
            let mut order = Vec::new();
            for i in 0..rounds {
                let id = if kind == "switch_long" && i % 2 == 0 {
                    long_id.clone()
                } else {
                    cx.update(|cx| {
                        handle
                            .read(cx)
                            .ok()
                            .and_then(|root| doc_id_at(root, 400 + (i * 53 + 11) % 1500, cx))
                    })
                };
                let Some(id) = id else {
                    continue;
                };
                let mut collector = gpui::profiler::FrameTimingCollector::new();
                let started = Instant::now();
                cx.update(|cx| {
                    handle
                        .update(cx, |root, _, cx| {
                            root.store.update(cx, |s, cx| s.open(Some(id.clone()), cx))
                        })
                        .ok();
                });
                let mut seen = Vec::new();
                let mut settled_at = None;
                let mut last_frame = started;
                for _ in 0..1500 {
                    sleep(cx, 2).await;
                    for f in collector.collect_unseen() {
                        if f.window_id == window_id {
                            last_frame = f.draw_end;
                            seen.push(f.draw_duration().as_secs_f64() * 1e6);
                        }
                    }
                    let loaded = cx.update(|cx| {
                        handle
                            .read(cx)
                            .ok()
                            .map(|root| {
                                let pane = root.pane.read(cx);
                                pane.debug_loaded(&id) && pane.transcript.read(cx).debug_loaded()
                            })
                            .unwrap_or(false)
                    });
                    if loaded && settled_at.is_none() {
                        settled_at = Some(Instant::now());
                    }
                    // Settled: loaded, and no frame for 50 ms since.
                    if let Some(at) = settled_at
                        && at.max(last_frame).elapsed() > Duration::from_millis(50)
                    {
                        break;
                    }
                }
                if let Some(max) = seen.iter().copied().reduce(f64::max) {
                    worst.push(max);
                    order.push(format!("{:.1}", max / 1000.));
                }
                counts.push(seen.len() as f64);
                frames.extend(seen);
                settle.push(last_frame.duration_since(started).as_secs_f64() * 1e6);
            }
            gpui::profiler::set_frame_trace_enabled(false);
            let label = |s: &str| {
                if kind == "switch_long" {
                    format!("long-{s}")
                } else {
                    s.to_string()
                }
            };
            for (name, samples) in [
                ("switch-worst-frame", &mut worst),
                ("switch-frames", &mut frames),
                ("switch-settled", &mut settle),
                ("switch-frame-count", &mut counts),
            ] {
                if !samples.is_empty() {
                    crate::draw_bench::report("documents-bench", &label(name), samples);
                }
            }
            println!(
                "documents-bench: {} in order (ms): {}",
                label("switch-worst-frame"),
                order.join(" ")
            );
        }
        // The sidebar search as typed: the frame each key draws, then the
        // frame its hits land in (the search itself runs off the main thread).
        "search" => {
            cx.update(|cx| {
                handle
                    .update(cx, |root, window, cx| {
                        root.show_home(Some(Scope::All), window, cx)
                    })
                    .ok();
            });
            sleep(cx, 200).await;
            let mut keys = Vec::new();
            let mut landed = Vec::new();
            for word in ["design review", "pricing", "ana", "roadmap planning"] {
                for end in 1..=word.len() {
                    let typed = &word[..end];
                    let before = cx.update(|cx| {
                        handle
                            .read(cx)
                            .ok()
                            .map(|root| root.home.read(cx).debug_searches_landed())
                            .unwrap_or(0)
                    });
                    let started = Instant::now();
                    cx.update(|cx| {
                        handle
                            .update(cx, |root, window, cx| {
                                root.home
                                    .update(cx, |h, cx| h.debug_search(typed, window, cx))
                            })
                            .ok();
                        crate::draw_bench::timed_draw(handle.into(), cx);
                    });
                    keys.push(started.elapsed().as_secs_f64() * 1e6);
                    for _ in 0..400 {
                        let now = cx.update(|cx| {
                            handle
                                .read(cx)
                                .ok()
                                .map(|root| root.home.read(cx).debug_searches_landed())
                                .unwrap_or(0)
                        });
                        if now != before {
                            break;
                        }
                        sleep(cx, 2).await;
                    }
                    if let Some(frame) =
                        cx.update(|cx| crate::draw_bench::timed_draw(handle.into(), cx))
                    {
                        landed.push(frame.as_secs_f64() * 1e6);
                    }
                }
                cx.update(|cx| {
                    handle
                        .update(cx, |root, window, cx| {
                            root.home.update(cx, |h, cx| h.debug_search("", window, cx))
                        })
                        .ok();
                    crate::draw_bench::timed_draw(handle.into(), cx);
                });
                sleep(cx, 50).await;
            }
            crate::draw_bench::report("documents-bench", "search-key", &mut keys);
            crate::draw_bench::report("documents-bench", "search-hits", &mut landed);
        }
        "draw" => {
            let mut samples = Vec::new();
            for _ in 0..60 {
                if let Some(elapsed) = cx.update(|cx| {
                    handle.update(cx, |_, window, _| window.refresh()).ok();
                    crate::draw_bench::timed_draw(handle.into(), cx)
                }) {
                    samples.push(elapsed.as_secs_f64() * 1e6);
                }
                sleep(cx, 10).await;
            }
            crate::draw_bench::report("documents-bench", "full-redraw", &mut samples);
        }
        // The open note's one scroll (summary, then every transcript line):
        // down through it and back, a draw per step. And lighting a point's
        // lines, as on hover.
        "page_scroll" => {
            let mut samples = Vec::new();
            for i in 0..400 {
                let delta = if (i / 100) % 2 == 0 { 48. } else { -48. };
                cx.update(|cx| {
                    handle
                        .update(cx, |root, _, cx| {
                            let list = root.pane.read(cx).transcript.read(cx).list_state();
                            list.scroll_by(gpui::px(delta));
                            // As a wheel does: the list's own view and the
                            // transcript's scroll handler both hear of it.
                            root.pane
                                .read(cx)
                                .transcript
                                .clone()
                                .update(cx, |t, cx| t.changed(cx));
                        })
                        .ok();
                });
                if let Some(elapsed) =
                    cx.update(|cx| crate::draw_bench::timed_draw(handle.into(), cx))
                    && i >= 20
                {
                    samples.push(elapsed.as_secs_f64() * 1e6);
                }
            }
            if !samples.is_empty() {
                crate::draw_bench::report("documents-bench", "page-scroll", &mut samples);
            }
            let counts = |cx: &mut AsyncApp| {
                cx.update(|cx| {
                    handle
                        .read(cx)
                        .ok()
                        .map(|root| {
                            let t = root.pane.read(cx).transcript.read(cx);
                            (t.lines_renders(cx), t.lead_resizes())
                        })
                        .unwrap_or_default()
                })
            };
            let (lines, resizes) = counts(cx);
            println!(
                "documents-bench: page-counts after scroll: lines renders {lines}, lead resizes {resizes}"
            );
            let mut lit = Vec::new();
            for i in 0..60 {
                cx.update(|cx| {
                    handle
                        .update(cx, |root, _, cx| {
                            root.pane.update(cx, |p, cx| {
                                if i % 2 == 0 {
                                    p.debug_lit(false, cx)
                                } else {
                                    p.transcript.update(cx, |t, cx| t.light(&[], cx))
                                }
                            })
                        })
                        .ok();
                });
                if let Some(elapsed) =
                    cx.update(|cx| crate::draw_bench::timed_draw(handle.into(), cx))
                {
                    lit.push(elapsed.as_secs_f64() * 1e6);
                }
                sleep(cx, 10).await;
            }
            crate::draw_bench::report("documents-bench", "light-source", &mut lit);
            let (lines2, resizes2) = counts(cx);
            println!(
                "documents-bench: page-counts during lighting (60 draws): lines renders {}, lead resizes {}",
                lines2 - lines,
                resizes2 - resizes
            );
        }
        // Short scripted walk-throughs for the videos.
        "demo_sources" => {
            for (index, reveal, wait) in [
                (0, false, 1300),
                (1, false, 1300),
                (2, false, 1300),
                (2, true, 1800),
                (usize::MAX, false, 600),
            ] {
                cx.update(|cx| {
                    handle
                        .update(cx, |root, _, cx| {
                            root.pane
                                .update(cx, |p, cx| p.debug_lit_at(index, reveal, cx))
                        })
                        .ok()
                });
                sleep(cx, wait).await;
            }
        }
        "demo_ask" => {
            sleep(cx, 1500).await;
            cx.update(|cx| {
                handle
                    .update(cx, |root, _, cx| {
                        root.pane.update(cx, |p, cx| p.debug_sheet(cx))
                    })
                    .ok()
            });
            sleep(cx, 3500).await;
            cx.update(|cx| {
                handle
                    .update(cx, |root, _, cx| {
                        root.pane.update(cx, |p, cx| p.debug_close_sheet(cx))
                    })
                    .ok()
            });
            sleep(cx, 1500).await;
        }
        "list" => {
            let listed = cx.update(|cx| {
                handle
                    .read(cx)
                    .ok()
                    .and_then(|root| root.store.read(cx).last_list_ms)
            });
            println!("documents-bench: listing {listed:?} ms");
        }
        _ => {}
    }
}
