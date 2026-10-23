//! Model-based tests of the decoder request logic.
//!
//! The real decoders (AVAssetReader pool on macOS, FFmpeg everywhere) are
//! spawned through `spawn_decoder` on scripted media
//! (`cap_video_decode::scripted`): sample lists with exact presentation times
//! and sync flags. Seeded request sequences (export and playback order, double
//! requests at 60 fps over 30 fps grids, timelines with cuts, speed changes
//! and backward jumps, transitions, random seeks, keyframe seeks, scrubs,
//! jumps back into old pts holes, reads past the end) run against them, and
//! every answer is checked against the reference rule below.
//!
//! Reference rule (the decoder contract documented next to `pts_to_frame`):
//! a sample is labelled `round(fps * pts_seconds)` on the decoder grid, where
//! both decoders preserve the stream's presentation timeline. A request for
//! time `t` asks for grid index `request_frame(t, fps)`, `floor(t * fps)`
//! with a few f32 steps of slack for the request time. The correct answer is
//! the newest sample whose label is at or before that index
//! (the frame on screen at `t`); when several samples share that label any of
//! them is accepted. A request before the first sample is answered with the
//! first sample.
//!
//! An answer that is not the grid frame but is the sample on screen at the
//! exact request time is `grid-rounding`: correct for a seek straight to `t`,
//! but different from what sequential playback shows for the same request.
//! Other wrong answers are `future` or `stale`. The sequence continues after
//! any wrong answer, so a seed's recorded classes are its full failure set
//! (an expected first failure cannot hide a later, different one). Every
//! request also checks that the reader did not decode past the sample after
//! the answer (`overread`: the reader running ahead of the requests) and that
//! reader starts and seeks stay within a budget of two per jump in the request
//! stream (`resets`); these, like `grid-rounding`, are recorded once and the
//! sequence continues. A request that gets no frame is `dropped`, and the
//! macOS AVAssetReader decoder falling back to FFmpeg is `fallback`.
//!
//! Known failures are strict expected failures, per seed, in
//! `expectations.toml`.
//!
//! Environment:
//! - `CAP_DECODER_MODEL_SCALE`: multiplies every family's seed count.
//! - `CAP_DECODER_MODEL_FILTER`: only run cases whose name contains this.
//! - `CAP_DECODER_MODEL_CASE` + `CAP_DECODER_MODEL_SEED_INDEX`: replay one
//!   sequence and print every request.
//! - `CAP_DECODER_MODEL_SHRINK`: `none`, `new` (default, unexpected failures
//!   only) or `all`.
//! - `CAP_DECODER_MODEL_THREADS`: worker threads (at most 3 for
//!   AVAssetReader, 4 for FFmpeg).
//! - `CAP_DECODER_MODEL_REPORT=<prefix>`: also write the report to
//!   `<prefix>.<decoder>.txt`; `CAP_DECODER_MODEL_SEEDS_OUT=<prefix>` writes
//!   every seed's outcome to `<prefix>.<decoder>.tsv`.
//! - `CAP_VERIFY_REPORT_DIR=<dir>`: write one JSON record per case for the
//!   CI summary and for `cap-verify-expect bless` (see
//!   `crates/verify-expect`), which rewrites `expectations.toml` to match.
//!
//! Wall-clock inputs of the decoders (the AVAssetReader idle timeout of
//! 250 ms and the scrub detector's 100 ms cooldown) only matter when a
//! request is delayed by that long, so outcomes are deterministic unless the
//! machine stalls the test threads.

mod generate;

