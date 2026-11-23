//! Runs one recording through the app's speech segmenter and the diarizer
//! the way a meeting would, and writes live and final labels for scoring.
//!
//! diarize-eval <model.onnx> <out.json> <system.wav> [mic.wav] [key=value ...]
//!
//! Keys: threads, optimize (0|1), profile (path), save_profile (path),
//! peek (0|1: label partial words with `MeetingDiarizer::peek` the way the
//! app does; 0 = the last speaker on the track), words (a JSON file
//! `{"mic": [ms], "system": [ms]}` of word middles, reported for each segment
//! as the app reports transcribed words), any `Config` field. Debug environment: DIARIZE_DUMMY (no model),
//! DIARIZE_SEGMENTS_ONLY (segmenter only), DIARIZE_SHAPES_LOG=<file> (input
//! lengths the model saw).

use std::path::Path;
use std::time::Instant;

use cap_diarize::{
    Config, Embed, MeetingDiarizer, OnnxEmbedder, Segment, SegmentLabels, SpeakerId, SpeakerNames,
    Track, VoiceProfile,
};
use cap_meetings::segment::{Segmenter, SegmenterConfig};

const CHUNK: usize = 1_600;
const PARTIAL_EVERY: usize = 16_000;
const PARTIAL_MIN: usize = 24_000;
const PARTIAL_GROWTH: usize = 32_000;

fn read_wav(path: &Path) -> Vec<i16> {
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert_eq!(&bytes[0..4], b"RIFF");
    let mut at = 12;
    let mut format = (0u16, 0u16, 0u32, 0u16);
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let len = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
        let body = &bytes[at + 8..(at + 8 + len).min(bytes.len())];
        if id == b"fmt " {
            format = (
                u16::from_le_bytes(body[0..2].try_into().unwrap()),
                u16::from_le_bytes(body[2..4].try_into().unwrap()),
                u32::from_le_bytes(body[4..8].try_into().unwrap()),
                u16::from_le_bytes(body[14..16].try_into().unwrap()),
            );
        } else if id == b"data" {
            assert_eq!(format, (1, 1, 16_000, 16), "expected 16 kHz mono PCM16");
            return body
                .as_chunks::<2>()
                .0
                .iter()
                .map(|b| i16::from_le_bytes(*b))
                .collect();
        }
        at += 8 + len + (len & 1);
    }
    panic!("no data chunk in {}", path.display());
}

/// What the segmenter hands over while streaming.
enum Event<'a> {
    /// A segment that is still open, offered for partial words with the
    /// app's cadence (`capture.rs`: checked every second once 1.5 s long,
    /// again after 2 s more).
    Partial(Track, u64, &'a [f32]),
    Closed(Track, u64, Vec<f32>),
}

