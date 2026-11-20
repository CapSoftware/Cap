use cap_meetings::transcript::{Gap, LogLine, Transcript, Word, append_jsonl};
use cap_project::CaptionWord;

use super::*;

const START: u64 = 16_000;

fn job() -> SegmentJob {
    SegmentJob {
        source: Source::Mic,
        start_sample: START,
        samples: vec![0.0; 32_000],
        speech_ms: 2_000,
    }
}

fn caption_words(texts: &[&str]) -> Vec<CaptionWord> {
    texts
        .iter()
        .enumerate()
        .map(|(i, text)| CaptionWord {
            text: text.to_string(),
            start: i as f32 * 0.4,
            end: i as f32 * 0.4 + 0.3,
        })
        .collect()
}

fn local_model() -> LocalModel {
    LocalModel {
        model: "best".into(),
        language: "en".into(),
    }
}

enum Answer {
    Words(&'static [&'static str]),
    Fail,
    /// Fails this many times, then answers with the words.
    FailThen(usize, &'static [&'static str]),
    /// The account has no Pro.
    Upgrade,
    /// The sign-in is refused this many times, then the same one works.
    AuthThen(usize, &'static [&'static str]),
}

struct Ran {
    events: Vec<EngineEvent>,
    transcript: Transcript,
}

impl Ran {
    fn lines(&self) -> Vec<(String, String, bool)> {
        self.events
            .iter()
            .filter_map(|e| match e {
                EngineEvent::Utterance { utterance, .. } => Some((
                    utterance.id.clone(),
                    utterance.text.clone(),
                    utterance.is_final,
                )),
                _ => None,
            })
            .collect()
    }

    fn removed(&self) -> Vec<String> {
        self.events
            .iter()
            .flat_map(|e| match e {
                EngineEvent::Removed { ids, .. } => ids.clone(),
                _ => Vec::new(),
            })
            .collect()
    }

    fn saved(&self) -> Vec<(String, String)> {
        self.transcript
            .utterances()
            .iter()
            .map(|u| (u.id.clone(), u.text.clone()))
            .collect()
    }

    fn drained(&self) -> bool {
        matches!(self.events.last(), Some(EngineEvent::Drained { .. }))
    }

    fn last_status(&self) -> Option<EngineStatus> {
        self.events.iter().rev().find_map(|e| match e {
            EngineEvent::Status { status, .. } => Some(status.clone()),
            _ => None,
        })
    }
}

/// Runs a worker to the end of a meeting: the given partials and segments,
/// then every sender closes as when recording stops.
fn run(
    mode: EngineMode,
    fallback: bool,
    local: &'static [&'static str],
    cloud: Option<Answer>,
    partials: Vec<SegmentJob>,
    segments: Vec<SegmentJob>,
) -> Ran {
    run_with(&[], mode, fallback, local, cloud, partials, segments)
}

fn run_with(
    dictionary: &[cap_meetings::dictionary::Entry],
    mode: EngineMode,
    fallback: bool,
    local: &'static [&'static str],
    cloud: Option<Answer>,
    partials: Vec<SegmentJob>,
    segments: Vec<SegmentJob>,
) -> Ran {
    run_opts(Opts {
        dictionary: dictionary.to_vec(),
        mode,
        fallback,
        local,
        cloud,
        partials,
        segments,
        ..Opts::default()
    })
}

struct Opts {
    dictionary: Vec<cap_meetings::dictionary::Entry>,
    mode: EngineMode,
    fallback: bool,
    local: &'static [&'static str],
    cloud: Option<Answer>,
    partials: Vec<SegmentJob>,
    segments: Vec<SegmentJob>,
    missed: Vec<Missed>,
    gaps: Vec<Gap>,
    /// Retries inside one clip (zero: a failure goes straight to the bridge).
    budget: Duration,
    /// Saved audio is readable for repair.
    audio: bool,
    /// The transcript file can't be written until the local model's n-th call.
    disk_full_until: Option<usize>,
}

