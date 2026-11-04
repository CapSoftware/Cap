//! Regression guard for verbatim transcription on committed clips: every
//! caption model's recorded output for each clip is finished by the real
//! alignment and snapping code (with the aligner's recorded emissions in place
//! of the ONNX model) and scored against exact word boundaries.
//! `record_verbatim_fixtures` regenerates the recordings from real models.

use super::eval::{Envelope, Manifest, Tally, TimingTruth};
use super::*;

const ENGINES: [&str; 4] = ["small", "medium", "best", "best-max"];
const LOG_PROB_STEP: f32 = 0.1;

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/transcription")
}

fn clip_samples(path: &Path) -> Vec<f32> {
    let decoded = cap_audio::AudioData::from_file(path).expect("fixture audio decodes");
    let channels = usize::from(decoded.channels());
    let mono: Vec<f32> = decoded
        .samples()
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect();
    let dir = tempfile::tempdir().expect("temp dir");
    let wav = dir.path().join("clip.wav");
    ffmpeg::init().expect("ffmpeg");
    write_wav_16k_mono(&mono, &wav).expect("resample");
    read_wav_16k_mono(&wav).expect("read resampled")
}

struct Recorded;

impl Recorded {
    fn load(path: &Path) -> align::Heard {
        let bytes = std::fs::read(path).expect("emissions");
        let classes = usize::from(bytes[0]);
        let log_probs = bytes[1..]
            .iter()
            .map(|byte| -f32::from(*byte) * LOG_PROB_STEP)
            .collect();
        align::Heard::new(log_probs, classes)
    }

    fn encode(log_probs: &[f32], classes: usize) -> Vec<u8> {
        let mut bytes = vec![classes as u8];
        bytes.extend(
            log_probs
                .iter()
                .map(|value| (-value / LOG_PROB_STEP).round().clamp(0.0, 255.0) as u8),
        );
        bytes
    }
}

fn raw_path(engine: &str, clip: &str) -> PathBuf {
    fixture_dir()
        .join("raw")
        .join(engine)
        .join(format!("{clip}.json"))
}

fn emissions_path(clip: &str) -> PathBuf {
    fixture_dir().join("emissions").join(format!("{clip}.bin"))
}

fn score(engine: &str, options: &VerbatimOptions, align: bool) -> Tally {
    let manifest = Manifest::load(&fixture_dir()).expect("fixture manifest");
    let mut tally = Tally::default();
    for clip in &manifest.clips {
        let samples = clip_samples(&fixture_dir().join(&clip.audio));
        let raw: Vec<Vec<CaptionWord>> = serde_json::from_str(
            &std::fs::read_to_string(raw_path(engine, &clip.id)).expect("raw output"),
        )
        .expect("raw json");
        let mut recorded = Recorded::load(&emissions_path(&clip.id));
        let aligner = align.then_some(&mut recorded as &mut dyn align::Emissions);
        let words: Vec<CaptionWord> = finish_words(raw, &samples, options, aligner)
            .into_iter()
            .flatten()
            .collect();
        let timing = if clip.id.starts_with("splice") {
            TimingTruth::Exact
        } else {
            TimingTruth::None
        };
        let envelope = Envelope::new(&samples, WHISPER_SAMPLE_RATE);
        tally.score(&clip.words, &words, timing, Some(&envelope));
    }
    tally
}

#[test]
fn verbatim_finish_keeps_fillers_and_tightens_every_engines_word_timing() {
    let results: Vec<_> = ENGINES
        .iter()
        .map(|engine| {
            let before = score(engine, &VerbatimOptions::BASELINE, false).summary();
            let after = score(engine, &VerbatimOptions::default(), true).summary();
            eprintln!(
                "{engine}: start median {:.0} -> {:.0} ms, end median {:.0} -> {:.0} ms, pause edges {:.0} ms, cut safety {:.0}% -> {:.0}%, filler recall {:.0}% -> {:.0}%",
                before.start_median_ms,
                after.start_median_ms,
                before.end_median_ms,
                after.end_median_ms,
                after.pause_edge_median_ms,
                before.cut_safety * 100.0,
                after.cut_safety * 100.0,
                before.hesitation_recall * 100.0,
                after.hesitation_recall * 100.0,
            );
            (engine, before, after)
        })
        .collect();
    for (engine, before, after) in results {
        assert!(
            after.hesitation_recall >= before.hesitation_recall,
            "{engine}: finishing lost fillers"
        );
        assert!(
            after.start_median_ms <= 25.0 && after.end_median_ms <= 25.0,
            "{engine}: {after:?}"
        );
        assert!(after.pause_edge_median_ms <= 10.0, "{engine}: {after:?}");
        assert!(
            after.cut_safety >= 0.8 && after.cut_safety >= before.cut_safety + 0.1,
            "{engine}: {before:?} -> {after:?}"
        );
    }
}