/// Feeds both tracks through the app's segmenter in 100 ms chunks, side by
/// side, and hands each closed segment over in the order the app would see
/// them, so nothing but the open segments is held in memory.
fn stream(tracks: &[(Track, &[i16])], seg: &[SegmenterConfig; 2], mut on_event: impl FnMut(Event<'_>)) {
    let mut segmenters: Vec<Segmenter> = tracks
        .iter()
        .map(|(track, _)| Segmenter::new(seg[usize::from(*track == Track::Mic)].clone()))
        .collect();
    let mut since_partial = vec![0usize; tracks.len()];
    let mut last_partial: Vec<Option<(u64, usize)>> = vec![None; tracks.len()];
    let longest = tracks.iter().map(|(_, a)| a.len()).max().unwrap_or(0);
    let mut chunk = Vec::with_capacity(CHUNK);
    let mut closed = Vec::new();
    for start in (0..longest).step_by(CHUNK) {
        for ((track, audio), segmenter) in tracks.iter().zip(&mut segmenters) {
            if start >= audio.len() {
                continue;
            }
            chunk.clear();
            chunk.extend(
                audio[start..(start + CHUNK).min(audio.len())]
                    .iter()
                    .map(|s| *s as f32 / 32_768.0),
            );
            for s in segmenter.push(start as u64, &chunk) {
                closed.push((s.end_sample(), *track, s.start_sample, s.samples));
            }
        }
        closed.sort_by_key(|c| (c.0, c.1));
        for (_, track, start, samples) in closed.drain(..) {
            on_event(Event::Closed(track, start, samples));
        }
        for (i, ((track, audio), segmenter)) in tracks.iter().zip(&segmenters).enumerate() {
            if start >= audio.len() {
                continue;
            }
            since_partial[i] += CHUNK;
            if since_partial[i] < PARTIAL_EVERY {
                continue;
            }
            since_partial[i] = 0;
            let Some((open_start, samples)) = segmenter.open_snapshot() else {
                continue;
            };
            if samples.len() < PARTIAL_MIN
                || last_partial[i]
                    .is_some_and(|(s, n)| s == open_start && samples.len() < n + PARTIAL_GROWTH)
            {
                continue;
            }
            last_partial[i] = Some((open_start, samples.len()));
            on_event(Event::Partial(*track, open_start, samples));
        }
    }
    for ((track, _), segmenter) in tracks.iter().zip(&mut segmenters) {
        if let Some(s) = segmenter.flush() {
            on_event(Event::Closed(*track, s.start_sample, s.samples));
        }
    }
}

fn set(config: &mut Config, key: &str, value: &str) -> bool {
    let f = || value.parse::<f32>().unwrap();
    let u = || value.parse::<u64>().unwrap();
    match key {
        "window_ms" => config.window_ms = u(),
        "hop_ms" => config.hop_ms = u(),
        "whole_max_ms" => config.whole_max_ms = u(),
        "min_embed_ms" => config.min_embed_ms = u(),
        "assign" => config.assign = f(),
        "new_speaker" => config.new_speaker = f(),
        "new_min_ms" => config.new_min_ms = u(),
        "mic_new_speaker" => config.mic_new_speaker = f(),
        "mic_new_min_ms" => config.mic_new_min_ms = u(),
        "merge" => config.merge = f(),
        "small_ms" => config.small_ms = u(),
        "small_merge" => config.small_merge = f(),
        "refine_rounds" => config.refine_rounds = u() as usize,
        "split" => config.split = f(),
        "split_min_ms" => config.split_min_ms = u(),
        "confirm_ms" => config.confirm_ms = u(),
        "min_speaker_ms" => config.min_speaker_ms = u(),
        "profile_match" => config.profile_match = f(),
        "profile_reject" => config.profile_reject = f(),
        "enrol_min_ms" => config.enrol_min_ms = u(),
        "enrol_max_unlike" => config.enrol_max_unlike = value.parse().unwrap(),
        "echo_slack_ms" => config.echo_slack_ms = u(),
        "max_embeddings" => config.max_embeddings = u() as usize,
        "leak" => config.leak = f(),
        "fold_ms" => config.fold_ms = u(),
        "fold_share" => config.fold_share = f(),
        "fold_merge" => config.fold_merge = f(),
        _ => return false,
    }
    true
}

/// Debug stand-in for the model: a coarse spectral-energy vector.
struct Dummy;

impl Embed for Dummy {
    fn dim(&self) -> usize {
        64
    }

    fn model_id(&self) -> &str {
        "dummy"
    }

    fn embed(&mut self, windows: &[&[f32]]) -> Result<Vec<Vec<f32>>, cap_diarize::Error> {
        Ok(windows
            .iter()
            .map(|w| {
                let mut v: Vec<f32> = w
                    .chunks(w.len().div_ceil(64))
                    .map(|c| c.iter().map(|x| x.abs()).sum::<f32>() + 1e-3)
                    .collect();
                v.resize(64, 1e-3);
                cap_diarize::embed::normalized(&v)
            })
            .collect())
    }
}

/// Debug wrapper: records every input length the model sees.
struct ShapeLog {
    inner: OnnxEmbedder,
    path: String,
    seen: std::collections::BTreeMap<usize, usize>,
}

impl Embed for ShapeLog {
    fn dim(&self) -> usize {
        self.inner.dim()
    }

    fn model_id(&self) -> &str {
        self.inner.model_id()
    }

    fn embed(&mut self, windows: &[&[f32]]) -> Result<Vec<Vec<f32>>, cap_diarize::Error> {
        for w in windows {
            *self.seen.entry(w.len()).or_default() += 1;
        }
        let _ = std::fs::write(&self.path, format!("{:?}", self.seen));
        self.inner.embed(windows)
    }
}

fn rss_kb() -> u64 {
    std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
        .unwrap_or(0)
}

fn labels_json(
    track: Track,
    start: u64,
    len: usize,
    labels: &SegmentLabels,
    push_ms: f64,
) -> serde_json::Value {
    serde_json::json!({
        "track": track,
        "key": labels.key,
        "startMs": start,
        "endMs": start + len as u64 / 16,
        "pushMs": push_ms,
        "spans": labels.spans,
    })
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let model = Path::new(&args[0]);
    let out = Path::new(&args[1]);
    let system = read_wav(Path::new(&args[2]));
    let mut mic = None;
    let mut config = Config::default();
    let mut threads = 1;
    let mut optimize = false;
    let mut profile = None;
    let mut save_profile = None;
    let mut peek = false;
    let mut words: Option<(Vec<u64>, Vec<u64>)> = None;
    let mut nemo: Option<String> = None;
    let mut nemo_threads = 2;
    // nemo_after=1: Nemotron as the app runs it off Apple Silicon (speech kept until Stop, one pass after)
    let mut nemo_after = false;
    let mut seg_config = [SegmenterConfig::default(), SegmenterConfig::microphone()]; // system, mic (as the app)
    for arg in &args[3..] {
        match arg.split_once('=') {
            Some(("threads", v)) => threads = v.parse().unwrap(),
            Some(("optimize", v)) => optimize = v == "1",
            Some(("profile", v)) => profile = VoiceProfile::load(Path::new(v)).ok(),
            Some(("save_profile", v)) => save_profile = Some(v.to_string()),
            Some(("peek", v)) => peek = v == "1",
            Some(("nemo", v)) => nemo = Some(v.to_string()),
            Some(("nemo_threads", v)) => nemo_threads = v.parse().unwrap(),
            Some(("nemo_after", v)) => nemo_after = v == "1",
            Some(("seg_min_db", v)) => seg_config.iter_mut().for_each(|c| c.min_level_db = v.parse().unwrap()),
            Some(("seg_min_db_mic", v)) => seg_config[1].min_level_db = v.parse().unwrap(),
            Some(("seg_max_ms_mic", v)) => seg_config[1].max_segment_ms = v.parse().unwrap(),
            Some(("seg_enter_db", v)) => seg_config.iter_mut().for_each(|c| c.enter_db = v.parse().unwrap()),
            Some(("words", v)) => {
                let w: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(v).expect("words file")).unwrap();
                let list = |k: &str| -> Vec<u64> {
                    let mut l: Vec<u64> = w[k]
                        .as_array()
                        .map(|a| a.iter().filter_map(|x| x.as_u64()).collect())
                        .unwrap_or_default();
                    l.sort_unstable();
                    l
                };
                words = Some((list("mic"), list("system")));
            }
            Some((k, v)) => assert!(set(&mut config, k, v), "unknown key {k}"),
            None => mic = Some(read_wav(Path::new(arg))),
        }
    }

    let load_started = Instant::now();
    let embedder = OnnxEmbedder::load(model, threads, optimize).expect("load model");
    let load_ms = load_started.elapsed().as_secs_f64() * 1000.0;
    let model_id = embedder.info().id.clone();
    let embedder: Box<dyn Embed> = if std::env::var_os("DIARIZE_DUMMY").is_some() {
        Box::new(Dummy)
    } else {
        match std::env::var("DIARIZE_SHAPES_LOG") {
            Ok(path) => Box::new(ShapeLog {
                inner: embedder,
                path,
                seen: std::collections::BTreeMap::new(),
            }),
            Err(_) => Box::new(embedder),
        }
    };
    let mut diarizer = MeetingDiarizer::new(config.clone(), embedder, profile);
    let mut nemo_load_ms = 0.0;
    if let Some(path) = &nemo {
        let t = Instant::now();
        let model = cap_diarize::nemotron::OnnxNemotron::load(Path::new(path), nemo_threads).expect("load nemotron");
        nemo_load_ms = t.elapsed().as_secs_f64() * 1000.0;
        if nemo_after {
            diarizer.set_nemotron_with(Box::new(model), cap_diarize::nemotron::Schedule::AfterStop, || {});
        } else {
            diarizer.set_nemotron(Box::new(model));
        }
    }

    let mut tracks: Vec<(Track, &[i16])> = vec![(Track::System, &system)];
    if let Some(mic) = &mic {
        tracks.push((Track::Mic, mic));
    }
    let mut live = Vec::new();
    let mut push_times = Vec::new();
    let mut memory = vec![(0u64, rss_kb())];
    let mut segments = 0usize;
    let mut speech_secs = 0f64;
    let started = Instant::now();
    let segments_only = std::env::var_os("DIARIZE_SEGMENTS_ONLY").is_some();
    let mut partials = Vec::new();
    let mut last: [Option<SpeakerId>; 2] = [None, None];
    let mut heard: Vec<SpeakerId> = Vec::new();
    let mut names = SpeakerNames::new(None);
    let slot = |track: Track| match track {
        Track::Mic => 0,
        Track::System => 1,
    };
    stream(&tracks, &seg_config, |event| {
        let (track, start, samples) = match event {
            Event::Partial(track, start, samples) => {
                if segments_only {
                    return;
                }
                let t = Instant::now();
                let peeked = if peek {
                    diarizer
                        .peek(Segment {
                            track,
                            key: start,
                            start_ms: start / 16,
                            samples,
                        })
                        .expect("peek")
                } else {
                    None
                };
                partials.push(serde_json::json!({
                    "track": track,
                    "key": start,
                    "atMs": (start + samples.len() as u64) / 16,
                    "last": last[slot(track)],
                    "peek": peeked,
                    "ms": t.elapsed().as_secs_f64() * 1000.0,
                }));
                return;
            }
            Event::Closed(track, start, samples) => (track, start, samples),
        };
        if segments_only {
            segments += 1;
            if segments.is_multiple_of(10) {
                memory.push(((start + samples.len() as u64) / 16, rss_kb()));
            }
            return;
        }
        let t = Instant::now();
        let labels = diarizer
            .push(Segment {
                track,
                key: start,
                start_ms: start / 16,
                samples: &samples,
            })
            .expect("push");
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        push_times.push(ms);
        if let Some((mic_words, system_words)) = &words {
            let list = match track {
                Track::Mic => mic_words,
                Track::System => system_words,
            };
            let (a, b) = (start / 16, (start + samples.len() as u64) / 16);
            let from = list.partition_point(|&m| m < a);
            let to = list.partition_point(|&m| m < b);
            diarizer.transcribed(track, start, &list[from..to]);
        }
        segments += 1;
        speech_secs += samples.len() as f64 / 16_000.0;
        if let Some(span) = labels.spans.iter().rev().find(|s| !s.echo) {
            last[slot(track)] = Some(span.speaker);
        }
        for span in labels.spans.iter().filter(|s| !s.echo) {
            if !heard.contains(&span.speaker) {
                heard.push(span.speaker);
            }
        }
        let speaking: Vec<_> = diarizer
            .speakers()
            .into_iter()
            .filter(|s| heard.contains(&s.id))
            .collect();
        names.observe(&speaking);
        live.push(labels_json(track, start / 16, samples.len(), &labels, ms));
        if live.len().is_multiple_of(10) {
            memory.push(((start + samples.len() as u64) / 16, rss_kb()));
        }
    });
    memory.push((u64::MAX, rss_kb()));
    let live_secs = started.elapsed().as_secs_f64();
    let live_speakers = diarizer.speakers();
    let t = Instant::now();
    let mut pass = diarizer.finish();
    let final_ms = t.elapsed().as_secs_f64() * 1000.0;
    // the recording is over: a CPU probe reading stdout splits recording from after Stop here
    {
        use std::io::Write as _;
        println!("AF_PHASE stop");
        let _ = std::io::stdout().flush();
    }
    let mut after_stop: Option<serde_json::Value> = None;
    if let Some(late) = diarizer.take_late() {
        let t = Instant::now();
        after_stop = Some(match late.wait() {
            Ok((corrected, h)) => {
                pass = corrected;
                serde_json::json!({"ms": t.elapsed().as_secs_f64() * 1000.0, "relabelledMs": h.relabelled_ms,
                                   "newVoices": h.new_voices, "mergedIds": h.merged_ids, "error": null})
            }
            Err(e) => serde_json::json!({"ms": t.elapsed().as_secs_f64() * 1000.0, "error": e}),
        });
    }
    {
        use std::io::Write as _;
        println!("AF_PHASE done");
        let _ = std::io::stdout().flush();
    }
    let label_map = |names: &SpeakerNames, ids: &[SpeakerId]| -> serde_json::Value {
        ids.iter()
            .filter_map(|id| {
                names
                    .label(*id)
                    .map(|l| (id.0.to_string(), serde_json::Value::from(format!("{l:?}"))))
            })
            .collect::<serde_json::Map<_, _>>()
            .into()
    };
    let mut all_ids: Vec<SpeakerId> = heard.clone();
    all_ids.extend(pass.speakers.iter().map(|s| s.id));
    all_ids.sort();
    all_ids.dedup();
    let live_names = label_map(&names, &all_ids);
    let name_changes = names.apply_final(&pass).len();
    let final_names = label_map(&names, &all_ids);
    if let (Some(path), Some(profile)) = (&save_profile, &pass.enrolment) {
        profile.save(Path::new(path)).expect("save profile");
    }
    let stats = diarizer.stats();
    let mut sorted = push_times.clone();
    sorted.sort_by(f64::total_cmp);
    let pct = |p: f64| {
        sorted
            .get(((sorted.len() as f64 - 1.0) * p) as usize)
            .copied()
            .unwrap_or(0.0)
    };
    let audio_secs = system.len().max(mic.as_ref().map_or(0, Vec::len)) as f64 / 16_000.0;
    let report = serde_json::json!({
        "model": model_id,
        "config": format!("{config:?}"),
        "threads": threads,
        "optimize": optimize,
        "audioSecs": audio_secs,
        "speechSecs": speech_secs,
        "segments": segments,
        "windows": stats.windows,
        "loadMs": load_ms,
        "liveSecs": live_secs,
        "embedSecs": stats.embed_time.as_secs_f64(),
        "finalMs": final_ms,
        "pushMs": {"p50": pct(0.5), "p90": pct(0.9), "p99": pct(0.99), "max": pct(1.0)},
        "embeddingsKept": stats.embeddings_kept,
        "rssKb": memory,
        "liveSpeakers": live_speakers,
        "peek": peek,
        "reusedWindows": stats.reused_windows,
        "micAbsorbedMs": stats.mic_absorbed_ms,
        "nemotron": {"model": nemo, "threads": nemo_threads, "loadMs": nemo_load_ms, "applied": stats.nemotron_applied,
                     "relabelledMs": stats.nemotron_relabelled_ms, "newVoices": stats.nemotron_new_voices,
                     "mergedIds": stats.nemotron_merged_ids, "error": diarizer.nemotron_error(),
                     "activeSecs": diarizer.nemotron_voices().map(|v| [v[0].active_secs().to_vec(), v[1].active_secs().to_vec()]),
                     "afterStop": after_stop},
        "earlyWindows": stats.early_windows,
        "partials": partials,
        "liveNames": live_names,
        "finalNames": final_names,
        "nameChanges": name_changes,
        "live": live,
        "final": pass,
    });
    std::fs::write(out, serde_json::to_vec(&report).unwrap()).expect("write report");
    // DIARIZE_NEMO_DUMP=<dir>: the Nemotron voices of both tracks, to try final-pass rules offline
    if let (Ok(dir), Some(v)) = (std::env::var("DIARIZE_NEMO_DUMP"), diarizer.nemotron_voices()) {
        let stem = out.file_stem().unwrap().to_string_lossy().to_string();
        for (name, tv) in [("mic", &v[0]), ("system", &v[1])] {
            std::fs::write(format!("{dir}/{stem}.{name}.u8"), tv.raw()).expect("dump");
            std::fs::write(format!("{dir}/{stem}.{name}.parts.json"), serde_json::to_vec(&tv.parts()).unwrap()).expect("dump");
        }
    }
}