impl Default for Opts {
    fn default() -> Self {
        Self {
            dictionary: Vec::new(),
            mode: cloud_mode(),
            fallback: false,
            local: LOCAL,
            cloud: None,
            partials: Vec::new(),
            segments: Vec::new(),
            missed: Vec::new(),
            gaps: Vec::new(),
            budget: Duration::from_millis(200),
            audio: true,
            disk_full_until: None,
        }
    }
}

fn run_opts(opts: Opts) -> Ran {
    let Opts {
        dictionary,
        mode,
        fallback,
        local,
        cloud,
        partials,
        segments,
        missed,
        gaps,
        budget,
        audio,
        disk_full_until,
    } = opts;
    let dictionary = dictionary.as_slice();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("transcript.jsonl");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let (events_tx, events_rx) = flume::unbounded();
    let (segments_tx, segments_rx) = flume::bounded(16);
    let (partials_tx, partials_rx) = flume::bounded(16);
    let (commands_tx, commands_rx) = flume::unbounded();
    let (missed_tx, missed_rx) = flume::unbounded();
    for p in partials {
        partials_tx.send(p).unwrap();
    }
    for s in segments {
        segments_tx.send(s).unwrap();
    }
    for m in missed {
        missed_tx.send(m).unwrap();
    }
    drop((segments_tx, partials_tx, commands_tx, missed_tx));
    let config = EngineConfig {
        doc_id: "doc".into(),
        transcript_path: path.clone(),
        mode,
        fallback: fallback.then(local_model),
        vocabulary: Vec::new(),
        dictionary: Arc::new(cap_meetings::dictionary::Corrector::new(dictionary)),
        live: true,
        voices: None,
        audio: Vec::new(),
        gaps,
        runtime: runtime.handle().clone(),
        events: events_tx,
    };
    let mut worker = Worker::new(
        config,
        segments_rx,
        partials_rx,
        missed_rx,
        commands_rx,
        Arc::new(AtomicBool::new(false)),
    );
    worker.policy = RetryPolicy {
        first: Duration::from_millis(1),
        max: Duration::from_millis(2),
        budget,
        stop_budget: budget,
        probe_first: Duration::ZERO,
        probe_jitter: Duration::ZERO,
        probe_max: Duration::ZERO,
    };
    let disk_full = Arc::new(AtomicBool::new(disk_full_until.is_some()));
    if disk_full_until.is_some() {
        worker.hooks.disk_full = Some(disk_full.clone());
    }
    let local_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    worker.hooks.local = Some(Arc::new(move |_| {
        let n = local_calls.fetch_add(1, Ordering::SeqCst) + 1;
        if disk_full_until.is_some_and(|until| n >= until) {
            disk_full.store(false, Ordering::SeqCst);
        }
        Ok(caption_words(local))
    }));
    if audio {
        worker.hooks.audio = Some(Arc::new(|_, _, len| Some(vec![0.1; len as usize])));
    } else {
        worker.hooks.audio = Some(Arc::new(|_, _, _| None));
    }
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    worker.hooks.cloud = cloud.map(|answer| -> CloudAnswer {
        let words = |texts: &[&str]| cloud::CloudTranscript {
            text: texts.join(" "),
            words: caption_words(texts)
                .into_iter()
                .map(|w| cloud::CloudWord {
                    text: w.text,
                    start_ms: f64::from(w.start) * 1000.0,
                    end_ms: f64::from(w.end) * 1000.0,
                    speaker: None,
                })
                .collect(),
        };
        Arc::new(move |_clip: &Clip| {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            match &answer {
                Answer::Words(texts) => Ok(words(texts)),
                Answer::Fail => Err(CloudError::Failed("server error".into())),
                Answer::FailThen(fails, texts) if n >= *fails => Ok(words(texts)),
                Answer::FailThen(..) => Err(CloudError::Offline("unreachable".into())),
                Answer::Upgrade => Err(CloudError::UpgradeRequired),
                Answer::AuthThen(fails, texts) if n >= *fails => Ok(words(texts)),
                Answer::AuthThen(..) => Err(CloudError::NotSignedIn),
            }
        })
    });
    worker.run();
    drop(worker);
    let events = events_rx.try_iter().collect();
    let (transcript, _) = Transcript::load_jsonl(&path).unwrap();
    Ran { events, transcript }
}