#[test]
#[ignore = "needs CAP_EVAL_ALIGNER, and CAP_FIXTURE_MODELS (a transcription_models directory) to re-record engine output"]
fn record_verbatim_fixtures() {
    let models = std::env::var("CAP_FIXTURE_MODELS").ok().map(PathBuf::from);
    let aligner = std::env::var("CAP_EVAL_ALIGNER").expect("CAP_EVAL_ALIGNER");
    let mut acoustic = align::AcousticPool::load(Path::new(&aligner)).expect("aligner");
    let manifest = Manifest::load(&fixture_dir()).expect("fixture manifest");
    let options = VerbatimOptions::default();
    for clip in &manifest.clips {
        let samples = clip_samples(&fixture_dir().join(&clip.audio));
        let (log_probs, classes) = align::Heard::hear(
            &samples,
            &mut acoustic,
            &std::sync::atomic::AtomicBool::new(false),
        )
        .expect("emissions")
        .expect("not stopped")
        .into_parts();
        std::fs::create_dir_all(emissions_path(&clip.id).parent().unwrap()).unwrap();
        std::fs::write(
            emissions_path(&clip.id),
            Recorded::encode(&log_probs, classes),
        )
        .unwrap();
        let Some(models) = &models else {
            continue;
        };
        for engine in ENGINES {
            let file = models.join(match engine {
                "best" => "parakeet-best".to_string(),
                "best-max" => "parakeet-best-max".to_string(),
                other => format!("{other}.bin"),
            });
            let raw = if is_parakeet_model(engine) {
                process_with_parakeet(&samples, &file.to_string_lossy(), &options)
            } else {
                let context = get_whisper_context(&file.to_string_lossy()).expect("whisper");
                process_with_whisper(
                    &samples,
                    context,
                    "en",
                    &default_transcription_hints(),
                    &options,
                )
            }
            .expect("engine");
            let path = raw_path(engine, &clip.id);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, serde_json::to_string(&raw).unwrap()).unwrap();
        }
    }
}

#[test]
#[ignore = "needs CAP_DEMO_OUT, CAP_DEMO_AUDIO and downloaded caption models"]
fn make_caption_demo_project() {
    use cap_verify::{
        audio_code::AudioSource,
        fixture::{self, AudioTrackSpec, FixtureSpec, SegmentSpec, Timing, VideoTrackSpec},
    };
    let out = PathBuf::from(std::env::var("CAP_DEMO_OUT").expect("CAP_DEMO_OUT"));
    let speech = PathBuf::from(std::env::var("CAP_DEMO_AUDIO").expect("CAP_DEMO_AUDIO"));
    let model = std::env::var("CAP_DEMO_MODEL").unwrap_or_else(|_| "best".into());
    let duration = 14.5;
    let spec = FixtureSpec {
        name: "caption-demo".into(),
        segments: vec![SegmentSpec {
            display: VideoTrackSpec::new(1280, 720, 30, Timing::Constant { duration }),
            camera: None,
            mic: Some(AudioTrackSpec {
                source: AudioSource::Mic,
                sample_rate: 48_000,
                channels: 1,
                duration,
                start_time: 0.0,
            }),
            system_audio: None,
        }],
    };
    let source = fixture::ensure_fixture(&spec, fixture::write_fixture).expect("fixture");
    let copy = std::process::Command::new("cp")
        .arg("-R")
        .arg(&source)
        .arg(&out)
        .status()
        .expect("cp");
    assert!(copy.success());
    let meta = RecordingMeta::load_for_project(&out).expect("meta");
    let Some(StudioRecordingMeta::MultipleSegments { inner }) = meta.studio_meta() else {
        panic!("multi-segment fixture");
    };
    let mic = meta.path(&inner.segments[0].mic.as_ref().expect("mic").path);
    let encode = std::process::Command::new("ffmpeg")
        .args(["-loglevel", "error", "-y", "-i"])
        .arg(&speech)
        .args([
            "-af",
            "apad",
            "-t",
            &duration.to_string(),
            "-ar",
            "48000",
            "-ac",
            "1",
        ])
        .arg(&mic)
        .status()
        .expect("ffmpeg");
    assert!(encode.success());
    let durations = [duration];
    let segments =
        transcribe_blocking(&out, &model, "en", None, &durations).expect("transcription");
    let mut config = ProjectConfiguration::load(&out).unwrap_or_default();
    apply_caption_result(&mut config, segments, "en", &durations, duration);
    if let Some(captions) = config.captions.as_mut() {
        captions.settings.show_filler_words = std::env::var("CAP_DEMO_SHOW_FILLERS").is_ok();
    }
    config.write(&out).expect("write project");
    for segment in &config.captions.as_ref().unwrap().segments {
        eprintln!("{}", serde_json::to_string(&segment.words).unwrap());
    }
}
