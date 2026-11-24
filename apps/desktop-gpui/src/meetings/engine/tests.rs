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

/// A model stub for repairs: `texts` heard in the last `seconds` of what it
/// is given (the gap; anything before it is context).
fn words_at_end(
    texts: &'static [&'static str],
    seconds: f32,
) -> Arc<dyn Fn(&[f32]) -> Result<Vec<CaptionWord>, String> + Send + Sync> {
    Arc::new(move |samples: &[f32]| {
        let offset = samples.len() as f32 / 16_000.0 - seconds;
        Ok(caption_words(texts)
            .into_iter()
            .map(|w| CaptionWord { start: w.start + offset, end: w.end + offset, ..w })
            .collect())
    })
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
    /// Records how many samples each local pass heard.
    heard: Option<Arc<std::sync::Mutex<Vec<usize>>>>,
    /// The stand-in model puts its words at the start of what it hears, as
    /// the live caption tests expect, instead of at its end (repairs hear
    /// context before their gap).
    words_at_start: bool,
    /// `EngineConfig::slow_cloud_live`.
    slow_cloud_live: Option<bool>,
    /// The segment closes right after its first live caption; with `true`
    /// the local model hears no words in it after that caption.
    close_after_caption: Option<(SegmentJob, bool)>,
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
            heard: None,
            words_at_start: false,
            slow_cloud_live: None,
            close_after_caption: None,
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
        heard,
        words_at_start,
        slow_cloud_live,
        close_after_caption,
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
    // Some(None) once the segment closed.
    let silent_after_caption = close_after_caption
        .as_ref()
        .is_some_and(|(_, silent)| *silent);
    let closes =
        std::sync::Mutex::new(close_after_caption.map(|(job, _)| Some((job, segments_tx.clone()))));
    drop((segments_tx, partials_tx, commands_tx, missed_tx));
    let config = EngineConfig {
        doc_id: "doc".into(),
        transcript_path: path.clone(),
        mode,
        fallback: fallback.then(local_model),
        vocabulary: Vec::new(),
        dictionary: Arc::new(cap_meetings::dictionary::Corrector::new(dictionary)),
        live: true,
        slow_cloud_live,
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
    worker.hooks.local = Some(Arc::new(move |samples: &[f32]| {
        if let Some(heard) = &heard {
            heard.lock().unwrap().push(samples.len());
        }
        let n = local_calls.fetch_add(1, Ordering::SeqCst) + 1;
        if disk_full_until.is_some_and(|until| n >= until) {
            disk_full.store(false, Ordering::SeqCst);
        }
        let mut closes = closes.lock().unwrap();
        if silent_after_caption && closes.as_ref().is_some_and(|c| c.is_none()) {
            return Ok(Vec::new());
        }
        if let Some((job, tx)) = closes.as_mut().and_then(Option::take) {
            tx.send(job).unwrap();
        }
        drop(closes);
        if words_at_start {
            return Ok(caption_words(local));
        }
        // The words end where the audio does: a repair hears the 2 s before
        // its gap first, and only words reaching into the gap are its own.
        let words = caption_words(local);
        let span = words.last().map_or(0.0, |w| w.end) + 0.05;
        let offset = (samples.len() as f32 / 16_000.0 - span).max(0.0);
        Ok(words
            .into_iter()
            .map(|w| CaptionWord { start: w.start + offset, end: w.end + offset, ..w })
            .collect())
    }));
    if audio {
        worker.hooks.audio = Some(Arc::new(|_, _, len| Some(vec![0.1; len as usize])));
    } else {
        worker.hooks.audio = Some(Arc::new(|_, _, _| None));
    }
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    worker.hooks.cloud = cloud.map(|answer| -> CloudAnswer {
        // The words are heard in every part of the clip, as real speech in
        // each batched segment would be.
        let words = |clip: &Clip, texts: &[&str]| {
            let offsets: Vec<f64> = if clip.parts.is_empty() {
                vec![0.0]
            } else {
                clip.parts
                    .iter()
                    .map(|p| timeline::samples_to_ms(p.clip_offset_samples) as f64)
                    .collect()
            };
            cloud::CloudTranscript {
                text: vec![texts.join(" "); offsets.len()].join(" "),
                words: offsets
                    .iter()
                    .flat_map(|offset| {
                        caption_words(texts).into_iter().map(move |w| cloud::CloudWord {
                            text: w.text,
                            start_ms: offset + f64::from(w.start) * 1000.0,
                            end_ms: offset + f64::from(w.end) * 1000.0,
                            speaker: None,
                        })
                    })
                    .collect(),
            }
        };
        Arc::new(move |clip: &Clip| {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            match &answer {
                Answer::Words(texts) => Ok(words(clip, texts)),
                Answer::Fail => Err(CloudError::Failed("server error".into())),
                Answer::FailThen(fails, texts) if n >= *fails => Ok(words(clip, texts)),
                Answer::FailThen(..) => Err(CloudError::Offline("unreachable".into())),
                Answer::Upgrade => Err(CloudError::UpgradeRequired),
                Answer::AuthThen(fails, texts) if n >= *fails => Ok(words(clip, texts)),
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

/// A noise in a quiet room: the live pass took it for a word, the segment's
/// final pass heard nothing. The caption goes instead of staying on screen
/// under the user's name for the rest of the meeting, and nothing is saved.
fn caption_then_silence(mode: EngineMode, cloud: Option<Answer>) -> Ran {
    run_opts(Opts {
        mode,
        fallback: true,
        local: &["yeah"],
        cloud,
        partials: vec![job()],
        close_after_caption: Some((job(), true)),
        budget: Duration::ZERO,
        ..Opts::default()
    })
}

#[test]
fn a_caption_whose_segment_has_no_words_goes_local() {
    let ran = caption_then_silence(EngineMode::Local(local_model()), None);
    let id = utterance_id(Source::Mic, START);
    assert_eq!(ran.lines(), vec![(id.clone(), "yeah".into(), false)]);
    assert_eq!(ran.removed(), vec![id]);
    assert!(ran.saved().is_empty());
    assert!(ran.drained());
}

#[test]
fn a_caption_whose_segment_has_no_words_goes_cloud() {
    let ran = caption_then_silence(cloud_mode(), Some(Answer::Words(&[])));
    let id = utterance_id(Source::Mic, START);
    assert_eq!(ran.lines(), vec![(id.clone(), "yeah".into(), false)]);
    assert_eq!(ran.removed(), vec![id]);
    assert!(ran.saved().is_empty());
    assert!(ran.drained());
}

#[test]
fn a_caption_whose_segment_has_words_is_replaced_not_removed() {
    let ran = run_opts(Opts {
        mode: EngineMode::Local(local_model()),
        partials: vec![job()],
        close_after_caption: Some((job(), false)),
        ..Opts::default()
    });
    let id = utterance_id(Source::Mic, START);
    assert_eq!(
        ran.lines(),
        vec![
            (id.clone(), "hello from here".into(), false),
            (id.clone(), "hello from here".into(), true),
        ]
    );
    assert!(ran.removed().is_empty());
    assert_eq!(ran.saved(), vec![(id, "hello from here".into())]);
}

/// A slow computer in Cloud mode with live captions off: the local model
/// sits idle while the cloud answers.
fn slow_cloud(cloud: Answer, heard: &Arc<std::sync::Mutex<Vec<usize>>>) -> Ran {
    run_opts(Opts {
        fallback: true,
        cloud: Some(cloud),
        partials: vec![job()],
        segments: vec![job()],
        heard: Some(heard.clone()),
        slow_cloud_live: Some(false),
        ..Opts::default()
    })
}

#[test]
fn a_slow_computer_in_cloud_runs_no_local_pass_while_the_cloud_answers() {
    let heard = Arc::default();
    let ran = slow_cloud(Answer::Words(CLOUD), &heard);
    let id = utterance_id(Source::Mic, START);
    assert_eq!(
        ran.lines(),
        vec![(id.clone(), "hello from the cloud".into(), true)],
        "no caption and no local line: the cloud's line only, as without a local model"
    );
    assert_eq!(ran.saved(), vec![(id, "hello from the cloud".into())]);
    assert!(
        heard.lock().unwrap().is_empty(),
        "the local model never ran"
    );
    assert!(ran.transcript.gaps().is_empty());
}

#[test]
fn a_slow_computer_in_cloud_still_writes_locally_when_the_cloud_fails() {
    let heard = Arc::default();
    let ran = run_opts(Opts {
        fallback: true,
        cloud: Some(Answer::Fail),
        budget: Duration::ZERO,
        segments: vec![job()],
        heard: Some(Arc::clone(&heard)),
        slow_cloud_live: Some(false),
        ..Opts::default()
    });
    let id = utterance_id(Source::Mic, START);
    assert_eq!(
        ran.saved(),
        vec![(id, "hello from here".into())],
        "nothing lost"
    );
    assert_eq!(
        heard.lock().unwrap().len(),
        1,
        "one local pass, for the failed clip"
    );
    assert!(ran.transcript.gaps().is_empty());
    assert_eq!(
        ran.last_status().unwrap().cloud,
        CloudState::Down { local: true }
    );
}

#[test]
fn a_slow_computer_without_pro_falls_back_to_local_finals_without_captions() {
    let heard = Arc::default();
    let ran = slow_cloud(Answer::Upgrade, &heard);
    let id = utterance_id(Source::Mic, START);
    assert_eq!(ran.saved(), vec![(id.clone(), "hello from here".into())]);
    assert!(
        ran.lines().iter().all(|(_, _, is_final)| *is_final),
        "captions stay off: {:?}",
        ran.lines()
    );
    let status = ran.last_status().unwrap();
    assert!(
        matches!(status.kind, EngineKind::Local { .. }),
        "{status:?}"
    );
    assert!(ran.transcript.gaps().is_empty());
}

#[test]
fn a_slow_computer_that_turned_captions_on_gets_cloud_as_before() {
    let heard: Arc<std::sync::Mutex<Vec<usize>>> = Arc::default();
    let ran = run_opts(Opts {
        fallback: true,
        cloud: Some(Answer::Words(CLOUD)),
        partials: vec![job()],
        segments: vec![job()],
        heard: Some(heard.clone()),
        slow_cloud_live: Some(true),
        ..Opts::default()
    });
    let before = run_opts(Opts {
        fallback: true,
        cloud: Some(Answer::Words(CLOUD)),
        partials: vec![job()],
        segments: vec![job()],
        ..Opts::default()
    });
    assert_eq!(ran.lines(), before.lines());
    assert_eq!(ran.saved(), before.saved());
    assert!(!heard.lock().unwrap().is_empty());
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
            slow_cloud_live: None,
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
    worker.hooks.local = Some(words_at_end(LOCAL, 2.0));
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

fn w(text: &str, start_ms: u64, end_ms: u64) -> Word {
    Word {
        text: text.into(),
        start_ms,
        end_ms,
    }
}

fn texts(words: &[Word]) -> Vec<&str> {
    words.iter().map(|w| w.text.as_str()).collect()
}

#[test]
fn live_captions_keep_words_two_passes_agree_on_and_hear_only_what_follows() {
    let mut live = LiveSegment::new(START);
    let first = vec![
        w("so", 1_000, 1_300),
        w("the", 1_400, 1_600),
        w("plan", 1_700, 2_100),
        w("is", 3_500, 3_800),
    ];
    let shown = live.heard(first.clone(), 1_000, 4_000);
    assert_eq!(texts(&shown), ["so", "the", "plan", "is"]);
    assert_eq!(live.from, 0, "nothing is kept after one pass");

    let mut second = first.clone();
    second.push(w("simple", 4_100, 4_500));
    let shown = live.heard(second, 1_000, 4_700);
    assert_eq!(texts(&shown), ["so", "the", "plan", "is", "simple"]);
    assert_eq!(
        texts(&live.kept),
        ["so", "the", "plan"],
        "the last second waits for more audio"
    );
    assert_eq!(
        live.from,
        timeline::ms_to_samples((2_100 + 3_500) / 2 - 1_000) as usize
    );
}

#[test]
fn live_captions_never_keep_a_word_the_next_pass_heard_differently() {
    let mut live = LiveSegment::new(START);
    live.heard(
        vec![
            w("so", 1_000, 1_300),
            w("the", 1_400, 1_600),
            w("plan", 1_700, 2_100),
        ],
        1_000,
        4_000,
    );
    let shown = live.heard(
        vec![
            w("so", 1_000, 1_300),
            w("they", 1_400, 1_600),
            w("plan", 1_700, 2_100),
        ],
        1_000,
        5_000,
    );
    assert_eq!(texts(&live.kept), ["so"]);
    assert_eq!(texts(&shown), ["so", "they", "plan"]);
}

#[test]
fn a_long_caption_pass_keeps_its_older_words_even_without_agreement() {
    let mut live = LiveSegment::new(START);
    let words: Vec<Word> = (0..10)
        .map(|i| w(&format!("w{i}"), 1_000 + i * 900, 1_000 + i * 900 + 600))
        .collect();
    let shown = live.heard(words.clone(), 1_000, 10_500);
    assert_eq!(texts(&shown), texts(&words), "the caption shows every word");
    assert_eq!(
        texts(&live.kept),
        ["w0", "w1", "w2", "w3", "w4", "w5"],
        "a 9.5 s pass keeps the words older than 4 s though nothing agreed yet"
    );
    assert_eq!(
        live.from,
        timeline::ms_to_samples((6_100 + 6_400) / 2 - 1_000) as usize
    );
}

#[test]
fn caption_passes_hear_the_audio_after_their_kept_words_and_finals_hear_everything() {
    let heard = Arc::new(std::sync::Mutex::new(Vec::new()));
    let partial = |secs: usize| SegmentJob {
        samples: vec![0.0; 16_000 * secs],
        speech_ms: 0,
        ..job()
    };
    run_opts(Opts {
        mode: EngineMode::Local(local_model()),
        partials: vec![partial(4), partial(6), partial(8)],
        heard: Some(heard.clone()),
        words_at_start: true,
        ..Opts::default()
    });
    // LOCAL's words end at 0.3, 0.7 and 1.1 s: the second pass agrees on
    // all three and keeps the first two, so the third starts between
    // "from" and "here" (0.75 s in).
    assert_eq!(
        *heard.lock().unwrap(),
        vec![64_000, 96_000, 128_000 - 12_000]
    );

    let heard = Arc::new(std::sync::Mutex::new(Vec::new()));
    run_opts(Opts {
        mode: EngineMode::Local(local_model()),
        segments: vec![SegmentJob {
            samples: vec![0.0; 16_000 * 8],
            ..job()
        }],
        heard: Some(heard.clone()),
        ..Opts::default()
    });
    assert_eq!(
        *heard.lock().unwrap(),
        vec![128_000],
        "a final line hears the whole segment"
    );
}

#[test]
fn sweep_stretches_stop_where_the_saved_audio_ends() {
    // Speech runs to the end of a track whose saved audio stops 390 samples
    // into its last 30 ms frame (a meeting stopped mid-sentence).
    let end = 845 * SWEEP_FRAME as u64 + 390;
    let track = levels(&[(700, 846)], 846);
    let missing = sweep_missing(&track, &[], &[], &[]);
    let reach = missing.iter().map(|(s, l)| s + l).max().unwrap();
    assert!(reach > end, "the frame grid alone reaches past the audio: {reach}");
    let kept = within_track(missing, end);
    assert_eq!(kept.iter().map(|(s, l)| s + l).max(), Some(end));
    assert!(within_track(vec![(end, 100), (end + 10, 100)], end).is_empty());
}

/// A worker holding one ledger gap, as after Stop or at the next launch.
struct Bench {
    worker: Worker,
    path: std::path::PathBuf,
    _dir: tempfile::TempDir,
    _runtime: tokio::runtime::Runtime,
    _senders: (
        flume::Sender<SegmentJob>,
        flume::Sender<SegmentJob>,
        flume::Sender<Missed>,
        flume::Sender<EngineCommand>,
    ),
    _events: flume::Receiver<EngineEvent>,
}

fn bench(gap: Gap, audio: Vec<AudioPart>) -> Bench {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("transcript.jsonl");
    append_jsonl(&path, &[LogLine::Gap { gap: gap.clone() }]).unwrap();
    let (events_tx, events_rx) = flume::unbounded();
    let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
    let (s, segments_rx) = flume::bounded(1);
    let (p, partials_rx) = flume::bounded(1);
    let (m, missed_rx) = flume::unbounded();
    let (c, commands_rx) = flume::unbounded();
    let mut worker = Worker::new(
        EngineConfig {
            doc_id: "doc".into(),
            transcript_path: path.clone(),
            mode: EngineMode::Local(local_model()),
            fallback: None,
            vocabulary: Vec::new(),
            dictionary: Arc::new(cap_meetings::dictionary::Corrector::new(&[])),
            live: false,
            slow_cloud_live: None,
            voices: None,
            audio,
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
    worker.hooks.local = Some(Arc::new(|_| Ok(caption_words(LOCAL))));
    Bench { worker, path, _dir: dir, _runtime: runtime, _senders: (s, p, m, c), _events: events_rx }
}

fn tail_gap(start: u64, len: u64) -> Gap {
    Gap {
        id: Gap::id_for(Source::System, start),
        source: Source::System,
        start_sample: start,
        end_sample: start + len,
        segments: vec![(start, len)],
        reason: reason::SWEEP.into(),
    }
}

#[test]
fn after_stop_a_track_that_ends_early_is_repaired_with_what_it_holds() {
    // The ledger asks for 90 samples more than the saved file holds.
    let gap = tail_gap(START, 19_360);
    let mut b = bench(gap, Vec::new());
    b.worker.hooks.audio = Some(Arc::new(|_, _, len| Some(vec![0.1; len as usize - 90])));
    b.worker.hooks.local = Some(words_at_end(LOCAL, 1.2));
    b.worker.finishing = true;
    b.worker.repair_after_stop();
    let (transcript, _) = Transcript::load_jsonl(&b.path).unwrap();
    assert!(transcript.gaps().is_empty(), "the gap closed: {:?}", transcript.gaps());
    let line = transcript.get(&utterance_id(Source::System, START)).expect("the tail got its words");
    assert_eq!(line.text, "hello from here");
}

#[test]
fn while_recording_a_short_read_waits_for_the_rest() {
    let gap = tail_gap(START, 19_360);
    let mut b = bench(gap.clone(), Vec::new());
    b.worker.hooks.audio = Some(Arc::new(|_, _, len| Some(vec![0.1; len as usize - 90])));
    assert!(b.worker.gap_jobs(&gap).is_none(), "the file is still being written");
    b.worker.finishing = true;
    let jobs = b.worker.gap_jobs(&gap).expect("after Stop the file is complete");
    assert_eq!(jobs[0].samples.len(), 19_360 - 90);
    // Nothing at all is still nothing to repair.
    b.worker.hooks.audio = Some(Arc::new(|_, _, _| Some(Vec::new())));
    b.worker.repairing.clear();
    assert!(b.worker.gap_jobs(&gap).is_none());
}

#[test]
fn a_tail_across_a_clock_jump_is_transcribed_on_both_sides_of_the_hole() {
    // Speech 8-10 s into each file, as the speech segmenter hears it.
    fn file(seconds: u64) -> Vec<f32> {
        (0..seconds * 16_000)
            .map(|at| {
                if (8 * 16_000..10 * 16_000).contains(&at) {
                    0.3 * ((at as f32) * 0.37).sin() * if at % 7 < 4 { 1.0 } else { -0.6 }
                } else {
                    0.0005 * if at % 3 == 0 { 1.0 } else { -1.0 }
                }
            })
            .collect()
    }
    let dir = tempfile::tempdir().unwrap();
    // 40 s, then the clock jumps 90 s and the track goes on in a new file.
    let after_jump = 130 * 16_000;
    let mut parts = Vec::new();
    for (name, offset) in [("others.ogg", 0), ("others.r1.ogg", after_jump)] {
        let path = dir.path().join(name);
        let mut writer = crate::meetings::audio_file::OpusOggWriter::create(&path).unwrap();
        writer.write(&file(40)).unwrap();
        writer.finish().unwrap();
        parts.push(AudioPart { source: Source::System, path, offset_samples: offset });
    }
    let gap = Gap {
        id: Gap::id_for(Source::System, 0),
        source: Source::System,
        start_sample: 0,
        end_sample: after_jump + 40 * 16_000,
        segments: Vec::new(),
        reason: reason::TAIL.into(),
    };
    let mut b = bench(gap.clone(), parts);
    b.worker.finishing = true;
    let jobs = b.worker.gap_jobs(&gap).expect("the saved audio");
    let starts: Vec<u64> = jobs.iter().map(|j| j.start_sample / 16_000).collect();
    assert!(starts.iter().any(|s| *s < 40), "speech before the jump: {starts:?}");
    assert!(starts.iter().any(|s| *s >= 130), "speech after the jump: {starts:?}");
    b.worker.repairing.clear();

    b.worker.repair_after_stop();
    let (transcript, _) = Transcript::load_jsonl(&b.path).unwrap();
    let heard: Vec<u64> = transcript
        .utterances()
        .iter()
        .filter(|u| u.text == "hello from here")
        .map(|u| u.start_ms / 1000)
        .collect();
    assert!(heard.iter().any(|s| *s < 40), "{heard:?}");
    assert!(heard.iter().any(|s| *s >= 130), "the words after the jump: {heard:?}");
    assert!(transcript.gaps().is_empty(), "closed once both sides were heard");
}

#[test]
fn after_stop_the_saved_audio_is_read_again_from_the_finished_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("audio/others.ogg");
    let tone: Vec<f32> = (0..16_000 * 5)
        .map(|n| (0.3 * (n as f64 * 440.0 * std::f64::consts::TAU / 16_000.0).sin()) as f32)
        .collect();
    let mut writer = crate::meetings::audio_file::OpusOggWriter::create(&file).unwrap();
    writer.write(&tone[..16_000 * 3]).unwrap();
    // 2 s .. 3.5 s: not all written yet while the meeting runs.
    let gap = tail_gap(32_000, 24_000);
    let part = AudioPart { source: Source::System, path: file.clone(), offset_samples: 0 };
    let mut b = bench(gap.clone(), vec![part]);
    let heard = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = heard.clone();
    let words = words_at_end(LOCAL, 1.5);
    b.worker.hooks.local = Some(Arc::new(move |samples: &[f32]| {
        seen.store(samples.len(), Ordering::SeqCst);
        words(samples)
    }));
    assert!(b.worker.gap_jobs(&gap).is_none(), "still being written");
    b.worker.repairing.clear();
    // The meeting ends: the rest is written and the file finished.
    writer.write(&tone[16_000 * 3..]).unwrap();
    writer.finish().unwrap();
    drop(writer);
    b.worker.finishing = true;
    b.worker.repair_after_stop();
    assert_eq!(
        heard.load(Ordering::SeqCst),
        24_000,
        "the whole stretch, not what the early reader saw"
    );
    let (transcript, _) = Transcript::load_jsonl(&b.path).unwrap();
    assert!(transcript.gaps().is_empty());
    let line = transcript.get(&utterance_id(Source::System, 32_000)).expect("the stretch got its words");
    assert_eq!(line.text, "hello from here");
}

#[test]
fn a_short_tail_gap_the_model_cannot_hear_alone_gets_no_guessed_words() {
    // The meeting stopped mid-sentence: the sweep's gap holds the last 1.2 s,
    // starting inside a word. The repair hears the segment alone, as context
    // costs far more words elsewhere; a model that hears nothing in it writes
    // nothing, so no guess at the cut ever reaches the transcript.
    let start = START * 10;
    let gap = tail_gap(start, 19_360);
    let mut b = bench(gap, Vec::new());
    let mut line = utterance(Source::System, 0, vec![Word { text: "his".into(), start_ms: 9_200, end_ms: 9_500 }], true).unwrap();
    line.id = "s0".into();
    append_jsonl(&b.path, &[LogLine::Upsert { utterance: line }]).unwrap();
    b.worker.hooks.audio = Some(Arc::new(|_, _, len| Some(vec![0.1; len as usize])));
    b.worker.hooks.local = Some(Arc::new(|samples: &[f32]| {
        let secs = samples.len() as f32 / 16_000.0;
        if secs < 2.0 {
            return Ok(Vec::new());
        }
        let at = |text: &str, from: f32, to: f32| CaptionWord { text: text.into(), start: secs + from, end: secs + to };
        // "his" is context (heard already), the rest is the gap's own.
        Ok(vec![at("his", -2.8, -2.5), at("revelation", -1.3, -0.6), at("lighted", -0.5, -0.1)])
    }));
    b.worker.finishing = true;
    b.worker.repair_after_stop();
    let (transcript, _) = Transcript::load_jsonl(&b.path).unwrap();
    assert!(transcript.get(&utterance_id(Source::System, start)).is_none(), "nothing is guessed");
    assert!(transcript.gaps().is_empty(), "{:?}", transcript.gaps());
}

/// A track whose first writer failed at 3 s; the next file starts at 4 s.
fn split_track(dir: &std::path::Path) -> Vec<AudioPart> {
    let tone = |hz: f64, secs: usize| -> Vec<f32> {
        (0..16_000 * secs)
            .map(|n| (0.3 * (n as f64 * hz * std::f64::consts::TAU / 16_000.0).sin()) as f32)
            .collect()
    };
    let mut parts = Vec::new();
    for (name, offset, hz) in [("others.ogg", 0u64, 440.0), ("others-2.ogg", 64_000u64, 660.0)] {
        let path = dir.join("audio").join(name);
        let mut writer = crate::meetings::audio_file::OpusOggWriter::create(&path).unwrap();
        writer.write(&tone(hz, 3)).unwrap();
        writer.finish().unwrap();
        parts.push(AudioPart { source: Source::System, path, offset_samples: offset });
    }
    parts
}

#[test]
fn a_segment_just_after_a_new_audio_file_is_repaired_from_that_file() {
    // 0.5 s into the second file: its context must not reach back into the
    // first file's end and the unsaved second between them.
    let dir = tempfile::tempdir().unwrap();
    let parts = split_track(dir.path());
    let gap = tail_gap(64_000 + 8_000, 16_000);
    let mut b = bench(gap.clone(), parts);
    let jobs = b.worker.gap_jobs(&gap).expect("readable while recording");
    assert_eq!(jobs[0].samples.len(), 16_000);
    b.worker.repairing.clear();
    let heard = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = heard.clone();
    let words = words_at_end(LOCAL, 1.0);
    b.worker.hooks.local = Some(Arc::new(move |samples: &[f32]| {
        seen.store(samples.len(), Ordering::SeqCst);
        words(samples)
    }));
    b.worker.finishing = true;
    b.worker.repair_after_stop();
    assert_eq!(heard.load(Ordering::SeqCst), 16_000, "the segment alone, nothing from the first file");
    let (transcript, _) = Transcript::load_jsonl(&b.path).unwrap();
    assert!(transcript.gaps().is_empty(), "{:?}", transcript.gaps());
    assert_eq!(
        transcript.get(&utterance_id(Source::System, 72_000)).unwrap().text,
        "hello from here"
    );
}

#[test]
fn a_segment_across_the_unsaved_stretch_reads_on_into_the_next_file() {
    // From 3.5 s (unsaved) to 5 s: silence for what was never saved, then
    // the second file, not a short read that looks like the end.
    let dir = tempfile::tempdir().unwrap();
    let parts = split_track(dir.path());
    let gap = tail_gap(64_000 - 8_000, 24_000);
    let mut b = bench(gap.clone(), parts);
    let jobs = b.worker.gap_jobs(&gap).expect("readable while recording");
    let samples = &jobs[0].samples;
    assert_eq!(samples.len(), 24_000);
    assert!(samples[..8_000].iter().all(|x| *x == 0.0), "the unsaved stretch is silence");
    let loud = samples[8_000..].iter().map(|x| x * x).sum::<f32>() / 16_000.0;
    assert!(loud > 0.01, "the second file's audio follows: {loud}");
    b.worker.repairing.clear();
    b.worker.hooks.local = Some(words_at_end(LOCAL, 1.0));
    b.worker.finishing = true;
    b.worker.repair_after_stop();
    let (transcript, _) = Transcript::load_jsonl(&b.path).unwrap();
    assert!(transcript.gaps().is_empty(), "{:?}", transcript.gaps());
    assert_eq!(
        transcript.get(&utterance_id(Source::System, 56_000)).unwrap().text,
        "hello from here"
    );
}

#[test]
fn a_long_tail_is_read_in_fixed_pieces_and_finds_the_same_speech() {
    // Speech for 2 s in every 40 s of an 11-minute tail, then the file ends.
    fn said(at: u64) -> f32 {
        let s = at % (40 * 16_000);
        if (8 * 16_000..10 * 16_000).contains(&s) {
            0.3 * ((at as f32) * 0.37).sin() * if at % 7 < 4 { 1.0 } else { -0.6 }
        } else {
            0.0005 * if at % 3 == 0 { 1.0 } else { -1.0 }
        }
    }
    let total: u64 = 11 * 60 * 16_000;
    let saved = total - 5_000;
    let gap = Gap {
        id: Gap::id_for(Source::System, START),
        source: Source::System,
        start_sample: START,
        end_sample: START + total,
        segments: Vec::new(),
        reason: reason::TAIL.into(),
    };
    let mut b = bench(gap.clone(), Vec::new());
    let reads = Arc::new(std::sync::Mutex::new(Vec::new()));
    b.worker.hooks.audio = Some(Arc::new({
        let reads = reads.clone();
        move |_, start, len| {
            reads.lock().unwrap().push(len);
            let end = (start + len).min(START + saved);
            Some((start..end.max(start)).map(|at| said(at - START)).collect())
        }
    }));
    b.worker.finishing = true;
    let jobs = b.worker.gap_jobs(&gap).expect("the tail's audio");

    let whole: Vec<f32> = (0..saved).map(said).collect();
    let mut segmenter = Segmenter::new(SegmenterConfig::default());
    let mut expected = segmenter.push(START, &whole);
    expected.extend(segmenter.flush());
    assert!(expected.len() >= 10, "{} segments", expected.len());
    let got: Vec<_> = jobs.iter().map(|j| (j.start_sample, j.samples.clone())).collect();
    let want: Vec<_> = expected.into_iter().map(|s| (s.start_sample, s.samples)).collect();
    assert_eq!(got, want);
    let reads = reads.lock().unwrap();
    assert!(reads.iter().all(|len| *len <= SWEEP_READ_SAMPLES), "{reads:?}");
}