fn cloud_mode() -> EngineMode {
    EngineMode::Cloud {
        language: "en".into(),
    }
}

const LOCAL: &[&str] = &["hello", "from", "here"];
const CLOUD: &[&str] = &["hello", "from", "the", "cloud"];

#[test]
fn cloud_shows_local_words_first_then_replaces_them_in_place() {
    let ran = run(
        cloud_mode(),
        true,
        LOCAL,
        Some(Answer::Words(CLOUD)),
        Vec::new(),
        vec![job()],
    );
    let id = utterance_id(Source::Mic, START);
    assert_eq!(
        ran.lines(),
        vec![
            (id.clone(), "hello from here".into(), true),
            (id.clone(), "hello from the cloud".into(), true),
        ],
        "one line, local words first, the cloud's words in the same place"
    );
    assert!(ran.removed().is_empty());
    assert_eq!(ran.saved(), vec![(id, "hello from the cloud".into())]);
    assert!(ran.drained());
}

#[test]
fn a_segment_the_cloud_heard_nothing_in_loses_its_local_line() {
    let ran = run(
        cloud_mode(),
        true,
        LOCAL,
        Some(Answer::Words(&[])),
        Vec::new(),
        vec![job()],
    );
    let id = utterance_id(Source::Mic, START);
    assert_eq!(ran.removed(), vec![id]);
    assert!(ran.saved().is_empty(), "{:?}", ran.saved());
}

#[test]
fn a_failed_clip_keeps_the_local_words_and_the_meeting_stays_on_cloud() {
    let ran = run(
        cloud_mode(),
        true,
        LOCAL,
        Some(Answer::Fail),
        Vec::new(),
        vec![job()],
    );
    let id = utterance_id(Source::Mic, START);
    assert!(ran.removed().is_empty());
    assert_eq!(ran.saved(), vec![(id, "hello from here".into())]);
    let status = ran.last_status().unwrap();
    assert_eq!(status.kind, EngineKind::Cloud, "one failure never downgrades the meeting");
    assert_eq!(status.cloud, CloudState::Down { local: true });
    assert_eq!(status.gaps, 0, "no words were lost");
    assert!(ran.transcript.gaps().is_empty());
}

#[test]
fn an_outage_the_retries_ride_out_loses_nothing() {
    let ran = run_opts(Opts {
        cloud: Some(Answer::FailThen(2, CLOUD)),
        segments: vec![job()],
        ..Opts::default()
    });
    let id = utterance_id(Source::Mic, START);
    assert_eq!(ran.saved(), vec![(id, "hello from the cloud".into())]);
    let status = ran.last_status().unwrap();
    assert_eq!(status.cloud, CloudState::Ok);
    assert_eq!(status.gaps, 0);
}

#[test]
fn a_long_outage_keeps_the_audio_and_repairs_it_after_stop() {
    let ran = run_opts(Opts {
        cloud: Some(Answer::FailThen(1, CLOUD)),
        budget: Duration::ZERO,
        segments: vec![job()],
        ..Opts::default()
    });
    let id = utterance_id(Source::Mic, START);
    assert!(
        ran.events.iter().any(|e| matches!(
            e,
            EngineEvent::Status { status, .. } if status.cloud == CloudState::Down { local: false } && status.gaps == 1
        )),
        "the clip went in the ledger while the cloud was down"
    );
    assert_eq!(ran.saved(), vec![(id, "hello from the cloud".into())]);
    assert!(ran.transcript.gaps().is_empty(), "the gap closed");
    assert_eq!(ran.last_status().unwrap().gaps, 0);
    assert!(ran.drained());
}