use std::{
    collections::{BTreeMap, BTreeSet},
    fmt::Write as _,
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use cap_video_decode::scripted::{self, Script};

use generate::{PatternKind, Rng, SourceKind};

#[cfg(target_os = "macos")]
use super::DecoderType;
use super::spawn_decoder;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decoder {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Avf,
    Ffmpeg,
}

impl Decoder {
    fn name(self) -> &'static str {
        match self {
            Self::Avf => "avf",
            Self::Ffmpeg => "ffmpeg",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// `prefer_sequential_access`, like export.
    Export,
    /// Editor playback: seeks use the initial request path.
    Playback,
}

impl Mode {
    fn name(self) -> &'static str {
        match self {
            Self::Export => "export",
            Self::Playback => "playback",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Request {
    pub time: f32,
    pub initial: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum FailureClass {
    GridRounding,
    Future,
    Stale,
    Dropped,
    Fallback,
    Unidentified,
    Overread,
    Resets,
}

impl FailureClass {
    fn name(self) -> &'static str {
        match self {
            Self::GridRounding => "grid-rounding",
            Self::Future => "future",
            Self::Stale => "stale",
            Self::Dropped => "dropped",
            Self::Fallback => "fallback",
            Self::Unidentified => "unidentified",
            Self::Overread => "overread",
            Self::Resets => "resets",
        }
    }
}

#[derive(Clone, Debug)]
struct Failure {
    class: FailureClass,
    request: usize,
    detail: String,
}

#[derive(Clone)]
struct Case {
    name: String,
    seed_index: u64,
    seed: u64,
    decoder: Decoder,
    mode: Mode,
    fps: u32,
    max_fallback_distance: u32,
    script: Script,
    requests: Vec<Request>,
}

struct Outcome {
    /// The first occurrence of each class over the whole sequence
    /// (`Future`, `Stale`, `GridRounding`, `Overread`, `Resets`), then at
    /// most one terminal failure (`Dropped`, `Fallback`, `Unidentified`)
    /// that ended it.
    failures: Vec<Failure>,
    requests: usize,
    starts: u64,
}

struct Oracle {
    labels: Vec<u32>,
    secs: Vec<f64>,
    fps: u32,
    decoder: Decoder,
}

fn label(pts: i64, time_base: (i32, i32), fps: u32) -> u32 {
    (fps as f64 * ((pts as f64 * time_base.0 as f64) / time_base.1 as f64)).round() as u32
}

impl Oracle {
    fn new(script: &Script, decoder: Decoder, fps: u32) -> Self {
        Self {
            labels: script
                .frames
                .iter()
                .map(|frame| label(frame.pts, script.time_base, fps))
                .collect(),
            secs: script
                .frames
                .iter()
                .map(|frame| script.secs(frame.pts))
                .collect(),
            fps,
            decoder,
        }
    }

    /// The newest sample presented at or before `time`, ignoring the grid:
    /// what a seek straight to `time` shows.
    fn on_screen(&self, time: f32) -> usize {
        let time = match self.decoder {
            Decoder::Avf => time,
            Decoder::Ffmpeg => time.max(0.0),
        } as f64;
        self.secs
            .partition_point(|&secs| secs <= time)
            .saturating_sub(1)
    }

    fn index(&self, time: f32) -> u32 {
        let time = match self.decoder {
            Decoder::Avf => time,
            Decoder::Ffmpeg => time.max(0.0),
        };
        super::request_frame(time, self.fps)
    }

    /// Inclusive range of acceptable sample indices for a request.
    fn expect(&self, index: u32) -> (usize, usize) {
        let after = self.labels.partition_point(|&label| label <= index);
        let newest = after.saturating_sub(1);
        let label = self.labels[newest];
        let oldest = self.labels.partition_point(|&other| other < label);
        (oldest, newest)
    }

    fn last_label(&self) -> u32 {
        *self.labels.last().unwrap()
    }
}

/// Records the first occurrence of a failure class that does not end the
/// sequence.
fn note(failures: &mut Vec<Failure>, class: FailureClass, request: usize, detail: String) {
    if !failures.iter().any(|failure| failure.class == class) {
        failures.push(Failure {
            class,
            request,
            detail,
        });
    }
}

fn frame_identity(frame: &crate::DecodedFrame) -> Option<u32> {
    let data = frame.data();
    scripted::frame_id(&data[..data.len().min(16)])
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

fn run_case(case: &Case, runtime: &tokio::runtime::Runtime, trace: bool) -> Outcome {
    let registration = scripted::register(case.script.clone());
    let oracle = Oracle::new(&case.script, case.decoder, case.fps);
    let path = registration.path().to_path_buf();

    runtime.block_on(async {
        let mut failures: Vec<Failure> = Vec::new();
        let fail = |mut failures: Vec<Failure>, class, request, detail: String| {
            failures.push(Failure {
                class,
                request,
                detail,
            });
            Outcome {
                failures,
                requests: request + 1,
                starts: registration.reader_starts() + registration.seeks(),
            }
        };
        let handle = match spawn_decoder(
            "model",
            path,
            case.fps,
            0.0,
            case.decoder == Decoder::Ffmpeg,
        )
        .await
        {
            Ok(handle) => handle.with_max_fallback_distance(case.max_fallback_distance),
            Err(error) => {
                return fail(
                    failures,
                    FailureClass::Dropped,
                    0,
                    format!("spawn failed: {error}"),
                );
            }
        };
        if case.mode == Mode::Export {
            handle.prefer_sequential_access();
        }
        let decoder_type = handle.decoder_type();
        #[cfg(target_os = "macos")]
        if case.decoder == Decoder::Avf {
            assert_eq!(decoder_type, DecoderType::AVAssetReader);
        }
        registration.take_vended();

        let mut previous: Option<(u32, usize)> = None;
        let mut discontinuities = 0u64;
        let mut past_end = 0u64;
        for (position, request) in case.requests.iter().enumerate() {
            let index = oracle.index(request.time);
            let (oldest, newest) = oracle.expect(index);
            if previous.is_none_or(|(previous_index, previous_sample)| {
                index < previous_index
                    || index > previous_index + 2
                    || case.script.secs(case.script.frames[newest].pts)
                        - case.script.secs(case.script.frames[previous_sample].pts)
                        > LONG_HOLD_SECS
            }) {
                discontinuities += 1;
            }
            if index > oracle.last_label() {
                past_end += 1;
            }
            previous = Some((index, newest));

            let frame = if request.initial {
                handle.get_frame_initial(request.time).await
            } else {
                handle.get_frame(request.time).await
            };
            let vended = registration.take_vended();
            let starts = registration.reader_starts() + registration.seeks();
            let describe = |got: Option<u32>| {
                let mut text = format!(
                    "request {position}: t={:?} ({}) -> grid {index}, expected sample {}..={} (label {}), got {}",
                    request.time,
                    if request.initial { "initial" } else { "normal" },
                    oldest,
                    newest,
                    oracle.labels[newest],
                    got.map_or("nothing".to_string(), |got| format!(
                        "sample {got} (label {})",
                        oracle.labels.get(got as usize).copied().unwrap_or(u32::MAX)
                    )),
                );
                let shown: Vec<String> = vended.iter().take(12).map(u32::to_string).collect();
                let _ = write!(
                    text,
                    "; vended [{}{}], reader starts+seeks {starts}",
                    shown.join(", "),
                    if vended.len() > 12 { ", ..." } else { "" }
                );
                text
            };

            if handle.decoder_type() != decoder_type {
                return fail(
                    failures,
                    FailureClass::Fallback,
                    position,
                    format!("decoder switched to {}; {}", handle.decoder_type(), describe(None)),
                );
            }
            let Some(frame) = frame else {
                return fail(failures, FailureClass::Dropped, position, describe(None));
            };
            let Some(got) = frame_identity(&frame) else {
                return fail(
                    failures,
                    FailureClass::Unidentified,
                    position,
                    describe(None),
                );
            };
            if trace {
                eprintln!("{}", describe(Some(got)));
            }
            let got_index = got as usize;
            if !(oldest..=newest).contains(&got_index) {
                if got_index == oracle.on_screen(request.time) {
                    note(
                        &mut failures,
                        FailureClass::GridRounding,
                        position,
                        describe(Some(got)),
                    );
                } else if got_index > newest {
                    note(
                        &mut failures,
                        FailureClass::Future,
                        position,
                        describe(Some(got)),
                    );
                } else {
                    note(
                        &mut failures,
                        FailureClass::Stale,
                        position,
                        describe(Some(got)),
                    );
                }
            }
            if let Some(&furthest) = vended.iter().max()
                && furthest as usize > newest.max(got_index) + 1
            {
                note(
                    &mut failures,
                    FailureClass::Overread,
                    position,
                    describe(Some(got)),
                );
            }
            let allowed = 2 + 2 * discontinuities + past_end / 10;
            if starts > allowed {
                note(
                    &mut failures,
                    FailureClass::Resets,
                    position,
                    format!(
                        "{} (allowed {allowed} for {discontinuities} discontinuities)",
                        describe(Some(got))
                    ),
                );
            }
        }
        Outcome {
            failures,
            requests: case.requests.len(),
            starts: registration.reader_starts() + registration.seeks(),
        }
    })
}

/// Sequential requests that cross a hold this long count as a jump: the
/// AVAssetReader pool repositions a reader once a request is 5 s past it.
const LONG_HOLD_SECS: f64 = 4.0;

struct Family {
    source: SourceKind,
    pattern: PatternKind,
    mode: Mode,
    seeds: usize,
}

const fn family(source: SourceKind, pattern: PatternKind, mode: Mode, seeds: usize) -> Family {
    Family {
        source,
        pattern,
        mode,
        seeds,
    }
}

const FAMILIES: &[Family] = {
    use Mode::*;
    use PatternKind::*;
    use SourceKind::*;
    &[
        family(Cfr, Sequential, Export, 120),
        family(Cfr, Sequential, Playback, 120),
        family(Cfr, Timeline, Export, 150),
        family(Cfr, Transition, Export, 80),
        family(Cfr, Transition, Playback, 80),
        family(Cfr, RandomSeeks, Playback, 300),
        family(Cfr, KeyframeSeeks, Playback, 300),
        family(Cfr, Scrub, Playback, 200),
        family(Cfr, Tail, Export, 100),
        family(Cfr, Tail, Playback, 100),
        family(Dense, Sequential, Export, 60),
        family(Dense, RandomSeeks, Playback, 150),
        family(Camera, Sequential, Export, 4),
        family(Camera, Sequential, Playback, 4),
        family(CameraFast, Sequential, Export, 30),
        family(CameraFast, Sequential, Playback, 30),
        family(CameraFast, RandomSeeks, Playback, 60),
        family(Vfr, Sequential, Export, 100),
        family(Vfr, Sequential, Playback, 100),
        family(Vfr, Timeline, Export, 120),
        family(Vfr, RandomSeeks, Playback, 200),
        family(Vfr, KeyframeSeeks, Playback, 100),
        family(Vfr, Scrub, Playback, 120),
        family(Vfr, Transition, Playback, 80),
        family(HalfGrid, Sequential, Export, 20),
        family(HalfGrid, BackIntoOldGap, Playback, 60),
        family(HalfGrid, BackIntoOldGap, Export, 60),
        family(Syn, Edlist, Playback, 8),
        family(Syn, Edlist, Export, 8),
        family(LateStart, Sequential, Playback, 80),
        family(LateStart, RandomSeeks, Playback, 80),
    ]
};

fn case_name(decoder: Decoder, family: &Family) -> String {
    format!(
        "decoder-model/{}/{}/{}/{}",
        decoder.name(),
        family.source.name(),
        family.pattern.name(),
        family.mode.name()
    )
}

fn build_case(decoder: Decoder, family: &Family, seed_index: u64) -> Case {
    let name = case_name(decoder, family);
    let seed = generate::family_seed(&name, seed_index);
    let mut rng = Rng::new(seed);
    let source = generate::source(&mut rng, family.source);
    let requests = generate::requests(&mut rng, &source, family.pattern, family.mode);
    Case {
        name,
        seed_index,
        seed,
        decoder,
        mode: family.mode,
        fps: source.fps,
        max_fallback_distance: source.max_fallback_distance,
        script: source.script,
        requests,
    }
}

fn fails_with(case: &Case, class: FailureClass, runtime: &tokio::runtime::Runtime) -> bool {
    run_case(case, runtime, false)
        .failures
        .iter()
        .any(|failure| failure.class == class)
}

/// Delta-debugging over the request list, then trims the script tail.
fn shrink(case: &Case, failure: &Failure, runtime: &tokio::runtime::Runtime) -> Case {
    let deadline = Instant::now() + Duration::from_secs(20);
    let class = failure.class;
    let mut best = case.clone();
    best.requests.truncate(failure.request + 1);

    let mut chunks = 2usize;
    while best.requests.len() >= 2 && Instant::now() < deadline {
        let size = best.requests.len().div_ceil(chunks);
        let mut reduced = false;
        for start in (0..best.requests.len()).step_by(size) {
            let mut candidate = best.clone();
            candidate
                .requests
                .drain(start..(start + size).min(candidate.requests.len()));
            if !candidate.requests.is_empty() && fails_with(&candidate, class, runtime) {
                best = candidate;
                chunks = (chunks - 1).max(2);
                reduced = true;
                break;
            }
            if Instant::now() >= deadline {
                break;
            }
        }
        if !reduced {
            if chunks >= best.requests.len() {
                break;
            }
            chunks = (chunks * 2).min(best.requests.len());
        }
    }

    let oracle = Oracle::new(&best.script, best.decoder, best.fps);
    let needed = best
        .requests
        .iter()
        .map(|request| oracle.expect(oracle.index(request.time)).1 + 2)
        .max()
        .unwrap_or(1);
    if needed < best.script.frames.len() {
        let mut candidate = best.clone();
        candidate.script.frames.truncate(needed);
        if fails_with(&candidate, class, runtime) {
            best = candidate;
        }
    }
    best
}

fn describe_script(script: &Script) -> String {
    let mut runs: Vec<(i64, usize)> = Vec::new();
    for pair in script.frames.windows(2) {
        let delta = pair[1].pts - pair[0].pts;
        match runs.last_mut() {
            Some((last, count)) if *last == delta => *count += 1,
            _ => runs.push((delta, 1)),
        }
    }
    let deltas: Vec<String> = runs
        .iter()
        .map(|(delta, count)| {
            if *count == 1 {
                delta.to_string()
            } else {
                format!("{delta}x{count}")
            }
        })
        .collect();
    let keyframes: Vec<String> = script
        .frames
        .iter()
        .enumerate()
        .filter(|(_, frame)| frame.keyframe)
        .map(|(index, _)| index.to_string())
        .collect();
    format!(
        "time_base {}/{}, {} samples, first pts {}, pts deltas [{}], sync samples [{}], last duration {}",
        script.time_base.0,
        script.time_base.1,
        script.frames.len(),
        script.frames[0].pts,
        deltas.join(" "),
        keyframes.join(" "),
        script.last_duration
    )
}

fn describe_requests(requests: &[Request]) -> String {
    requests
        .iter()
        .map(|request| {
            if request.initial {
                format!("{:?}i", request.time)
            } else {
                format!("{:?}", request.time)
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

struct FamilyResult {
    name: String,
    seeds: usize,
    requests: usize,
    starts: u64,
    elapsed: Duration,
    failures: Vec<(Case, Failure)>,
    outcomes: Vec<(u64, Vec<(FailureClass, usize)>)>,
}

fn env_usize(name: &str) -> Option<usize> {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
}

const EXPECTATIONS: &str = "crates/rendering/src/decoder/model/expectations.toml";

fn write_records(
    decoder: Decoder,
    results: &[FamilyResult],
    ran: &cap_verify_expect::Ran,
    verdict: &cap_verify_expect::Verdict,
    platform: &str,
) {
    use cap_verify_expect::{Outcome, Record};
    if cap_verify_expect::report_dir().is_none() {
        return;
    }
    let records: Vec<(Record, serde_json::Value)> = results
        .iter()
        .map(|result| {
            let mut failures: BTreeMap<String, BTreeSet<u64>> = BTreeMap::new();
            let mut problems: BTreeMap<String, String> = BTreeMap::new();
            for (case, failure) in &result.failures {
                let class = failure.class.name().to_string();
                failures
                    .entry(class.clone())
                    .or_default()
                    .insert(case.seed_index);
                problems.entry(class).or_insert_with(|| {
                    format!(
                        "seed index {} request {}: {}",
                        case.seed_index, failure.request, failure.detail
                    )
                });
            }
            let new: Vec<&cap_verify_expect::Unexpected> = verdict
                .unexpected
                .iter()
                .filter(|found| found.case == result.name)
                .collect();
            let fixed: Vec<&cap_verify_expect::Fixed> = verdict
                .fixed
                .iter()
                .filter(|fixed| fixed.case == result.name)
                .collect();
            let outcome = if !new.is_empty() {
                Outcome::Fail
            } else if !fixed.is_empty() {
                Outcome::Xpass
            } else if failures.is_empty() {
                Outcome::Pass
            } else {
                Outcome::Xfail
            };
            let mut summary: Vec<String> = new
                .iter()
                .map(|found| {
                    format!(
                        "{} on seeds {}: {}",
                        found.class,
                        cap_verify_expect::format_seeds(&found.seeds),
                        problems.get(&found.class).map_or("", String::as_str)
                    )
                })
                .collect();
            summary.extend(fixed.iter().map(|fixed| fixed.message(EXPECTATIONS)));
            if summary.is_empty() {
                summary.push(format!(
                    "{} seeds, {} requests{}",
                    result.seeds,
                    result.requests,
                    if failures.is_empty() {
                        String::new()
                    } else {
                        format!(
                            ", expected failures: {}",
                            failures.keys().cloned().collect::<Vec<_>>().join(", ")
                        )
                    }
                ));
            }
            let replay_seed = new
                .first()
                .and_then(|found| found.seeds.first().copied())
                .or_else(|| {
                    fixed
                        .first()
                        .and_then(|fixed| fixed.seeds.as_ref()?.first().copied())
                });
            let test = match decoder {
                Decoder::Avf => "avassetreader_answers_match_the_reference_model",
                Decoder::Ffmpeg => "ffmpeg_answers_match_the_reference_model",
            };
            let repro = match replay_seed {
                Some(seed) => format!(
                    "CAP_DECODER_MODEL_CASE={} CAP_DECODER_MODEL_SEED_INDEX={seed} cargo test -p cap-rendering --lib decoder::model::{test} -- --nocapture",
                    result.name
                ),
                None => format!(
                    "CAP_DECODER_MODEL_FILTER={} cargo test -p cap-rendering --lib decoder::model::{test} -- --nocapture",
                    result.name
                ),
            };
            let record = Record {
                suite: "decoder-model".into(),
                expectations: EXPECTATIONS.into(),
                case: result.name.clone(),
                platform: platform.into(),
                tier: std::env::var("CAP_VERIFY_TIER").unwrap_or_else(|_| "fast".into()),
                outcome,
                failures,
                seeds_ran: ran.get(&result.name).cloned().flatten(),
                unobserved: Default::default(),
                problems,
                measures: Default::default(),
                excused: Default::default(),
                starved: false,
                summary: summary.join("\n"),
                repro,
                seconds: result.elapsed.as_secs_f64(),
            };
            (record, serde_json::Value::Null)
        })
        .collect();
    cap_verify_expect::write_records(&records);
}

fn run_suite(decoder: Decoder) {
    let xfails = cap_verify_expect::parse(include_str!("expectations.toml"))
        .unwrap_or_else(|e| panic!("{EXPECTATIONS}: {e}"));
    let filter = std::env::var("CAP_DECODER_MODEL_FILTER").ok();
    let scale: f64 = std::env::var("CAP_DECODER_MODEL_SCALE")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1.0);

    if let (Ok(name), Some(seed_index)) = (
        std::env::var("CAP_DECODER_MODEL_CASE"),
        env_usize("CAP_DECODER_MODEL_SEED_INDEX"),
    ) {
        let Some(family) = FAMILIES
            .iter()
            .find(|family| case_name(decoder, family) == name)
        else {
            return;
        };
        let case = build_case(decoder, family, seed_index as u64);
        eprintln!(
            "replaying {} seed index {} (seed {:#x}): {}",
            case.name,
            seed_index,
            case.seed,
            describe_script(&case.script)
        );
        let outcome = run_case(&case, &runtime(), true);
        for failure in &outcome.failures {
            eprintln!("{} {}", failure.class.name(), failure.detail);
        }
        assert!(outcome.failures.is_empty());
        return;
    }

    let families: Vec<&Family> = FAMILIES
        .iter()
        .filter(|family| {
            filter
                .as_ref()
                .is_none_or(|filter| case_name(decoder, family).contains(filter.as_str()))
        })
        .filter(|family| cap_verify_expect::case_selected(&case_name(decoder, family)))
        .collect();
    let jobs: Vec<(usize, u64)> = families
        .iter()
        .enumerate()
        .flat_map(|(family_index, family)| {
            let seeds = ((family.seeds as f64 * scale).ceil() as u64).max(1);
            (0..seeds).map(move |seed| (family_index, seed))
        })
        .collect();

    let started = Instant::now();
    let next = AtomicUsize::new(0);
    let results = Mutex::new(
        families
            .iter()
            .map(|family| FamilyResult {
                name: case_name(decoder, family),
                seeds: 0,
                requests: 0,
                starts: 0,
                elapsed: Duration::ZERO,
                failures: Vec::new(),
                outcomes: Vec::new(),
            })
            .collect::<Vec<_>>(),
    );
    // AVAssetReader pools share 16 reader permits per process and grow to 5
    // readers each, so more than 3 concurrent sequences would let one
    // sequence's pool growth depend on another's and make outcomes vary.
    let max_threads = match decoder {
        Decoder::Avf => 3,
        Decoder::Ffmpeg => 4,
    };
    let threads = env_usize("CAP_DECODER_MODEL_THREADS")
        .unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(2)
        })
        .clamp(1, max_threads);
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                let runtime = runtime();
                loop {
                    let job = next.fetch_add(1, Ordering::Relaxed);
                    let Some(&(family_index, seed_index)) = jobs.get(job) else {
                        break;
                    };
                    let case = build_case(decoder, families[family_index], seed_index);
                    let case_started = Instant::now();
                    let outcome = run_case(&case, &runtime, false);
                    let mut results = results.lock().unwrap();
                    let result = &mut results[family_index];
                    result.seeds += 1;
                    result.requests += outcome.requests;
                    result.starts += outcome.starts;
                    result.elapsed += case_started.elapsed();
                    result.outcomes.push((
                        seed_index,
                        outcome
                            .failures
                            .iter()
                            .map(|failure| (failure.class, failure.request))
                            .collect(),
                    ));
                    for failure in outcome.failures {
                        result.failures.push((case.clone(), failure));
                    }
                }
            });
        }
    });
    let mut results = results.into_inner().unwrap();
    for result in &mut results {
        result
            .failures
            .sort_by_key(|(case, failure)| (failure.class, case.seed_index));
    }

    if let Ok(path) = std::env::var("CAP_DECODER_MODEL_SEEDS_OUT") {
        let mut lines = String::new();
        for result in &mut results {
            result.outcomes.sort_by_key(|(seed_index, _)| *seed_index);
            for (seed_index, outcome) in &result.outcomes {
                let _ = writeln!(
                    lines,
                    "{}\t{}\t{}",
                    result.name,
                    seed_index,
                    if outcome.is_empty() {
                        "ok".to_string()
                    } else {
                        outcome
                            .iter()
                            .map(|(class, request)| format!("{} {}", class.name(), request))
                            .collect::<Vec<_>>()
                            .join(", ")
                    }
                );
            }
        }
        let _ = std::fs::write(format!("{path}.{}.tsv", decoder.name()), lines);
    }

    let ran: cap_verify_expect::Ran = results
        .iter()
        .map(|result| {
            let seeds = result.outcomes.iter().map(|(seed, _)| *seed).collect();
            (result.name.clone(), Some(seeds))
        })
        .collect();
    let mut observed = cap_verify_expect::Observed::new();
    for result in &results {
        for (case, failure) in &result.failures {
            observed
                .entry((result.name.clone(), failure.class.name().to_string()))
                .or_default()
                .insert(case.seed_index);
        }
    }
    let platform = cap_verify_expect::platform();
    let verdict = cap_verify_expect::judge(&xfails, platform, &ran, &observed);
    let unexpected: BTreeSet<(String, String, u64)> = verdict
        .unexpected
        .iter()
        .flat_map(|found| {
            found
                .seeds
                .iter()
                .map(move |&seed| (found.case.clone(), found.class.clone(), seed))
        })
        .collect();
    write_records(decoder, &results, &ran, &verdict, platform);

    let mut report = String::new();
    let total_requests: usize = results.iter().map(|result| result.requests).sum();
    let total_seeds: usize = results.iter().map(|result| result.seeds).sum();
    let _ = writeln!(
        report,
        "{} decoder model: {} sequences, {} requests, {:.1} s wall on {} threads",
        decoder.name(),
        total_seeds,
        total_requests,
        started.elapsed().as_secs_f64(),
        threads
    );
    for result in &results {
        let mut classes: BTreeMap<FailureClass, (usize, usize)> = BTreeMap::new();
        for (case, failure) in &result.failures {
            let counts = classes.entry(failure.class).or_default();
            counts.0 += 1;
            if unexpected.contains(&(
                result.name.clone(),
                failure.class.name().to_string(),
                case.seed_index,
            )) {
                counts.1 += 1;
            }
        }
        let summary = if classes.is_empty() {
            "ok".to_string()
        } else {
            classes
                .iter()
                .map(|(class, (count, new))| {
                    let status = if *new == 0 {
                        "xfail".to_string()
                    } else {
                        format!("{new} NEW")
                    };
                    format!("{} {}/{} ({status})", class.name(), count, result.seeds)
                })
                .collect::<Vec<_>>()
                .join(", ")
        };
        let _ = writeln!(
            report,
            "  {:<58} seeds {:>4} requests {:>7} starts {:>6} {:>6.1}s  {}",
            result.name,
            result.seeds,
            result.requests,
            result.starts,
            result.elapsed.as_secs_f64(),
            summary
        );
    }

    let shrink_mode = std::env::var("CAP_DECODER_MODEL_SHRINK").unwrap_or_else(|_| "new".into());
    let runtime = runtime();
    for result in &results {
        let mut shown: BTreeMap<FailureClass, bool> = BTreeMap::new();
        for (case, failure) in &result.failures {
            let is_new = unexpected.contains(&(
                result.name.clone(),
                failure.class.name().to_string(),
                case.seed_index,
            ));
            match shown.get(&failure.class) {
                Some(true) => continue,
                Some(false) if !is_new => continue,
                _ => {}
            }
            shown.insert(failure.class, is_new);
            let _ = writeln!(
                report,
                "\n{} {} {}: seed index {} (seed {:#x}), first failure at request {} of {}\n  {}",
                if is_new { "FAIL" } else { "xfail" },
                result.name,
                failure.class.name(),
                case.seed_index,
                case.seed,
                failure.request,
                case.requests.len(),
                failure.detail
            );
            let _ = writeln!(
                report,
                "  replay: CAP_DECODER_MODEL_CASE={} CAP_DECODER_MODEL_SEED_INDEX={}",
                result.name, case.seed_index
            );
            let wants_shrink = match shrink_mode.as_str() {
                "all" => true,
                "none" => false,
                _ => is_new,
            };
            if wants_shrink {
                let minimal = shrink(case, failure, &runtime);
                let outcome = run_case(&minimal, &runtime, false);
                let _ = writeln!(
                    report,
                    "  minimal repro: fps {}, max fallback {}, mode {}\n    script: {}\n    requests ({}): {}\n    {}",
                    minimal.fps,
                    minimal.max_fallback_distance,
                    minimal.mode.name(),
                    describe_script(&minimal.script),
                    minimal.requests.len(),
                    describe_requests(&minimal.requests),
                    outcome
                        .failures
                        .iter()
                        .find(|found| found.class == failure.class)
                        .map_or("(did not reproduce)".to_string(), |found| found
                            .detail
                            .clone())
                );
            }
        }
    }

    for found in &verdict.unexpected {
        let _ = writeln!(
            report,
            "\nUNEXPECTED FAILURE {} {} on seed indices {}",
            found.case,
            found.class,
            cap_verify_expect::format_seeds(&found.seeds)
        );
    }
    for fixed in &verdict.fixed {
        let _ = writeln!(report, "\nUNEXPECTED PASS {}", fixed.message(EXPECTATIONS));
    }
    eprintln!("{report}");
    if let Ok(path) = std::env::var("CAP_DECODER_MODEL_REPORT") {
        let _ = std::fs::write(format!("{path}.{}.txt", decoder.name()), report.as_bytes());
    }
    assert!(
        verdict.ok(),
        "decoder model: {} unexpected failures, {} unexpected passes (see report above)",
        verdict.unexpected.len(),
        verdict.fixed.len()
    );
}

#[cfg(target_os = "macos")]
#[test]
fn avassetreader_answers_match_the_reference_model() {
    // Engine verify runs only this test of the module on macOS.
    avassetreader_answers_stay_exact_when_its_reader_fails();
    avassetreader_switches_to_software_only_when_its_reader_stops_answering();
    run_suite(Decoder::Avf);
    avassetreader_scrubbing_backwards_reuses_the_frames_below_each_seek();
    avassetreader_stops_reading_only_once_every_request_is_abandoned();
}

/// A native reader can fail mid-stream with a decode error and vend nothing
/// more. Every later answer must still be the frame on screen: read from a
/// fresh reader, or from software decoding when that one fails too.
#[cfg(target_os = "macos")]
#[test]
fn avassetreader_answers_stay_exact_when_its_reader_fails() {
    let script = Script {
        time_base: (1, 30),
        frames: (0..120)
            .map(|pts| scripted::ScriptFrame {
                pts,
                keyframe: pts % 30 == 0,
            })
            .collect(),
        last_duration: 1,
    };
    let runtime = runtime();
    let patterns: [(&str, Vec<u32>, bool); 2] = [
        ("playback", (0..90).collect(), false),
        ("scrub", (0..112).step_by(7).collect(), true),
    ];
    for failed_reads in [1, 2] {
        for (pattern, frames, initial) in &patterns {
            let registration = scripted::register(script.clone());
            for _ in 0..failed_reads {
                registration.fail_avf_read_at(40);
            }
            let path = registration.path().to_path_buf();
            runtime.block_on(async {
                let handle = spawn_decoder("model", path, 30, 0.0, false)
                    .await
                    .unwrap()
                    .with_max_fallback_distance(2);
                for &frame in frames {
                    let time = frame as f32 / 30.0;
                    let decoded = if *initial {
                        handle.get_frame_initial(time).await
                    } else {
                        handle.get_frame(time).await
                    };
                    assert_eq!(
                        decoded.as_ref().and_then(frame_identity),
                        Some(frame),
                        "{pattern} with {failed_reads} failed reads at sample 40: request {frame}"
                    );
                }
                assert_eq!(
                    handle.decoder_type() == DecoderType::AVAssetReader,
                    failed_reads == 1,
                    "{pattern} with {failed_reads} failed reads ended on {}",
                    handle.decoder_type()
                );
            });
        }
    }
}

/// A busy machine can miss one playback deadline without anything being
/// wrong with the reader: that request gets no frame, and hardware decoding
/// stays. A reader that answers without a frame, misses every playback
/// deadline round after round, or misses the deadline of a first frame that
/// nothing will ask for again is replaced by software decoding.
#[cfg(target_os = "macos")]
#[test]
fn avassetreader_switches_to_software_only_when_its_reader_stops_answering() {
    use super::{FrameDeadline, MacOsDecoderFallback};

    let script = Script {
        time_base: (1, 30),
        frames: (0..120)
            .map(|pts| scripted::ScriptFrame {
                pts,
                keyframe: pts % 30 == 0,
            })
            .collect(),
        last_duration: 1,
    };
    let runtime = runtime();
    let time = |frame: u32| frame as f32 / 30.0;
    let slow_vend = Duration::from_millis(1500);
    let deadline_ms = 250;

    let registration = scripted::register(script.clone());
    let path = registration.path().to_path_buf();
    runtime.block_on(async {
        let handle = spawn_decoder("model", path, 30, 0.0, false)
            .await
            .unwrap()
            .with_max_fallback_distance(2);
        let mut frame = 0;
        for episode in 0..3 {
            registration.set_vend_delay(slow_vend);
            for _ in 1..MacOsDecoderFallback::MAX_TIMED_OUT_ROUNDS {
                frame += 1;
                let late = handle
                    .get_frame_with_timeout(time(frame), deadline_ms, 2, FrameDeadline::Drop)
                    .await;
                assert!(
                    matches!(late, Ok(None)),
                    "slow episode {episode}: request {frame} beat a {deadline_ms} ms deadline"
                );
                assert_eq!(handle.decoder_type(), DecoderType::AVAssetReader);
            }
            registration.set_vend_delay(Duration::ZERO);
            frame += 1;
            assert_eq!(
                handle
                    .get_frame_initial(time(frame))
                    .await
                    .as_ref()
                    .and_then(frame_identity),
                Some(frame),
                "after slow episode {episode}"
            );
            assert_eq!(
                handle.decoder_type(),
                DecoderType::AVAssetReader,
                "slow episode {episode} switched to {}",
                handle.decoder_type()
            );
        }

        registration.set_vend_delay(slow_vend);
        for round in 1..=MacOsDecoderFallback::MAX_TIMED_OUT_ROUNDS {
            frame += 1;
            let request =
                handle.get_frame_with_timeout(time(frame), deadline_ms, 2, FrameDeadline::Drop);
            if round < MacOsDecoderFallback::MAX_TIMED_OUT_ROUNDS {
                assert!(
                    matches!(request.await, Ok(None)),
                    "stalled round {round}: request {frame} beat a {deadline_ms} ms deadline"
                );
                assert_eq!(handle.decoder_type(), DecoderType::AVAssetReader);
                continue;
            }
            // The reader is still inside the vend it started with the slow
            // delay in round 1, so lifting the delay now lets only the
            // software decoder answer this request within its deadline.
            let lift_delay = async {
                tokio::time::sleep(Duration::from_millis(deadline_ms / 2)).await;
                registration.set_vend_delay(Duration::ZERO);
            };
            let (answered, ()) = tokio::join!(request, lift_delay);
            assert_eq!(
                answered.unwrap().as_ref().and_then(frame_identity),
                Some(frame),
                "the request that switched to software decoding"
            );
        }
        assert_eq!(handle.decoder_type(), DecoderType::FFmpegSoftware);
        assert_eq!(
            handle.fallback_reason(),
            Some("AVAssetReader stopped answering")
        );
        frame += 1;
        assert_eq!(
            handle
                .get_frame(time(frame))
                .await
                .as_ref()
                .and_then(frame_identity),
            Some(frame)
        );
    });

    let registration = scripted::register(script.clone());
    let path = registration.path().to_path_buf();
    runtime.block_on(async {
        let handle = spawn_decoder("model", path, 30, 0.0, false)
            .await
            .unwrap()
            .with_max_fallback_distance(2);
        assert_eq!(
            handle
                .get_frame_initial(time(5))
                .await
                .as_ref()
                .and_then(frame_identity),
            Some(5)
        );
        registration.set_vend_delay(slow_vend);
        let late = handle
            .get_frame_with_timeout(time(6), deadline_ms, 2, FrameDeadline::Drop)
            .await;
        assert!(
            matches!(late, Ok(None)),
            "request 6 beat a {deadline_ms} ms deadline"
        );
        assert_eq!(handle.decoder_type(), DecoderType::AVAssetReader);
        let seek = handle.get_frame_with_timeout(time(10), deadline_ms, 2, FrameDeadline::Initial);
        let lift_delay = async {
            tokio::time::sleep(Duration::from_millis(deadline_ms / 2)).await;
            registration.set_vend_delay(Duration::ZERO);
        };
        let (answered, ()) = tokio::join!(seek, lift_delay);
        assert_eq!(
            answered.unwrap().as_ref().and_then(frame_identity),
            Some(10),
            "the first timed-out initial request"
        );
        assert_eq!(handle.decoder_type(), DecoderType::FFmpegSoftware);
        assert_eq!(
            handle.fallback_reason(),
            Some("AVAssetReader stopped answering")
        );
    });

    let registration = scripted::register(script);
    registration.fail_avf_read_at(40);
    registration.fail_avf_read_at(40);
    let path = registration.path().to_path_buf();
    runtime.block_on(async {
        let handle = spawn_decoder("model", path, 30, 0.0, false)
            .await
            .unwrap()
            .with_max_fallback_distance(2);
        assert_eq!(
            handle
                .get_frame(time(45))
                .await
                .as_ref()
                .and_then(frame_identity),
            Some(45)
        );
        assert_eq!(handle.decoder_type(), DecoderType::FFmpegSoftware);
        assert_eq!(
            handle.fallback_reason(),
            Some("AVAssetReader returned no frame")
        );
    });
}

#[test]
fn ffmpeg_answers_match_the_reference_model() {
    run_suite(Decoder::Ffmpeg);
}

#[test]
fn ffmpeg_preserves_late_pts_across_playback_and_seeks() {
    let script = Script {
        time_base: (1, 30),
        frames: (60..180)
            .map(|pts| scripted::ScriptFrame {
                pts,
                keyframe: pts % 30 == 0,
            })
            .collect(),
        last_duration: 1,
    };
    let runtime = runtime();
    for mode in [Mode::Export, Mode::Playback] {
        let case = Case {
            name: "late-pts".into(),
            seed_index: 0,
            seed: 0,
            decoder: Decoder::Ffmpeg,
            mode,
            fps: 30,
            max_fallback_distance: 2,
            script: script.clone(),
            requests: (0..180)
                .chain([135, 15, 75, 165, 45, 105])
                .enumerate()
                .map(|(position, frame)| Request {
                    time: (frame as f32 + 0.25) / 30.0,
                    initial: mode == Mode::Playback && (position == 0 || position >= 180),
                })
                .collect(),
        };
        let outcome = run_case(&case, &runtime, false);
        assert!(
            outcome.failures.is_empty(),
            "{mode:?}: {:?}",
            outcome.failures
        );
        assert_eq!(outcome.requests, case.requests.len());
    }
}

#[cfg(target_os = "macos")]
#[test]
fn avassetreader_scrubbing_backwards_reuses_the_frames_below_each_seek() {
    let script = Script {
        time_base: (1, 30),
        frames: (0..120)
            .map(|pts| scripted::ScriptFrame {
                pts,
                keyframe: pts % 30 == 0,
            })
            .collect(),
        last_duration: 1,
    };
    let case = Case {
        name: "backward-scrub".into(),
        seed_index: 0,
        seed: 0,
        decoder: Decoder::Avf,
        mode: Mode::Playback,
        fps: 30,
        max_fallback_distance: 2,
        script,
        requests: (0..60)
            .map(|step| Request {
                time: (118 - step * 2) as f32 / 30.0,
                initial: true,
            })
            .collect(),
    };
    let outcome = run_case(&case, &runtime(), false);
    assert!(outcome.failures.is_empty(), "{:?}", outcome.failures);
    assert_eq!(outcome.requests, case.requests.len());
    assert!(
        outcome.starts <= 16,
        "{} reader starts and seeks for 60 backward scrub steps",
        outcome.starts
    );
}

#[cfg(target_os = "macos")]
#[test]
fn avassetreader_stops_reading_only_once_every_request_is_abandoned() {
    let script = Script {
        time_base: (1, 30),
        frames: (0..900)
            .map(|pts| scripted::ScriptFrame {
                pts,
                keyframe: pts % 600 == 0,
            })
            .collect(),
        last_duration: 1,
    };
    let registration = scripted::register(script);
    let path = registration.path().to_path_buf();
    runtime().block_on(async {
        let handle = spawn_decoder("model", path, 30, 0.0, false)
            .await
            .unwrap()
            .with_max_fallback_distance(2);
        registration.set_vend_delay(Duration::from_millis(2));
        registration.take_vended();
        let time = |frame: u32| frame as f32 / 30.0;

        let abandoned = tokio::time::timeout(
            Duration::from_millis(40),
            handle.get_frame_initial(time(550)),
        );
        let batch = async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            tokio::join!(
                tokio::time::timeout(
                    Duration::from_millis(150),
                    handle.get_frame_initial(time(760)),
                ),
                handle.get_frame_initial(time(765)),
            )
        };
        let (abandoned, (dropped, kept)) = tokio::join!(abandoned, batch);

        assert!(abandoned.is_err(), "frame 550 arrived before 40 ms");
        assert!(dropped.is_err(), "frame 760 arrived before 160 ms");
        assert_eq!(
            kept.as_ref().and_then(frame_identity),
            Some(765),
            "the open request of a batch whose other request was dropped"
        );
        let read_below_keyframe = registration
            .take_vended()
            .iter()
            .filter(|&&index| index < 600)
            .count();
        assert!(
            read_below_keyframe < 450,
            "{read_below_keyframe} frames read towards frame 550 after its request was dropped at 40 ms"
        );
        assert_eq!(handle.decoder_type(), DecoderType::AVAssetReader);
    });
}