#[test]
fn audio_nothing_could_transcribe_stays_in_the_ledger() {
    let ran = run_opts(Opts {
        cloud: Some(Answer::Fail),
        budget: Duration::ZERO,
        segments: vec![job()],
        ..Opts::default()
    });
    assert!(ran.saved().is_empty());
    let gaps = ran.transcript.gaps();
    assert_eq!(gaps.len(), 1);
    assert_eq!(gaps[0].segments, vec![(START, 32_000)]);
    assert_eq!(gaps[0].reason, reason::CLOUD);
    assert_eq!(ran.last_status().unwrap().gaps, 1);
}

#[test]
fn a_full_queue_is_transcribed_from_the_saved_audio_after_stop() {
    let ran = run_opts(Opts {
        mode: EngineMode::Local(local_model()),
        missed: vec![Missed {
            source: Source::System,
            start_sample: 64_000,
            len: 32_000,
        }],
        segments: vec![job()],
        ..Opts::default()
    });
    let mut saved = ran.saved();
    saved.sort();
    assert_eq!(
        saved,
        vec![
            (utterance_id(Source::Mic, START), "hello from here".into()),
            (utterance_id(Source::System, 64_000), "hello from here".into()),
        ]
    );
    assert!(ran.transcript.gaps().is_empty());
}

#[test]
fn without_the_audio_a_missed_segment_waits_in_the_ledger() {
    let ran = run_opts(Opts {
        mode: EngineMode::Local(local_model()),
        audio: false,
        missed: vec![Missed {
            source: Source::System,
            start_sample: 64_000,
            len: 32_000,
        }],
        ..Opts::default()
    });
    assert!(ran.saved().is_empty());
    assert_eq!(ran.transcript.gaps().len(), 1);
    assert_eq!(ran.transcript.gaps()[0].reason, reason::BUSY);
}

#[test]
fn missed_segments_close_together_share_one_gap() {
    let ran = run_opts(Opts {
        mode: EngineMode::Unavailable("no model".into()),
        missed: (0..5)
            .map(|n| Missed {
                source: Source::Mic,
                start_sample: n * 48_000,
                len: 16_000,
            })
            .collect(),
        ..Opts::default()
    });
    let gaps = ran.transcript.gaps();
    assert_eq!(gaps.len(), 1, "{gaps:?}");
    assert_eq!(gaps[0].segments.len(), 5);
    assert_eq!(gaps[0].end_sample, 4 * 48_000 + 16_000);
}

#[test]
fn a_gap_from_before_is_repaired_when_the_meeting_ends() {
    let gap = Gap {
        id: Gap::id_for(Source::Mic, 160_000),
        source: Source::Mic,
        start_sample: 160_000,
        end_sample: 192_000,
        segments: vec![(160_000, 32_000)],
        reason: reason::TAIL.into(),
    };
    let ran = run_opts(Opts {
        mode: EngineMode::Local(local_model()),
        gaps: vec![gap],
        ..Opts::default()
    });
    assert_eq!(
        ran.saved(),
        vec![(utterance_id(Source::Mic, 160_000), "hello from here".into())]
    );
    assert!(
        ran.events.iter().any(|e| matches!(e, EngineEvent::Status { status, .. } if status.gaps == 0)),
        "the repair closed it"
    );
}

#[test]
fn lines_wait_in_memory_while_the_disk_is_full() {
    let second = SegmentJob {
        start_sample: START * 10,
        ..job()
    };
    let ran = run_opts(Opts {
        mode: EngineMode::Local(local_model()),
        segments: vec![job(), second],
        disk_full_until: Some(2),
        ..Opts::default()
    });
    assert!(
        ran.events.iter().any(|e| matches!(e, EngineEvent::Status { status, .. } if status.disk_failed)),
        "the full disk was reported"
    );
    assert!(!ran.last_status().unwrap().disk_failed, "and cleared");
    assert_eq!(ran.saved().len(), 2, "both lines reached the file: {:?}", ran.saved());
}

#[test]
fn no_pro_falls_back_to_this_computer_for_good() {
    let ran = run_opts(Opts {
        fallback: true,
        cloud: Some(Answer::Upgrade),
        segments: vec![job(), SegmentJob { start_sample: START * 40, ..job() }],
        ..Opts::default()
    });
    assert_eq!(ran.saved().len(), 2, "both keep this computer's words");
    let status = ran.last_status().unwrap();
    assert!(matches!(status.kind, EngineKind::Local { .. }), "{status:?}");
    assert!(ran.transcript.gaps().is_empty());
}

#[test]
fn backoff_doubles_within_a_fifth_either_way_and_honours_the_server() {
    let policy = RetryPolicy::default();
    let offline = CloudError::Offline("x".into());
    for attempt in 1..=8u32 {
        let wait = policy.backoff(attempt, &offline);
        let base = Duration::from_secs(1u64 << (attempt - 1)).min(Duration::from_secs(30));
        assert!(wait >= base.mul_f64(0.8) && wait <= base.mul_f64(1.2), "{attempt}: {wait:?}");
    }
    let limited = CloudError::RateLimited { retry_after_secs: 45 };
    assert!(policy.backoff(1, &limited) >= Duration::from_secs(45));
    assert_eq!(request_timeout(28_000), Duration::from_secs(95), "past the server's 90 s");
    assert_eq!(request_timeout(110_000), Duration::from_secs(180));
}

#[test]
fn live_captions_run_in_cloud_from_the_local_model() {
    let ran = run(
        cloud_mode(),
        true,
        LOCAL,
        Some(Answer::Words(CLOUD)),
        vec![job()],
        Vec::new(),
    );
    assert_eq!(
        ran.lines(),
        vec![(
            utterance_id(Source::Mic, START),
            "hello from here".into(),
            false
        )]
    );
    assert!(
        ran.saved().is_empty(),
        "a live caption is never written down"
    );
}

#[test]
fn cloud_without_a_local_model_waits_for_the_clip_as_before() {
    let ran = run(
        cloud_mode(),
        false,
        LOCAL,
        Some(Answer::Words(CLOUD)),
        vec![job()],
        vec![job()],
    );
    let id = utterance_id(Source::Mic, START);
    assert_eq!(
        ran.lines(),
        vec![(id.clone(), "hello from the cloud".into(), true)],
        "no live caption and no local line without a local model"
    );
    assert_eq!(ran.saved(), vec![(id, "hello from the cloud".into())]);
}

#[test]
fn local_mode_is_unchanged() {
    let ran = run(
        EngineMode::Local(local_model()),
        false,
        LOCAL,
        None,
        Vec::new(),
        vec![job()],
    );
    let id = utterance_id(Source::Mic, START);
    assert_eq!(
        ran.lines(),
        vec![(id.clone(), "hello from here".into(), true)]
    );
    assert_eq!(ran.saved(), vec![(id, "hello from here".into())]);
}

const SAID: &[&str] = &["I", "think", "Kap", "is", "great,", "nice", "cap."];

#[test]
fn the_dictionary_spells_live_and_final_words_the_same() {
    let cap = cap_meetings::dictionary::builtins();
    let ran = run_with(
        &cap,
        EngineMode::Local(local_model()),
        false,
        SAID,
        None,
        vec![job()],
        vec![job()],
    );
    let id = utterance_id(Source::Mic, START);
    let mut texts: Vec<(String, bool)> = ran.lines().into_iter().map(|(_, t, f)| (t, f)).collect();
    texts.sort_by_key(|(_, final_line)| *final_line);
    assert_eq!(
        texts,
        vec![
            ("I think Cap is great, nice cap.".to_string(), false),
            ("I think Cap is great, nice cap.".to_string(), true),
        ],
        "the caption and the final line agree, the lowercase word stays"
    );
    assert_eq!(
        ran.saved(),
        vec![(id, "I think Cap is great, nice cap.".into())]
    );
}

#[test]
fn the_dictionary_spells_cloud_words_too() {
    let cap = cap_meetings::dictionary::builtins();
    let ran = run_with(
        &cap,
        cloud_mode(),
        true,
        SAID,
        Some(Answer::Words(SAID)),
        Vec::new(),
        vec![job()],
    );
    let id = utterance_id(Source::Mic, START);
    assert_eq!(
        ran.saved(),
        vec![(id, "I think Cap is great, nice cap.".into())]
    );
}

#[test]
fn an_empty_dictionary_leaves_words_as_heard() {
    let ran = run(
        EngineMode::Local(local_model()),
        false,
        SAID,
        None,
        Vec::new(),
        vec![job()],
    );
    let id = utterance_id(Source::Mic, START);
    assert_eq!(
        ran.saved(),
        vec![(id, "I think Kap is great, nice cap.".into())]
    );
}

fn levels(loud: &[(usize, usize)], frames: usize) -> Vec<(u64, f32)> {
    (0..frames)
        .map(|i| {
            let db = if loud.iter().any(|(a, b)| (*a..*b).contains(&i)) { -30.0 } else { -70.0 };
            ((i * SWEEP_FRAME) as u64, db)
        })
        .collect()
}

fn frame_ms(i: usize) -> u64 {
    timeline::samples_to_ms((i * SWEEP_FRAME) as u64)
}

#[test]
fn the_sweep_finds_speech_no_line_covers() {
    // Two stretches of speech; a line covers the second.
    let track = levels(&[(100, 160), (300, 360)], 500);
    let heard = [(frame_ms(300), frame_ms(360))];
    let missing = sweep_missing(&track, &heard, &[], &[]);
    assert_eq!(missing.len(), 1, "{missing:?}");
    let (start, len) = missing[0];
    assert_eq!(start, (100 * SWEEP_FRAME) as u64 - SWEEP_PAD_SAMPLES);
    assert_eq!(start + len, (160 * SWEEP_FRAME) as u64 + SWEEP_PAD_SAMPLES);
}

#[test]
fn the_sweep_leaves_the_call_heard_in_the_room_and_waiting_gaps_alone() {
    let track = levels(&[(100, 160)], 300);
    let call = [(frame_ms(90), frame_ms(170))];
    assert!(sweep_missing(&track, &[], &call, &[]).is_empty(), "the mic heard the call");
    assert!(sweep_missing(&track, &[], &[], &call).is_empty(), "a gap already waits for it");
}

#[test]
fn the_sweep_ignores_clicks_and_silence() {
    // 5 loud frames (150 ms) is a click, not speech; digital silence has no level.
    assert!(sweep_missing(&levels(&[(100, 105)], 300), &[], &[], &[]).is_empty());
    let silent: Vec<(u64, f32)> = (0..300).map(|i| ((i * SWEEP_FRAME) as u64, -120.0)).collect();
    assert!(sweep_missing(&silent, &[], &[], &[]).is_empty());
}

#[test]
fn a_long_unheard_stretch_is_cut_into_pieces_the_model_can_take() {
    // 60 s of speech nobody transcribed.
    let frames = 60_000 / 30;
    let track = levels(&[(10, 10 + frames)], frames + 100);
    let missing = sweep_missing(&track, &[], &[], &[]);
    assert!(missing.len() >= 3, "{missing:?}");
    assert!(missing.iter().all(|(_, len)| *len <= SWEEP_MAX_SAMPLES));
    let total: u64 = missing.iter().map(|(_, len)| len).sum();
    assert!(total >= (frames * SWEEP_FRAME) as u64);
}

#[test]
fn a_repair_never_writes_words_a_line_already_has() {
    // The heard spans drop a repaired word that sits on an existing word.
    let gap = Gap {
        id: Gap::id_for(Source::Mic, START),
        source: Source::Mic,
        start_sample: START,
        end_sample: START + 32_000,
        segments: vec![(START, 32_000)],
        reason: reason::SWEEP.into(),
    };
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("transcript.jsonl");
    let mut line = utterance(Source::Mic, 0, vec![Word { text: "hello".into(), start_ms: 1_000, end_ms: 1_300 }], true).unwrap();
    line.id = "m0".into();
    append_jsonl(&path, &[LogLine::Upsert { utterance: line }]).unwrap();
    let (events_tx, events_rx) = flume::unbounded();
    let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
    let (_s, segments_rx) = flume::bounded(1);
    let (_p, partials_rx) = flume::bounded(1);
    let (_m, missed_rx) = flume::unbounded();
    let (commands_tx, commands_rx) = flume::unbounded();
    let mut worker = Worker::new(
        EngineConfig {
            doc_id: "doc".into(),
            transcript_path: path.clone(),
            mode: EngineMode::Local(local_model()),
            fallback: None,
            vocabulary: Vec::new(),
            dictionary: Arc::new(cap_meetings::dictionary::Corrector::new(&[])),
            live: false,
            voices: None,
            audio: Vec::new(),
            gaps: vec![gap],
            runtime: runtime.handle().clone(),
            events: events_tx,
        },
        segments_rx,
        partials_rx,
        missed_rx,
        commands_rx,
        Arc::new(AtomicBool::new(false)),
    );
    // "hello" lands at 1000 ms, on the line already there; "from here" is new.
    worker.hooks.local = Some(Arc::new(|_| Ok(caption_words(LOCAL))));
    worker.hooks.audio = Some(Arc::new(|_, _, len| Some(vec![0.1; len as usize])));
    worker.repair_after_stop();
    drop(commands_tx);
    let _ = events_rx.try_iter().count();
    let (transcript, _) = Transcript::load_jsonl(&path).unwrap();
    let repaired = transcript.get(&utterance_id(Source::Mic, START)).unwrap();
    assert_eq!(repaired.text, "from here");
    assert!(transcript.gaps().is_empty());
}

#[test]
fn a_segment_lost_inside_continuous_speech_is_found_between_its_heard_neighbours() {
    // 9 s of unbroken speech; lines cover the first and last 3 s only.
    let track = levels(&[(100, 400)], 600);
    let heard = [(frame_ms(100), frame_ms(200)), (frame_ms(300), frame_ms(400))];
    let missing = sweep_missing(&track, &heard, &[], &[]);
    assert_eq!(missing.len(), 1, "{missing:?}");
    let (start, len) = missing[0];
    let (a, b) = (timeline::samples_to_ms(start), timeline::samples_to_ms(start + len));
    assert!(a >= frame_ms(200) + SWEEP_HEARD_SLACK_MS - 250 - 1 && b <= frame_ms(300) - SWEEP_HEARD_SLACK_MS + 250 + 1, "{a}..{b}");
}

#[test]
fn words_with_ordinary_pauses_count_as_heard() {
    // Speech covered word by word with short pauses between words.
    let track = levels(&[(100, 300)], 400);
    let heard: Vec<(u64, u64)> = (0..12)
        .map(|n| (frame_ms(100) + n * 500, frame_ms(100) + n * 500 + 300))
        .chain(std::iter::once((frame_ms(100) + 6_000, frame_ms(300))))
        .collect();
    assert!(sweep_missing(&track, &heard, &[], &[]).is_empty());
}

#[test]
fn a_refused_sign_in_that_works_again_is_tried_again_and_its_audio_repaired() {
    let later = SegmentJob { start_sample: START * 40, ..job() };
    let ran = run_opts(Opts {
        cloud: Some(Answer::AuthThen(1, CLOUD)),
        budget: Duration::ZERO,
        segments: vec![job(), later],
        ..Opts::default()
    });
    assert!(
        ran.events.iter().any(|e| matches!(
            e,
            EngineEvent::Status { status, .. } if matches!(status.cloud, CloudState::SignIn { .. })
        )),
        "the refused sign-in was said"
    );
    assert_eq!(ran.saved().len(), 2, "both segments got their words: {:?}", ran.saved());
    assert!(ran.transcript.gaps().is_empty());
    assert_eq!(ran.last_status().unwrap().cloud, CloudState::Ok);
}
